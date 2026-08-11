/**
 * Electron main process for StashBase.
 *
 * Boots the Express server as a child process, waits for :8090 to
 * answer, then opens the window pointed at localhost. Server logs are
 * inherited to this terminal so `tsx watch` rebuilds + diagnostics
 * surface naturally. Quitting the app kills the server.
 *
 * The renderer is sandboxed; all main → renderer surfaces are exposed
 * through the narrow IPC bridge in preload.cjs.
 */

const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {
  createServerArguments,
  createServerChildEnvironment,
  isCompatibleServerHealth,
} = require('./main-probe.cjs');
const { createBugReportService } = require('./bug-report-service.cjs');
const { collectBugReportDiagnostics } = require('./bug-report-diagnostics.cjs');
const { collectRedactedApplicationLog, readApplicationLogTail } = require('./bug-report-log.cjs');
const { captureWindowScreenshot } = require('./bug-report-screenshot.cjs');
const { createBugReportHandoff } = require('./bug-report-handoff.cjs');
const { registerBugReportReviewIpc } = require('./bug-report-review-ipc.cjs');
const { createBugReportReviewWindow } = require('./bug-report-review-window.cjs');
const {
  WINDOW_ID_ARG_PREFIX,
  classifyProtocolLaunch,
  createApplicationMenuTemplate,
  createRendererFlushCoordinator,
  createRendererFlushReadiness,
  createSingleFlight,
  createWindowRegistry,
  focusWindow,
  isOAuthReturnUrl,
  isStashBaseProtocolUrl,
  openOrFocusFolder,
  releaseWindowContextWithRetry,
  shouldQuitAfterLastWindow,
  windowLifecycleShortcutAction,
} = require('./multi-window.cjs');

function parsePortArg(argv, fallback) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--port=')) return Number(a.slice(7)) || fallback;
    if (a === '--port') return Number(argv[i + 1]) || fallback;
  }
  return fallback;
}
const SERVER_PORT = parsePortArg(process.argv.slice(1), 8090);

function pythonCandidates(root) {
  return process.platform === 'win32'
    ? [
      path.join(root, 'Scripts', 'python.exe'),
      path.join(root, 'bin', 'python'),
    ]
    : [
      path.join(root, 'bin', 'python'),
      path.join(root, 'Scripts', 'python.exe'),
    ];
}

function sidecarExecutable(root, name, opts = {}) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  return opts.direct ? path.join(root, exe) : path.join(root, name, exe);
}

function statIsFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

let serverLogPath = null;

function getServerLogPath() {
  if (serverLogPath) return serverLogPath;
  try {
    // Electron chooses the platform-correct application log directory. This
    // must not fall back to a handwritten macOS-only location.
    app.setAppLogsPath();
    const logDir = app.getPath('logs');
    if (typeof logDir !== 'string' || !logDir) return null;
    serverLogPath = path.join(logDir, 'server.log');
    return serverLogPath;
  } catch {
    return null;
  }
}

function appendServerLogHint(message) {
  const logPath = getServerLogPath();
  const tail = logPath ? readApplicationLogTail({ filePath: logPath, maxBytes: 5000 }) : null;
  return tail?.text
    ? `${message}\n\nRecent server log:\n${tail.text}`
    : message;
}

function stopSpawnedServer() {
  const proc = serverProc;
  if (!proc || proc.exitCode != null || proc.signalCode != null) return;
  try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => {
    if (proc.exitCode == null && proc.signalCode == null) {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }, 1500).unref();
}

// Use the IPv4 loopback address explicitly. The server binds to
// 127.0.0.1, and `localhost` may resolve to ::1 first on dual-stack
// systems — pointing the renderer at 127.0.0.1 sidesteps the silent
// "can't connect" race.
const SERVER_HOST = '127.0.0.1';
const SERVER_URL = `http://${SERVER_HOST}:${SERVER_PORT}`;
const SERVER_PROTOCOL_VERSION = 1;
const SERVER_SHUTDOWN_TOKEN = crypto.randomBytes(32).toString('hex');
const OAUTH_RETURN_TOKEN = crypto.randomBytes(32).toString('hex');
const PROJECT_ROOT = app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..');
const SERVER_ENTRY = app.isPackaged
  ? path.join(PROJECT_ROOT, 'dist', 'server', 'index.mjs')
  : path.join(PROJECT_ROOT, 'server', 'index.ts');
const MCP_ENTRY = app.isPackaged
  ? path.join(PROJECT_ROOT, 'dist', 'mcp', 'server.mjs')
  : path.join(PROJECT_ROOT, 'mcp', 'server.ts');
const RESOURCES_ROOT = app.isPackaged ? process.resourcesPath : PROJECT_ROOT;

let serverProc = null;
let serverStartPromise = null;
const mainWindows = new Set();
const bugReportReviewWindows = new Set();
const bugReportReviewDraftBySender = new Map();
const windowRegistry = createWindowRegistry({ platform: process.platform });
const rendererFlush = createRendererFlushCoordinator();
const rendererFlushReadinessByWebContents = new Map();
const approvedWindowCloses = new WeakSet();
const pendingWindowCloses = new WeakSet();
let lastMainWindow = null;
const bugReports = createBugReportService({
  captureScreenshot: async ({ webContentsId }) => {
    const sourceWindow = [...mainWindows].find((win) => (
      isLiveMainWindow(win) && win.webContents.id === webContentsId
    ));
    return sourceWindow ? captureWindowScreenshot(sourceWindow.webContents) : null;
  },
  collectDiagnostics: () => collectBugReportDiagnostics({ app }),
  collectLog: () => {
    const logPath = getServerLogPath();
    return logPath ? collectRedactedApplicationLog({ filePath: logPath }) : null;
  },
});
const bugReportHandoff = createBugReportHandoff({
  baseTemporaryDirectory: path.join(app.getPath('temp'), 'stashbase', 'bug-reports'),
  downloadsDirectory: async () => app.getPath('downloads'),
  openExternal: (url) => shell.openExternal(url),
});
registerBugReportReviewIpc({
  ipcMain,
  bugReports,
  draftIdForSender: (senderWebContentsId) => (
    bugReportReviewDraftBySender.get(senderWebContentsId) ?? null
  ),
  prepareApprovedReport: (snapshot) => bugReportHandoff.prepare(snapshot),
  openPreparedReport: (snapshot) => bugReportHandoff.openGitHub(snapshot),
  savePreparedReport: (snapshot) => bugReportHandoff.saveToDownloads(snapshot),
});

const APP_CONFIG_FILE = path.join(os.homedir(), '.stashbase', 'config.json');

