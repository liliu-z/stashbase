/**
 * Electron main process for StashBase.
 *
 * Boots the Express server as a child process, waits for :8090 to
 * answer, then opens the window pointed at localhost. Server logs are
 * inherited to this terminal so `tsx watch` rebuilds + diagnostics
 * surface naturally. Quitting the app kills the server.
 *
 * The renderer is sandboxed; the only main → renderer surface is the
 * folder-picker IPC exposed via preload.cjs.
 */
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

function parsePortArg(argv, fallback) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--port=')) return Number(a.slice(7)) || fallback;
    if (a === '--port') return Number(argv[i + 1]) || fallback;
  }
  return fallback;
}
const SERVER_PORT = parsePortArg(process.argv.slice(1), 8090);

// Capture server stdout/stderr to a file the user can `cat` after a
// failed launch. Dock-launched packaged apps inherit Electron's stderr
// which goes to /dev/null, so without this every server crash is
// invisible. Path is shown in the failure dialog.
const SERVER_LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'StashBase');
const SERVER_LOG_PATH = path.join(SERVER_LOG_DIR, 'server.log');
// Use the IPv4 loopback address explicitly. The server binds to
// 127.0.0.1, and `localhost` may resolve to ::1 first on dual-stack
// systems — pointing the renderer at 127.0.0.1 sidesteps the silent
// "can't connect" race.
const SERVER_HOST = '127.0.0.1';
const SERVER_URL = `http://${SERVER_HOST}:${SERVER_PORT}`;
const PROJECT_ROOT = app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..');
const SERVER_ENTRY = app.isPackaged
  ? path.join(PROJECT_ROOT, 'dist', 'server', 'index.mjs')
  : path.join(PROJECT_ROOT, 'server', 'index.ts');
const MCP_ENTRY = app.isPackaged
  ? path.join(PROJECT_ROOT, 'dist', 'mcp', 'server.mjs')
  : path.join(PROJECT_ROOT, 'mcp', 'server.ts');

let serverProc = null;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
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

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function writeMcpWrapper() {
  const binDir = path.join(os.homedir(), '.stashbase', 'bin');
  const wrapper = path.join(binDir, 'stashbase-mcp');
  const resourcesPath = app.isPackaged ? process.resourcesPath : PROJECT_ROOT;
  const commandLines = app.isPackaged
    ? [
        'export ELECTRON_RUN_AS_NODE=1',
        `exec ${shellQuote(process.execPath)} ${shellQuote(MCP_ENTRY)} "$@"`,
      ]
    : [
        `exec ${shellQuote(path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx'))} ${shellQuote(MCP_ENTRY)} "$@"`,
      ];
  const content = [
    '#!/bin/sh',
    'set -eu',
    `export STASHBASE_APP_ROOT=${shellQuote(PROJECT_ROOT)}`,
    `export STASHBASE_RESOURCES_PATH=${shellQuote(resourcesPath)}`,
    ...commandLines,
    '',
  ].join('\n');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(wrapper, content, { mode: 0o755 });
  fs.chmodSync(wrapper, 0o755);
  return wrapper;
}

function configureJsonMcp(file, serverConfig) {
  const config = readJsonObject(file);
  if (!config) return false;
  const currentServers =
    config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
      ? config.mcpServers
      : {};
  config.mcpServers = {
    ...currentServers,
    stashbase: serverConfig,
  };
  writeJson(file, config);
  return true;
}

function replaceTomlTable(raw, tableName, block) {
  const lines = raw.split(/\r?\n/);
  const out = [];
  const headerRe = /^\s*\[([^\]]+)\]\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(headerRe);
    if (!match || match[1] !== tableName) {
      out.push(lines[i]);
      continue;
    }
    i += 1;
    while (i < lines.length) {
      const nextMatch = lines[i].match(headerRe);
      if (nextMatch && nextMatch[1] !== tableName && !nextMatch[1].startsWith(`${tableName}.`)) {
        break;
      }
      i += 1;
    }
    i -= 1;
  }
  const trimmed = out.join('\n').trimEnd();
  return `${trimmed ? `${trimmed}\n\n` : ''}${block}\n`;
}

