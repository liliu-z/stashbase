'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, net, protocol, session } = require('electron');

const {
  APP_ORIGIN,
  APP_URL,
  installAppProtocol,
  registerAppScheme,
} = require('../app-protocol.cjs');
const {
  applicationWindowWebPreferences,
  isAllowedApplicationUrl,
  secureApplicationWindow,
} = require('../window-security.cjs');
const { installRequestAuthorization } = require('./requests.cjs');
const { serveGalleryFixture, checkGalleryImages } = require('./gallery-smoke.cjs');

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-boundary-'));
app.setPath('userData', path.join(smokeRoot, 'profile'));
registerAppScheme(protocol);

const repositoryRoot = path.resolve(__dirname, '../..');
let projectServer;
let phase = 'app readiness';
const timeout = setTimeout(() => {
  console.error(`replacement Electron boundary smoke timed out during ${phase}`);
  app.exit(1);
}, 30_000);

app
  .whenReady()
  .then(async () => {
    let receivedProjectRequest = null;
    let projectMembers = [];
    projectServer = http.createServer((request, response) => {
      response.setHeader('Access-Control-Allow-Origin', APP_ORIGIN);
      response.setHeader('Access-Control-Allow-Headers', 'content-type');
      response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, POST');
      if (request.method === 'OPTIONS') {
        response.statusCode = 204;
        response.end();
        return;
      }
      if (serveGalleryFixture(request, response)) return;
      response.setHeader('Content-Type', 'application/json');
      receivedProjectRequest = {
        method: request.method,
        origin: request.headers.origin,
        windowId: request.headers['x-stashbase-window-id'],
      };
      response.end(JSON.stringify({ current: null, homeDir: '/project', recent: projectMembers }));
    });
    await new Promise((resolve, reject) => {
      projectServer.once('error', reject);
      projectServer.listen(0, '127.0.0.1', resolve);
    });
    const address = projectServer.address();
    assert.ok(address && typeof address === 'object');
    const serverOrigin = `http://127.0.0.1:${address.port}`;

    installAppProtocol({
      protocol,
      net,
      rendererRoot: path.join(repositoryRoot, 'dist', 'renderer'),
      serverOrigin,
    });

    const boundary = require(
      path.join(repositoryRoot, 'dist', 'electron', 'project', 'dialog.cjs'),
    );
    const externalNavigation = require(
      path.join(repositoryRoot, 'dist', 'electron', 'external-navigation', 'handler.cjs'),
    );
    const lifecycle = require(
      path.join(repositoryRoot, 'dist', 'electron', 'project', 'lifecycle.cjs'),
    );
    const workspaceSession = require(
      path.join(repositoryRoot, 'dist', 'electron', 'workspace', 'session.cjs'),
    );
    const bugReportReview = require(
      path.join(repositoryRoot, 'dist', 'electron', 'bug-report', 'review-ipc.cjs'),
    );
    const updates = require(
      path.join(repositoryRoot, 'dist', 'electron', 'updates', 'ipc.cjs'),
    );
    const windowLifecycle = require(
      path.join(repositoryRoot, 'dist', 'electron', 'window', 'lifecycle.cjs'),
    );
    const authorizedWindows = new Set();
    const openedExternalUrls = [];
    const activeFolders = new WeakMap();
    const isLiveWindow = (window) =>
      authorizedWindows.has(window) && !window.isDestroyed();
    const hasCapability = (window, capability) =>
      isLiveWindow(window) &&
      (capability === boundary.PROJECT_FOLDER_DIALOG_CAPABILITY ||
        capability === externalNavigation.EXTERNAL_NAVIGATION_CAPABILITY ||
        capability === lifecycle.PROJECT_LIFECYCLE_CAPABILITY ||
        capability === workspaceSession.WORKSPACE_SESSION_CAPABILITY ||
        capability === updates.UPDATES_CAPABILITY ||
        capability === windowLifecycle.WINDOW_LIFECYCLE_CAPABILITY);
    const windowLifecycleService = windowLifecycle.registerWindowLifecycle({
      BrowserWindow, ipcMain, expectedOrigins: new Set([APP_ORIGIN]),
      isLiveWindow, hasCapability,
    });
    // No draft is ever bound here, so every review channel must answer FORBIDDEN.
    bugReportReview.registerBugReportReviewIpc({
      ipcMain,
      bugReports: {},
      draftIdForSender: () => null,
      isReviewFrameUrl: (url) => isAllowedApplicationUrl(url, APP_ORIGIN),
      prepareApprovedReport: async () => ({ ok: false }),
      openPreparedReport: async () => ({ ok: false }),
      savePreparedReport: async () => ({ ok: false }),
    });
    boundary.registerDialog({
      BrowserWindow,
      dialog: {
        async showOpenDialog() {
          return { canceled: true, filePaths: [] };
        },
      },
      ipcMain,
      expectedOrigins: new Set([APP_ORIGIN]),
      isLiveWindow,
      hasCapability,
    });
    externalNavigation.registerExternalNavigation({
      BrowserWindow,
      ipcMain,
      expectedOrigins: new Set([APP_ORIGIN]),
      isLiveWindow,
      hasCapability,
      openExternal: async (url) => { openedExternalUrls.push(url); },
    });
    lifecycle.registerLifecycle({
      BrowserWindow,
      ipcMain,
      expectedOrigins: new Set([APP_ORIGIN]),
      isLiveWindow,
      hasCapability,
      // This harness creates its window for no folder, which is why it expects
      // the welcome screen below rather than a folder workspace.
      liveWindows: () => [...authorizedWindows].filter(isLiveWindow),
      // Required by the service and never exercised here: this smoke proves
      // the preload surface exists and is frozen, not that a second window
      // opens. Present so the dependency is total rather than latently
      // undefined, since a .cjs harness is not typechecked against the
      // service's interface.
      openFolderWindow: async (window, folder, enterFolder) => { await enterFolder(window, folder); return 'opened'; },
      setActiveFolder: (window, folder) => {
        activeFolders.set(window, folder);
        return true;
      },
      windowsForFolder: (folder) =>
        [...authorizedWindows].filter(
          (window) => isLiveWindow(window) && activeFolders.get(window) === folder,
        ),
    });
    // The state below carries diagnostics and simulation controls, so the
    // asserted snapshot is also the proof that the projection strips them.
    const updateManagerState = {
      phase: 'idle',
      currentVersion: '0.0.0-test',
      autoCheckEnabled: true,
      message: 'never shown',
      simulation: { enabled: false, value: 'off' },
    };
    updates.registerUpdatesIpc({
      BrowserWindow,
      ipcMain,
      expectedOrigins: new Set([APP_ORIGIN]),
      isLiveWindow,
      hasCapability,
      // Packaged is what this smoke represents, so the simulation channel is
      // never registered here.
      debugEnabled: false,
      manager: {
        check: async () => updateManagerState,
        getState: () => updateManagerState,
        openDownloadPage: async () => true,
        primaryAction: async () => updateManagerState,
        refreshPreference: async () => updateManagerState,
        setUpdateSimulation: () => updateManagerState,
      },
      setAutoCheck: async () => {},
      windows: () => authorizedWindows,
    });
    const sessionFile = path.join(smokeRoot, 'workspace-session.json');
    const sessionStore = workspaceSession.createWorkspaceSessionStore({ filePath: sessionFile });
    workspaceSession.registerWorkspaceSession({
      BrowserWindow,
      ipcMain,
      expectedOrigins: new Set([APP_ORIGIN]),
      isLiveWindow,
      hasCapability,
      claimRestore: (candidate) => candidate === window,
      store: sessionStore,
    });

    const webPreferences = applicationWindowWebPreferences({
      preloadPath: path.join(repositoryRoot, 'dist', 'electron', 'renderer', 'preload.cjs'),
      additionalArguments: [`--stashbase-server-origin=${serverOrigin}`],
    });
    assert.deepEqual(webPreferences, {
      preload: path.join(repositoryRoot, 'dist', 'electron', 'renderer', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      experimentalFeatures: false,
      allowRunningInsecureContent: false,
      additionalArguments: [`--stashbase-server-origin=${serverOrigin}`],
    });

    const window = new BrowserWindow({ show: false, webPreferences });
    installRequestAuthorization({
      rendererOrigins: new Set([APP_ORIGIN]),
      serverOrigin,
      session: session.defaultSession,
      windowRegistrationForWebContentsId: (webContentsId) =>
        webContentsId === window.webContents.id
          ? { windowId: 'replacement-smoke-window', window }
          : null,
    });
    authorizedWindows.add(window);
    windowLifecycleService.attach(window);
    secureApplicationWindow(window, APP_ORIGIN);
    phase = 'primary renderer load';
    await window.loadURL(APP_URL);

    phase = 'primary IPC and security checks';
    const result = await window.webContents.executeJavaScript(`
    (async () => {
      const welcomeDeadline = Date.now() + 5000;
      while (
        ![...document.querySelectorAll('button')]
          .some((button) => button.getAttribute('aria-label') === 'Open a project')
        && Date.now() < welcomeDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      delete window.__stashbaseInlineScriptRan;
      const script = document.createElement('script');
      script.textContent = 'window.__stashbaseInlineScriptRan = true';
      document.head.append(script);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const popup = window.open('https://example.com/');
      return {
        externalNavigation: await window.stashbase.externalNavigation.open('https://example.com/docs'),
        externalNavigationFrozen: Object.isFrozen(window.stashbase.externalNavigation),
        folderResult: await window.stashbase.project.chooseFolder(),
        globalKeys: Object.keys(window.stashbase),
        projectRegistrySnapshot: await fetch(
          window.stashbase.runtime.serverOrigin + '/api/projects/open',
          {
            body: JSON.stringify({ path: '/project/notes' }),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          },
        ).then((response) => response.json()),
        nodeGlobal: typeof process,
        popupDenied: popup === null,
        preloadFrozen: Object.isFrozen(window.stashbase),
        runtime: window.stashbase.runtime,
        runtimeFrozen: Object.isFrozen(window.stashbase.runtime),
        inlineScriptDenied: window.__stashbaseInlineScriptRan !== true,
        welcomeActions: [...document.querySelectorAll('button')]
          .map((button) => button.getAttribute('aria-label'))
          .filter((label) => label === 'Open a project' || label === 'Create a project')
          .sort(),
        welcomeTitle: document.querySelector('h1')?.textContent?.trim(),
        workspaceMarginLeft: getComputedStyle(
          document.querySelector('[data-slot="sidebar-inset"]'),
        ).marginLeft,
        url: location.href,
        projectKeys: Object.keys(window.stashbase.project).sort(),
        workspaceSession: await window.stashbase.workspaceSession.read(),
        workspaceSessionFrozen: Object.isFrozen(window.stashbase.workspaceSession),
        windowLifecycleFrozen: Object.isFrozen(window.stashbase.windowLifecycle),
        windowLifecycleKeys: Object.keys(window.stashbase.windowLifecycle).sort(),
        updatesFrozen: Object.isFrozen(window.stashbase.updates),
        updatesKeys: Object.keys(window.stashbase.updates).sort(),
        updatesRead: await window.stashbase.updates.read(),
      };
    })()
  `);

    assert.deepEqual(result, {
      externalNavigation: { ok: true },
      externalNavigationFrozen: true,
      folderResult: { ok: true, folderPath: null },
      globalKeys: [
        'externalNavigation',
        'runtime',
        'project',
        'textServices',
        'workspaceSession',
        'windowLifecycle',
        'updates',
      ],
      nodeGlobal: 'undefined',
      popupDenied: true,
      preloadFrozen: true,
      projectRegistrySnapshot: { current: null, homeDir: '/project', recent: [] },
      runtime: { serverOrigin },
      runtimeFrozen: true,
      inlineScriptDenied: true,
      welcomeActions: ['Create a project', 'Open a project'],
      welcomeTitle: 'StashBase',
      // A window arrives on the welcome screen with the sidebar collapsed,
      // and the collapsed rail leaves the inset its 8px margin.
      workspaceMarginLeft: '8px',
      url: APP_URL,
      projectKeys: [
        'cancelEntry',
        'chooseFolder',
        'notifyFolderRemoved',
        'onEnterFolder',
        'onEntryCancelled',
        'onFolderRemoved',
        'onPrepareFolderRemoval',
        'openFolderWindow',
        'prepareFolderRemoval',
        'setActiveFolder',
      ],
      workspaceSession: { ok: true, session: null },
      workspaceSessionFrozen: true,
      windowLifecycleFrozen: true,
      windowLifecycleKeys: ['onPrepareContextRelease', 'setAppearance'],
      updatesFrozen: true,
      updatesKeys: [
        'check',
        'onSnapshot',
        'openReleasePage',
        'primaryAction',
        'read',
        'setAutoCheck',
        'setSimulation',
      ],
      updatesRead: {
        ok: true,
        snapshot: { autoCheckEnabled: true, currentVersion: '0.0.0-test', phase: 'idle' },
      },
    });
    assert.deepEqual(openedExternalUrls, ['https://example.com/docs']);
    assert.deepEqual(receivedProjectRequest, {
      method: 'POST',
      origin: APP_ORIGIN,
      windowId: 'replacement-smoke-window',
    });
    assert.equal(activeFolders.get(window), null);

    phase = 'Gallery image loading';
    await checkGalleryImages(window, serverOrigin);

    projectMembers = [
      {
        favorite: false,
        openedAt: '2026-09-01T00:00:00.000Z',
        path: '/project/engineering-blogs',
      },
    ];
    phase = 'project list reload';
    const didReload = new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
    window.reload();
    await didReload;
    const folderCursor = await window.webContents.executeJavaScript(`
      (async () => {
        const deadline = Date.now() + 5000;
        let row;
        while (!row && Date.now() < deadline) {
          row = document.querySelector('button[title="/project/engineering-blogs"]');
          if (!row) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return row ? getComputedStyle(row).cursor : null;
      })()
    `);
    assert.equal(folderCursor, 'pointer');
    assert.equal(activeFolders.get(window), null);

    // Two real renderers keep local state, but one window's welcome-screen
    // layout write must not erase another folder's durable tab record.
    const savedSession = {
      version: 1, activeFolderPath: null,
      folders: [{
        folderPath: '/project/engineering-blogs', expandedPaths: ['drafts'],
        selectedPath: 'note.md', activeTabId: 'note', tabs: [{ id: 'note', path: 'note.md' }],
      }],
      shell: { agentPaneWidth: 576, sidebarOpen: false, sidebarWidth: 288 },
    };
    assert.deepEqual(await window.webContents.executeJavaScript(
      `window.stashbase.workspaceSession.write(${JSON.stringify(savedSession)})`,
    ), { ok: true });
    const peer = new BrowserWindow({ show: false, webPreferences });
    authorizedWindows.add(peer);
    windowLifecycleService.attach(peer);
    installRequestAuthorization({
      rendererOrigins: new Set([APP_ORIGIN]), serverOrigin, session: session.defaultSession,
      windowRegistrationForWebContentsId: (id) => {
        const candidate = [...authorizedWindows].find((item) => item.webContents.id === id);
        return candidate ? { windowId: String(id), window: candidate } : null;
      },
    });
    secureApplicationWindow(peer, APP_ORIGIN);
    phase = 'peer renderer load';
    await peer.loadURL(APP_URL);
    phase = 'two-window session persistence';
    await peer.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 5000;
      while (document.body.dataset.bootSettled !== '1' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const toggle = document.querySelector('button[aria-label="Show files sidebar"]');
      if (!toggle) throw new Error('new window did not reach Welcome');
      toggle.click();
      while (Date.now() < deadline) {
        const response = await window.stashbase.workspaceSession.read();
        if (response.session?.shell.sidebarOpen === true) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('sidebar change was not persisted');
    })()`);
    const reopenedStore = workspaceSession.createWorkspaceSessionStore({ filePath: sessionFile });
    assert.deepEqual((await reopenedStore.read()).folders, savedSession.folders);
    assert.deepEqual((await window.webContents.executeJavaScript(
      'window.stashbase.workspaceSession.read()',
    )).session, savedSession);
    assert.deepEqual((await peer.webContents.executeJavaScript(
      'window.stashbase.workspaceSession.read()',
    )).session.folders, []);
    const { runUpdateInstallSmoke } = require('./update-install-smoke.cjs');
    phase = 'two-window update barrier';
    await runUpdateInstallSmoke({
      windows: [window, peer], lifecycle: windowLifecycleService, isLiveWindow,
    });
    authorizedWindows.delete(peer);
    peer.destroy();
    console.log('real two-window session persistence smoke passed');

    const reviewWindow = new BrowserWindow({
      show: false,
      webPreferences: applicationWindowWebPreferences({
        preloadPath: path.join(
          repositoryRoot, 'dist', 'electron', 'bug-report', 'review-window-preload.cjs',
        ),
      }),
    });
    secureApplicationWindow(reviewWindow, APP_ORIGIN);
    phase = 'bug report renderer';
    await reviewWindow.loadURL(`${APP_URL}bug-report.html`);
    const reviewResult = await reviewWindow.webContents.executeJavaScript(`
      (async () => {
        const deadline = Date.now() + 5000;
        while (document.title !== 'Report a Bug' && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return {
          bridgeFrozen: Object.isFrozen(window.stashbase.bugReportReview),
          bridgeKeys: Object.keys(window.stashbase.bugReportReview).sort(),
          get: await window.stashbase.bugReportReview.get(),
          globalKeys: Object.keys(window.stashbase),
          title: document.title,
        };
      })()
    `);

    assert.deepEqual(reviewResult, {
      bridgeFrozen: true,
      bridgeKeys: [
        'discard',
        'excludeArtifact',
        'get',
        'getArtifactPreview',
        'includeArtifact',
        'openGitHub',
        'prepare',
        'reopen',
        'saveArtifacts',
        'updateDescription',
      ],
      get: {
        ok: false,
        error: { code: 'FORBIDDEN', message: 'This window cannot access a bug report review.' },
      },
      globalKeys: ['bugReportReview'],
      title: 'Report a Bug',
    });
    reviewWindow.destroy();

    console.log('replacement Electron boundary smoke passed');
    clearTimeout(timeout);
    window.destroy();
    projectServer.closeAllConnections();
    await new Promise((resolve) => projectServer.close(resolve));
    fs.rmSync(smokeRoot, { recursive: true, force: true });
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    clearTimeout(timeout);
    if (projectServer?.listening) {
      projectServer.closeAllConnections();
      projectServer.close();
    }
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    fs.rmSync(smokeRoot, { recursive: true, force: true });
    app.exit(1);
  });
