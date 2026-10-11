'use strict';

// Shared JSON keeps native and renderer surfaces on one external-link source;
// this file runs unbuilt and cannot require a .ts module.
const LINKS = require('../shared/links.json');

function buildElectronSmokeArgs(platform, script, port) {
  const appArgs = [script, `--port=${port}`];
  // GitHub-hosted Linux runners cannot install Electron's chrome-sandbox
  // helper as root with mode 4755. This affects only the isolated source
  // smoke under Xvfb; production Electron launches retain their sandbox.
  return platform === 'linux' ? ['--no-sandbox', ...appArgs] : appArgs;
}

function applicationWindowChromeOptions(platform = process.platform) {
  return {
    // Linux otherwise reserves a permanent native menu strip above the
    // renderer. Keep the application menu installed for accelerators and let
    // the platform reveal it temporarily with Alt when it is needed.
    autoHideMenuBar: platform === 'linux',
    titleBarStyle: 'hiddenInset',
    // The inset shell starts every column 8px below the window top (the
    // sidebar's py-2, the inset's m-2), so the 44px (h-11) titlebar band is
    // centered at window y 30. The light group renders ~14px tall, so y
    // puts its center on that axis, level with the sidebar toggle beside
    // it.
    trafficLightPosition: { x: 14, y: 23 },
  };
}

function createApplicationMenuTemplate({
  platform = process.platform,
  onNewWindow,
  onCloseWindow,
  onOpenExternal,
  onReportBug = () => { },
  includeDeveloperTools = false,
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
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        ...(includeDeveloperTools
          ? [{ type: 'separator' }, { role: 'toggleDevTools' }]
          : []),
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    // Not `role: 'windowMenu'`: on Windows and Linux that stock menu quietly
    // adds a Close item bound to Ctrl+W, which would take the renderer's
    // close-tab chord and, with one window open, quit the app. The window
    // menu keeps only what the platform expects from it.
    {
      label: 'Window',
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : []),
      ],
    },
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
    || typeof input.key !== 'string'
  ) {
    return null;
  }

  const key = input.key.toLowerCase();
  const primary = platform === 'darwin'
    ? input.meta === true && input.control !== true
    : input.control === true && input.meta !== true;
  const shiftedPrimary = primary && input.shift === true && input.alt !== true;

  // Electron's stock View menu and Chromium both expose reload chords. A
  // reload tears down the renderer and its live edits. Recovery currently
  // remounts the React subtree; no native reload capability is exposed.
  const windowsReloadKey = platform !== 'darwin'
    && key === 'f5'
    && input.alt !== true
    && input.meta !== true;
  if ((primary && input.alt !== true && key === 'r') || windowsReloadKey) return 'block-reload';
  if (input.isAutoRepeat === true) return null;
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

function shouldQuitAfterLastWindow(platform, quitRequested = false) {
  return quitRequested || platform !== 'darwin';
}

function createWindowRegistry({ platform = process.platform } = {}) {
  const { createFilesystemPath } = require('../dist/electron/project/filesystem-path.cjs');
  const paths = createFilesystemPath({
    platform: platform === 'win32' || platform === 'darwin' ? platform : 'posix',
  });
  const folderPath = (folder) => typeof folder === 'string' && folder.trim()
    ? paths.absolute(folder) : null;
  const records = new Map();

  async function matchingWindows(folder, excludeWindowId = null) {
    const wanted = folderPath(folder);
    if (!wanted) return [];
    const matches = [];
    for (const [windowId, record] of [...records]) {
      const candidate = record.folder;
      if (windowId === excludeWindowId || !candidate) continue;
      const matchesFolder = await paths.equalAsync(candidate, wanted);
      if (matchesFolder) matches.push({ windowId, record, folder: candidate });
    }
    // Recheck every result after all probes: a later probe may yield long
    // enough for an earlier matching window to close or switch folders.
    return matches
      .filter(({ windowId, record, folder }) => records.get(windowId) === record && record.folder === folder)
      .map(({ record }) => record.win);
  }

  return {
    add(windowId, win, folder = null) {
      records.set(windowId, { win, folder: folderPath(folder) });
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
    registrationForWebContentsId(webContentsId) {
      for (const [windowId, record] of records) {
        if (record.win?.webContents?.id === webContentsId) {
          return { windowId, window: record.win };
        }
      }
      return null;
    },
    windowForId(windowId) {
      return records.get(windowId)?.win ?? null;
    },
    folderForWindow(win) {
      return records.get(this.idForWindow(win))?.folder ?? null;
    },
    setFolder(windowId, folder) {
      const record = records.get(windowId);
      if (!record) return false;
      record.folder = folderPath(folder);
      return true;
    },
    async findByFolder(folder, { excludeWindowId = null } = {}) {
      return (await matchingWindows(folder, excludeWindowId))[0] ?? null;
    },
    windowsByFolder(folder) {
      return matchingWindows(folder);
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

function isReturnUrl(value, authority) {
  if (typeof value !== 'string' || value.length > 256) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'stashbase:'
      && url.hostname === authority
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

function isOAuthReturnUrl(value) { return isReturnUrl(value, 'oauth-complete'); }
function isBillingReturnUrl(value) { return isReturnUrl(value, 'billing-return'); }

function isStashBaseProtocolUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { return new URL(value).protocol === 'stashbase:'; }
  catch { return false; }
}

function classifyProtocolLaunch(argv) {
  if (argv.some(isOAuthReturnUrl)) return 'oauth-return';
  if (argv.some(isBillingReturnUrl)) return 'billing-return';
  if (argv.some(isStashBaseProtocolUrl)) return 'inert';
  return 'ordinary';
}

// Allocation and readiness share one lane. A second request observes the first
// settled workspace, including filesystem aliases, before allocating a window.
const entryLanes = new WeakMap();
function openOrFocusFolder({ registry, folder, senderWindow, createWindow, enterFolder, signal }) {
  const previous = entryLanes.get(registry) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    signal?.throwIfAborted();
    if (senderWindow.isDestroyed?.()) throw new Error('The initiating window closed.');
    const existing = await registry.findByFolder(folder);
    signal?.throwIfAborted();
    if (focusWindow(existing)) return { ok: true, action: 'focused', win: existing };
    const target = registry.folderForWindow(senderWindow)
      ? await createWindow()
      : senderWindow;
    if (!target) throw new Error('A project window could not be created.');
    try { await enterFolder(target, folder); }
    catch (error) {
      if (target !== senderWindow && !registry.folderForWindow(target)) target.close?.();
      throw error;
    }
    registry.setFolder(registry.idForWindow(target), folder);
    focusWindow(target);
    return { ok: true, action: 'opened', win: target };
  });
  entryLanes.set(registry, operation);
  void operation.finally(() => {
    if (entryLanes.get(registry) === operation) entryLanes.delete(registry);
  }).catch(() => {});
  return operation;
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
  };
}

module.exports = {
  applicationWindowChromeOptions,
  buildElectronSmokeArgs,
  classifyProtocolLaunch,
  createApplicationMenuTemplate,
  createSingleFlight,
  createWindowRegistry,
  focusWindow,
  isOAuthReturnUrl,
  isBillingReturnUrl,
  isStashBaseProtocolUrl,
  openOrFocusFolder,
  releaseWindowContextWithRetry,
  shouldQuitAfterLastWindow,
  windowLifecycleShortcutAction,
};
