'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const {
  terminateChildProcessTree,
  waitForChildExit,
} = require('./smoke-process.cjs');
const {
  applicationWindowChromeOptions,
  buildElectronSmokeArgs,
  classifyProtocolLaunch,
  createApplicationMenuTemplate,
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
const { registerWindowLifecycle } = require('../dist/electron/window/lifecycle.cjs');
const { createWindowLifecycleUpdateBarrier } = require('./update-window-barrier.cjs');
const { createUpdateManager } = require('./update-manager.cjs');

test('Linux main windows auto-hide the native application menu bar', () => {
  assert.equal(applicationWindowChromeOptions('linux').autoHideMenuBar, true);
  assert.equal(applicationWindowChromeOptions('win32').autoHideMenuBar, false);
  assert.equal(applicationWindowChromeOptions('darwin').autoHideMenuBar, false);
});

test('smoke runner terminates and rejects a hung Electron child', async () => {
  const child = new EventEmitter();
  child.pid = 43123;
  child.exitCode = null;
  child.signalCode = null;
  let terminated = 0;

  await assert.rejects(
    waitForChildExit(child, {
      launch: 'layout',
      timeoutMs: 5,
      terminate: () => { terminated += 1; },
    }),
    /Electron smoke launch layout timed out after 5ms/,
  );
  assert.equal(terminated, 1);
});

test('smoke runner accepts a clean child exit without terminating it', async () => {
  const child = new EventEmitter();
  child.pid = 43124;
  child.exitCode = null;
  child.signalCode = null;
  let terminated = 0;

  const completed = waitForChildExit(child, {
    launch: 1,
    timeoutMs: 1000,
    terminate: () => { terminated += 1; },
  });
  child.emit('exit', 0, null);
  await completed;
  assert.equal(terminated, 0);
});

test('POSIX smoke timeout terminates the isolated Electron process group', async () => {
  const child = new EventEmitter();
  child.pid = 43125;
  child.exitCode = null;
  child.signalCode = null;
  const kills = [];

  await terminateChildProcessTree(child, 'linux', {
    killProcess: (pid, signal) => {
      kills.push([pid, signal]);
      child.exitCode = 1;
    },
  });

  assert.deepEqual(kills, [[-43125, 'SIGKILL']]);
});

test('Electron smoke disables Chromium sandbox only on Linux CI hosts', () => {
  assert.deepEqual(
    buildElectronSmokeArgs('linux', '/repo/electron/smoke.cjs', 43123),
    ['--no-sandbox', '/repo/electron/smoke.cjs', '--port=43123'],
  );
  assert.deepEqual(
    buildElectronSmokeArgs('darwin', '/repo/electron/smoke.cjs', 43123),
    ['/repo/electron/smoke.cjs', '--port=43123'],
  );
  assert.deepEqual(
    buildElectronSmokeArgs('win32', 'C:\\repo\\electron\\smoke.cjs', 43123),
    ['C:\\repo\\electron\\smoke.cjs', '--port=43123'],
  );
});

test('application menu exposes VS Code window commands on Windows and Linux', () => {
  let opened = 0;
  let closed = 0;
  const template = createApplicationMenuTemplate({
    platform: 'win32',
    onNewWindow: () => { opened += 1; },
    onCloseWindow: () => { closed += 1; },
  });
  const fileMenu = template.find((item) => item.label === 'File');
  const newWindow = fileMenu.submenu[0];

  assert.equal(newWindow.label, 'New Window');
  assert.equal(newWindow.accelerator, 'CommandOrControl+Shift+N');
  newWindow.click();
  assert.equal(opened, 1);
  const closeWindow = fileMenu.submenu.find((item) => item.label === 'Close Window');
  assert.ok(closeWindow);
  assert.equal(closeWindow.role, undefined);
  assert.equal(closeWindow.accelerator, 'Alt+F4');
  closeWindow.click();
  assert.equal(closed, 1);
  assert.equal(fileMenu.submenu.at(-1).role, 'quit');

  const linuxTemplate = createApplicationMenuTemplate({
    platform: 'linux',
    onNewWindow: () => {},
    onCloseWindow: () => {},
  });
  // Cmd/Ctrl+W belongs to the renderer's close-tab command on every platform.
  const items = (menu) => menu.flatMap((item) => [item, ...(item.submenu ? items(item.submenu) : [])]);
  for (const platform of ['win32', 'linux', 'darwin']) {
    const all = items(createApplicationMenuTemplate({
      platform,
      onNewWindow: () => {},
      onCloseWindow: () => {},
    }));
    assert.equal(all.some((item) => item.role === 'close' || item.role === 'windowMenu'), false, platform);
    assert.equal(all.some((item) => /^(Command|Control|CommandOrControl)\+W$/.test(item.accelerator ?? '')), false, platform);
  }
  const linuxCloseWindow = linuxTemplate
    .find((item) => item.label === 'File')
    .submenu.find((item) => item.label === 'Close Window');
  assert.equal(linuxCloseWindow.accelerator, 'Alt+F4');
});

test('macOS application menu keeps Cmd+W for tabs and uses Cmd+Shift+W for windows', () => {
  const template = createApplicationMenuTemplate({
    platform: 'darwin',
    onNewWindow: () => {},
    onCloseWindow: () => {},
  });
  assert.equal(template[0].role, 'appMenu');
  const closeWindow = template.find((item) => item.label === 'File').submenu.at(-1);
  assert.equal(closeWindow.label, 'Close Window');
  assert.equal(closeWindow.role, undefined);
  assert.equal(closeWindow.accelerator, 'Command+Shift+W');
});

test('application View menu has no reload bypass and exposes developer tools only in explicit Vite mode', () => {
  const baseOptions = {
    platform: 'darwin',
    onNewWindow: () => {},
    onCloseWindow: () => {},
    onOpenExternal: () => {},
  };
  const shippingView = createApplicationMenuTemplate(baseOptions)
    .find((item) => item.label === 'View');
  const shippingRoles = shippingView.submenu.map((item) => item.role).filter(Boolean);

  assert.deepEqual(shippingRoles, ['resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen']);
  assert.equal(shippingRoles.includes('reload'), false);
  assert.equal(shippingRoles.includes('forceReload'), false);
  assert.equal(shippingRoles.includes('toggleDevTools'), false);

  const developmentView = createApplicationMenuTemplate({
    ...baseOptions,
    includeDeveloperTools: true,
  }).find((item) => item.label === 'View');
  assert.equal(developmentView.submenu.some((item) => item.role === 'toggleDevTools'), true);
  assert.equal(developmentView.submenu.some((item) => item.role === 'reload'), false);
  assert.equal(developmentView.submenu.some((item) => item.role === 'forceReload'), false);
});

test('Help menu opens the shared links and is the last menu on both platforms', () => {
  const links = require('../shared/links.json');
  for (const platform of ['darwin', 'win32', 'linux']) {
    const opened = [];
    const template = createApplicationMenuTemplate({
      platform,
      onNewWindow: () => {},
      onCloseWindow: () => {},
      onOpenExternal: (url) => opened.push(url),
    });
    // `role: 'help'` is what makes macOS place it last and attach the
    // system search field; a plain `label: 'Help'` silently loses both.
    const help = template.at(-1);
    assert.equal(help.role, 'help', `${platform}: Help must be the final menu`);

    for (const [label, expected] of [
      ['StashBase Website', links.website],
      ['Community Discord', links.discord],
      ['Report an Issue', links.issues],
    ]) {
      const item = help.submenu.find((entry) => entry.label === label);
      assert.ok(item, `${platform}: Help is missing ${label}`);
      item.click();
      assert.equal(opened.at(-1), expected);
    }
    // Hard-coding a URL here would let the menu and the renderer's Discord
    // button drift to different invites — the reason links.json exists.
    assert.deepEqual(opened, [links.website, links.discord, links.issues]);
  }
});

test('application menu exposes Report a Bug from Help without coupling it to renderer UI', () => {
  let reports = 0;
  const template = createApplicationMenuTemplate({
    platform: 'linux',
    onNewWindow: () => {},
    onCloseWindow: () => {},
    onOpenExternal: () => {},
    onReportBug: () => { reports += 1; },
  });
  const helpMenu = template.find((item) => item.role === 'help');
  const reportBug = helpMenu.submenu.find((item) => item.label === 'Report a Bug…');

  assert.ok(reportBug);
  reportBug.click();
  assert.equal(reports, 1);
});

test('window lifecycle input follows the platform menu mapping without stealing tab chords', () => {
  const ctrlShiftN = {
    type: 'keyDown',
    key: 'n',
    control: true,
    meta: false,
    shift: true,
    alt: false,
  };
  const ctrlShiftW = {
    type: 'keyDown',
    key: 'w',
    control: true,
    meta: false,
    shift: true,
    alt: false,
  };

  assert.equal(windowLifecycleShortcutAction(ctrlShiftN, 'win32'), 'new-window');
  assert.equal(windowLifecycleShortcutAction(ctrlShiftN, 'linux'), 'new-window');
  assert.equal(
    windowLifecycleShortcutAction({ ...ctrlShiftN, control: false, meta: true }, 'darwin'),
    'new-window',
  );
  assert.equal(windowLifecycleShortcutAction(ctrlShiftW, 'win32'), 'close-window');
  assert.equal(windowLifecycleShortcutAction(ctrlShiftW, 'linux'), 'close-window');
  assert.equal(
    windowLifecycleShortcutAction({ ...ctrlShiftW, control: false, meta: true }, 'darwin'),
    'close-window',
  );
  assert.equal(
    windowLifecycleShortcutAction({
      type: 'keyDown',
      key: 'F4',
      control: false,
      meta: false,
      shift: false,
      alt: true,
    }, 'win32'),
    'close-window',
  );
  assert.equal(
    windowLifecycleShortcutAction({ ...ctrlShiftW, shift: false }, 'win32'),
    null,
  );
  assert.equal(
    windowLifecycleShortcutAction({ ...ctrlShiftW, type: 'keyUp' }, 'win32'),
    null,
  );
  assert.equal(
    windowLifecycleShortcutAction({ ...ctrlShiftW, alt: true }, 'linux'),
    null,
  );
  assert.equal(
    windowLifecycleShortcutAction({ ...ctrlShiftW, isAutoRepeat: true }, 'linux'),
    null,
  );
  for (const platform of ['win32', 'linux']) {
    assert.equal(
      windowLifecycleShortcutAction({ ...ctrlShiftW, key: 'r', shift: false }, platform),
      'block-reload',
    );
    assert.equal(
      windowLifecycleShortcutAction({ ...ctrlShiftW, key: 'r' }, platform),
      'block-reload',
    );
  }
  assert.equal(
    windowLifecycleShortcutAction({
      ...ctrlShiftW,
      key: 'r',
      control: false,
      meta: true,
      shift: false,
    }, 'darwin'),
    'block-reload',
  );
  assert.equal(
    windowLifecycleShortcutAction({ ...ctrlShiftW, key: 'r', shift: false, alt: true }, 'linux'),
    null,
  );
  assert.equal(
    windowLifecycleShortcutAction({
      ...ctrlShiftW, key: 'r', shift: false, isAutoRepeat: true,
    }, 'linux'),
    'block-reload',
  );
  for (const platform of ['win32', 'linux']) {
    for (const modifiers of [
      { control: false, shift: false },
      { control: false, shift: true },
      { control: true, shift: false },
    ]) {
      assert.equal(
        windowLifecycleShortcutAction({
          ...ctrlShiftW,
          key: 'F5',
          ...modifiers,
        }, platform),
        'block-reload',
      );
    }
  }
  assert.equal(
    windowLifecycleShortcutAction({
      ...ctrlShiftW, key: 'F5', control: false, shift: false, meta: false,
    }, 'darwin'),
    null,
  );
});

test('last-window behavior follows each desktop platform convention', () => {
  assert.equal(shouldQuitAfterLastWindow('darwin'), false);
  assert.equal(shouldQuitAfterLastWindow('win32'), true);
  assert.equal(shouldQuitAfterLastWindow('linux'), true);
  assert.equal(shouldQuitAfterLastWindow('darwin', true), true);
  assert.equal(shouldQuitAfterLastWindow('darwin', false), false);
});

test('folder registry finds an existing context, excludes the sender, and retires closed windows', async () => {
  const registry = createWindowRegistry({ platform: 'win32' });
  const first = { name: 'first' };
  const second = { name: 'second' };
  registry.add('window-1', first);
  registry.add('window-2', second);
  registry.setFolder('window-1', 'C:\\Users\\Ada\\Notes');

  assert.equal(registry.windowForId('window-1'), first);
  assert.equal(registry.windowForId('missing'), null);
  assert.equal(await registry.findByFolder('c:/users/ada/notes'), first);
  assert.equal(await registry.findByFolder('C:\\Users\\Ada\\Notes', { excludeWindowId: 'window-1' }), null);

  registry.remove('window-1');
  assert.equal(await registry.findByFolder('C:\\Users\\Ada\\Notes'), null);
});

test('window registry resolves main-owned request authorization records', () => {
  const registry = createWindowRegistry({ platform: 'linux' });
  const window = { webContents: { id: 41 } };
  registry.add('window-41', window);

  assert.deepEqual(registry.registrationForWebContentsId(41), {
    windowId: 'window-41',
    window,
  });
  assert.equal(registry.registrationForWebContentsId(99), null);

  registry.remove('window-41');
  assert.equal(registry.registrationForWebContentsId(41), null);
});

test('focusing an existing folder window restores it before bringing it forward', () => {
  const calls = [];
  const win = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  };

  assert.equal(focusWindow(win), true);
  assert.deepEqual(calls, ['restore', 'show', 'focus']);
});