const VIEWABLE_FILE_EXTENSIONS = new Set([
  'md', 'markdown', 'html', 'htm', 'pdf',
  'png', 'jpg', 'jpeg', 'webp', 'docx',
  'mp3', 'wav', 'm4a', 'flac', 'ogg', 'opus', 'aac', 'aiff', 'aif',
  'mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'
]);

function getFileFormat(filePath) {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'].includes(ext)) return 'video';
  return 'audio';
}

const activePreviewGrants = new Map();
const pendingFilesToOpen = [];
const rendererReadyWindows = new Set();

function sendInternalPost(requestPath, bodyObj) {
  return new Promise((resolve) => {
    const bodyStr = JSON.stringify(bodyObj);
    const req = http.request(
      {
        host: SERVER_HOST,
        port: SERVER_PORT,
        path: requestPath,
        method: 'POST',
        headers: {
          'x-stashbase-shutdown-token': SERVER_SHUTDOWN_TOKEN,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
        timeout: 1000,
      },
      (res) => {
        res.resume(); // drain body to free the socket
        resolve({ statusCode: res.statusCode });
      }
    );
    req.on('error', () => resolve({ statusCode: 500 }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ statusCode: 504 });
    });
    req.write(bodyStr);
    req.end();
  });
}

function sendInternalDelete(requestPath) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: SERVER_HOST,
        port: SERVER_PORT,
        path: requestPath,
        method: 'DELETE',
        headers: {
          'x-stashbase-shutdown-token': SERVER_SHUTDOWN_TOKEN,
        },
        timeout: 1000,
      },
      (res) => {
        res.resume(); // drain body to free the socket
        resolve({ statusCode: res.statusCode });
      }
    );
    req.on('error', () => resolve({ statusCode: 500 }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ statusCode: 504 });
    });
    req.end();
  });
}

function getFilePathsFromArgs(argv) {
  const filePaths = [];
  const startIndex = app.isPackaged ? 1 : 2;
  for (let i = startIndex; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('-')) continue;
    if (arg.startsWith(WINDOW_ID_ARG_PREFIX)) continue;
    try {
      const absPath = path.resolve(arg);
      if (fs.existsSync(absPath)) {
        const st = fs.statSync(absPath);
        if (st.isFile()) {
          const ext = path.extname(absPath).toLowerCase().slice(1);
          if (VIEWABLE_FILE_EXTENSIONS.has(ext)) {
            filePaths.push(absPath);
          }
        }
      }
    } catch (err) {
      // Ignore invalid paths
    }
  }
  return filePaths;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function cmdQuote(value) {
  return `"${cmdValue(value).replace(/"/g, '""')}"`;
}

function cmdValue(value) {
  return String(value).replace(/%/g, '%%');
}

function localBin(name) {
  return path.join(PROJECT_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
}

function needsCmdShell(command) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

function mcpWrapperPath() {
  return path.join(
    os.homedir(),
    '.stashbase',
    'bin',
    process.platform === 'win32' ? 'stashbase-mcp.cmd' : 'stashbase-mcp',
  );
}

function readJsonObject(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    console.warn(`[electron] ${file} is not a JSON object; leaving untouched`);
  } catch (err) {
    console.warn(`[electron] couldn't parse ${file}: ${err.message}; leaving untouched`);
  }
  return null;
}

function readAppConfig() {
  const cfg = readJsonObject(APP_CONFIG_FILE);
  return cfg && typeof cfg === 'object' ? cfg : {};
}