function configureCodex(wrapper) {
  const file = path.join(os.homedir(), '.codex', 'config.toml');
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const block = [
    '[mcp_servers.stashbase]',
    `command = ${JSON.stringify(wrapper)}`,
  ].join('\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, replaceTomlTable(raw, 'mcp_servers.stashbase', block));
  return true;
}

function getMcpServerConfig(wrapper) {
  return { command: wrapper };
}

const JSON_MCP_CONFIG_FILES = {
  'gemini-cli': () => path.join(os.homedir(), '.gemini', 'settings.json'),
  'qwen-code': () => path.join(os.homedir(), '.qwen', 'settings.json'),
  cursor: () => path.join(os.homedir(), '.cursor', 'mcp.json'),
};

function getStandardMcpJson(wrapper) {
  return {
    mcpServers: {
      stashbase: {
        command: wrapper,
      },
    },
  };
}

function getMcpManualConfig(client, wrapper) {
  if (client === 'cherry-studio') {
    return {
      kind: 'gui',
      name: 'stashbase',
      type: 'STDIO',
      command: wrapper,
      arguments: [],
    };
  }
  if (client === 'augment') {
    return {
      'augment.advanced': {
        mcpServers: [
          {
            name: 'stashbase',
            command: wrapper,
          },
        ],
      },
    };
  }
  if (client === 'zencoder') {
    return {
      command: wrapper,
      args: [],
    };
  }
  return getStandardMcpJson(wrapper);
}

function configureMcpClient(client) {
  if (!fs.existsSync(MCP_ENTRY)) {
    throw new Error(`MCP entry missing: ${MCP_ENTRY}`);
  }

  const wrapper = writeMcpWrapper();
  if (client === 'claude-desktop') {
    if (process.platform !== 'darwin') {
      throw new Error('Claude Desktop auto configuration is currently supported on macOS only.');
    }
    const file = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    );
    configureJsonMcp(file, getMcpServerConfig(wrapper));
    return { client, file, command: wrapper, manual: getMcpManualConfig(client, wrapper), mode: 'file' };
  }
  if (client === 'claude-code') {
    const file = path.join(os.homedir(), '.claude.json');
    configureJsonMcp(file, { type: 'stdio', command: wrapper });
    return { client, file, command: wrapper, manual: getMcpManualConfig(client, wrapper), mode: 'file' };
  }
  if (client === 'codex-cli') {
    const file = path.join(os.homedir(), '.codex', 'config.toml');
    configureCodex(wrapper);
    return { client, file, command: wrapper, manual: getMcpManualConfig(client, wrapper), mode: 'file' };
  }
  if (client in JSON_MCP_CONFIG_FILES) {
    const file = JSON_MCP_CONFIG_FILES[client]();
    configureJsonMcp(file, getMcpServerConfig(wrapper));
    return { client, file, command: wrapper, manual: getMcpManualConfig(client, wrapper), mode: 'file' };
  }
  if (
    client === 'chatgpt' ||
    client === 'void' ||
    client === 'windsurf' ||
    client === 'vscode' ||
    client === 'cherry-studio' ||
    client === 'cline' ||
    client === 'augment' ||
    client === 'roo-code' ||
    client === 'zencoder' ||
    client === 'langchain-langgraph' ||
    client === 'other'
  ) {
    return { client, command: wrapper, manual: getMcpManualConfig(client, wrapper), mode: 'clipboard' };
  }
  throw new Error(`Unknown MCP client: ${client}`);
}

/** Spawn the Express server as a child. If something else is already on
 *  the port (e.g. you've got `pnpm dev` running in a terminal), we
 *  skip the spawn and just point the window at it — handy for editing
 *  the server in your editor with tsx-watch hot reload. */
