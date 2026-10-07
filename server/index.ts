import { ensureMcpLauncher } from './agent-mcp.ts';
import { closeAgentProcesses } from './agent-process.ts';
import { mountFileOperationReceipts } from './routes/file-operations.ts';
/**
 * Express server entry point.
 *
 * Owns process lifecycle (boot middleware, mount route modules, listen,
 * graceful shutdown) but no business logic — that lives in the route
 * modules under `server/routes/` and the shared helpers in
 * `server/state.ts` and `server/http.ts`.
 *
 * Boot order matters:
 *   1. JSON body parser
 *   2. Security middleware (CSP + Origin check)
 *   3. Static web bundle for non-data routes (no-op in DEV_VITE)
 *   4. `requireFolder` mounted on data-route prefixes
 *   5. Route modules in the order they should resolve
 *   6. Vite dev-only proxy (last — it swallows /everything/)
 *   7. `listen` + WebSocket upgrade handler
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { WebSocketServer } from 'ws';
import { createWebSocketUpgradeHandler, type WebSocketUpgrade } from './websocket-upgrade.ts';
import {
  attachAgentRuntime,
  isAgentAccessMode,
  parseAgentEffort,
  registerAgentAdapter,
  resolveAgentSessionScope,
  stopAgentRuntime,
  type AgentAccessMode,
  type AgentConnectionOptions,
} from './agent-contract.ts';
import { onClose, ensureFolderHome, registeredFolderRoots } from './folder.ts';
import { filesystemPath } from './filesystem-path.ts';
import { bootBindAllFolders, resetIndexerRuntime } from './state.ts';
import { reapOrphanDaemons, reclaimStaleServerPort } from './stale-lock.ts';
import { startParentWatchdog } from './parent-watchdog.ts';
import { logger } from './log.ts';
import { cancelAllConversions, setDerivedNoteIndexer } from './conversion.ts';
import { noteTreeChanged } from './watcher.ts';
import { indexer } from './state.ts';
import { closeStateDb } from './state-db.ts';
import { requireFolder, withWindowContext } from './http.ts';
import { mount as mountWindowContextRoutes } from './routes/window-context.ts';
import { mountInternalShutdownRoute } from './routes/internal-shutdown.ts';
import { mount as mountProjectRoutes } from './routes/project.ts';
import { mount as mountGalleryRoutes } from './routes/gallery.ts';
import { mount as mountEmbedderRoutes } from './routes/embedder.ts';
import { mount as mountTelemetryRoutes } from './routes/telemetry.ts';
import { telemetry } from './telemetry.ts';
import { mount as mountAppearanceRoutes } from './routes/appearance.ts';
import { mount as mountWorkspacePreferenceRoutes } from './routes/workspace-preferences.ts';
import { mount as mountUpdateRoutes } from './routes/updates.ts';
import { mount as mountLocalComponentRoutes } from './routes/local-components.ts';
import { resumeExtractorDownload, closeExtractorRuntime } from './python-host.ts';
import { mount as mountFilesRoutes } from './routes/files.ts';
import { mount as mountFoldersRoutes } from './routes/folders.ts';
import { mount as mountUploadRoutes } from './routes/upload.ts';
import { mount as mountAttachRoutes } from './routes/attach.ts';
import { mount as mountIndexingRoutes } from './routes/indexing.ts';
import { mount as mountProjectFileRoutes } from './routes/project-files.ts';
import { mount as mountTurnChangeRoutes } from './routes/turn-changes.ts';
import { mount as mountTerminalRoutes } from './routes/terminal.ts';
import { mount as mountMcpRoutes } from './routes/mcp.ts';
import { createMcpHttpService } from './mcp-http-service.ts';
import { runShutdownCleanup } from './shutdown-cleanup.ts';
import { mount as mountAgentSessionsRoutes } from './routes/agent-sessions.ts';
import { mount as mountAgentPreferencesRoutes } from './routes/agent-preferences.ts';
import { mount as mountAgentPersonaRoutes } from './routes/agent-persona.ts';
import { createRendererOriginPolicy } from './middleware/renderer-origin.ts';
import { mount as mountAccountRoutes } from './routes/account.ts';
import { BUILT_IN_AGENT_ADAPTERS } from './agent-adapters.ts';
import {
  cancelAgentRuntimeInstalls,
  connectInstalledAgentMcpOnStartup,
} from './agent-runtime-installer.ts';
import { createClientErrorHandler } from './client-error.ts';
import { stopOpenCodeRuntime } from './opencode-runtime.ts';
import { cancelAllGitHubImports } from './github-import.ts';

const log = logger('server');


// Compatibility adapters preserve the established Claude SDK and Codex
// app-server behaviour behind one panel contract.  Their native protocols
// stay in their bridge modules; new renderer code should use the contract.
for (const adapter of BUILT_IN_AGENT_ADAPTERS) registerAgentAdapter(adapter);

// Converters push their derived notes straight into the index on
// completion — there is no fs-watcher intermediary anymore. Wired here
// (not inside conversion.ts) to avoid a conversion ↔ state module cycle.
setDerivedNoteIndexer(async (sourceAbs, derivedAbs) => {
  // Derived text lives in app data; index it UNDER the source
  // PDF/image/DOCX path so folder-scoped search finds it. MFS owns the
  // accepted projection's content identity and unchanged decision.
  const derivedContent = fs.readFileSync(derivedAbs, 'utf8');
  const result = await indexer.upsertConvertedFile(
    filesystemPath.absolute(sourceAbs),
    derivedContent,
    path.extname(derivedAbs),
  );
  noteTreeChanged();
  return result;
});

function parsePortArg(argv: string[], fallback: number): number {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--port=')) return Number(a.slice(7)) || fallback;
    if (a === '--port') return Number(argv[i + 1]) || fallback;
  }
  return fallback;
}
const PORT = parsePortArg(process.argv.slice(2), 8090);
const SERVER_PROTOCOL_VERSION = 1;
const VITE_PORT = Number(process.env.VITE_PORT ?? 5173);
// In dev mode the React app is served by Vite (HMR, fast refresh) but
// Electron still loads :8090 — so we proxy non-API requests through.
// Keeps the single-port story and avoids teaching Electron about Vite.
const DEV_VITE = process.env.STASHBASE_DEV_VITE === '1';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = process.env.STASHBASE_APP_ROOT
  ? path.resolve(process.env.STASHBASE_APP_ROOT)
  : path.resolve(__dirname, '..');
const RESOURCES_ROOT = process.env.STASHBASE_RESOURCES_PATH
  ? path.resolve(process.env.STASHBASE_RESOURCES_PATH)
  : APP_ROOT;
const WEB_BUILD_DIR = path.resolve(APP_ROOT, 'dist', 'renderer');
const PDFJS_DIST_DIR = path.resolve(APP_ROOT, 'node_modules', 'pdfjs-dist');

// Establish the default folder home without adding projects or source files.
// Unavailable folders retain their durable project registration.
ensureFolderHome();
// NB: the daemon is NOT spawned here — `bootBindAllFolders` runs from the
// `listen` success callback below, i.e. only AFTER we win the `:8090`
// arbiter. That way the loser of a startup race never spawns a daemon
// (no race orphan), and the winner reaps pre-existing orphans before
// spawning its own MFS owner.

const app = express();
const mcpHttpService = createMcpHttpService({ webPort: PORT });
app.use(express.json({ limit: '10mb' }));
app.use(withWindowContext);

// ----- security middleware ------------------------------------------------
//
// The server binds to 127.0.0.1 so it isn't reachable from the LAN, but a
// malicious webpage opened in the user's browser could still try to fetch
// our routes via DNS rebinding or cross-origin script injection. Two
// belt-and-suspenders defenses below:
//   1. `Content-Security-Policy` — limit what the renderer can load /
//      execute. Tighter in production; dev needs unsafe-eval for React
//      Refresh and unsafe-inline for Vite's HMR shim.
//   2. Origin check — reject requests whose `Origin` header points
//      anywhere other than our own localhost URL. Missing-Origin is
//      allowed because Electron's top-level navigation, the MCP server,
//      and `curl` all omit the header — none of which are exploitable
//      from a webpage.

const ALLOWED_ORIGINS = new Set([
  'app://renderer',
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
]);

const CSP_PROD =
  "default-src 'self'; " +
  // 'unsafe-inline' is needed for the scroll-bootstrap script injected by
  // addScrollBootstrap and for bundler-format HTML loaders (user-uploaded
  // self-contained apps). blob: lets those loaders load their own assets
  // via <script src="blob:…"> ('self' does NOT match blob: for script-src).
  // The iframe sandbox is the primary security boundary; CSP here is
  // belt-and-suspenders for the main renderer.
  "script-src 'self' 'unsafe-inline' blob:; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; " +
  "font-src 'self' data:; " +
  // blob: needed so bundler-format HTML can fetch() their own blob: URLs
  // (text/babel scripts are inlined via fetch before Babel transforms them).
  "connect-src 'self' blob:; " +
  "frame-src 'self' blob: about:; " +
  "worker-src 'self' blob:; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "form-action 'none';";

const CSP_DEV =
  // Same as prod but allow eval for React Refresh / Vite HMR shim and
  // WebSocket connect-src for HMR. Dev bundle never ships to users.
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; " +
  "font-src 'self' data:; " +
  "connect-src 'self' blob: ws: wss:; " +
  "frame-src 'self' blob: about:; " +
  "worker-src 'self' blob:; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "form-action 'none';";

app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', DEV_VITE ? CSP_DEV : CSP_PROD);
  // Belt-and-suspenders defaults that don't change per request.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(createRendererOriginPolicy(ALLOWED_ORIGINS));

// pdf.js fetches CMaps, fallback fonts, and WASM by URL at render time.
// Serve the bundled package assets from the app server so dev, packaged,
// and Electron CSP all use the same same-origin resource path.
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
  app.use(
    `/pdfjs-assets/${dir}`,
    express.static(path.join(PDFJS_DIST_DIR, dir), { fallthrough: false, redirect: false }),
  );
}

// Cheap identity probe for Electron's startup arbiter. A random process
// can be listening on :8090 and even answer `/api/folder`; the main
// process should only reuse a server that explicitly identifies itself
// as StashBase.
app.get('/api/health', (_req, res) => {
  res.json({
    app: 'stashbase',
    ok: true,
    protocolVersion: SERVER_PROTOCOL_VERSION,
    appRoot: APP_ROOT,
    resourcesPath: RESOURCES_ROOT,
    pid: process.pid,
    instanceId: process.env.STASHBASE_SERVER_INSTANCE_ID,
  });
});

mountInternalShutdownRoute(app, {
  token: process.env.STASHBASE_SHUTDOWN_TOKEN ?? '',
  shutdown: () => { void shutdown('Electron request'); },
});

// Static layer is mounted before the API routes for renderer bundle
// requests, but data routes must bypass it entirely. In packaged asar
// builds, serve-static can still issue directory-normalisation redirects
// before "falling through"; API and asset paths must reach their route handlers as-is.
if (!DEV_VITE) {
  if (fs.existsSync(path.join(WEB_BUILD_DIR, 'index.html'))) {
    const webStatic = express.static(WEB_BUILD_DIR, { redirect: false });
    app.use((req, res, next) => {
      if (
        req.path === '/api' ||
        req.path.startsWith('/api/') ||
        req.path === '/asset' ||
        req.path.startsWith('/asset/') ||
        req.path === '/asset-derived' ||
        req.path.startsWith('/asset-derived/') ||
        req.path === '/mcp'
      ) {
        return next();
      }
      return webStatic(req, res, next);
    });
  } else {
    throw new Error(
      `dist/renderer/index.html not found. Run \`pnpm build:web\` first.`,
    );
  }
}

// Folder/project routes include Welcome-screen operations that must work
// before a window has an open folder, so mount them before the gate.
mountWindowContextRoutes(app);
mountProjectRoutes(app);
// Gallery browsing works before any folder is open too.
mountGalleryRoutes(app);

// Route-prefix gate: every API path under these roots needs an open
// folder. Centralises the NO_FOLDER 412 response so individual handlers
// don't have to call `requireCurrentFolder()` and the search route
// (which bypasses the files layer) can't silently run against a
// previously-bound folder.
app.use([
  '/api/files',
  '/api/file-operations',
  '/api/file-preview',
  '/api/folders',
  '/api/search',
  '/api/rename-preview',
  '/api/reveal',
  '/asset',
  '/asset-derived',
], requireFolder);

// ----- mount routes -------------------------------------------------------
mountAppearanceRoutes(app);
mountTelemetryRoutes(app);
mountWorkspacePreferenceRoutes(app);
mountUpdateRoutes(app);
mountAccountRoutes(app, {
  appReturnToken: process.env.STASHBASE_OAUTH_RETURN_TOKEN ?? '',
});
mountEmbedderRoutes(app);
mountLocalComponentRoutes(app);
// Register exact `/api/files/prepare` and `/api/files/reprocess` endpoints
// before the generic file-content wildcard routes.
mountIndexingRoutes(app);
mountFileOperationReceipts(app);
mountFilesRoutes(app);
mountFoldersRoutes(app);
mountUploadRoutes(app);
mountAttachRoutes(app);
mountProjectFileRoutes(app);
mountTurnChangeRoutes(app);
mountTerminalRoutes(app);
mountMcpRoutes(app, mcpHttpService);
mcpHttpService.mountLoopback(app); // local POST /mcp; Docker listener is opt-in and MCP-only
mountAgentSessionsRoutes(app); // shared contract history surface for the built-in panel
mountAgentPersonaRoutes(app);
mountAgentPreferencesRoutes(app); // global + explicit member-folder Chat guidance

// Renderer error sink. The root `ErrorBoundary` POSTs render-time
// exceptions here so they appear in the same server log developers
// already monitor (next to fs / sync warnings) — no need to open
// devtools to see why the user's session blanked.
const clientErrLog = log;
app.post('/api/log/client-error', createClientErrorHandler(clientErrLog));

// Dev-only fallthrough: any request that didn't match an `/api/*` or
// `/asset/*` route gets proxied to Vite. Must be the LAST middleware
// or it'll swallow API routes registered after it. WebSocket upgrade
// (for HMR) is wired below at `server.on('upgrade', ...)`.
const viteProxy = DEV_VITE
  ? createProxyMiddleware({
      target: `http://localhost:${VITE_PORT}`,
      changeOrigin: true,
      // Socket upgrades are dispatched explicitly below; do not let the
      // proxy attach a second, unfiltered upgrade listener after an HTTP read.
      logger: undefined,
    })
  : null;
if (viteProxy) app.use(viteProxy);

const server = app.listen(PORT, '127.0.0.1', () => {
  try { ensureMcpLauncher(); }
  catch (err: unknown) { log.warn(`MCP launcher refresh failed: ${err instanceof Error ? err.message : String(err)}`); }
  log.info(`listening on http://127.0.0.1:${PORT}`);
  void resumeExtractorDownload().catch((error) => log.warn(`component recovery failed: ${String(error)}`));
  void mcpHttpService.start().catch((err: unknown) => {
    log.warn(`MCP HTTP startup failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  void connectInstalledAgentMcpOnStartup().then((results) => {
    for (const { id, status } of results) {
      if (status.phase === 'ready') log.info(`connected StashBase MCP for installed ${id} runtime`);
      else if (status.phase === 'failed') log.warn(`could not connect StashBase MCP for ${id}: ${status.failure?.message ?? 'unknown error'}`);
    }
  }).catch((error) => log.warn(`Agent startup check failed: ${String(error)}`));
  if (DEV_VITE) log.info(`dev-proxy → vite at http://localhost:${VITE_PORT}`);
  // We own :8090 now → we're THE server. Reap any orphan daemon left by a
  // previous server that died hard (kill -9 / crash / lost the startup
  // race) BEFORE spawning ours, so it can acquire the MFS store cleanly.
  try { reapOrphanDaemons(); } catch (err: unknown) {
    log.warn(`reap orphan daemons failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Configure the daemon and bind registered folders in the background so
  // each namespace is ready when a window selects it. Boot reconciles nothing:
  // a folder reconciles when a window opens it, so a long recent-folder list
  // never queues every registered folder ahead of the one the user is in.
  Promise.resolve()
    .then(() => bootBindAllFolders())
    .catch((err) =>
      log.warn(`boot project bind failed: ${err?.message ?? err}`),
    );
  log.info('waiting for the user to pick a folder');
});

// Surface common bind failures (port collision, permission denied) with
// a clean message + exit code 1 instead of an unhandled `Error: listen
// EADDRINUSE` stack trace, which Electron presents as "server quit
// unexpectedly" with no useful context.
//
// Before giving up on EADDRINUSE, try once to reclaim the port from an
// orphaned sibling server — the leftover of an Electron owner that died
// without completing its kill ladder. A wedged orphan never answers
// `/api/health` and ignores SIGTERM, so without this the app cannot launch
// at all until the user hand-kills the process. Only a verified sibling
// (same entry file, parent gone) is reclaimed; anything else falls through
// to the existing guidance.
let portReclaimAttempted = false;
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE' && !portReclaimAttempted) {
    portReclaimAttempted = true;
    let reclaimed = 0;
    try {
      reclaimed = reclaimStaleServerPort(PORT, fileURLToPath(import.meta.url));
    } catch (reclaimErr: unknown) {
      log.warn(`stale server reclaim failed: ${reclaimErr instanceof Error ? reclaimErr.message : String(reclaimErr)}`);
    }
    if (reclaimed > 0) {
      log.warn(`reclaimed port ${PORT} from ${reclaimed} orphaned server(s) — retrying bind`);
      // SIGKILL frees a LISTEN socket immediately; the delay just gives the
      // kernel a beat. The original `app.listen` callback is still pending
      // on 'listening', so a successful rebind boots normally.
      setTimeout(() => server.listen(PORT, '127.0.0.1'), 400);
      return;
    }
  }
  if (err.code === 'EADDRINUSE') {
    log.warn(`port ${PORT} is already in use — is another StashBase running? Quit it (or pass --port=N to use a different port).`);
  } else if (err.code === 'EACCES') {
    log.warn(`permission denied binding to port ${PORT} — pick a port above 1024.`);
  } else {
    log.warn(`server error: ${err.message}`);
  }
  process.exit(1);
});

// WebSocket bridges for the structured chat panel. `noServer: true`
// because we share the existing http.Server with Vite's HMR proxy.
const agentWss = new WebSocketServer({ noServer: true });
agentWss.on('connection', (ws, req) => {
  // Reject missing or unregistered projects before starting a runtime.
  const resolved = resolveAgentSessionScope(rawScopeOf(req), rawFolderOf(req), registeredFolderRoots());
  if (!resolved.ok) {
    ws.send(JSON.stringify({ t: 'error', message: 'That folder is not a registered project.' }));
    ws.close();
    return;
  }
  const scope = resolved.scope;
  attachAgentRuntime(agentIdOf(req), ws, {
    ...connectionOptionsOf(req),
    folder: scope.path,
  });
});

function agentIdOf(req: import('node:http').IncomingMessage): string {
  try {
    const u = new URL(req.url ?? '', `http://${req.headers.host ?? '127.0.0.1'}`);
    return u.searchParams.get('agent') || 'claude';
  } catch {
    return 'claude';
  }
}

function connectionOptionsOf(req: import('node:http').IncomingMessage): AgentConnectionOptions {
  return { windowId: windowIdOf(req), effort: effortOf(req), resume: resumeOf(req), access: accessOf(req), model: modelOf(req) };
}

/** Model ids are opaque native identifiers. Keep only a small URL safety bound;
 * each adapter validates membership in its freshly discovered catalog. */