function writeAppConfig(cfg) {
  writeFileAtomic(APP_CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

function writeMcpWrapper() {
  const wrapper = mcpWrapperPath();
  const resourcesPath = RESOURCES_ROOT;
  const content = process.platform === 'win32'
    ? [
      '@echo off',
      `set "STASHBASE_APP_ROOT=${cmdValue(PROJECT_ROOT)}"`,
      `set "STASHBASE_RESOURCES_PATH=${cmdValue(resourcesPath)}"`,
      ...(app.isPackaged
        ? [
          'set "ELECTRON_RUN_AS_NODE=1"',
          `${cmdQuote(process.execPath)} ${cmdQuote(MCP_ENTRY)} %*`,
        ]
        : [
          `${cmdQuote(localBin('tsx'))} ${cmdQuote(MCP_ENTRY)} %*`,
        ]),
      '',
    ].join('\r\n')
    : [
      '#!/bin/sh',
      'set -eu',
      `export STASHBASE_APP_ROOT=${shellQuote(PROJECT_ROOT)}`,
      `export STASHBASE_RESOURCES_PATH=${shellQuote(resourcesPath)}`,
      ...(app.isPackaged
        ? [
          'export ELECTRON_RUN_AS_NODE=1',
          `exec ${shellQuote(process.execPath)} ${shellQuote(MCP_ENTRY)} "$@"`,
        ]
        : [
          `exec ${shellQuote(localBin('tsx'))} ${shellQuote(MCP_ENTRY)} "$@"`,
        ]),
      '',
    ].join('\n');
  writeFileAtomic(wrapper, content, { mode: 0o755 });
  return wrapper;
}

function writeFileAtomic(file, content, options = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const nonce = Math.random().toString(36).slice(2);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.${nonce}.tmp`);
  try {
    fs.writeFileSync(tmp, content, options);
    fs.renameSync(tmp, file);
    if (typeof options.mode === 'number') {
      try { fs.chmodSync(file, options.mode); } catch { /* best-effort */ }
    }
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    throw err;
  }
}

/** Spawn the Express server as a child. If something else is already on
 *  the port (e.g. you've got `pnpm dev` running in a terminal), we
 *  skip the spawn and just point the window at it — handy for editing
 *  the server in your editor with tsx-watch hot reload. */
async function startOrReuseServer() {
  const existing = await probeServer(SERVER_PORT, 300);
  if (existing.compatible) {
    console.log(`[electron] reusing existing server at ${SERVER_URL}`);
    return;
  }
  if (existing.occupied) {
    const what = existing.legacyStashBase
      ? 'an older StashBase server'
      : 'another local service';
    throw new Error(
      `Port ${SERVER_PORT} is already in use by ${what}, so this StashBase build cannot start its server.\n` +
      `Quit the other StashBase/app using ${SERVER_URL}, then reopen StashBase.`,
    );
  }
  const serverBin = app.isPackaged
    ? process.execPath
    : localBin('tsx');
  // `watch` mode in dev so server-side edits hot-reload without a full
  // app restart. Packaged builds run the pre-bundled Node entry through
  // Electron's embedded Node runtime. `--port=N` is appended only when
  // overriding the default so the server's argv parser sees the standard
  // CLI flag (matches the `npm start -- --port=...` workflow).
  const portArgs = SERVER_PORT === 8090 ? [] : [`--port=${SERVER_PORT}`];
  const serverArgs = createServerArguments({
    entry: SERVER_ENTRY,
    portArgs,
    packaged: app.isPackaged,
    vite: process.env.STASHBASE_DEV_VITE === '1',
  });
  // In packaged builds the Python sidecar lives under
  // `process.resourcesPath` (electron-builder `extraResources`). In dev
  // tsx finds python via the local venv, so we only override when
  // packaged. Model weights are cached by huggingface_hub under
  // `~/.cache/huggingface/` regardless of dev vs packaged.
  const packagedPythonCandidates = [
    ...pythonCandidates(path.join(RESOURCES_ROOT, 'python', 'runtime')),
    ...pythonCandidates(path.join(RESOURCES_ROOT, 'python', '.venv')),
  ];
  const packagedPython = packagedPythonCandidates.find((candidate) => {
    try { return require('node:fs').existsSync(candidate); } catch { return false; }
  });
  // PyInstaller --onedir lays out the bundle as
  // `sidecar/stashbase-daemon/stashbase-daemon` (outer name = dir,
  // inner name = executable). The --onefile layout used to put the
  // executable directly at `sidecar/stashbase-daemon`, so check both
  // for forward compat with anyone still on the old layout, and stat
  // each candidate as a *file* — spawn-ing the outer directory by
  // mistake yields EACCES with no useful hint.
  const packagedDaemonCandidates = [
    sidecarExecutable(path.join(RESOURCES_ROOT, 'python', 'sidecar'), 'stashbase-daemon'),
    sidecarExecutable(path.join(RESOURCES_ROOT, 'python', 'sidecar'), 'stashbase-daemon', { direct: true }),
  ];
  const packagedDaemon = packagedDaemonCandidates.find((candidate) => {
    return statIsFile(candidate);
  });
  const hasPackagedDaemon = Boolean(packagedDaemon);
  // The PDF / OCR extractors ship as a second PyInstaller --onedir bundle
  // (`sidecar/stashbase-extract/stashbase-extract`) so the packaged app can
  // run them without a Python interpreter — there's no bundled venv. The
  // server (pdf.ts / image.ts) spawns this binary with a `pdf` / `ocr`
  // subcommand when STASHBASE_EXTRACT_BIN is set; in dev it spawns the
  // scripts via the local venv instead.
  const packagedExtractCandidates = [
    sidecarExecutable(path.join(RESOURCES_ROOT, 'python', 'sidecar'), 'stashbase-extract'),
    sidecarExecutable(path.join(RESOURCES_ROOT, 'python', 'sidecar'), 'stashbase-extract', { direct: true }),
  ];
  const packagedExtract = packagedExtractCandidates.find((candidate) => {
    return statIsFile(candidate);
  });
  const hasPackagedExtract = Boolean(packagedExtract);
  const packagedDaemonScript = path.join(RESOURCES_ROOT, 'python', 'stashbase_daemon.py');
  const packagedPdfScript = path.join(RESOURCES_ROOT, 'python', 'pdf_extract.py');
  const packagedOcrScript = path.join(RESOURCES_ROOT, 'python', 'ocr_extract.py');
  if (app.isPackaged) {
    if (!statIsFile(SERVER_ENTRY)) {
      throw new Error(`Packaged server entry is missing: ${SERVER_ENTRY}`);
    }
    if (!hasPackagedDaemon && !(packagedPython && statIsFile(packagedDaemonScript))) {
      throw new Error(
        'Packaged Python daemon is missing. Rebuild with `pnpm build:python-sidecar` and package again.\n' +
        `Looked for: ${packagedDaemonCandidates.join(', ')}\n` +
        `Fallback script: ${packagedDaemonScript}`,
      );
    }
  }
  const packagedEnv = app.isPackaged
    ? {
      ELECTRON_RUN_AS_NODE: '1',
      STASHBASE_APP_ROOT: PROJECT_ROOT,
      STASHBASE_RESOURCES_PATH: RESOURCES_ROOT,
      ...(hasPackagedDaemon ? { STASHBASE_DAEMON_BIN: packagedDaemon } : {}),
      ...(hasPackagedExtract ? { STASHBASE_EXTRACT_BIN: packagedExtract } : {}),
      ...(packagedPython ? { STASHBASE_PYTHON: packagedPython } : {}),
    }
    : { STASHBASE_APP_ROOT: PROJECT_ROOT };
  // In packaged+asar mode PROJECT_ROOT is `.../Resources/app.asar` —
  // a FILE, not a directory. spawn(cwd) hits the OS syscall (no
  // electron asar shim) and bails with ENOTDIR. Use the real
  // Resources/ directory there; in dev keep PROJECT_ROOT (the repo).
  const serverCwd = app.isPackaged ? RESOURCES_ROOT : PROJECT_ROOT;
  // Tee server output to a per-launch log file in ~/Library/Logs/StashBase/
  // so a packaged Dock launch is debuggable, AND to the parent stdio so
  // `pnpm electron` from a terminal still shows live logs. The file is
  // truncated each launch — old crashes would only confuse the user.
  const currentServerLogPath = getServerLogPath();
  let logFd = null;
  if (currentServerLogPath) {
    try {
      fs.mkdirSync(path.dirname(currentServerLogPath), { recursive: true });
      logFd = fs.openSync(currentServerLogPath, 'w');
      fs.writeSync(
        logFd,
        `--- StashBase server launch ${new Date().toISOString()} (pid=${process.pid}, packaged=${app.isPackaged}) ---\n`,
      );
      fs.writeSync(logFd, `server entry: ${SERVER_ENTRY}\n`);
      fs.writeSync(logFd, `server cwd: ${serverCwd}\n`);
      if (app.isPackaged) {
        fs.writeSync(logFd, `resources: ${RESOURCES_ROOT}\n`);
        fs.writeSync(logFd, `daemon: ${packagedDaemon || '(missing; using Python script fallback if available)'}\n`);
        fs.writeSync(logFd, `extractor: ${packagedExtract || '(missing; using Python script fallback if available)'}\n`);
        fs.writeSync(logFd, `python: ${packagedPython || '(missing)'}\n`);
        if (!hasPackagedExtract && !(packagedPython && statIsFile(packagedPdfScript) && statIsFile(packagedOcrScript))) {
          fs.writeSync(
            logFd,
            'warning: packaged extractor resources are missing; PDF/image text extraction will fail until the package is rebuilt\n',
          );
        }
      }
    } catch (err) {
      console.warn(`[electron] application log unavailable: ${err?.message ?? err}`);
      if (logFd !== null) {
        try { fs.closeSync(logFd); } catch { /* nothing left to close */ }
      }
      logFd = null;
    }
  }
  serverProc = spawn(serverBin, serverArgs, {
    cwd: serverCwd,
    // Port flows via the CLI arg above, not the env — keeps the server
    // entry's argv parser the single source of truth for port config.
    env: createServerChildEnvironment({
      baseEnv: process.env,
      packaged: app.isPackaged,
      packagedEnv,
      shutdownToken: SERVER_SHUTDOWN_TOKEN,
      oauthReturnToken: OAUTH_RETURN_TOKEN,
    }),
    // stdin = 'ignore' is intentional: the server never reads from
    // stdin, and inheriting the parent's TTY made Node attach a real
    // TTY ReadStream to the child's fd 0. Any flake on that TTY
    // (shell repaint, tmux/screen detach, Ctrl-Z, terminal closed
    // while the app was still running) emitted an `EIO` on the
    // unread stream which had no listener → unhandled 'error'
    // event, killed the whole electron process. Closing stdin
    // entirely sidesteps the class of bug.
    // Logging is optional: an unavailable log directory must not prevent
    // StashBase from starting. Bug-report collection only reads the
    // Electron-managed file, never an arbitrary renderer-provided path.
    stdio: logFd === null ? ['ignore', 'inherit', 'inherit'] : ['ignore', logFd, logFd],
    shell: needsCmdShell(serverBin),
  });
  if (logFd !== null) {
    try { fs.closeSync(logFd); } catch { /* child owns its duplicate */ }
  }
  // `spawn` can fail asynchronously (ENOENT when tsx isn't installed,
  // permission errors, etc.). Without an explicit listener Node treats
  // the 'error' event as fatal and the whole Electron process crashes
  // with an unhelpful stack — surface a useful message instead.
  let serverSpawnError = null;
  serverProc.on('error', (err) => {
    serverSpawnError = err;
    console.warn(`[electron] server spawn failed: ${err.message}`);
    if (err.code === 'ENOENT') {
      console.warn(`[electron]   couldn't find ${serverBin}. ` +
        `Run \`pnpm install\` to populate node_modules/.bin.`);
    }
  });
  serverProc.on('exit', (code) => {
    serverStartPromise = null;
    if (code != null && code !== 0) {
      console.warn(`[electron] server exited with code ${code}`);
    }
  });
  // Poll until the server is up. Embedding cold-start on first model load
  // call can be slow, but listen() is sub-second — 10s ceiling is
  // generous; we surface a clear error rather than hanging forever.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (serverSpawnError) {
      throw new Error(appendServerLogHint(`server spawn failed: ${serverSpawnError.message}`));
    }
    if ((await probeServer(SERVER_PORT, 200)).compatible) return;
    if (serverProc.exitCode != null || serverProc.signalCode != null) {
      const detail = serverProc.exitCode != null
        ? `server exited with code ${serverProc.exitCode}`
        : `server exited with signal ${serverProc.signalCode}`;
      throw new Error(appendServerLogHint(`${detail} before reporting healthy on :${SERVER_PORT}`));
    }
    await sleep(150);
  }
  stopSpawnedServer();
  throw new Error(appendServerLogHint(`server did not come up on :${SERVER_PORT} within 10s`));
}

