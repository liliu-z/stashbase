'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  terminateChildProcessTree,
  waitForChildExit,
} = require('./smoke-process.cjs');
const { createServerArguments, createServerChildEnvironment } = require('./main-probe.cjs');
const {
  WINDOW_ID_ARG_PREFIX,
  buildElectronSmokeArgs,
  classifyProtocolLaunch,
  createApplicationMenuTemplate,
  createNativeOpenQueueCoordinator,
  createRendererFlushCoordinator,
  createRendererFlushReadiness,
  createSafeReloadCoordinator,
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
} = require('./multi-window.cjs');

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

test('Electron-owned source server does not enable the Vite proxy without an inherited Vite marker', () => {
  const environment = createServerChildEnvironment({
    baseEnv: { PATH: '/test/bin' },
    packaged: false,
    packagedEnv: { STASHBASE_APP_ROOT: '/repo' },
    shutdownToken: 'shutdown-token',
    oauthReturnToken: 'oauth-token',
  });

  assert.equal(environment.STASHBASE_DEV_RUNTIME, '1');
  assert.equal(environment.STASHBASE_DEV_VITE, undefined);
  assert.equal(environment.STASHBASE_APP_ROOT, '/repo');
  assert.equal(environment.STASHBASE_SHUTDOWN_TOKEN, 'shutdown-token');
  assert.equal(environment.STASHBASE_OAUTH_RETURN_TOKEN, 'oauth-token');
});

test('Electron-owned source server preserves an explicit Vite proxy marker', () => {
  const environment = createServerChildEnvironment({
    baseEnv: { STASHBASE_DEV_VITE: '1' },
    packaged: false,
    packagedEnv: { STASHBASE_APP_ROOT: '/repo' },
    shutdownToken: 'shutdown-token',
    oauthReturnToken: 'oauth-token',
  });

  assert.equal(environment.STASHBASE_DEV_RUNTIME, '1');
  assert.equal(environment.STASHBASE_DEV_VITE, '1');
});

test('packaged server environment cannot inherit development runtime flags', () => {
  const environment = createServerChildEnvironment({
    baseEnv: {
      STASHBASE_DEV_RUNTIME: '1',
      STASHBASE_DEV_VITE: '1',
    },
    packaged: true,
    packagedEnv: { ELECTRON_RUN_AS_NODE: '1' },
    shutdownToken: 'shutdown-token',
    oauthReturnToken: 'oauth-token',
  });

  assert.equal(environment.STASHBASE_DEV_RUNTIME, undefined);
  assert.equal(environment.STASHBASE_DEV_VITE, undefined);
  assert.equal(environment.ELECTRON_RUN_AS_NODE, '1');
});

test('Electron-owned server uses a single process unless Vite explicitly needs watch mode', () => {
  const direct = createServerArguments({
    entry: '/repo/server/index.ts',
    portArgs: ['--port=4200'],
    packaged: false,
    vite: false,
  });
  const vite = createServerArguments({
    entry: '/repo/server/index.ts',
    portArgs: ['--port=4200'],
    packaged: false,
    vite: true,
  });
  const packaged = createServerArguments({
    entry: '/app/dist/server/index.mjs',
    portArgs: [],
    packaged: true,
    vite: false,
  });

  assert.deepEqual(direct, ['/repo/server/index.ts', '--port=4200']);
  assert.deepEqual(vite, ['watch', '/repo/server/index.ts', '--port=4200']);
  assert.deepEqual(packaged, ['/app/dist/server/index.mjs']);
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
});