function modelOf(req: import('node:http').IncomingMessage): string | undefined {
  try {
    const value = new URL(req.url ?? '', `http://${req.headers.host ?? '127.0.0.1'}`).searchParams.get('model')?.trim();
    return value && value.length <= 200 ? value : undefined;
  } catch { return undefined; }
}

/** Raw explicit-folder request off the WS URL. Membership validation happens
 *  in the connection handler via `resolveAgentSessionScope`. */
function rawFolderOf(req: import('node:http').IncomingMessage): string | undefined {
  try {
    const u = new URL(req.url ?? '', `http://${req.headers.host ?? '127.0.0.1'}`);
    return u.searchParams.get('folder') ?? undefined;
  } catch {
    return undefined;
  }
}

/** Reject retired or unsupported scope selectors at the connection boundary. */
function rawScopeOf(req: import('node:http').IncomingMessage): string | undefined {
  try {
    const u = new URL(req.url ?? '', `http://${req.headers.host ?? '127.0.0.1'}`);
    return u.searchParams.get('scope') ?? undefined;
  } catch {
    return undefined;
  }
}

function windowIdOf(req: import('node:http').IncomingMessage): string {
  const value = req.headers['x-stashbase-window-id'];
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === 'string' && candidate.trim()
    ? candidate.trim().slice(0, 128)
    : 'default';
}