/** Coalesce every window onto one server readiness promise. The spawned
 *  server's exit listener clears the latch; a reused development server is
 *  assumed to remain the renderer owner for this Electron session. */
async function ensureServer() {
  if (!serverStartPromise) serverStartPromise = startOrReuseServer();
  const pending = serverStartPromise;
  try {
    await pending;
  } catch (err) {
    // A failed older startup must not clear a newer retry installed after
    // its child process exited.
    if (serverStartPromise === pending) serverStartPromise = null;
    throw err;
  }
}

async function probeServer(port, timeoutMs) {
  const health = await requestJson(port, '/api/health', timeoutMs);
  if (!health.reachable) return { compatible: false, occupied: false, legacyStashBase: false };
  if (
    health.statusCode === 200 &&
    isCompatibleServerHealth(health.body, {
      protocolVersion: SERVER_PROTOCOL_VERSION,
      appRoot: PROJECT_ROOT,
      resourcesPath: RESOURCES_ROOT,
    })
  ) {
    return { compatible: true, occupied: true, legacyStashBase: false };
  }

  const folder = await requestJson(port, '/api/folder', timeoutMs);
  const legacyStashBase =
    folder.statusCode === 200 &&
    folder.body &&
    typeof folder.body === 'object' &&
    ('current' in folder.body || 'recent' in folder.body) &&
    'homeDir' in folder.body;
  return { compatible: false, occupied: true, legacyStashBase };
}

function requestJson(port, requestPath, timeoutMs, options = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: SERVER_HOST,
        port,
        path: requestPath,
        method: options.method || 'GET',
        headers: options.headers,
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (body.length < 4096) body += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ reachable: true, statusCode: res.statusCode ?? 0, body: JSON.parse(body) });
          } catch {
            resolve({ reachable: true, statusCode: res.statusCode ?? 0, body: null });
          }
        });
      },
    );
    req.on('error', () => resolve({ reachable: false, statusCode: 0, body: null }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ reachable: false, statusCode: 0, body: null });
    });
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isHttpUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isAppUrl(rawUrl) {
  try {
    return new URL(rawUrl).origin === new URL(SERVER_URL).origin;
  } catch {
    return false;
  }
}

async function openExternalUnchecked(rawUrl, label = 'external URL') {
  try {
    await shell.openExternal(rawUrl);
    return { ok: true };
  } catch (err) {
    const message = err && typeof err.message === 'string' ? err.message : String(err);
    console.warn(`[electron] failed to open ${label}: ${message}`);
    return { ok: false, error: message };
  }
}

async function openHttpExternal(rawUrl, label = 'external URL') {
  if (typeof rawUrl !== 'string' || !isHttpUrl(rawUrl)) return false;
  const result = await openExternalUnchecked(rawUrl, label);
  return result.ok;
}

function isLiveMainWindow(win) {
  return !!(win && mainWindows.has(win) && !win.isDestroyed());
}

function bugReportSourceForWindow(win) {
  if (!isLiveMainWindow(win)) return null;
  const windowId = windowRegistry.idForWindow(win);
  const webContentsId = win.webContents?.id;
  if (!windowId || !Number.isSafeInteger(webContentsId) || webContentsId <= 0) return null;
  return { windowId, webContentsId };
}

