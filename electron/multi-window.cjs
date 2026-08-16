'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
// Shared with the renderer (web-src/src/lib/externalLink.ts) so the Help
// menu and the sidebar's Discord button can never point at different
// invites. JSON, because this file runs unbuilt and cannot require a .ts.
const LINKS = require('../shared/links.json');

const WINDOW_ID_ARG_PREFIX = '--stashbase-window-id=';

function buildElectronSmokeArgs(platform, script, port) {
  const appArgs = [script, `--port=${port}`];
  // GitHub-hosted Linux runners cannot install Electron's chrome-sandbox
  // helper as root with mode 4755. This affects only the isolated source
  // smoke under Xvfb; production Electron launches retain their sandbox.
  return platform === 'linux' ? ['--no-sandbox', ...appArgs] : appArgs;
}

function windowIdFromArgv(argv) {
  const arg = Array.isArray(argv)
    ? argv.find((value) => typeof value === 'string' && value.startsWith(WINDOW_ID_ARG_PREFIX))
    : undefined;
  const id = typeof arg === 'string' ? arg.slice(WINDOW_ID_ARG_PREFIX.length).trim() : '';
  return id ? id.slice(0, 128) : null;
}

function createApplicationMenuTemplate({
  platform = process.platform,
  onNewWindow,
  onCloseWindow,
  onOpenExternal,
  onReportBug = () => { },
}) {
  const isMac = platform === 'darwin';
  // Do not use Electron's `role: 'close'`: its Cmd/Ctrl+W binding conflicts
  // with the renderer's active-tab command. Match VS Code instead: macOS uses
  // Cmd+Shift+W, while Windows/Linux display their native Alt+F4 binding.
  const closeWindow = {
    label: 'Close Window',
    accelerator: isMac ? 'Command+Shift+W' : 'Alt+F4',
    click: (_item, win) => onCloseWindow(win),
  };
  const fileLifecycleItems = isMac
    ? [closeWindow]
    : [closeWindow, { type: 'separator' }, { role: 'quit' }];
  return [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CommandOrControl+Shift+N',
          click: onNewWindow,
        },
        { type: 'separator' },
        ...fileLifecycleItems,
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    // Help is where both platforms train people to look when they are
    // stuck, and it is the only route out of the app that survives a
    // renderer that has failed to paint. `role: 'help'` matters on macOS:
    // it is what puts the entry last and gives it the system search field.
    // Opening is injected rather than calling `shell` here, so this module
    // stays importable by the menu tests without an Electron runtime.
    {
      role: 'help',
      submenu: [
        {
          label: 'StashBase Website',
          click: () => onOpenExternal(LINKS.website),
        },
        {
          label: 'Community Discord',
          click: () => onOpenExternal(LINKS.discord),
        },
        { type: 'separator' },
        // Bugs belong on the issue tracker, not in chat: an issue is
        // searchable by the next person who hits the same thing, and a
        // Discord message is not.
        {
          label: 'Report a Bug…',
          click: () => onReportBug(),
        },
        {
          label: 'Report an Issue',
          click: () => onOpenExternal(LINKS.issues),
        },
      ],
    },
  ];
}

function windowLifecycleShortcutAction(input, platform = process.platform) {
  if (
    !input
    || input.type !== 'keyDown'
    || input.isAutoRepeat === true
    || typeof input.key !== 'string'
  ) {
    return null;
  }

  const key = input.key.toLowerCase();
  const primary = platform === 'darwin'
    ? input.meta === true && input.control !== true
    : input.control === true && input.meta !== true;
  const shiftedPrimary = primary && input.shift === true && input.alt !== true;

  if (shiftedPrimary && key === 'n') return 'new-window';
  if (shiftedPrimary && key === 'w') return 'close-window';
  if (
    platform !== 'darwin'
    && key === 'f4'
    && input.alt === true
    && input.control !== true
    && input.meta !== true
    && input.shift !== true
  ) {
    return 'close-window';
  }
  return null;
}

function shouldQuitAfterLastWindow(platform) {
  return platform !== 'darwin';
}

