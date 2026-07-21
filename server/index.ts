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
import {
  attachAgentRuntime,
  isAgentAccessMode,
  registerAgentAdapter,
  stopAgentRuntime,
  type AgentAccessMode,
  type AgentConnectionOptions,
} from './agent-contract.ts';
import { onClose, onSwitch, ensureFolderHome } from './folder.ts';
import { filesystemPath } from './filesystem-path.ts';
import { getApiKey, migrateLegacyEmbedderConfig } from './app-config.ts';
import { bootBindAllFolders, reconcileLibraryFolders } from './state.ts';
import { reapOrphanDaemons } from './stale-lock.ts';
import { logger } from './log.ts';
import { cancelAllConversions, setDerivedNoteIndexer } from './conversion.ts';
import { cancelAllTranscriptionModelDownloads } from './transcription-models.ts';
import {
  initializeTranscriptionRuntime,
  recoverTranscriptionRuntimeAfterServerBind,
} from './transcription-runtime.ts';
import { noteTreeChanged } from './watcher.ts';
import { indexer } from './state.ts';
import { closeStateDb } from './state-db.ts';
import { requireFolder, withWindowContext } from './http.ts';
import { mount as mountLibraryRoutes } from './routes/library.ts';
import { mount as mountEmbedderRoutes } from './routes/embedder.ts';
import { mount as mountTranscriptionRoutes } from './routes/transcription.ts';
import { mount as mountFilesRoutes } from './routes/files.ts';
import { mount as mountFoldersRoutes } from './routes/folders.ts';
import { mount as mountUploadRoutes } from './routes/upload.ts';
import { mount as mountAttachRoutes } from './routes/attach.ts';
import { mount as mountIndexingRoutes } from './routes/indexing.ts';
import { mount as mountLibraryFileRoutes } from './routes/library-files.ts';
import { mount as mountTerminalRoutes } from './routes/terminal.ts';
import { mount as mountMcpRoutes } from './routes/mcp.ts';
import { createMcpHttpService } from './mcp-http-service.ts';
import { runShutdownCleanup } from './shutdown-cleanup.ts';
import { blake3File } from './file-hash.ts';
import { mount as mountSessionsRoutes } from './routes/sessions.ts';
import { mount as mountCodexSessionsRoutes } from './routes/codex-sessions.ts';
import { mount as mountAgentSessionsRoutes } from './routes/agent-sessions.ts';
import { BUILT_IN_AGENT_ADAPTERS } from './agent-adapters.ts';

const log = logger('server');

initializeTranscriptionRuntime();

// Compatibility adapters preserve the established Claude SDK and Codex
// app-server behaviour behind one panel contract.  Their native protocols
// stay in their bridge modules; new renderer code should use the contract.
for (const adapter of BUILT_IN_AGENT_ADAPTERS) registerAgentAdapter(adapter);

// Converters push their derived notes straight into the index on
// completion — there is no fs-watcher intermediary anymore. Wired here
// (not inside conversion.ts) to avoid a conversion ↔ state module cycle.
setDerivedNoteIndexer(async (sourceAbs, derivedAbs, boundSourceHash) => {
  if (!getApiKey()) return;
  // Derived text lives in app data; index it UNDER the source
  // PDF/image/DOCX path so folder-scoped search finds it. Stamp the SOURCE's
  // byte hash so the daemon's scan_diff (which hashes the source file) sees
  // it as unchanged rather than re-converting in a loop.
  const derivedContent = fs.readFileSync(derivedAbs, 'utf8');
  let sourceHash = boundSourceHash;
  if (!sourceHash) {
    const beforeHash = fs.statSync(sourceAbs);
    sourceHash = await blake3File(sourceAbs);
    const afterHash = fs.statSync(sourceAbs);
    if (beforeHash.size !== afterHash.size || beforeHash.mtimeMs !== afterHash.mtimeMs) {
      throw new Error(`source changed while hashing converted content: ${sourceAbs}`);
    }
  }
  await indexer.upsertConvertedFile(filesystemPath.absolute(sourceAbs), derivedContent, sourceHash, path.extname(derivedAbs));
  noteTreeChanged();
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
const WEB_BUILD_DIR = path.resolve(APP_ROOT, 'web', 'dist-app');
const PDFJS_DIST_DIR = path.resolve(APP_ROOT, 'node_modules', 'pdfjs-dist');

// One-time migration from the old global-provider schema. Idempotent.
migrateLegacyEmbedderConfig();
// Ensure the default folder home exists and seed the built-in manual, and
// prune any stale recent entries. There is no first-run picker — the home
// is a fixed path, always ready.
ensureFolderHome();
// NB: the daemon is NOT spawned here — `bootBindAllFolders` runs from the
// `listen` success callback below, i.e. only AFTER we win the `:8090`
// arbiter. That way the loser of a startup race never spawns a daemon
// (no race orphan), and the winner reaps pre-existing orphans before
// spawning its own (clean Milvus lock).

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

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next(); // Electron loadURL / MCP / curl have none.
  if (ALLOWED_ORIGINS.has(origin)) return next();
  res.status(403).json({ error: 'cross-origin request rejected', code: 'BAD_ORIGIN' });
});

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
  });
});