async function showBugReportError(win, message) {
  const options = {
    type: 'error',
    title: 'Report a Bug',
    message,
  };
  try {
    if (isLiveMainWindow(win)) await dialog.showMessageBox(win, options);
    else await dialog.showMessageBox(options);
  } catch {
    // A native error dialog is best effort and must not affect cleanup.
  }
}

async function openBugReportReview(win) {
  const source = bugReportSourceForWindow(win);
  if (!source) {
    await showBugReportError(win, 'StashBase could not start a bug report for this window.');
    return;
  }
  const created = await bugReports.createDraft(source);
  if (!created.ok) {
    await showBugReportError(win, 'StashBase could not start a bug report.');
    return;
  }

  let review;
  try {
    review = createBugReportReviewWindow({
      BrowserWindow,
      preloadPath: path.join(__dirname, 'bug-report-review-preload.cjs'),
      htmlPath: path.join(__dirname, 'bug-report-review.html'),
      sourceWindow: isLiveMainWindow(win) ? win : null,
    });
  } catch {
    bugReports.discardDraft(created.draft.id, source.webContentsId);
    await showBugReportError(win, 'StashBase could not open the bug report review.');
    return;
  }

  const reviewWindow = review.window;
  const reviewWebContentsId = reviewWindow.webContents.id;
  bugReportReviewWindows.add(reviewWindow);
  bugReportReviewDraftBySender.set(reviewWebContentsId, created.draft.id);
  reviewWindow.once('closed', () => {
    bugReportReviewDraftBySender.delete(reviewWebContentsId);
    bugReportReviewWindows.delete(reviewWindow);
    bugReports.discardDraftsForReviewWindow(reviewWebContentsId);
    if (mainWindows.size === 0 && bugReportReviewWindows.size === 0 && shouldQuitAfterLastWindow(process.platform)) {
      app.quit();
    }
  });

  const bound = bugReports.bindReviewWindow(created.draft.id, reviewWebContentsId);
  if (!bound.ok) {
    reviewWindow.destroy();
    bugReports.discardDraft(created.draft.id, source.webContentsId);
    await showBugReportError(win, 'StashBase could not authorize the bug report review.');
    return;
  }

  try {
    await review.loaded;
  } catch {
    if (!reviewWindow.isDestroyed()) reviewWindow.destroy();
    await showBugReportError(win, 'StashBase could not load the bug report review.');
  }
}

// --- Clipboard image offer ---------------------------------------------
// When a main window regains focus we peek at the clipboard: if it holds
// an image we haven't offered yet (e.g. the user just took a screenshot
// with Cmd+Ctrl+Shift+4, which copies to the clipboard, then switched
// back), we ping the renderer to ask "add this to the library?". Reading
// the clipboard is cheap; we hash the PNG bytes so the same image is only
// offered once — dismiss is final until the clipboard content changes.
// Default-on; toggleable from the renderer via `clipboard:setWatch`.
let clipboardWatchEnabled = true;
let lastClipboardOfferHash = null;
const agentComposerFocusedContents = new Set();

function clipboardImageFilename() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `clipboard-${stamp}.png`;
}

function markCurrentClipboardImageHandled() {
  let img;
  try {
    img = clipboard.readImage();
  } catch {
    return false;
  }
  if (!img || img.isEmpty()) return false;
  let png;
  try {
    png = img.toPNG();
  } catch {
    return false;
  }
  if (!png || !png.length) return false;
  lastClipboardOfferHash = crypto.createHash('sha1').update(png).digest('hex');
  return true;
}

function offerClipboardImage(win) {
  if (!clipboardWatchEnabled) return;
  if (!win || win.isDestroyed()) return;
  // A focused Agent composer claims clipboard images as transient chat
  // context, so do not race the explicit paste with a library-import offer.
  if (agentComposerFocusedContents.has(win.webContents.id)) return;
  let img;
  try {
    img = clipboard.readImage();
  } catch {
    return;
  }
  if (!img || img.isEmpty()) return;
  let png;
  try {
    png = img.toPNG();
  } catch {
    return;
  }
  if (!png || !png.length) return;
  const hash = crypto.createHash('sha1').update(png).digest('hex');
  // Same image we've already offered (or one the renderer just imported,
  // which calls clipboard:markHandled). Don't re-prompt on every focus.
  if (hash === lastClipboardOfferHash) return;
  lastClipboardOfferHash = hash;
  const size = img.getSize();
  win.webContents.send('clipboard:image-available', {
    dataUrl: img.toDataURL(),
    mime: 'image/png',
    width: size.width,
    height: size.height,
    hash,
    filename: clipboardImageFilename(),
  });
}

// Poll the clipboard while a StashBase window is focused so a system
// screenshot taken *while browsing* (⌘⇧⌃4 copies to the clipboard) is
// offered the instant macOS finishes writing it. The bare 'focus' read
// alone raced that async write — the bytes often land just after focus
// returns, so the single read came up empty and the offer didn't appear
// until the user manually clicked away and back. The timer self-stops
// once focus leaves a main window, so we never poll while the user is in
// another app. `offerClipboardImage` already dedups by hash, so a clip
// sitting in the clipboard is encoded+offered once, not every tick.
let clipboardPollTimer = null;
const CLIPBOARD_POLL_MS = 600;
function startClipboardPolling() {
  if (clipboardPollTimer || !clipboardWatchEnabled) return;
  clipboardPollTimer = setInterval(() => {
    const win = BrowserWindow.getFocusedWindow();
    if (win && mainWindows.has(win) && !win.isDestroyed()) offerClipboardImage(win);
    else stopClipboardPolling();
  }, CLIPBOARD_POLL_MS);
}
function stopClipboardPolling() {
  if (clipboardPollTimer) {
    clearInterval(clipboardPollTimer);
    clipboardPollTimer = null;
  }
}