test('folder registry finds an existing context, excludes the sender, and retires closed windows', () => {
  const registry = createWindowRegistry({ platform: 'win32' });
  const first = { name: 'first' };
  const second = { name: 'second' };
  registry.add('window-1', first);
  registry.add('window-2', second);
  registry.setFolder('window-1', 'C:\\Users\\Ada\\Notes');

  assert.equal(registry.windowForId('window-1'), first);
  assert.equal(registry.windowForId('missing'), null);
  assert.equal(registry.findByFolder('c:/users/ada/notes'), first);
  assert.equal(registry.findByFolder('C:\\Users\\Ada\\Notes', { excludeWindowId: 'window-1' }), null);

  registry.remove('window-1');
  assert.equal(registry.findByFolder('C:\\Users\\Ada\\Notes'), null);
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

test('folder action follows the user flow: focus another matching window or open a new one', async () => {
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
  assert.equal(opened.action, 'opened');
  assert.deepEqual(created, ['/work/notes']);
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

test('renderer flush coordinator waits for the matching save acknowledgement', async () => {
  const sent = [];
  const coordinator = createRendererFlushCoordinator({
    createRequestId: () => 'request-1',
    timeoutMs: 1000,
  });
  const win = {
    isDestroyed: () => false,
    webContents: {
      id: 41,
      isDestroyed: () => false,
      send: (...args) => sent.push(args),
    },
  };

  const pending = coordinator.request(win, 'window-close');
  assert.deepEqual(sent, [[
    'window:prepare-context-release',
    { requestId: 'request-1', reason: 'window-close' },
  ]]);
  assert.equal(coordinator.handleResponse(99, { requestId: 'request-1', ok: true }), false);
  assert.equal(coordinator.handleResponse(41, { requestId: 'wrong', ok: true }), false);
  assert.equal(coordinator.handleResponse(41, { requestId: 'request-1', ok: true }), true);
  assert.equal(await pending, true);
});

test('safe reload waits for save acknowledgement and coalesces simultaneous requests', async () => {
  let releaseSave;
  const save = new Promise((resolve) => { releaseSave = resolve; });
  const calls = [];
  const win = {
    isDestroyed: () => false,
    webContents: { id: 51, isDestroyed: () => false },
  };
  const coordinator = createSafeReloadCoordinator({
    requestFlush: async (_win, reason) => {
      calls.push(`flush:${reason}`);
      return save;
    },
    reloadWindow: () => calls.push('reload'),
  });

  const first = coordinator.request(win, { saveBarrierReady: true });
  const second = coordinator.request(win, { saveBarrierReady: true });
  assert.equal(first, second);
  assert.deepEqual(calls, ['flush:window-reload']);
  releaseSave(true);
  assert.deepEqual(await first, { reloaded: true, reason: null });
  assert.deepEqual(calls, ['flush:window-reload', 'reload']);
});

test('safe reload blocks failed saves and requires confirmation without a save barrier', async () => {
  const calls = [];
  const win = {
    isDestroyed: () => false,
    webContents: { id: 52, isDestroyed: () => false },
  };
  let confirm = false;
  const coordinator = createSafeReloadCoordinator({
    requestFlush: async () => false,
    confirmWithoutSaveBarrier: async () => confirm,
    reloadWindow: () => calls.push('reload'),
  });

  assert.deepEqual(
    await coordinator.request(win, { saveBarrierReady: true }),
    { reloaded: false, reason: 'save-failed' },
  );
  assert.deepEqual(
    await coordinator.request(win, { saveBarrierReady: false }),
    { reloaded: false, reason: 'unconfirmed' },
  );
  assert.deepEqual(calls, []);

  confirm = true;
  assert.deepEqual(
    await coordinator.request(win, { saveBarrierReady: false }),
    { reloaded: true, reason: null },
  );
  assert.deepEqual(calls, ['reload']);
});

test('window close does not request a save acknowledgement before the renderer installs its handler', () => {
  const readiness = createRendererFlushReadiness();
  readiness.markDocumentLoaded();
  assert.equal(readiness.shouldRequest(), false);
  readiness.markHandlerReady(true);
  assert.equal(readiness.shouldRequest(), true);
  readiness.markHandlerReady(false);
  assert.equal(readiness.shouldRequest(), false);
});

test('renderer navigation requires the replacement save handler to announce readiness', () => {
  const readiness = createRendererFlushReadiness();
  readiness.markDocumentLoaded();
  readiness.markHandlerReady(true);
  assert.equal(readiness.shouldRequest(), true);

  readiness.markDocumentLoaded();
  assert.equal(readiness.shouldRequest(), false);
});

test('preload reads and bounds the main-process window identity', () => {
  assert.equal(
    windowIdFromArgv(['electron', `${WINDOW_ID_ARG_PREFIX}window-123`]),
    'window-123',
  );
  assert.equal(windowIdFromArgv(['electron']), null);
  assert.equal(
    windowIdFromArgv([`${WINDOW_ID_ARG_PREFIX}${'x'.repeat(200)}`]).length,
    128,
  );
});

test('native-open queue coordinator isolates queues per target window and handles startup files', () => {
  const coordinator = createNativeOpenQueueCoordinator();
  const sentWin1 = [];
  const sentWin2 = [];

  // Cold startup file arrived before any window exists
  coordinator.handleStartupFiles(['/path/to/startup.md']);

  // Window 1 is created: attach startup files to it
  coordinator.attachStartupFilesToWindow(101);
  assert.deepEqual(coordinator.getPending(101), ['/path/to/startup.md']);

  // Queue a file specifically for Window 2 (not ready yet)
  coordinator.queueFilesForWindow(102, ['/path/to/target-win2.pdf'], (paths) => sentWin2.push(...paths));
  assert.deepEqual(coordinator.getPending(102), ['/path/to/target-win2.pdf']);
  assert.deepEqual(sentWin2, []);

  // Window 1 announces ready: drains ONLY Window 1's queue
  coordinator.markReady(101, (paths) => sentWin1.push(...paths));
  assert.deepEqual(sentWin1, ['/path/to/startup.md']);
  assert.deepEqual(coordinator.getPending(101), []);
  assert.deepEqual(sentWin2, []); // Window 2's queue was untouched!

  // Window 2 announces ready: drains Window 2's queue
  coordinator.markReady(102, (paths) => sentWin2.push(...paths));
  assert.deepEqual(sentWin2, ['/path/to/target-win2.pdf']);
  assert.deepEqual(coordinator.getPending(102), []);

  // While Window 1 is ready, subsequent files send immediately
  coordinator.queueFilesForWindow(101, ['/path/to/live.docx'], (paths) => sentWin1.push(...paths));
  assert.deepEqual(sentWin1, ['/path/to/startup.md', '/path/to/live.docx']);

  // Cleanup removes readiness and any pending
  coordinator.cleanup(101);
  coordinator.cleanup(102);
  assert.equal(coordinator.isReady(101), false);
  assert.equal(coordinator.isReady(102), false);
});