test('OAuth return deep links have one exact, data-free authority', () => {
  assert.equal(isOAuthReturnUrl('stashbase://oauth-complete'), true);
  assert.equal(isOAuthReturnUrl('stashbase://oauth-complete/'), true);
  assert.equal(isOAuthReturnUrl('stashbase://oauth-complete?token=secret'), false);
  assert.equal(isOAuthReturnUrl('stashbase://oauth-complete#flow'), false);
  assert.equal(isOAuthReturnUrl('stashbase://oauth-complete:123'), false);
  assert.equal(isOAuthReturnUrl('stashbase://user@oauth-complete'), false);
  assert.equal(isOAuthReturnUrl('stashbase://other-action'), false);
  assert.equal(isOAuthReturnUrl('https://oauth-complete'), false);
  assert.equal(isOAuthReturnUrl('not a URL'), false);
  assert.equal(isStashBaseProtocolUrl('stashbase://other-action'), true);
  assert.equal(isStashBaseProtocolUrl('stashbase:not-a-return'), true);
  assert.equal(isStashBaseProtocolUrl('https://oauth-complete'), false);
  assert.equal(classifyProtocolLaunch(['/Applications/StashBase', 'stashbase://oauth-complete']), 'oauth-return');
  assert.equal(classifyProtocolLaunch(['/Applications/StashBase', 'stashbase://other-action']), 'inert');
  assert.equal(classifyProtocolLaunch(['/Applications/StashBase']), 'ordinary');

  const packageJson = require('../package.json');
  assert.deepEqual(packageJson.build.protocols, [{
    name: 'StashBase OAuth Return',
    schemes: ['stashbase'],
  }]);
});