// Static layer is mounted before the API routes for renderer bundle
// requests, but data routes must bypass it entirely. In packaged asar
// builds, serve-static can still issue directory-normalisation redirects
// before "falling through"; `/api/*`, `/asset/*`, and the dedicated audio
// preview asset prefix must always reach the route handlers below as-is.
if (!DEV_VITE) {
  if (fs.existsSync(path.join(WEB_BUILD_DIR, 'index.html'))) {
    const webStatic = express.static(WEB_BUILD_DIR, { redirect: false });
    app.use((req, res, next) => {
      if (
        req.path === '/api' ||
        req.path.startsWith('/api/') ||
        req.path === '/asset' ||
        req.path.startsWith('/asset/') ||
        req.path === '/asset-audio-preview' ||
        req.path.startsWith('/asset-audio-preview/') ||
        req.path === '/mcp'
      ) {
        return next();
      }
      return webStatic(req, res, next);
    });
  } else {
    throw new Error(
      `web/dist-app/index.html not found. Run \`pnpm build:web\` first.`,
    );
  }
}

// Folder/library routes include Welcome-screen operations that must work
// before a window has an open folder, so mount them before the gate.
mountLibraryRoutes(app);

// Route-prefix gate: every API path under these roots needs an open
// folder. Centralises the NO_FOLDER 412 response so individual handlers
// don't have to call `requireCurrentFolder()` and the search route
// (which bypasses the files layer) can't silently run against a
// previously-bound folder.
app.use([
  '/api/files',
  '/api/folders',
  '/api/search',
  '/api/rename-preview',
  '/api/file-order',
  '/api/reveal',
  '/asset',
  '/asset-audio-preview',
  '/api/audio',
], requireFolder);

// ----- mount routes -------------------------------------------------------
mountEmbedderRoutes(app);
mountTranscriptionRoutes(app);
// Register exact `/api/files/prepare` and `/api/files/reprocess` endpoints
// before the generic file-content wildcard routes.
mountIndexingRoutes(app);
mountFilesRoutes(app);
mountFoldersRoutes(app);
mountUploadRoutes(app);
mountAttachRoutes(app);
mountLibraryFileRoutes(app);
mountTerminalRoutes(app);
mountMcpRoutes(app, mcpHttpService);
mcpHttpService.mountLoopback(app); // local POST /mcp; Docker listener is opt-in and MCP-only
mountSessionsRoutes(app); // global (no requireFolder) — lists all local sessions
mountCodexSessionsRoutes(app); // global (no requireFolder) — filters to current folder when open
mountAgentSessionsRoutes(app); // shared contract history surface for the built-in panel