async function ensureServer() {
  if (await isServerLive(SERVER_PORT, 300)) {
    console.log(`[electron] reusing existing server at ${SERVER_URL}`);
    return;
  }
  const serverBin = app.isPackaged
    ? process.execPath
    : path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
  // `watch` mode in dev so server-side edits hot-reload without a full
  // app restart. Packaged builds run the pre-bundled Node entry through
  // Electron's embedded Node runtime. `--port=N` is appended only when
  // overriding the default so the server's argv parser sees the standard
  // CLI flag (matches the `npm start -- --port=...` workflow).
  const portArgs = SERVER_PORT === 8090 ? [] : [`--port=${SERVER_PORT}`];
  const serverArgs = app.isPackaged
    ? [SERVER_ENTRY, ...portArgs]
    : ['watch', SERVER_ENTRY, ...portArgs];
  // In packaged builds the Python sidecar lives under
  // `process.resourcesPath` (electron-builder `extraResources`). In dev
  // tsx finds python via the local venv, so we only override when
  // packaged. Model weights are cached by huggingface_hub under
  // `~/.cache/huggingface/` regardless of dev vs packaged.
  const packagedPythonCandidates = [
    path.join(process.resourcesPath, 'python', 'runtime', 'bin', 'python'),
    path.join(process.resourcesPath, 'python', '.venv', 'bin', 'python'),
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
    path.join(process.resourcesPath, 'python', 'sidecar', 'stashbase-daemon', 'stashbase-daemon'),
    path.join(process.resourcesPath, 'python', 'sidecar', 'stashbase-daemon'),
  ];
  const packagedDaemon = packagedDaemonCandidates.find((candidate) => {
    try { return require('node:fs').statSync(candidate).isFile(); } catch { return false; }
  });
  const hasPackagedDaemon = Boolean(packagedDaemon);
  const packagedEnv = app.isPackaged
    ? {
        ELECTRON_RUN_AS_NODE: '1',
        STASHBASE_APP_ROOT: PROJECT_ROOT,
        STASHBASE_RESOURCES_PATH: process.resourcesPath,
        ...(hasPackagedDaemon ? { STASHBASE_DAEMON_BIN: packagedDaemon } : {}),
        ...(packagedPython ? { STASHBASE_PYTHON: packagedPython } : {}),
      }
    : { STASHBASE_APP_ROOT: PROJECT_ROOT };
  // In packaged+asar mode PROJECT_ROOT is `.../Resources/app.asar` —
  // a FILE, not a directory. spawn(cwd) hits the OS syscall (no
  // electron asar shim) and bails with ENOTDIR. Use the real
  // Resources/ directory there; in dev keep PROJECT_ROOT (the repo).
  const serverCwd = app.isPackaged ? process.resourcesPath : PROJECT_ROOT;
  // Tee server output to a per-launch log file in ~/Library/Logs/StashBase/
  // so a packaged Dock launch is debuggable, AND to the parent stdio so
  // `pnpm electron` from a terminal still shows live logs. The file is
  // truncated each launch — old crashes would only confuse the user.
  fs.mkdirSync(SERVER_LOG_DIR, { recursive: true });
  const logFd = fs.openSync(SERVER_LOG_PATH, 'w');
  fs.writeSync(
    logFd,
    `--- StashBase server launch ${new Date().toISOString()} (pid=${process.pid}, packaged=${app.isPackaged}) ---\n`,
  );
  serverProc = spawn(serverBin, serverArgs, {
    cwd: serverCwd,
    // Port flows via the CLI arg above, not the env — keeps the server
    // entry's argv parser the single source of truth for port config.
    env: { ...process.env, ...packagedEnv },
    // stdin = 'ignore' is intentional: the server never reads from
    // stdin, and inheriting the parent's TTY made Node attach a real
    // TTY ReadStream to the child's fd 0. Any flake on that TTY
    // (shell repaint, tmux/screen detach, Ctrl-Z, terminal closed
    // while the app was still running) emitted an `EIO` on the
    // unread stream which had no listener → unhandled 'error'
    // event, killed the whole electron process. Closing stdin
    // entirely sidesteps the class of bug.
    // stdout + stderr go to the per-launch log file so dock launches
    // are debuggable; terminal launches can `tail -f` the same file.
    stdio: ['ignore', logFd, logFd],
  });
  // `spawn` can fail asynchronously (ENOENT when tsx isn't installed,
  // permission errors, etc.). Without an explicit listener Node treats
  // the 'error' event as fatal and the whole Electron process crashes
  // with an unhelpful stack — surface a useful message instead.
  serverProc.on('error', (err) => {
    console.warn(`[electron] server spawn failed: ${err.message}`);
    if (err.code === 'ENOENT') {
      console.warn(`[electron]   couldn't find ${serverBin}. ` +
        `Run \`pnpm install\` to populate node_modules/.bin.`);
    }
  });
  serverProc.on('exit', (code) => {
    if (code != null && code !== 0) {
      console.warn(`[electron] server exited with code ${code}`);
    }
  });
  // Poll until the server is up. Embedding cold-start on first model load
  // call can be slow, but listen() is sub-second — 10s ceiling is
  // generous; we surface a clear error rather than hanging forever.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await isServerLive(SERVER_PORT, 200)) return;
    await sleep(150);
  }
  throw new Error(`server did not come up on :${SERVER_PORT} within 10s`);
}

function isServerLive(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: SERVER_HOST, port, path: '/api/space', method: 'GET', timeout: timeoutMs },
      (res) => { res.resume(); resolve(true); },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
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