/** Read the agent session's thinking effort off the WS URL. Effort is
 *  fixed per session (no live SDK setter), so the renderer encodes it in
 *  the connect URL and reconnects to change it. */
function effortOf(req: import('node:http').IncomingMessage): string | undefined {
  try {
    const u = new URL(req.url ?? '', `http://${req.headers.host ?? '127.0.0.1'}`);
    return parseAgentEffort(u.searchParams.get('effort'));
  } catch {
    return undefined;
  }
}

/** Read the Agent access mode off the WS URL. Claude applies it live after
 *  connect; Codex consumes it when the app-server thread starts. */
function accessOf(req: import('node:http').IncomingMessage): AgentAccessMode | undefined {
  try {
    const u = new URL(req.url ?? '', `http://${req.headers.host ?? '127.0.0.1'}`);
    const access = u.searchParams.get('access');
    return isAgentAccessMode(access) ? access : undefined;
  } catch {
    return undefined;
  }
}

/** Read a session id to resume off the WS URL. Set by the history
 *  dropdown when the user opens a past session; the SDK then appends to
 *  that session rather than starting a fresh one. */
function resumeOf(req: import('node:http').IncomingMessage): string | undefined {
  try {
    const u = new URL(req.url ?? '', `http://${req.headers.host ?? '127.0.0.1'}`);
    const id = u.searchParams.get('resume');
    return id && id.trim() ? id.trim() : undefined;
  } catch {
    return undefined;
  }
}