function folderKey(folder, platform) {
  if (typeof folder !== 'string' || !folder.trim()) return null;
  const raw = folder.trim();
  const normalized = platform === 'win32'
    ? path.win32.resolve(raw.replaceAll('/', '\\')).toLowerCase()
    : path.resolve(raw);
  return normalized;
}

function createWindowRegistry({ platform = process.platform } = {}) {
  const records = new Map();

  return {
    add(windowId, win, folder = null) {
      records.set(windowId, { win, folderKey: folderKey(folder, platform) });
    },
    remove(windowId) {
      records.delete(windowId);
    },
    idForWindow(win) {
      for (const [windowId, record] of records) {
        if (record.win === win) return windowId;
      }
      return null;
    },
    windowForId(windowId) {
      return records.get(windowId)?.win ?? null;
    },
    setFolder(windowId, folder) {
      const record = records.get(windowId);
      if (!record) return false;
      record.folderKey = folderKey(folder, platform);
      return true;
    },
    findByFolder(folder, { excludeWindowId = null } = {}) {
      const wanted = folderKey(folder, platform);
      if (!wanted) return null;
      for (const [windowId, record] of records) {
        if (windowId === excludeWindowId) continue;
        if (record.folderKey === wanted) return record.win;
      }
      return null;
    },
    windowsByFolder(folder) {
      const wanted = folderKey(folder, platform);
      if (!wanted) return [];
      return [...records.values()]
        .filter((record) => record.folderKey === wanted)
        .map((record) => record.win);
    },
    folderForWindowId(windowId) {
      return records.get(windowId)?.folderKey ?? null;
    },
  };
}

function focusWindow(win) {
  if (!win || win.isDestroyed?.()) return false;
  if (win.isMinimized?.()) win.restore();
  win.show();
  win.focus();
  return true;
}

function isOAuthReturnUrl(value) {
  if (typeof value !== 'string' || value.length > 256) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'stashbase:'
      && url.hostname === 'oauth-complete'
      && (url.pathname === '' || url.pathname === '/')
      && url.search === ''
      && url.hash === ''
      && url.username === ''
      && url.password === ''
      && url.port === '';
  } catch {
    return false;
  }
}

function isStashBaseProtocolUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { return new URL(value).protocol === 'stashbase:'; }
  catch { return false; }
}

function classifyProtocolLaunch(argv) {
  if (argv.some(isOAuthReturnUrl)) return 'oauth-return';
  if (argv.some(isStashBaseProtocolUrl)) return 'inert';
  return 'ordinary';
}

async function openOrFocusFolder({
  registry,
  folder,
  senderWindow,
  createWindow,
}) {
  const senderId = registry.idForWindow(senderWindow);
  const existing = registry.findByFolder(folder, { excludeWindowId: senderId });
  if (focusWindow(existing)) return { ok: true, action: 'focused', win: existing };
  const created = await createWindow(folder);
  return { ok: Boolean(created), action: created ? 'opened' : 'failed', win: created ?? null };
}

async function releaseWindowContextWithRetry(
  request,
  {
    delays = [50, 200, 750, 1500],
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  let result = null;
  let attempts = 0;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    attempts = attempt + 1;
    result = await request();
    if (result?.reachable && result.statusCode >= 200 && result.statusCode < 300) {
      return { ok: true, result, attempts };
    }
    const retryable = !result?.reachable || result.statusCode === 408
      || result.statusCode === 429 || result.statusCode >= 500;
    if (!retryable || attempt === delays.length) break;
    await sleep(delays[attempt]);
  }
  return { ok: false, result, attempts };
}

function createSingleFlight(factory) {
  let pending = null;
  return {
    run() {
      if (pending) return pending;
      try {
        pending = Promise.resolve(factory());
      } catch (err) {
        pending = Promise.reject(err);
      }
      const current = pending;
      current.then(
        () => { if (pending === current) pending = null; },
        () => { if (pending === current) pending = null; },
      );
      return current;
    },
    isRunning() {
      return pending !== null;
    },
  };
}