// Renderer error sink. The root `ErrorBoundary` POSTs render-time
// exceptions here so they appear in the same server log developers
// already monitor (next to fs / sync warnings) — no need to open
// devtools to see why the user's session blanked.
const clientErrLog = log;
app.post('/api/log/client-error', (req, res) => {
  const b = req.body ?? {};
  const message = typeof b.message === 'string' ? b.message : '(no message)';
  const at = typeof b.at === 'string' ? b.at : new Date().toISOString();
  const stack = typeof b.stack === 'string' ? b.stack : '';
  const componentStack = typeof b.componentStack === 'string' ? b.componentStack : '';
  const url = typeof b.url === 'string' ? b.url : '';
  clientErrLog.warn(
    `client render error @ ${at} (${url}): ${message}` +
      (stack ? `\n${stack}` : '') +
      (componentStack ? `\nComponent stack:${componentStack}` : ''),
  );
  res.json({ ok: true });
});

// Dev-only fallthrough: any request that didn't match an `/api/*` or
// `/asset/*` route gets proxied to Vite. Must be the LAST middleware
// or it'll swallow API routes registered after it. WebSocket upgrade
// (for HMR) is wired below at `server.on('upgrade', ...)`.
const viteProxy = DEV_VITE
  ? createProxyMiddleware({
      target: `http://localhost:${VITE_PORT}`,
      changeOrigin: true,
      ws: true,
      logger: undefined,
    })
  : null;
if (viteProxy) app.use(viteProxy);