test('billing return only accepts a data-free focus link', () => {
  assert.equal(classifyProtocolLaunch(['stashbase://billing-return']), 'billing-return');
  for (const url of ['stashbase://billing-return?paid=true', 'stashbase://billing-return#token',
    'stashbase://user@billing-return', 'stashbase://billing-return:123', 'stashbase://billing-return/confirm']) {
    assert.equal(classifyProtocolLaunch([url]), 'inert');
  }
});

test('folder entry focuses a matching window, including its initiating window', async () => {
  const registry = createWindowRegistry({ platform: 'linux' });
  const notes = {
    isDestroyed: () => false,
    isMinimized: () => false,
    showCalled: 0,
    focusCalled: 0,
    show() { this.showCalled += 1; },
    focus() { this.focusCalled += 1; },
  };
  const research = { name: 'research' };
  registry.add('window-notes', notes, '/work/notes');
  registry.add('window-research', research, '/work/research');
  const created = [];

  const focused = await openOrFocusFolder({
    registry,
    folder: '/work/notes',
    senderWindow: research,
    createWindow: async (folder) => { created.push(folder); return { folder }; },
  });
  assert.equal(focused.action, 'focused');
  assert.equal(notes.showCalled, 1);
  assert.equal(notes.focusCalled, 1);
  assert.deepEqual(created, []);

  const opened = await openOrFocusFolder({
    registry,
    folder: '/work/notes',
    senderWindow: notes,
    createWindow: async (folder) => {
      created.push(folder);
      return { folder };
    },
  });
  assert.equal(opened.action, 'focused');
  assert.deepEqual(created, []);
});