async function createWindow(initialFolder) {
  try {
    await ensureServer();
  } catch (err) {
    dialog.showErrorBox(
      'StashBase failed to start',
      `${String(err?.message ?? err)}${getServerLogPath() ? '\n\nServer log: available in the application log directory.' : ''}`,
    );
    if (mainWindows.size === 0) app.quit();
    return;
  }
  const windowId = crypto.randomUUID();
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    // Initial OS-level title; the renderer adds the current folder once it
    // opens so Mission Control/task switchers can distinguish windows.
    // There is no in-window titlebar strip — document.title is the only
    // place the folder identity is spelled out.
    title: 'StashBase',
    backgroundColor: '#fafafa',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs `require` for ipcRenderer
      additionalArguments: [`${WINDOW_ID_ARG_PREFIX}${windowId}`],
    },
  });
  const webContentsId = win.webContents.id;
  const rendererFlushReadiness = createRendererFlushReadiness();
  rendererFlushReadinessByWebContents.set(webContentsId, rendererFlushReadiness);
  mainWindows.add(win);
  windowRegistry.add(windowId, win, initialFolder);
  lastMainWindow = win;
  win.on('focus', () => {
    lastMainWindow = win;
    offerClipboardImage(win);
    startClipboardPolling();
  });
  win.on('close', (event) => {
    if (approvedWindowCloses.has(win) || !rendererFlushReadiness.shouldRequest()) return;
    event.preventDefault();
    if (pendingWindowCloses.has(win)) return;
    pendingWindowCloses.add(win);
    void rendererFlush.request(win, 'window-close').then((ok) => {
      pendingWindowCloses.delete(win);
      if (!ok || win.isDestroyed()) {
        if (!win.isDestroyed() && process.env.STASHBASE_MULTI_WINDOW_SMOKE !== '1') {
          void dialog.showMessageBox(win, {
            type: 'error',
            title: 'Could not close window',
            message: 'StashBase could not confirm that the current edit was saved.',
            detail: 'Resolve the save error and close the window again.',
          });
        }
        return;
      }
      approvedWindowCloses.add(win);
      win.close();
    });
  });
  win.on('closed', () => {
    agentComposerFocusedContents.delete(webContentsId);
    rendererFlush.cancel(webContentsId);
    rendererFlushReadinessByWebContents.delete(webContentsId);
    bugReports.discardUnreviewedDraftsForSource(webContentsId);
    rendererReadyWindows.delete(webContentsId);
    mainWindows.delete(win);
    windowRegistry.remove(windowId);
    releaseWindowContext(windowId);
    for (const [grantId, grant] of activePreviewGrants) {
      if (grant.windowId === windowId) {
        activePreviewGrants.delete(grantId);
        void sendInternalDelete(`/api/internal/grants/${encodeURIComponent(grantId)}`);
      }
    }
    if (lastMainWindow === win) {
      lastMainWindow = [...mainWindows].find((candidate) => isLiveMainWindow(candidate)) ?? null;
    }
    if (mainWindows.size === 0 && bugReportReviewWindows.size === 0) {
      if (shouldQuitAfterLastWindow(process.platform)) app.quit();
    }
  });

  // External links → OS default browser. Anything else (popups,
  // accidental navigation away from the app shell) gets denied so the
  // main window stays anchored at SERVER_URL.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url)) void openHttpExternal(url, 'window-open URL');
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    void openHttpExternal(url, 'navigation URL');
  });

  // macOS fullscreen hides the traffic lights, so the sidebar shouldn't
  // reserve its top drag-zone clearance for them. Push state to the
  // renderer so CSS can flip a body class. Send the initial state once
  // the renderer is up in case the window started fullscreen (rare but
  // possible via `Restore Window` on relaunch).
  function pushFullscreen() {
    if (win.isDestroyed()) return;
    win.webContents.send('fullscreen-change', win.isFullScreen());
  }
  win.on('enter-full-screen', pushFullscreen);
  win.on('leave-full-screen', pushFullscreen);
  win.webContents.on('did-finish-load', () => {
    rendererFlushReadiness.markDocumentLoaded();
    pushFullscreen();
  });

  // Swallow ⌘R / Ctrl+R from the keyboard. Electron's default View
  // menu binds it to "Reload", which does a full renderer re-mount —
  // dropping all tab / nav / search state on the floor. Folder switching
  // happens through the sidebar's library list, which swaps the window's
  // folder cleanly without re-mounting.
  // The View → Reload menu item is left in place as an escape hatch
  // (mouse click); only the keyboard chord is gone.
  win.webContents.on('before-input-event', (event, input) => {
    // Own window-level input before it reaches the renderer. The native menu
    // still advertises the platform accelerator, while this boundary prevents
    // the same chord from also creating or closing a document tab.
    const windowAction = windowLifecycleShortcutAction(input);
    if (windowAction === 'new-window') {
      event.preventDefault();
      void createWindow();
      return;
    }
    if (windowAction === 'close-window') {
      event.preventDefault();
      win.close();
      return;
    }
    if (input.type !== 'keyDown') return;
    if (!(input.meta || input.control)) return;
    if (input.shift) return; // ⌘⇧R (Force Reload) stays — dev escape hatch.
    if (input.key.toLowerCase() === 'r') event.preventDefault();
  });

  const url = initialFolder
    ? `${SERVER_URL}/?folder=${encodeURIComponent(initialFolder)}`
    : SERVER_URL;
  win.loadURL(url);
  return win;
}

function releaseWindowContext(windowId) {
  void releaseWindowContextWithRetry(() => (
    requestJson(SERVER_PORT, '/api/window', 1000, {
      method: 'DELETE',
      headers: { 'x-stashbase-window-id': windowId },
    })
  )).then(({ ok, result, attempts }) => {
    if (!ok) {
      const detail = result?.reachable ? `HTTP ${result.statusCode}` : 'server unreachable';
      console.warn(`[electron] window context cleanup failed after ${attempts} attempts: ${detail}`);
    }
  });
}

function focusLastMainWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  const win = isLiveMainWindow(focused)
    ? focused
    : isLiveMainWindow(lastMainWindow)
      ? lastMainWindow
      : [...mainWindows].find((candidate) => isLiveMainWindow(candidate));
  if (!focusWindow(win)) return false;
  lastMainWindow = win;
  return true;
}