const server = app.listen(PORT, '127.0.0.1', () => {
  log.info(`listening on http://127.0.0.1:${PORT}`);
  try {
    const recovered = recoverTranscriptionRuntimeAfterServerBind();
    if (recovered.modelDownloads.length || recovered.audioPreviews.length) {
      log.info(
        `reclaimed transcription crash residue: ${recovered.modelDownloads.length} model download(s), `
        + `${recovered.audioPreviews.length} audio preview(s)`,
      );
    }
  } catch (err: unknown) {
    log.warn(`transcription crash recovery failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  void mcpHttpService.start().catch((err: unknown) => {
    log.warn(`MCP HTTP startup failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  if (DEV_VITE) log.info(`dev-proxy → vite at http://localhost:${VITE_PORT}`);
  // We own :8090 now → we're THE server. Reap any orphan daemon left by a
  // previous server that died hard (kill -9 / crash / lost the startup
  // race) BEFORE spawning ours, so it gets a clean Milvus lock instead of
  // fighting an orphan and black-holing writes.
  try { reapOrphanDaemons(); } catch (err: unknown) {
    log.warn(`reap orphan daemons failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // NB: the built-in manual is seeded inside `ensureFolderHome` (called at
  // module load above), so by the time we bind here the seeded folder is
  // already on disk and gets picked up. Configure the daemon + bind every
  // known folder so MCP / cross-folder search works without waiting for the
  // user to open one. Background.
  bootBindAllFolders()
    .then(() => reconcileLibraryFolders('app boot'))
    .catch((err) =>
      log.warn(`boot library bind/reconcile failed: ${err?.message ?? err}`),
    );
  log.info('waiting for the user to pick a folder');
});

// Surface common bind failures (port collision, permission denied) with
// a clean message + exit code 1 instead of an unhandled `Error: listen
// EADDRINUSE` stack trace, which Electron presents as "server quit
// unexpectedly" with no useful context.
server.on('error', (err: NodeJS.ErrnoException) => {
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
  attachAgentRuntime(agentIdOf(req), ws, connectionOptionsOf(req));
});

function agentIdOf(req: import('node:http').IncomingMessage): string {
  try {
    const u = new URL(req.url ?? '', `http://${req.headers.host ?? '127.0.0.1'}`);
    return u.searchParams.get('agent') || (u.pathname === '/ws/codex' ? 'codex' : 'claude');
  } catch {
    return 'claude';
  }
}

function connectionOptionsOf(req: import('node:http').IncomingMessage): AgentConnectionOptions {
  return { windowId: windowIdOf(req), effort: effortOf(req), resume: resumeOf(req), access: accessOf(req) };
}

function windowIdOf(req: import('node:http').IncomingMessage): string {
  try {
    const u = new URL(req.url ?? '', `http://${req.headers.host ?? '127.0.0.1'}`);
    return u.searchParams.get('windowId') || 'default';
  } catch {
    return 'default';
  }
}

/** Read the agent session's thinking effort off the WS URL. Effort is
 *  fixed per session (no live SDK setter), so the renderer encodes it in
 *  the connect URL and reconnects to change it. */
function effortOf(req: import('node:http').IncomingMessage): string | undefined {
  try {
    const u = new URL(req.url ?? '', `http://${req.headers.host ?? '127.0.0.1'}`);
    const e = u.searchParams.get('effort');
    return ['low', 'medium', 'high', 'xhigh', 'max'].includes(e ?? '') ? e! : undefined;
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

// Tear the agent session down when the user switches folders — it was
// bound to the old cwd; the renderer reconnects for the new folder when
// the user opens the panel again.
onSwitch((newRoot, windowId) => {
  stopAgentRuntime('claude', windowId);
  stopAgentRuntime('codex', windowId);
});
onClose((_oldRoot, windowId) => {
  stopAgentRuntime('claude', windowId);
  stopAgentRuntime('codex', windowId);
});
// Hook WebSocket upgrades. `/ws/agent` and `/ws/codex` go to our
// structured chat bridges; everything else (Vite HMR in dev) falls
// through to the existing
// proxy upgrade handler.
server.on('upgrade', (req, socket, head) => {
  // Same origin gate as the HTTP middleware — a webpage shouldn't be
  // able to open a WebSocket to our agent bridge any more than it can
  // hit our HTTP routes. Missing Origin is allowed for non-browser
  // tools (browsers always send it on WS upgrade).
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    socket.destroy();
    return;
  }
  const url = req.url ?? '';
  if (url.startsWith('/ws/agent') || url.startsWith('/ws/codex')) {
    agentWss.handleUpgrade(req, socket, head, (ws) => {
      agentWss.emit('connection', ws, req);
    });
    return;
  }
  if (viteProxy && 'upgrade' in viteProxy) {
    // `http.Server` types the upgrade socket as `Duplex` whereas
    // http-proxy-middleware's typed handler expects a `net.Socket`.
    // At runtime they're the same object — cast through unknown.
    (viteProxy.upgrade as unknown as (
      req: import('node:http').IncomingMessage,
      socket: unknown,
      head: Buffer,
    ) => void)(req, socket, head);
  } else {
    socket.destroy();
  }
});

// ----- graceful shutdown --------------------------------------------------
//
// Without this, SIGTERM (Electron `will-quit`) leaves the Python daemon
// orphaned still holding Milvus Lite's flock — the next launch then
// fails to open the same DB. Active extractors are cancelled before state.db
// closes so transient conversion exits can clear in-flight state. Run the close
// ladder once, with a hard ceiling so a stuck close can't keep us pinned.

let shuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`shutdown: ${reason}`);
  // Stop accepting new connections immediately; in-flight ones drain.
  try { server.close(); } catch { /* already gone */ }
  try { stopAgentRuntime('claude'); } catch { /* swallow */ }
  try { stopAgentRuntime('codex'); } catch { /* swallow */ }
  // Hard ceiling: conversion cancellation may spend up to 2.5 s waiting for
  // extractor process groups to exit, and the daemon close ladder can spend
  // another ~3.5 s. Exit anyway if either side wedges.
  const exitTimer = setTimeout(() => process.exit(0), 6500);
  try {
    await runShutdownCleanup({
      closeMcp: () => mcpHttpService.close(),
      cancelModelDownloads: cancelAllTranscriptionModelDownloads,
      cancelConversions: cancelAllConversions,
      closeStateDb,
      closeIndexer: () => indexer.close(),
      onCancelled: (cancelled) => {
        if (cancelled.length) log.info(`shutdown: cancelled ${cancelled.length} conversion(s)`);
      },
      onModelDownloadsCancelled: (cancelled) => {
        if (cancelled.length) log.info(`shutdown: cancelled ${cancelled.length} model download(s)`);
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