test('window context cleanup retries transient transport failures', async () => {
  const results = [
    { reachable: false, statusCode: 0 },
    { reachable: true, statusCode: 503 },
    { reachable: true, statusCode: 200 },
  ];
  let calls = 0;
  const result = await releaseWindowContextWithRetry(
    async () => {
      calls += 1;
      return results.shift();
    },
    { delays: [0, 0], sleep: async () => {} },
  );

  assert.equal(result.ok, true);
  assert.equal(calls, 3);
});

test('single-flight startup coalesces simultaneous initial-window requests', async () => {
  let starts = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const flight = createSingleFlight(async () => {
    starts += 1;
    await gate;
    return { id: starts };
  });

  const first = flight.run();
  const second = flight.run();
  assert.equal(starts, 1);
  release();
  assert.equal(await first, await second);

  await flight.run();
  assert.equal(starts, 2);
});

test('native activation shares pending startup and opens again after all windows close', async () => {
  // Execute the entrypoint's event registration, retaining its actual wiring
  // while replacing the native app and slow server readiness with test doubles.
  const source = fs.readFileSync(require.resolve('./main.cjs'), 'utf8');
  const start = source.indexOf("  app.on('activate', () => {");
  const end = source.indexOf("\n\n  app.on('window-all-closed'", start);
  assert.ok(start >= 0 && end > start);
  const app = new EventEmitter();
  const mainWindows = new Set();
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  let starts = 0;
  const createWindow = async () => {
    starts += 1;
    await ready;
    mainWindows.add({});
  };
  const initialWindowFlight = createSingleFlight(createWindow);
  vm.runInNewContext(source.slice(start, end), { app, mainWindows, createWindow, initialWindowFlight });
  const startup = initialWindowFlight.run();
  app.emit('activate');
  app.emit('activate');
  assert.equal(starts, 1);
  release();
  await startup;
  assert.equal(mainWindows.size, 1);
  app.emit('activate');
  assert.equal(starts, 1);
  mainWindows.clear();
  app.emit('activate');
  await initialWindowFlight.run();
  assert.equal(starts, 2);
  assert.equal(mainWindows.size, 1);
});