function installApplicationMenu() {
  const template = createApplicationMenuTemplate({
    platform: process.platform,
    onNewWindow: () => { void createWindow(); },
    onCloseWindow: (win) => {
      const target = isLiveMainWindow(win) ? win : BrowserWindow.getFocusedWindow();
      if (isLiveMainWindow(target)) target.close();
    },
    onOpenExternal: (url) => { void shell.openExternal(url); },
    onReportBug: () => {
      const target = BrowserWindow.getFocusedWindow();
      void openBugReportReview(isLiveMainWindow(target) ? target : lastMainWindow);
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Folder picker for Open/New folder flows. `defaultPath` lets New
// folder start at `~/Documents/StashBase`, while the OS panel owns the
// actual directory creation affordance.
ipcMain.handle('dialog:openFolder', async (event, opts = {}) => {
  const properties = ['openDirectory'];
  if (opts.allowCreateDirectory !== false) properties.push('createDirectory');
  const dialogOpts = {
    title: opts.title || 'Choose a folder',
    properties,
  };
  if (typeof opts.buttonLabel === 'string' && opts.buttonLabel) {
    dialogOpts.buttonLabel = opts.buttonLabel;
  }
  if (typeof opts.defaultPath === 'string' && opts.defaultPath) {
    dialogOpts.defaultPath = opts.defaultPath;
  }
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  const parent = isLiveMainWindow(senderWindow) ? senderWindow : BrowserWindow.getFocusedWindow();
  const result = parent
    ? await dialog.showOpenDialog(parent, dialogOpts)
    : await dialog.showOpenDialog(dialogOpts);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Renderer-initiated external link → OS default browser. Validates the
// scheme so an injected `file://` / `javascript:` URL can't smuggle a
// local navigation through us.
ipcMain.handle('shell:openExternal', async (_e, url) => {
  return openHttpExternal(url, 'renderer external URL');
});

// Renderer-initiated bug reporting: the sidebar button is the same deliberate
// entry as Help → Report a Bug…. The source window is derived from the IPC
// sender, never from renderer-supplied identity, and only a live main window
// may start a report.
ipcMain.handle('bug-report:open', async (event) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!isLiveMainWindow(senderWindow)) return false;
  await openBugReportReview(senderWindow);
  return true;
});

ipcMain.handle('window:setFolder', (event, folder) => {
  if (folder !== null && (typeof folder !== 'string' || !folder.trim())) return false;
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  const windowId = windowRegistry.idForWindow(senderWindow);
  if (!windowId) return false;
  return windowRegistry.setFolder(windowId, folder);
});

ipcMain.handle('window:openFolder', async (event, name) => {
  if (typeof name !== 'string' || !name.trim()) return false;
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  const result = await openOrFocusFolder({
    registry: windowRegistry,
    folder: name.trim(),
    senderWindow,
    createWindow,
  });
  if (result.ok && result.win) lastMainWindow = result.win;
  return result.ok;
});

ipcMain.on('window:context-release-ready', (event, payload) => {
  rendererFlush.handleResponse(event.sender.id, payload);
});

ipcMain.on('window:context-release-handler-state', (event, payload) => {
  rendererFlushReadinessByWebContents
    .get(event.sender.id)
    ?.markHandlerReady(payload?.ready === true);
});

ipcMain.handle('window:prepareFolderRemoval', async (event, folder) => {
  if (typeof folder !== 'string' || !folder.trim()) return false;
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!isLiveMainWindow(senderWindow)) return false;
  const affected = windowRegistry.windowsByFolder(folder.trim())
    .filter((win) => isLiveMainWindow(win));
  const saved = await Promise.all(
    affected.map((win) => rendererFlush.request(win, 'folder-removal')),
  );
  return saved.every(Boolean);
});

ipcMain.handle('window:notifyFolderRemoved', (event, folder) => {
  if (typeof folder !== 'string' || !folder.trim()) return false;
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!isLiveMainWindow(senderWindow)) return false;
  for (const win of mainWindows) {
    if (isLiveMainWindow(win)) {
      win.webContents.send('window:folder-removed', folder.trim());
    }
  }
  return true;
});

// A folder joined the library without any window opening it (Agent
// create_project). Broadcast so every window's sidebar refreshes its
// membership list; only the notifying (chat-owning) window navigates.
ipcMain.handle('window:notifyLibraryFolderAdded', (event, folder) => {
  if (typeof folder !== 'string' || !folder.trim()) return false;
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!isLiveMainWindow(senderWindow)) return false;
  for (const win of mainWindows) {
    if (isLiveMainWindow(win) && win !== senderWindow) {
      win.webContents.send('window:library-folder-added', folder.trim());
    }
  }
  return true;
});

// Renderer toggles clipboard-image watching (privacy switch). When
// turning it back on we clear the last-offered hash so the current
// clipboard image becomes eligible again.
ipcMain.handle('clipboard:setWatch', (_event, enabled) => {
  clipboardWatchEnabled = enabled !== false;
  if (clipboardWatchEnabled) {
    lastClipboardOfferHash = null;
    const win = BrowserWindow.getFocusedWindow();
    if (win && mainWindows.has(win)) { offerClipboardImage(win); startClipboardPolling(); }
  } else {
    stopClipboardPolling();
  }
  return clipboardWatchEnabled;
});

// Renderer confirms it imported (or chose to keep ignoring) a clipboard
// image; remember the hash so re-focus doesn't re-offer the same one.
ipcMain.on('clipboard:markHandled', (_event, hash) => {
  if (typeof hash === 'string' && hash) lastClipboardOfferHash = hash;
});

ipcMain.on('clipboard:markCurrentImageHandled', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!isLiveMainWindow(win)) return;
  markCurrentClipboardImageHandled();
});

ipcMain.on('clipboard:setAgentComposerFocused', (event, focused) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!isLiveMainWindow(win)) return;
  if (focused === true) agentComposerFocusedContents.add(event.sender.id);
  else agentComposerFocusedContents.delete(event.sender.id);
});

function getLastMainWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  const win = isLiveMainWindow(focused)
    ? focused
    : isLiveMainWindow(lastMainWindow)
      ? lastMainWindow
      : [...mainWindows].find((candidate) => isLiveMainWindow(candidate));
  return isLiveMainWindow(win) ? win : null;
}

function handleNativeFileOpenRequest(filePath) {
  const win = getLastMainWindow();
  if (win && rendererReadyWindows.has(win.webContents.id)) {
    win.webContents.send('window:open-external-files', [filePath]);
  } else {
    pendingFilesToOpen.push(filePath);
  }
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  handleNativeFileOpenRequest(filePath);
});