function createRendererFlushCoordinator({
  createRequestId = () => crypto.randomUUID(),
  timeoutMs = 5000,
} = {}) {
  const pendingByWebContents = new Map();

  function settle(webContentsId, ok) {
    const pending = pendingByWebContents.get(webContentsId);
    if (!pending) return false;
    pendingByWebContents.delete(webContentsId);
    clearTimeout(pending.timer);
    pending.resolve(ok === true);
    return true;
  }

  return {
    request(win, reason) {
      if (!win || win.isDestroyed?.() || win.webContents?.isDestroyed?.()) {
        return Promise.resolve(true);
      }
      const webContentsId = win.webContents.id;
      const existing = pendingByWebContents.get(webContentsId);
      if (existing) return existing.promise;

      const requestId = createRequestId();
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      const timer = setTimeout(() => settle(webContentsId, false), timeoutMs);
      timer.unref?.();
      pendingByWebContents.set(webContentsId, {
        promise,
        requestId,
        resolve,
        timer,
      });
      win.webContents.send('window:prepare-context-release', { requestId, reason });
      return promise;
    },
    handleResponse(webContentsId, payload) {
      const pending = pendingByWebContents.get(webContentsId);
      if (
        !pending
        || !payload
        || payload.requestId !== pending.requestId
        || typeof payload.ok !== 'boolean'
      ) {
        return false;
      }
      return settle(webContentsId, payload.ok);
    },
    cancel(webContentsId) {
      return settle(webContentsId, false);
    },
  };
}

/** Tracks whether a renderer can answer the awaited save barrier. Kept as a
 * separate seam because BrowserWindow `did-finish-load` precedes React effect
 * registration, and closing inside that gap must not manufacture a save
 * failure. */
function createRendererFlushReadiness() {
  let documentLoaded = false;
  let handlerReady = false;
  return {
    markDocumentLoaded() {
      documentLoaded = true;
      // A navigation/reload destroys the previous renderer's handlers. The
      // replacement must announce its own save barrier before main awaits it.
      handlerReady = false;
    },
    markHandlerReady(ready) {
      handlerReady = ready === true;
    },
    shouldRequest() {
      return documentLoaded && handlerReady;
    },
  };
}

function createNativeOpenQueueCoordinator() {
  const pendingByWebContents = new Map();
  const readyWebContents = new Set();
  const pendingStartupFiles = [];

  return {
    queueFilesForWindow(webContentsId, filePaths, sendFn) {
      if (!Array.isArray(filePaths) || filePaths.length === 0) return;
      if (readyWebContents.has(webContentsId)) {
        sendFn(filePaths);
      } else {
        const list = pendingByWebContents.get(webContentsId) ?? [];
        list.push(...filePaths);
        pendingByWebContents.set(webContentsId, list);
      }
    },
    handleStartupFiles(filePaths) {
      if (Array.isArray(filePaths)) {
        pendingStartupFiles.push(...filePaths);
      }
    },
    attachStartupFilesToWindow(webContentsId) {
      if (pendingStartupFiles.length === 0) return;
      const files = [...pendingStartupFiles];
      pendingStartupFiles.length = 0;
      const list = pendingByWebContents.get(webContentsId) ?? [];
      list.push(...files);
      pendingByWebContents.set(webContentsId, list);
    },
    markReady(webContentsId, sendFn) {
      readyWebContents.add(webContentsId);
      const pending = pendingByWebContents.get(webContentsId);
      if (pending && pending.length > 0) {
        pendingByWebContents.delete(webContentsId);
        sendFn(pending);
      }
    },
    cleanup(webContentsId) {
      readyWebContents.delete(webContentsId);
      pendingByWebContents.delete(webContentsId);
    },
    resetReadiness(webContentsId) {
      readyWebContents.delete(webContentsId);
    },
    isReady(webContentsId) {
      return readyWebContents.has(webContentsId);
    },
    getPending(webContentsId) {
      return pendingByWebContents.get(webContentsId) ?? [];
    },
  };
}

module.exports = {
  WINDOW_ID_ARG_PREFIX,
  buildElectronSmokeArgs,
  classifyProtocolLaunch,
  createApplicationMenuTemplate,
  createNativeOpenQueueCoordinator,
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
  windowIdFromArgv,
};