function updateBarrierFixture({ installUpdate = () => {} } = {}) {
  const sent = [];
  const handlers = new Map();
  const windowHandlers = new Map();
  const webContentsHandlers = new Map();
  const windows = new Set();
  let blocked = 0;
  let installs = 0;
  let requests = 0;

  function createWindow(id) {
    const frame = { url: 'app://renderer/' };
    const webContents = {
      id,
      isDestroyed: () => false,
      mainFrame: frame,
      on: (event, handler) => webContentsHandlers.set(`${id}:${event}`, handler),
      // The barrier's own messages only: the lifecycle also mirrors native
      // fullscreen on load, which these tests do not count.
      send: (channel, payload) => {
        if (channel !== 'window:fullscreen') sent.push({ id, channel, payload });
      },
    };
    let enabled = true;
    const win = {
      isEnabled: () => enabled,
      setEnabled: (value) => { enabled = value; },
      close: () => {},
      isDestroyed: () => false,
      isFullScreen: () => false,
      on: (event, handler) => windowHandlers.set(`${id}:${event}`, handler),
      webContents,
    };
    return { win, webContents, event: { sender: webContents, senderFrame: frame } };
  }

  const first = createWindow(71);
  const second = createWindow(72);
  const lifecycle = registerWindowLifecycle(
    {
      BrowserWindow: {
        fromWebContents: (candidate) => (
          [first, second].find((entry) => entry.webContents === candidate)?.win ?? null
        ),
      },
      expectedOrigins: new Set(['app://renderer']),
      hasCapability: () => true,
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      isLiveWindow: (candidate) => windows.has(candidate),
    },
    { createRequestId: () => `release-${(requests += 1)}`, timeoutMs: 1_000 },
  );

  for (const entry of [first, second]) {
    windows.add(entry.win);
    lifecycle.attach(entry.win);
    webContentsHandlers.get(`${entry.webContents.id}:did-finish-load`)();
  }

  const barrier = createWindowLifecycleUpdateBarrier({
    lifecycle: () => lifecycle,
    getWindows: () => windows,
    isLiveWindow: (win) => windows.has(win) && !win.isDestroyed(),
    onBlocked: () => {
      blocked += 1;
    },
  });

  const updater = new EventEmitter();
  updater.downloadUpdate = async () => {
    updater.emit('update-downloaded', { version: '2.1.0' });
  };
  updater.checkForUpdates = async () => {};
  const manager = createUpdateManager({
    updater,
    currentVersion: '2.0.0',
    isPackaged: true,
    readAutoCheck: async () => true,
    beforeInstall: barrier.prepare,
    afterInstallFailure: barrier.revoke,
    installUpdate: () => {
      installs += 1;
      installUpdate();
    },
    openReleasePage: async () => {},
    setTimer: (fn, delay) => ({ fn, delay, unref() {} }),
    clearTimer: () => {},
  });

  return {
    answer: async (entry, ready) => {
      const request = sent.find((message) => message.id === entry.webContents.id)?.payload;
      await handlers.get('window:context-release-ready')(entry.event, { ...request, ready });
    },
    blocked: () => blocked,
    close: (entry, closeEvent) => windowHandlers.get(`${entry.webContents.id}:close`)(closeEvent),
    first,
    installs: () => installs,
    manager,
    second,
    sent,
    updater,
  };
}