// Sessions stay with their project across navigation. Close, project removal,
// and shutdown retire them through their owning runtime.
onClose((_oldRoot, windowId) => {
  stopAgentRuntime('claude', windowId);
  stopAgentRuntime('codex', windowId);
  stopAgentRuntime('stashbase', windowId);
});
server.on('upgrade', createWebSocketUpgradeHandler({
  allowedOrigins: ALLOWED_ORIGINS,
  agentUpgrade: (request, socket, head) => {
    agentWss.handleUpgrade(request, socket, head, (ws) => {
      agentWss.emit('connection', ws, request);
    });
  },
  // Node exposes the upgrade socket as Duplex; the proxy types its runtime
  // Socket subclass more narrowly. Both handlers receive the same socket.
  ...(viteProxy ? { viteUpgrade: viteProxy.upgrade as unknown as WebSocketUpgrade } : {}),
}));

// ----- graceful shutdown --------------------------------------------------
//
// Without this, SIGTERM (Electron `will-quit`) leaves the Python daemon
// orphaned still holding the MFS store lease — the next launch then
// fails to open the same store. Active extractors are cancelled before state.db
// closes so transient conversion exits can clear in-flight state. Run the close
// ladder once, with a hard ceiling so a stuck close can't keep us pinned.

let shuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  telemetry.close();
  log.info(`shutdown: ${reason}`);
  // Stop accepting new connections immediately; in-flight ones drain.
  try { server.close(); } catch { /* already gone */ }
  try { stopAgentRuntime('claude'); } catch { /* swallow */ }
  try { stopAgentRuntime('codex'); } catch { /* swallow */ }
  try { stopAgentRuntime('stashbase'); } catch { /* swallow */ }
  // Hard ceiling: conversion cancellation may spend up to 2.5 s waiting for
  // extractor process groups to exit, and the daemon close ladder can spend
  // another ~3.5 s. Exit anyway if either side wedges.
  const exitTimer = setTimeout(() => process.exit(0), 6500);
  try {
    await runShutdownCleanup({
      closeMcp: () => mcpHttpService.close(),
      cancelAgentInstalls: cancelAgentRuntimeInstalls,
      closeBundledAgent: async () => { await Promise.all([stopOpenCodeRuntime(), closeAgentProcesses()]); },
      cancelGitHubImports: cancelAllGitHubImports,
      cancelConversions: async () => {
        const cancelled = await cancelAllConversions();
        await closeExtractorRuntime();
        return cancelled;
      },
      closeStateDb,
      closeIndexer: () => indexer.close(),
      onCancelled: (cancelled) => {
        if (cancelled.length) log.info(`shutdown: cancelled ${cancelled.length} conversion(s)`);
      },
      onAgentInstallsCancelled: (cancelled) => {
        if (cancelled.length) log.info(`shutdown: cancelled ${cancelled.length} Agent install(s)`);
      },
      onGitHubImportsCancelled: (cancelled) => {
        if (cancelled > 0) log.info(`shutdown: cancelled ${cancelled} GitHub import(s)`);
      },
      onError: (step, err) => {
        log.warn(`shutdown: ${step} cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      },
    });
  } finally {
    clearTimeout(exitTimer);
    process.exit(0);
  }
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGHUP', () => { void shutdown('SIGHUP'); });

// An Electron-owned server must not outlive its owner. The `will-quit` kill
// ladder lives in the parent, so it protects nothing when Electron itself
// dies uncleanly — the orphan then keeps the daemon, the MFS store lease, and
// the port. The shutdown token env is the "Electron owns me" marker; a
// standalone `node server` run stays exempt.
if (process.env.STASHBASE_SHUTDOWN_TOKEN) {
  startParentWatchdog({
    onOrphaned: () => {
      log.warn('parent process is gone — shutting down orphaned server');
      void shutdown('parent exited');
    },
  });
}