async function createWindow(initialSpace) {
  try {
    await ensureServer();
  } catch (err) {
    dialog.showErrorBox(
      'StashBase failed to start',
      `${String(err?.message ?? err)}\n\nServer log: ${SERVER_LOG_PATH}`,
    );
    app.quit();
    return;
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    // OS-level title (Dock right-click, Cmd+Tab, mission control) —
    // the visible app-name in the window itself is drawn by HTML in a
    // custom titlebar so we control typography and color seamlessly
    // (see `.electron-titlebar` rule).
    title: 'StashBase',
    backgroundColor: '#fafafa',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs `require` for ipcRenderer
    },
  });

  // External links → OS default browser. Anything else (popups,
  // accidental navigation away from the app shell) gets denied so the
  // main window stays anchored at SERVER_URL.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url) && isHttpUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (isHttpUrl(url)) shell.openExternal(url);
  });

  // macOS fullscreen hides the traffic lights, so the chrome strip
  // shouldn't reserve room for them. Push state to the renderer so CSS
  // can flip a body class. Send the initial state once the renderer is
  // up in case the window started fullscreen (rare but possible via
  // `Restore Window` on relaunch).
  function pushFullscreen() {
    if (win.isDestroyed()) return;
    win.webContents.send('fullscreen-change', win.isFullScreen());
  }
  win.on('enter-full-screen', pushFullscreen);
  win.on('leave-full-screen', pushFullscreen);
  win.webContents.on('did-finish-load', pushFullscreen);

  // Swallow ⌘R / Ctrl+R from the keyboard. Electron's default View
  // menu binds it to "Reload", which does a full renderer re-mount —
  // dropping all tab / nav / search state on the floor. The intentional
  // "back to Welcome" path is the Home icon in the chrome strip
  // (`actions.goHome()`), which resets tabs cleanly without re-mounting.
  // The View → Reload menu item is left in place as an escape hatch
  // (mouse click); only the keyboard chord is gone.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (!(input.meta || input.control)) return;
    if (input.shift) return; // ⌘⇧R (Force Reload) stays — dev escape hatch.
    if (input.key.toLowerCase() === 'r') event.preventDefault();
  });

  const url = initialSpace
    ? `${SERVER_URL}/?space=${encodeURIComponent(initialSpace)}`
    : SERVER_URL;
  win.loadURL(url);
}

// Folder picker — invoked from the Clone modal (Open/New use the
// custom in-app SpacePicker so they can enforce the kbRoot rule via
// list filtering; Clone wants the native "New Folder" affordance so
// the user can spin up `~/Documents/StashBase/<new>` on the spot).
// `defaultPath` opens the panel at a sensible starting location; the
// caller still validates the result is under kbRoot before using it.
ipcMain.handle('dialog:openFolder', async (_e, opts = {}) => {
  const properties = ['openDirectory'];
  if (opts.allowCreateDirectory !== false) properties.push('createDirectory');
  const dialogOpts = {
    title: opts.title || 'Choose a folder',
    buttonLabel: opts.buttonLabel || 'Choose',
    properties,
  };
  if (typeof opts.defaultPath === 'string' && opts.defaultPath) {
    dialogOpts.defaultPath = opts.defaultPath;
  }
  const focused = BrowserWindow.getFocusedWindow();
  const result = focused
    ? await dialog.showOpenDialog(focused, dialogOpts)
    : await dialog.showOpenDialog(dialogOpts);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Renderer-initiated external link → OS default browser. Validates the
// scheme so an injected `file://` / `javascript:` URL can't smuggle a
// local navigation through us.
ipcMain.handle('shell:openExternal', async (_e, url) => {
  if (typeof url !== 'string' || !isHttpUrl(url)) return false;
  await shell.openExternal(url);
  return true;
});

ipcMain.handle('mcp:configure', async (_e, client) => {
  if (typeof client !== 'string') {
    return { ok: false, error: 'Invalid MCP client.' };
  }
  try {
    const result = configureMcpClient(client);
    return { ok: true, ...result };
  } catch (err) {
    const message = err && typeof err.message === 'string' ? err.message : String(err);
    return { ok: false, error: message };
  }
});

ipcMain.handle('window:openSpace', async (_e, name) => {
  if (typeof name !== 'string' || !name.trim()) return false;
  await createWindow(name.trim());
  return true;
});

app.whenReady().then(() => {
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
  createWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Drag the server down with us on real shutdown. macOS keeps the
// process alive on window-close (Cmd+Q is the actual quit signal), so
// we hook `will-quit` rather than `window-all-closed` here.
//
// We need to **wait** for the server to actually exit before quitting
// Electron — otherwise the Python daemon orphans, still holding
// Milvus Lite's flock, and the next launch fails to open the DB.
// Hard 4 s ceiling so a stuck server can't pin the Electron quit.
let quitting = false;
app.on('will-quit', (event) => {
  if (quitting) return;
  if (!serverProc || serverProc.killed) return;
  event.preventDefault();
  quitting = true;
  serverProc.kill('SIGTERM');
  const fallback = setTimeout(() => app.exit(0), 4000);
  serverProc.once('exit', () => {
    clearTimeout(fallback);
    app.exit(0);
  });
});