test('one refused save cancels the update install and leaves every window unapproved', async () => {
  const setup = updateBarrierFixture();
  await setup.manager.start();
  setup.updater.emit('update-available', { version: '2.1.0' });

  const acting = setup.manager.primaryAction();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(setup.sent.map((message) => message.payload.reason), [
    'update-install',
    'update-install',
  ]);

  await setup.answer(setup.first, false);
  await setup.answer(setup.second, true);
  await acting;

  assert.equal(setup.installs(), 0);
  assert.equal(setup.manager.getState().phase, 'ready');
  assert.equal(setup.blocked(), 1);

  let prevented = 0;
  setup.close(setup.second, {
    preventDefault: () => {
      prevented += 1;
    },
  });
  assert.equal(prevented, 1);
  assert.equal(setup.sent.length, 3);
  assert.equal(setup.sent.at(-1).payload.reason, 'window-close');
});

test('an install that fails after every window approved stops pre-approving their closes', async () => {
  const setup = updateBarrierFixture({
    installUpdate: () => {
      throw new Error('installer rejected');
    },
  });
  await setup.manager.start();
  setup.updater.emit('update-available', { version: '2.1.0' });

  const acting = setup.manager.primaryAction();
  await new Promise((resolve) => setImmediate(resolve));
  await setup.answer(setup.first, true);
  await setup.answer(setup.second, true);
  await acting;

  assert.equal(setup.installs(), 1);
  assert.equal(setup.blocked(), 0);
  assert.equal(setup.manager.getState().phase, 'error');
  assert.match(setup.manager.getState().message, /installer rejected/);

  let prevented = 0;
  setup.close(setup.second, {
    preventDefault: () => {
      prevented += 1;
    },
  });
  assert.equal(prevented, 1);
  assert.equal(setup.sent.length, 3);
  assert.equal(setup.sent.at(-1).payload.reason, 'window-close');
});