ipcMain.handle('grant:register', async (event, filePath) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  const windowId = windowRegistry.idForWindow(senderWindow);
  if (!windowId || typeof filePath !== 'string') throw new Error('Invalid arguments');

  const canonicalPath = path.resolve(filePath);
  if (!fs.existsSync(canonicalPath)) throw new Error('File does not exist');
  const st = fs.statSync(canonicalPath);
  if (!st.isFile()) throw new Error('Not a file');

  const ext = path.extname(canonicalPath).toLowerCase().slice(1);
  if (!VIEWABLE_FILE_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported file type: .${ext}`);
  }

  const activeFolder = windowRegistry.folderForWindowId(windowId);
  if (activeFolder) {
    const relative = path.relative(activeFolder, canonicalPath);
    const isInternal = !relative.startsWith('..') && !path.isAbsolute(relative);
    if (isInternal) {
      return { isInternal: true, relPath: relative.replace(/\\/g, '/') };
    }
  }

  const grantId = crypto.randomUUID();
  const format = getFileFormat(canonicalPath);
  const name = path.basename(canonicalPath);

  activePreviewGrants.set(grantId, { windowId, filePath: canonicalPath });

  await sendInternalPost('/api/internal/grants', { grantId, windowId, filePath: canonicalPath });

  return {
    isInternal: false,
    grantId,
    name,
    format,
    absolutePath: canonicalPath,
  };
});

ipcMain.handle('grant:revoke', async (event, grantId) => {
  if (typeof grantId !== 'string') return false;
  activePreviewGrants.delete(grantId);
  await sendInternalDelete(`/api/internal/grants/${encodeURIComponent(grantId)}`);
  return true;
});

ipcMain.on('renderer:ready-for-native-files', (event) => {
  const webContentsId = event.sender.id;
  rendererReadyWindows.add(webContentsId);
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && pendingFilesToOpen.length > 0) {
    const paths = [...pendingFilesToOpen];
    pendingFilesToOpen.length = 0;
    win.webContents.send('window:open-external-files', paths);
  }
});

const initialWindowFlight = createSingleFlight(() => app.whenReady().then(() => createWindow()));

function focusOAuthReturn() {
  void app.whenReady().then(async () => {
    const acknowledged = await requestJson(SERVER_PORT, '/api/account/oauth/app-return', 1000, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-stashbase-oauth-return-token': OAUTH_RETURN_TOKEN,
      },
    });
    if (!acknowledged.reachable || acknowledged.statusCode !== 200) {
      console.warn('[electron] could not acknowledge OAuth return to the callback page');
    }
    if (process.platform === 'darwin') app.focus({ steal: true });
    const targetId = typeof acknowledged.body?.windowId === 'string'
      ? acknowledged.body.windowId
      : null;
    const target = targetId ? windowRegistry.windowForId(targetId) : null;
    if (isLiveMainWindow(target) && focusWindow(target)) {
      lastMainWindow = target;
      return;
    }
    if (!focusLastMainWindow()) {
      await initialWindowFlight.run();
      focusLastMainWindow();
    }
  });
}

function registerOAuthReturnProtocol() {
  const registered = process.defaultApp && process.argv[1]
    ? app.setAsDefaultProtocolClient('stashbase', process.execPath, [path.resolve(process.argv[1])])
    : app.setAsDefaultProtocolClient('stashbase');
  if (!registered) console.warn('[electron] could not register the stashbase:// return protocol');
}

app.on('open-url', (event, url) => {
  if (isStashBaseProtocolUrl(url)) event.preventDefault();
  if (!isOAuthReturnUrl(url)) return;
  focusOAuthReturn();
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
const initialProtocolLaunch = classifyProtocolLaunch(process.argv);
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const protocolLaunch = classifyProtocolLaunch(argv);
    if (protocolLaunch === 'oauth-return') {
      focusOAuthReturn();
      return;
    }
    // A malformed or unsupported stashbase: URL must not fall through to the
    // ordinary second-launch focus/create behavior.
    if (protocolLaunch === 'inert') return;
    const filePaths = getFilePathsFromArgs(argv);
    if (filePaths.length > 0) {
      for (const filePath of filePaths) {
        handleNativeFileOpenRequest(filePath);
      }
    } else {
      if (!focusLastMainWindow()) {
        void initialWindowFlight.run().then(() => { focusLastMainWindow(); });
      }
    }
  });

  app.whenReady().then(async () => {
    registerOAuthReturnProtocol();
    // A cold unsupported stashbase: URL is just as inert as the same URL sent
    // to an existing instance: do not start the server or create a window.
    if (initialProtocolLaunch === 'inert') {
      app.quit();
      return;
    }
    try {
      await bugReportHandoff.initializeSession();
    } catch {
      console.warn('[electron] bug-report temporary session initialization failed');
    }
    // Refresh the MCP wrapper on every launch so the most recently-opened
    // app owns it. Without this, a wrapper written by an earlier `pnpm
    // dev` run still points at a vanished `node_modules/.bin/tsx`, and
    // Claude Code / Claude Desktop spawn it after a brew install with
    // "command not found" (or, on macOS, "Operation not permitted" when
    // the old path is under ~/Downloads and TCC blocks it). Skip silently
    // if the entry for *this* app isn't on disk — partial dev checkouts
    // shouldn't clobber a working packaged wrapper.
    try {
      if (fs.existsSync(MCP_ENTRY)) writeMcpWrapper();
    } catch (err) {
      console.warn(`[electron] MCP wrapper refresh failed: ${err && err.message ? err.message : err}`);
    }
    installApplicationMenu();
    const startupFiles = getFilePathsFromArgs(process.argv);
    for (const filePath of startupFiles) {
      pendingFilesToOpen.push(filePath);
    }
    await initialWindowFlight.run();
    if (initialProtocolLaunch === 'oauth-return') focusOAuthReturn();
  });

  app.on('activate', () => {
    if (mainWindows.size === 0) {
      void createWindow();
    }
  });

  app.on('window-all-closed', () => {
    if (shouldQuitAfterLastWindow(process.platform)) app.quit();
  });
}

// Drag the server down with us on real shutdown. macOS keeps the
// process alive on window-close (Cmd+Q is the actual quit signal), so
// we hook `will-quit` rather than `window-all-closed` here.
//
// We need to **wait** for the server to actually exit before quitting
// Electron — otherwise the Python daemon orphans, still holding
// Milvus Lite's flock, and the next launch fails to open the DB.
// Hard 8 s ceiling so the server's 6.5 s cleanup ladder can finish without a
// stuck child pinning Electron forever.
let quitting = false;
app.on('will-quit', (event) => {
  if (quitting) return;
  if (!serverProc || serverProc.killed) return;
  event.preventDefault();
  quitting = true;
  void requestJson(SERVER_PORT, '/api/internal/shutdown', 1500, {
    method: 'POST',
    headers: { 'x-stashbase-shutdown-token': SERVER_SHUTDOWN_TOKEN },
  }).then((result) => {
    if (result.reachable && result.statusCode === 202) return;
    // POSIX receives this gracefully; Windows uses it only after the explicit
    // shutdown handshake failed, where forceful termination is preferable to
    // pinning the desktop process forever.
    try { serverProc.kill('SIGTERM'); } catch { /* already gone */ }
  });
  const fallback = setTimeout(() => {
    try { serverProc.kill('SIGKILL'); } catch { /* already gone */ }
    app.exit(process.exitCode || 0);
  }, 8000);
  serverProc.once('exit', () => {
    clearTimeout(fallback);
    app.exit(process.exitCode || 0);
  });
});