test('POSIX registry keeps distinct folder names with trailing spaces distinct', async () => {
  for (const platform of ['darwin', 'linux']) {
    const registry = createWindowRegistry({ platform });
    const plain = {}, spaced = {};
    registry.add('plain', plain, '/workspace/notes');
    registry.add('spaced', spaced, '/workspace/notes ');
    assert.equal(await registry.findByFolder('/workspace/notes '), spaced);
    assert.deepEqual(await registry.windowsByFolder('/workspace/notes'), [plain]);
    registry.setFolder('plain', '/workspace/other ');
    assert.equal(await registry.findByFolder('/workspace/other'), null);
  }
});

test('macOS folder matching follows real volume identity and keeps source spelling', async (t) => {
  if (process.platform !== 'darwin') return t.skip('requires a macOS filesystem');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-window-path-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'CaseFolder');
  const alias = path.join(temp, 'casefolder');
  fs.mkdirSync(root);
  const sameDirectory = fs.existsSync(alias) && fs.statSync(root).ino === fs.statSync(alias).ino;
  const registry = createWindowRegistry({ platform: 'darwin' });
  const existing = { isDestroyed: () => false, show() {}, focus() {} };
  const sender = {};
  registry.add('existing', existing, root);
  registry.add('sender', sender);
  const stat = t.mock.method(fs, 'statSync', () => { throw new Error('native matching must yield'); });
  assert.equal(await registry.findByFolder(alias), sameDirectory ? existing : null);
  assert.deepEqual(await registry.windowsByFolder(alias), sameDirectory ? [existing] : []);
  const result = await openOrFocusFolder({
    registry, folder: alias, senderWindow: sender, createWindow: async () => ({}), enterFolder: async () => {},
  });
  assert.equal(result.action, sameDirectory ? 'focused' : 'opened');
  stat.mock.restore();

  const composed = path.join(temp, 'Café'), decomposed = path.join(temp, 'Cafe\u0301');
  fs.mkdirSync(composed);
  const sameUnicodeDirectory = fs.existsSync(decomposed)
    && fs.statSync(composed).ino === fs.statSync(decomposed).ino;
  registry.setFolder('existing', composed);
  assert.equal(await registry.findByFolder(decomposed), sameUnicodeDirectory ? existing : null);
});

test('a folder lookup discards a match that changed while a later disk probe waited', async (t) => {
  if (process.platform !== 'darwin') return t.skip('requires macOS volume probes');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-window-race-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const first = path.join(temp, 'First'), second = path.join(temp, 'Second');
  fs.mkdirSync(first); fs.mkdirSync(second);
  const registry = createWindowRegistry({ platform: 'darwin' });
  registry.add('first', {}, first);
  registry.add('second', {}, second);
  let release, reached;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { reached = resolve; });
  const stat = fs.promises.stat;
  let held = false;
  t.mock.method(fs.promises, 'stat', async (...args) => {
    if (args[0] === second && !held) { held = true; reached(); await gate; }
    return stat(...args);
  });
  const pending = registry.findByFolder(first);
  await started;
  registry.setFolder('first', second);
  release();
  assert.equal(await pending, null);
});

test('Welcome is reused and concurrent entry requests wait instead of allocating duplicate windows', async () => {
  const registry = createWindowRegistry({ platform: 'linux' });
  const makeWindow = () => ({ isDestroyed: () => false, show() {}, focus() {} });
  const welcome = makeWindow();
  registry.add('welcome', welcome);
  let ready;
  let entered = 0;
  let created = 0;
  const options = {
    registry, folder: '/projects/Notes', senderWindow: welcome,
    createWindow: async () => { created++; const win = makeWindow(); registry.add(`new-${created}`, win); return win; },
    enterFolder: async () => { entered++; await new Promise((resolve) => { ready = resolve; }); },
  };
  const first = openOrFocusFolder(options);
  const second = openOrFocusFolder(options);
  await new Promise(setImmediate);
  assert.equal(entered, 1);
  assert.equal(created, 0);
  ready();
  assert.equal((await first).win, welcome);
  assert.equal((await second).action, 'focused');
  assert.equal(entered, 1);
  const next = await openOrFocusFolder({ ...options, folder: '/projects/Other', enterFolder: async () => {} });
  assert.equal(created, 1);
  assert.notEqual(next.win, welcome);
  assert.equal(registry.folderForWindow(welcome), '/projects/Notes');
});
