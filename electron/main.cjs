/**
 * Electron main process for StashBase.
 *
 * Boots the Express server as a child process and serves the application UI
 * from its privileged app:// origin. Explicit Vite development keeps using
 * the loopback development origin. Quitting the app kills the server.
 *
 * The renderer is sandboxed; replacement capabilities cross only through the
 * bundled, typed preload bridge.
 */

const { app, BrowserWindow, dialog, ipcMain, Menu, Notification, Tray, nativeImage, nativeTheme, net, powerMonitor, protocol, session, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const { installUpdateRequestTimeout } = require('./updates/network-timeout.cjs');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readServerLogTail,
  createServerArguments,
  createServerSpawn,
  createServerChildEnvironment,
  probeServerHealth,
  readDevelopmentExternalFileToken,
  requestJson,
  startServer,
} = require('./main-probe.cjs');
const { createBugReportService } = require('./bug-report-service.cjs');
const { collectBugReportDiagnostics } = require('./bug-report-diagnostics.cjs');
const { collectRedactedApplicationLog, readApplicationLogTail } = require('./bug-report-log.cjs');
const { captureWindowScreenshot } = require('./bug-report-screenshot.cjs');
const { createBugReportHandoff } = require('./bug-report-handoff.cjs');
const { createBugReportReviewWindow } = require('./bug-report-review-window.cjs');
const { createUpdateInstaller } = require('./update-install-strategy.cjs');
const { createUpdateManager } = require('./update-manager.cjs');
const { createWindowLifecycleUpdateBarrier } = require('./update-window-barrier.cjs');
const { createWindowRestoreRecord, foldersToRestore, reopenFolders } = require('./window-restore.cjs');
const {
  APP_ORIGIN,
  APP_URL,
  installAppProtocol,
  registerAppScheme,
} = require('./app-protocol.cjs');
const {
  applicationWindowWebPreferences,
  isAllowedApplicationUrl,
  secureApplicationWindow,
} = require('./window-security.cjs');
const { installRequestAuthorization } = require('./renderer/requests.cjs');
const {
  applicationWindowChromeOptions,
  classifyProtocolLaunch,
  createApplicationMenuTemplate,
  createSingleFlight,
  createWindowRegistry,
  focusWindow,
  isOAuthReturnUrl,
  isBillingReturnUrl,
  isStashBaseProtocolUrl,
  openFolderInBackground,
  openOrFocusFolder,
  releaseWindowContextWithRetry,
  shouldQuitAfterLastWindow,
  windowLifecycleShortcutAction,
} = require('./multi-window.cjs');

registerAppScheme(protocol);

function parsePortArg(argv, fallback) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--port=')) return Number(a.slice(7)) || fallback;
    if (a === '--port') return Number(argv[i + 1]) || fallback;
  }
  return fallback;
}
const SERVER_PORT = parsePortArg(process.argv.slice(1), 8090);

function statIsFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

let serverLogPath = null;

function getServerLogPath() {
  if (serverLogPath) return serverLogPath;
  // An overridden data root is an isolated launch (tests, profiling). Its log
  // stays inside that root: on macOS Electron's log directory ignores HOME, so
  // the default would truncate the real app's log.
  const isolatedRoot = process.env.STASHBASE_LOCAL_DATA_ROOT?.trim();
  if (isolatedRoot) {
    serverLogPath = path.join(path.resolve(isolatedRoot), 'logs', 'server.log');
    return serverLogPath;
  }
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

function stopSpawnedServer(proc) {
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
const USE_DEV_VITE = !app.isPackaged && process.env.STASHBASE_DEV_VITE === '1';
const RENDERER_ORIGIN = USE_DEV_VITE ? SERVER_URL : APP_ORIGIN;
const SERVER_PROTOCOL_VERSION = 1;
const SERVER_SHUTDOWN_TOKEN = crypto.randomBytes(32).toString('hex');
const OAUTH_RETURN_TOKEN = crypto.randomBytes(32).toString('hex');
const EXTERNAL_FILE_TOKEN = crypto.randomBytes(32).toString('hex');
const PROJECT_ROOT = app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..');
const SERVER_ENTRY = app.isPackaged
  ? path.join(PROJECT_ROOT, 'dist', 'server', 'index.mjs')
  : path.join(PROJECT_ROOT, 'server', 'index.ts');
const RESOURCES_ROOT = app.isPackaged ? process.resourcesPath : PROJECT_ROOT;

const { createNativeDiagnostics, telemetryAvailable } = require('../dist/electron/diagnostics/native.cjs');
const { attachWindowDiagnostics, attachChildProcessDiagnostics } = require('./renderer/lifecycle-diagnostics.cjs');
const appSessionId = crypto.randomUUID();
let hostInstanceId;
const nativeDiagnostics = createNativeDiagnostics({ available: telemetryAvailable(), distribution: app.isPackaged ? 'packaged' : 'source', version: app.getVersion() });
process.on('uncaughtExceptionMonitor', (error) => nativeDiagnostics.record(error, 'uncaught', { process: 'electron-main', app_session_id: appSessionId }));
attachChildProcessDiagnostics(app, { appSessionId, hostInstanceId: () => hostInstanceId,
  record: (...args) => nativeDiagnostics.record(...args) });
let serverProc = null;
let serverStartPromise = null;
let preparationStorageWarning = null;
let authNetworkBridge = null;
const mainWindows = new Set();
let quitRequested = false;
const bugReportReviewWindows = new Set();
const bugReportReviewDraftBySender = new Map();
const windowRegistry = createWindowRegistry({ platform: process.platform });
const replacementWindowCapabilities = new WeakMap();
let projectFolderDialogCapability = null;
let projectLifecycleCapability = null;
let workspaceSessionCapability = null;
let windowLifecycleCapability = null;
let externalNavigationCapability = null;
let externalFilesCapability = null;
let updatesCapability = null;
let textServicesCapability = null;
let notificationsCapability = null;
let scheduledTasksCapability = null;
let replacementWindowLifecycle = null;
let replacementAppearance = null;
let replacementEditableContextMenu = null;
let replacementUpdates = null;
let replacementScheduledTasks = null;
let scheduledTaskScheduler = null;
// Windows a scheduled run opened without showing them. Each is revealed,
// still without taking focus, the next time the reader comes back to StashBase.
const backgroundWindows = new Set();
let workspaceSessionRestoreWindow = null;
// Windows a launch reopened a project in also restore that project's tabs.
const reopenedProjectWindows = new WeakSet();
let projectEntry = null;
let replacementBoundaryInstalled = false;

// The review page is the renderer's own `bug-report.html`. It loads from the
// same origin the workspace does: the Vite dev origin while the development
// server owns the renderer, `app://renderer` in every other launch.
const BUG_REPORT_REVIEW_URL = USE_DEV_VITE
  ? `${SERVER_URL}/bug-report.html`
  : `${APP_URL}bug-report.html`;

function isBugReportReviewFrameUrl(url) {
  if (typeof url !== 'string') return false;
  return isAllowedApplicationUrl(url, RENDERER_ORIGIN);
}

function installReplacementBoundary() {
  if (replacementBoundaryInstalled) return;
  installAppProtocol({
    protocol,
    net,
    rendererRoot: path.join(PROJECT_ROOT, 'dist', 'renderer'),
    serverOrigin: SERVER_URL,
  });
  const boundary = require(path.join(
    PROJECT_ROOT,
    'dist',
    'electron',
    'project',
    'dialog.cjs',
  ));
  const externalNavigation = require(path.join(
    PROJECT_ROOT,
    'dist',
    'electron',
    'external-navigation',
    'handler.cjs',
  ));
  const externalFiles = require(path.join(
    PROJECT_ROOT,
    'dist',
    'electron',
    'external-files',
    'handler.cjs',
  ));
  const lifecycle = require(path.join(
    PROJECT_ROOT,
    'dist',
    'electron',
    'project',
    'lifecycle.cjs',
  ));
  const workspaceSession = require(path.join(
    PROJECT_ROOT,
    'dist',
    'electron',
    'workspace',
    'session.cjs',
  ));
  const windowLifecycle = require(path.join(
    PROJECT_ROOT,
    'dist',
    'electron',
    'window',
    'lifecycle.cjs',
  ));
  const bugReportReview = require(path.join(
    PROJECT_ROOT,
    'dist',
    'electron',
    'bug-report',
    'review-ipc.cjs',
  ));
  const windowAppearance = require(path.join(
    PROJECT_ROOT,
    'dist',
    'electron',
    'window',
    'appearance.cjs',
  ));
  const textServices = require(path.join(
    PROJECT_ROOT,
    'dist',
    'electron',
    'text-services',
    'ipc.cjs',
  ));
  const { listSystemFonts } = require(path.join(
    PROJECT_ROOT,
    'dist',
    'electron',
    'text-services',
    'system-fonts.cjs',
  ));
  replacementEditableContextMenu = require(path.join(
    PROJECT_ROOT,
    'dist',
    'electron',
    'text-services',
    'context-menu.cjs',
  )).editableContextMenu;
  const updates = require(path.join(
    PROJECT_ROOT,
    'dist',
    'electron',
    'updates',
    'ipc.cjs',
  ));
  const notifications = require(path.join(PROJECT_ROOT, 'dist', 'electron', 'notifications', 'ipc.cjs'));
  const nativeNotifications = require(path.join(PROJECT_ROOT, 'dist', 'electron', 'notifications', 'native.cjs'))
    .createNativeNotifications({ platform: process.platform, app, Notification,
      desktop: process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || '',
      openExternal: (url) => shell.openExternal(url),
    });
  notificationsCapability = notifications.NOTIFICATIONS_CAPABILITY;
  const notificationService = notifications.registerNotifications({
    BrowserWindow, ipcMain,
    expectedOrigins: new Set([RENDERER_ORIGIN]),
    isLiveWindow: (win) => isLiveMainWindow(win),
    hasCapability: (win, capability) => replacementWindowCapabilities.get(win)?.has(capability) === true,
    filePath: path.join(app.getPath('userData'), 'notifications.json'),
    supported: nativeNotifications.supported,
    settingsTarget: nativeNotifications.settingsTarget,
    openSettings: nativeNotifications.openSettings,
    indicators: require(path.join(PROJECT_ROOT, 'dist/electron/notifications/indicators.cjs')).createDesktopIndicators({
      platform: process.platform, app, Tray, Menu,
      image: (file) => nativeImage.createFromPath(file),
      iconDirectory: path.join(PROJECT_ROOT, 'electron/notifications/icons'),
      windows: () => [...mainWindows],
      openApp: () => { if (!focusLastMainWindow()) void initialWindowFlight.run(); },
      report: (error) => console.warn('[electron] Desktop status indicator unavailable', error),
    }),
    isAppFocused: () => BrowserWindow.getFocusedWindow() !== null,
    createNotification: nativeNotifications.create,
  });
  app.once('will-quit', () => notificationService.dispose());
  const scheduledTasks = require(path.join(
    PROJECT_ROOT,
    'dist',
    'electron',
    'scheduled-tasks',
    'ipc.cjs',
  ));
  const { createScheduleServer, createScheduledTaskScheduler } = require(path.join(
    PROJECT_ROOT,
    'dist',
    'electron',
    'scheduled-tasks',
    'scheduler.cjs',
  ));
  projectFolderDialogCapability = boundary.PROJECT_FOLDER_DIALOG_CAPABILITY;
  projectLifecycleCapability = lifecycle.PROJECT_LIFECYCLE_CAPABILITY;
  workspaceSessionCapability = workspaceSession.WORKSPACE_SESSION_CAPABILITY;
  windowLifecycleCapability = windowLifecycle.WINDOW_LIFECYCLE_CAPABILITY;
  externalNavigationCapability = externalNavigation.EXTERNAL_NAVIGATION_CAPABILITY;
  externalFilesCapability = externalFiles.EXTERNAL_FILES_CAPABILITY;
  updatesCapability = updates.UPDATES_CAPABILITY;
  textServicesCapability = textServices.TEXT_SERVICES_CAPABILITY;
  scheduledTasksCapability = scheduledTasks.SCHEDULED_TASKS_CAPABILITY;
  bugReportReview.registerBugReportReviewIpc({
    ipcMain,
    bugReports,
    draftIdForSender: (senderWebContentsId) => (
      bugReportReviewDraftBySender.get(senderWebContentsId) ?? null
    ),
    prepareApprovedReport: (snapshot) => bugReportHandoff.prepare(snapshot),
    openPreparedReport: (snapshot) => bugReportHandoff.openGitHub(snapshot),
    savePreparedReport: (snapshot) => bugReportHandoff.saveToDownloads(snapshot),
    isReviewFrameUrl: (url) => isBugReportReviewFrameUrl(url),
  });
  externalNavigation.registerExternalNavigation({
    BrowserWindow,
    ipcMain,
    expectedOrigins: new Set([RENDERER_ORIGIN]),
    isLiveWindow: (win) => isLiveMainWindow(win),
    hasCapability: (win, capability) => (
      replacementWindowCapabilities.get(win)?.has(capability) === true
    ),
    openExternal: (url) => shell.openExternal(url),
  });
  // A dropped file reaches the server only through main: preload reads the
  // path off the File, main stamps this window's identity, and the
  // process-private token keeps other local clients from granting reads.
  externalFiles.registerExternalFiles({
    BrowserWindow,
    ipcMain,
    expectedOrigins: new Set([RENDERER_ORIGIN]),
    isLiveWindow: (win) => isLiveMainWindow(win),
    hasCapability: (win, capability) => (
      replacementWindowCapabilities.get(win)?.has(capability) === true
    ),
    windowIdFor: (win) => windowRegistry.idForWindow(win) ?? null,
    register: async (windowId, filePath) => {
      const body = JSON.stringify({ path: filePath });
      const send = (token) => requestJson(SERVER_PORT, '/api/internal/external-files', 10_000, {
        method: 'POST',
        headers: {
          'content-length': Buffer.byteLength(body),
          'content-type': 'application/json',
          'x-stashbase-external-file-token': token,
          'x-stashbase-window-id': windowId,
        },
        body,
      });
      let result = await send(EXTERNAL_FILE_TOKEN);
      // A source launch may have reused a development server it did not
      // start; that server left its own token for main instead.
      const developmentToken = !app.isPackaged && result.statusCode === 403
        ? readDevelopmentExternalFileToken()
        : null;
      if (developmentToken) result = await send(developmentToken);
      return result.reachable && result.statusCode === 200 ? result.body : null;
    },
  });
  boundary.registerDialog({
    BrowserWindow,
    dialog,
    ipcMain,
    expectedOrigins: new Set([RENDERER_ORIGIN]),
    isLiveWindow: (win) => isLiveMainWindow(win),
    hasCapability: (win, capability) => (
      replacementWindowCapabilities.get(win)?.has(capability) === true
    ),
  });
  projectEntry = lifecycle.registerLifecycle({
    BrowserWindow,
    ipcMain,
    expectedOrigins: new Set([RENDERER_ORIGIN]),
    isLiveWindow: (win) => isLiveMainWindow(win),
    hasCapability: (win, capability) => (
      replacementWindowCapabilities.get(win)?.has(capability) === true
    ),
    liveWindows: () => [...mainWindows].filter((win) => isLiveMainWindow(win)),
    // A folder already showing somewhere is focused rather than opened twice,
    // which is the same rule the File menu and the protocol launch follow.
    openFolderWindow: async (win, folder, enterFolder, signal) => {
      const result = await openOrFocusFolder({
        createWindow,
        enterFolder,
        signal,
        folder,
        registry: windowRegistry,
        senderWindow: win,
      });
      rememberOpenProjects();
      return result.ok ? result.action : null;
    },
    setActiveFolder: (win, folder) => {
      const windowId = windowRegistry.idForWindow(win);
      const recorded = windowId ? windowRegistry.setFolder(windowId, folder) : false;
      if (recorded) rememberOpenProjects();
      return recorded;
    },
    windowsForFolder: async (folder) => (await windowRegistry.windowsByFolder(folder))
      .filter((win) => isLiveMainWindow(win)),
  });
  workspaceSession.registerWorkspaceSession({
    BrowserWindow,
    ipcMain,
    expectedOrigins: new Set([RENDERER_ORIGIN]),
    isLiveWindow: (win) => isLiveMainWindow(win),
    hasCapability: (win, capability) => (
      replacementWindowCapabilities.get(win)?.has(capability) === true
    ),
    claimRestore: (win) => win === workspaceSessionRestoreWindow || reopenedProjectWindows.has(win),
    store: workspaceSession.createWorkspaceSessionStore({
      filePath: path.join(app.getPath('userData'), 'workspace-session.json'),
    }),
  });
  replacementAppearance = windowAppearance.registerAppearance({
    allWindows: () => BrowserWindow.getAllWindows(),
    BrowserWindow,
    ipcMain,
    nativeTheme,
    platform: process.platform,
    spellchecker: session.defaultSession,
    expectedOrigins: new Set([RENDERER_ORIGIN]),
    isLiveWindow: (win) => isLiveMainWindow(win),
    hasCapability: (win, capability) => (
      replacementWindowCapabilities.get(win)?.has(capability) === true
    ),
    filePath: path.join(app.getPath('userData'), 'appearance.json'),
  });
  textServices.registerTextServices({
    BrowserWindow,
    ipcMain,
    expectedOrigins: new Set([RENDERER_ORIGIN]),
    isLiveWindow: (win) => isLiveMainWindow(win),
    hasCapability: (win, capability) => (
      replacementWindowCapabilities.get(win)?.has(capability) === true
    ),
    listFonts: () => listSystemFonts(process.platform),
    spellcheckLanguages: () => session.defaultSession.availableSpellCheckerLanguages,
  });
  replacementWindowLifecycle = windowLifecycle.registerWindowLifecycle({
    onCloseBlocked: () => { quitRequested = false; },
    beforeClose: async (win) => {
      const windowId = windowRegistry.idForWindow(win);
      if (windowId) await requestWindowContextRelease(windowId);
    },
    BrowserWindow,
    ipcMain,
    expectedOrigins: new Set([RENDERER_ORIGIN]),
    isLiveWindow: (win) => isLiveMainWindow(win),
    hasCapability: (win, capability) => (
      replacementWindowCapabilities.get(win)?.has(capability) === true
    ),
  });
  replacementUpdates = updates.registerUpdatesIpc({
    BrowserWindow,
    ipcMain,
    expectedOrigins: new Set([RENDERER_ORIGIN]),
    isLiveWindow: (win) => isLiveMainWindow(win),
    hasCapability: (win, capability) => (
      replacementWindowCapabilities.get(win)?.has(capability) === true
    ),
    // The simulation channel is registered only here, so a packaged build has
    // no handler for it to reach at all.
    debugEnabled: !app.isPackaged,
    manager: desktopUpdates,
    onDiagnostic: (error, action) => nativeDiagnostics.record(error, 'app-update', { action, process: 'electron-main' }),
    windows: () => mainWindows,
    setAutoCheck: writeAutoUpdatePreference,
  });
  replacementScheduledTasks = scheduledTasks.registerScheduledTasksIpc({
    BrowserWindow,
    ipcMain,
    expectedOrigins: new Set([RENDERER_ORIGIN]),
    isLiveWindow: (win) => isLiveMainWindow(win),
    hasCapability: (win, capability) => (
      replacementWindowCapabilities.get(win)?.has(capability) === true
    ),
    showsFolder: async (win, folder) => (await windowRegistry.windowsByFolder(folder)).includes(win),
    runNow: (win, folder, taskId) => scheduledTaskScheduler.runNow(folder, taskId, win),
  });
  scheduledTaskScheduler = createScheduledTaskScheduler({
    server: createScheduleServer(SERVER_URL),
    dispatch: dispatchScheduledRun,
    // An update install closes every window; nothing new starts meanwhile.
    paused: () => desktopUpdateWindows.isActive(),
    onDiagnostic: (error, action) => nativeDiagnostics.record(error, 'scheduled-task', { action, process: 'electron-main' }),
  });
  replacementBoundaryInstalled = true;
}

// A scheduled run behaves as if the reader opened a new chat in the project
// and sent the request: in the project's own window, which is opened in the
// background when there is none. The window starts the chat through its
// ordinary send path and answers whether that worked.
async function dispatchScheduledRun({ folderPath, runId, task, title, window }) {
  let target = window;
  if (!target) {
    const opened = await openFolderInBackground({
      createWindow: () => createWindow({ background: true }),
      enterFolder: (win, folder) => projectEntry.enterFolder(win, folder),
      folder: folderPath,
      registry: windowRegistry,
    });
    target = opened.win;
  }
  if (!isLiveMainWindow(target)) {
    return { reason: 'The project window closed before the chat started.', status: 'failed' };
  }
  return replacementScheduledTasks.request(target, {
    agent: task.agent,
    files: task.files,
    folderPath,
    prompt: task.prompt,
    runId,
    taskId: task.id,
    title,
  });
}

// Coming back to StashBase shows what scheduled runs opened meanwhile, behind
// whatever the reader is looking at, without moving focus.
function revealBackgroundWindows() {
  const focused = BrowserWindow.getFocusedWindow();
  let revealed = false;
  for (const win of [...backgroundWindows]) {
    backgroundWindows.delete(win);
    if (!isLiveMainWindow(win) || win.isVisible()) continue;
    win.showInactive();
    revealed = true;
  }
  // Showing a window can order it above the one just focused; keep the
  // reader's own window in front.
  if (revealed && focused && !focused.isDestroyed()) focused.moveTop();
}
let lastMainWindow = null;

// The projects the next launch reopens. Quitting and installing an update
// close every window; the record keeps what those windows showed instead of
// following them closed. Nothing is recorded until the launch has read it.
let windowRestore = null;
let windowRestoreReady = false;

function windowRestoreRecord() {
  windowRestore ??= createWindowRestoreRecord({
    filePath: path.join(app.getPath('userData'), 'window-restore.json'),
  });
  return windowRestore;
}

function rememberOpenProjects(closing = null) {
  if (!windowRestoreReady || quitRequested || desktopUpdateWindows.isActive()) return;
  windowRestoreRecord().write(foldersToRestore({
    windows: [...mainWindows].filter((win) => win === closing || isLiveMainWindow(win)),
    folderFor: (win) => windowRegistry.folderForWindow(win),
    focused: lastMainWindow,
    closing,
  }));
}

async function openInitialWindows() {
  const folders = windowRestoreRecord().read();
  const firstWindow = await initialWindowFlight.run();
  try {
    if (!projectEntry || folders.length === 0) return;
    await reopenFolders({
      folders,
      firstWindow,
      createWindow: () => createWindow({ reopensProject: true }),
      enterFolder: async (win, folder) => {
        await projectEntry.enterFolder(win, folder);
        windowRegistry.setFolder(windowRegistry.idForWindow(win), folder);
      },
      isLive: (win) => isLiveMainWindow(win),
      onFailure: (_folder, error) => {
        console.warn(`[electron] a project from the last session could not be reopened: ${error?.message ?? error}`);
      },
    });
  } finally {
    windowRestoreReady = true;
    rememberOpenProjects();
  }
}

async function readAutoUpdatePreference() {
  const response = await fetch(`${SERVER_URL}/api/updates/preferences`);
  if (!response.ok) throw new Error(`Update preferences returned HTTP ${response.status}`);
  const preferences = await response.json();
  return preferences?.autoCheck === true;
}

// Main owns this write because it already owns the read, which keeps the
// renderer on one transport and makes turning the preference on an atomic
// write-then-refresh rather than two independent round trips.
async function writeAutoUpdatePreference(enabled) {
  const response = await fetch(`${SERVER_URL}/api/updates/preferences`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ autoCheck: enabled === true }),
  });
  if (!response.ok) throw new Error(`Update preferences returned HTTP ${response.status}`);
}

let relaunchAfterServerExit = false;
const installDesktopUpdate = createUpdateInstaller({
  updater: autoUpdater,
  app,
  platform: process.platform,
  appImagePath: process.env.APPIMAGE || null,
  fileExists: fs.existsSync,
  onInstalledWithoutRelaunch: () => { relaunchAfterServerExit = true; },
});

const desktopUpdateWindows = createWindowLifecycleUpdateBarrier({
  lifecycle: () => replacementWindowLifecycle,
  getWindows: () => mainWindows,
  isLiveWindow: (win) => isLiveMainWindow(win),
  onBlocked: () => showUpdateInstallBlocked(),
});

installUpdateRequestTimeout(autoUpdater.httpExecutor);
const desktopUpdates = createUpdateManager({
  updater: autoUpdater,
  currentVersion: app.getVersion(),
  isPackaged: app.isPackaged,
  readAutoCheck: readAutoUpdatePreference,
  // Every live window releases its unsaved work before an update closes it;
  // one refusal cancels the install and leaves the download ready for retry.
  beforeInstall: desktopUpdateWindows.prepare,
  afterInstallFailure: desktopUpdateWindows.revoke,
  installUpdate: installDesktopUpdate,
  openReleasePage: (url) => openHttpExternal(url, 'update release URL'),
  onStateChange: (state) => replacementUpdates?.publish(state),
  onDiagnostic: (error, context, severity) => nativeDiagnostics.record(error, 'app-update', { ...context, process: 'electron-main' }, severity),
  debugEnabled: !app.isPackaged,
});
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

function localBin(name) {
  return path.join(PROJECT_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
}

/** Construct the owned server child; readiness and port arbitration live in main-probe. */
function spawnServer(instanceId) {
  hostInstanceId = instanceId;
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
  // Packaged builds ship the PyInstaller --onedir index daemon under
  // `process.resourcesPath` (electron-builder `extraResources`) as
  // `sidecar/stashbase-daemon/stashbase-daemon` (outer name = dir, inner
  // name = executable), and no Python interpreter. Stat it as a *file*:
  // spawning the outer directory by mistake yields EACCES with no useful
  // hint. In dev the server runs the daemon script with the local venv.
  const daemonExe = process.platform === 'win32' ? 'stashbase-daemon.exe' : 'stashbase-daemon';
  const packagedDaemon = path.join(RESOURCES_ROOT, 'python', 'sidecar', 'stashbase-daemon', daemonExe);
  if (app.isPackaged) {
    if (!statIsFile(SERVER_ENTRY)) {
      throw new Error(`Packaged server entry is missing: ${SERVER_ENTRY}`);
    }
    if (!statIsFile(packagedDaemon)) {
      throw new Error(
        'Packaged Python daemon is missing. Rebuild with `pnpm build:python-sidecar` and package again.\n' +
        `Looked for: ${packagedDaemon}`,
      );
    }
  }
  const packagedEnv = app.isPackaged
    ? {
      ELECTRON_RUN_AS_NODE: '1',
      STASHBASE_APP_ROOT: PROJECT_ROOT,
      STASHBASE_PACKAGED: '1',
      STASHBASE_RESOURCES_PATH: RESOURCES_ROOT,
      STASHBASE_DAEMON_BIN: packagedDaemon,
    }
    : { STASHBASE_APP_ROOT: PROJECT_ROOT, STASHBASE_PACKAGED: '0' };
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
        fs.writeSync(logFd, `daemon: ${packagedDaemon}\n`);
        fs.writeSync(logFd, 'PDF/OCR component: installed on demand by the server\n');
      }
    } catch (err) {
      console.warn(`[electron] application log unavailable: ${err?.message ?? err}`);
      if (logFd !== null) {
        try { fs.closeSync(logFd); } catch { /* nothing left to close */ }
      }
      logFd = null;
    }
  }
  const serverSpawn = createServerSpawn({ command: serverBin, args: serverArgs });
  serverProc = spawn(serverSpawn.command, serverSpawn.args, {
    cwd: serverCwd,
    // Port flows via the CLI arg above, not the env — keeps the server
    // entry's argv parser the single source of truth for port config.
    env: createServerChildEnvironment({
      baseEnv: process.env,
      packaged: app.isPackaged,
      packagedEnv,
      shutdownToken: SERVER_SHUTDOWN_TOKEN,
      oauthReturnToken: OAUTH_RETURN_TOKEN,
      externalFileToken: EXTERNAL_FILE_TOKEN,
      instanceId,
      authNetwork: authNetworkBridge,
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
    shell: serverSpawn.shell,
  });
  if (logFd !== null) {
    try { fs.closeSync(logFd); } catch { /* child owns its duplicate */ }
  }
  // `spawn` can fail asynchronously (ENOENT when tsx isn't installed,
  // permission errors, etc.). Without an explicit listener Node treats
  // the 'error' event as fatal and the whole Electron process crashes
  // with an unhelpful stack — surface a useful message instead.
  serverProc.on('error', (err) => {
    nativeDiagnostics.record(err, 'startup', { process: 'host', stage: 'spawn', host_instance_id: instanceId, app_session_id: appSessionId });
    console.warn(`[electron] server spawn failed: ${err.message}`);
    if (err.code === 'ENOENT') {
      console.warn(`[electron]   couldn't find ${serverBin}. ` +
        `Run \`pnpm install\` to populate node_modules/.bin.`);
    }
  });
  const child = serverProc;
  child.on('exit', (code, signal) => {
    if (serverProc === child) authNetworkBridge?.cancelPending();
    const unexpected = !quitRequested;
    nativeDiagnostics.record({ message: unexpected ? 'Host process exited unexpectedly' : 'Host process exited', exitCode: code, signal,
      ...(unexpected ? { stderr: readServerLogTail(getServerLogPath()) } : {}) }, 'host-lifecycle',
      { process: 'host', stage: 'exit', reason: unexpected ? 'unexpected_exit' : 'app_shutdown', host_instance_id: instanceId,
        app_session_id: appSessionId, ...(child.pid ? { pid: child.pid } : {}) }, unexpected ? 'error' : 'info');
    if (serverProc === child) serverStartPromise = null;
    if (code != null && code !== 0) {
      console.warn(`[electron] server exited with code ${code}`);
    }
  });
  return serverProc;
}

async function startOrReuseServer() {
  let spawnedChild = null;
  try {
    if (!authNetworkBridge) {
      const { createAuthNetworkBridge } = require('../dist/electron/account/auth-network.cjs');
      // An isolated in-memory session follows OS proxy/PAC changes without
      // sharing renderer cookies, request hooks, or authentication storage.
      const authSession = session.fromPartition('stashbase-account-network', { cache: false });
      await authSession.setProxy({ mode: 'system' });
      authNetworkBridge = await createAuthNetworkBridge({ fetch: (url, init) => authSession.fetch(url, init) });
    }
    const child = await startServer({
      packaged: app.isPackaged,
      port: SERVER_PORT,
      probe: (instanceId, timeoutMs = 300) => probeServer(SERVER_PORT, timeoutMs, instanceId),
      onReady: (health) => { hostInstanceId = health.instanceId; preparationStorageWarning = health.preparationStorageWarning ?? null; },
      spawn: (instanceId) => { spawnedChild = spawnServer(instanceId); return spawnedChild; },
    });
    if (!child) console.log(`[electron] reusing existing server at ${SERVER_URL}`);
  } catch (err) {
    stopSpawnedServer(spawnedChild);
    throw Object.assign(new Error(appendServerLogHint(err?.message ?? String(err)), { cause: err }), { startupContext: err?.startupContext });
  }
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

function probeServer(port, timeoutMs, instanceId) {
  return probeServerHealth(port, timeoutMs, {
    protocolVersion: SERVER_PROTOCOL_VERSION, appRoot: PROJECT_ROOT,
    resourcesPath: RESOURCES_ROOT, instanceId,
  });
}

function isHttpUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'http:' || url.protocol === 'https:';
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

async function showMainProcessMessage(win, options) {
  try {
    if (isLiveMainWindow(win)) await dialog.showMessageBox(win, options);
    else await dialog.showMessageBox(options);
  } catch {
    // A native dialog is best effort and must not affect the caller's cleanup.
  }
}

async function showBugReportError(win, message) {
  await showMainProcessMessage(win, { type: 'error', title: 'Report a Bug', message });
}

async function showUpdateInstallBlocked() {
  await showMainProcessMessage(preferredMainWindow(), {
    type: 'info',
    title: 'Update Not Installed',
    message:
      'StashBase kept the downloaded update because a window still has unsaved work. '
      + 'Save or discard those changes, then install the update again.',
  });
}

// The boundary is installed before any window opens; the fallback covers
// only a window created without it, which then follows the light default.
function windowBackgroundColor() {
  return replacementAppearance?.backgroundColor() ?? '#fafafa';
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
      backgroundColor: windowBackgroundColor(),
      sourceWindow: isLiveMainWindow(win) ? win : null,
      preloadPath: path.join(
        PROJECT_ROOT,
        'dist',
        'electron',
        'bug-report',
        'review-window-preload.cjs',
      ),
      appUrl: BUG_REPORT_REVIEW_URL,
      appOrigin: RENDERER_ORIGIN,
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
    if (mainWindows.size === 0 && bugReportReviewWindows.size === 0 && shouldQuitAfterLastWindow(process.platform, quitRequested)) {
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

async function createWindow({ background = false, reopensProject = false } = {}) {
  if (desktopUpdateWindows.isActive()) return;
  try {
    await ensureServer();
  } catch (err) {
    nativeDiagnostics.record({ message: err?.message ?? String(err), cause: err, stderr: readServerLogTail(getServerLogPath()) }, 'startup', { process: 'host', stage: 'ready', ...err?.startupContext });
    const message = String(err?.message ?? err);
    // Native error boxes are not BrowserWindows and can block unattended
    // launch diagnostics. Preserve the same failure in stdout before opening
    // the user-facing dialog so CI and terminal launches retain the cause.
    console.error(`[electron] StashBase failed to start: ${message}`);
    dialog.showErrorBox(
      'StashBase failed to start',
      `${message}${getServerLogPath() ? '\n\nServer log: available in the application log directory.' : ''}`,
    );
    if (mainWindows.size === 0) app.quit();
    return;
  }
  // A window request may have started before the update save barrier.
  if (desktopUpdateWindows.isActive()) return;
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
    backgroundColor: windowBackgroundColor(),
    // A window a scheduled run opens stays out of sight, so nothing appears
    // over whatever the reader is doing. It renders unthrottled meanwhile:
    // its workspace has to mount and its chat has to start while hidden.
    show: !background,
    ...applicationWindowChromeOptions(),
    webPreferences: {
      ...applicationWindowWebPreferences({
        preloadPath: path.join(PROJECT_ROOT, 'dist', 'electron', 'renderer', 'preload.cjs'),
        additionalArguments: [
          `--stashbase-server-origin=${SERVER_URL}`,
          ...(replacementAppearance?.windowArguments() ?? []),
        ],
      }),
      ...(background ? { backgroundThrottling: false } : {}),
    },
  });
  const webContentsId = win.webContents.id;
  // The reader's saved workspace belongs to a window they opened.
  if (!workspaceSessionRestoreWindow && !background) workspaceSessionRestoreWindow = win;
  if (reopensProject) reopenedProjectWindows.add(win);
  if (background) {
    backgroundWindows.add(win);
    win.once('show', () => {
      backgroundWindows.delete(win);
      if (!win.webContents.isDestroyed()) win.webContents.setBackgroundThrottling(true);
    });
  }
  attachWindowDiagnostics(win, { windowId, appSessionId, hostInstanceId: () => hostInstanceId,
    record: (...args) => nativeDiagnostics.record(...args), quitting: () => quitRequested });
  mainWindows.add(win);
  windowRegistry.add(windowId, win);
  if (
    projectFolderDialogCapability &&
    projectLifecycleCapability &&
    workspaceSessionCapability &&
    windowLifecycleCapability &&
    externalNavigationCapability &&
    externalFilesCapability &&
    updatesCapability &&
    textServicesCapability &&
    notificationsCapability &&
    scheduledTasksCapability
  ) {
    replacementWindowCapabilities.set(
      win,
      new Set([
        projectFolderDialogCapability,
        projectLifecycleCapability,
        workspaceSessionCapability,
        windowLifecycleCapability,
        externalNavigationCapability,
        externalFilesCapability,
        updatesCapability,
        textServicesCapability,
        notificationsCapability,
        scheduledTasksCapability,
      ]),
    );
  }
  if (!background) lastMainWindow = win;
  replacementWindowLifecycle?.attach(win);
  win.webContents.on('context-menu', (_event, params) => {
    const template = replacementEditableContextMenu?.(
      params,
      win.webContents,
      win.webContents.session,
    );
    if (template) Menu.buildFromTemplate(template).popup({ window: win });
  });
  win.on('focus', () => {
    lastMainWindow = win;
    rememberOpenProjects();
  });
  win.on('closed', () => {
    rememberOpenProjects(win);
    bugReports.discardUnreviewedDraftsForSource(webContentsId);
    mainWindows.delete(win);
    backgroundWindows.delete(win);
    windowRegistry.remove(windowId);
    releaseWindowContext(windowId);
    if (lastMainWindow === win) {
      lastMainWindow = [...mainWindows].find((candidate) => isLiveMainWindow(candidate)) ?? null;
    }
    if (mainWindows.size === 0 && bugReportReviewWindows.size === 0) {
      if (shouldQuitAfterLastWindow(process.platform, quitRequested)) app.quit();
    } else if (!quitRequested && process.platform !== 'darwin'
      && [...mainWindows].every((candidate) => backgroundWindows.has(candidate))) {
      // Where closing the last window quits, a hidden one must not keep the
      // app running out of sight. It is shown instead, so its chat is kept.
      revealBackgroundWindows();
    }
  });

  secureApplicationWindow(win, RENDERER_ORIGIN);

  // Native reload destroys live edits; recovery currently remounts React.
  // Keep the native reload chords blocked.
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
    if (windowAction === 'block-reload') event.preventDefault();
  });

  // The initial folder is not in this URL. A window learns which folder it was
  // created for by claiming it over the project bridge, so dev and packaged
  // windows load the same document and there is one answer to "how does a
  // window learn its folder" rather than two.
  win.loadURL(USE_DEV_VITE ? SERVER_URL : APP_URL);
  // Claim the warning once across windows. Background scheduled work must
  // not steal focus; show it only when a reader opens or reveals a window.
  const showPreparationStorageWarning = () => {
    if (!preparationStorageWarning || win.isDestroyed()) return;
    const detail = preparationStorageWarning;
    preparationStorageWarning = null;
    void dialog.showMessageBox(win, {
      type: 'warning',
      title: 'StashBase',
      message: 'File preparation is unavailable',
      detail: `${detail}\n\nYou can continue browsing and editing your documents.`,
      buttons: ['Continue'],
      noLink: true,
    }).catch((error) => console.warn('[electron] Could not show storage warning:', error));
  };
  if (background) win.once('show', showPreparationStorageWarning);
  else showPreparationStorageWarning();
  return win;
}

function requestWindowContextRelease(windowId) {
  return requestJson(SERVER_PORT, '/api/window', 1000, {
    method: 'DELETE',
    headers: { 'x-stashbase-window-id': windowId },
  });
}

function releaseWindowContext(windowId) {
  void releaseWindowContextWithRetry(() => requestWindowContextRelease(windowId)).then(({ ok, result, attempts }) => {
    if (!ok) {
      const detail = result?.reachable ? `HTTP ${result.statusCode}` : 'server unreachable';
      console.warn(`[electron] window context cleanup failed after ${attempts} attempts: ${detail}`);
    }
  });
}

function preferredMainWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (isLiveMainWindow(focused)) return focused;
  if (isLiveMainWindow(lastMainWindow)) return lastMainWindow;
  return [...mainWindows].find((candidate) => isLiveMainWindow(candidate));
}

function focusLastMainWindow() {
  const win = preferredMainWindow();
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
    includeDeveloperTools: process.env.STASHBASE_DEV_VITE === '1',
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

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

// This data-free link only focuses the app. The hosted status API owns rights.
function focusBillingReturn() {
  void app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.focus({ steal: true });
    if (!focusLastMainWindow()) {
      await initialWindowFlight.run();
      focusLastMainWindow();
    }
  });
}

function registerOAuthReturnProtocol() {
  // macOS/Linux cannot route a URL to `electron <project>`: launch arguments
  // are a Windows-only registration option. Never replace an installed app's
  // handler with generic Electron from a source checkout.
  if (!app.isPackaged) return;
  const registered = app.setAsDefaultProtocolClient('stashbase');
  if (!registered) console.warn('[electron] could not register the stashbase:// return protocol');
}

app.on('open-url', (event, url) => {
  if (isStashBaseProtocolUrl(url)) event.preventDefault();
  if (isBillingReturnUrl(url)) focusBillingReturn();
  else if (isOAuthReturnUrl(url)) focusOAuthReturn();
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
const initialProtocolLaunch = classifyProtocolLaunch(process.argv);
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const protocolLaunch = classifyProtocolLaunch(argv);
    if (protocolLaunch === 'billing-return') {
      focusBillingReturn();
      return;
    }
    if (protocolLaunch === 'oauth-return') {
      focusOAuthReturn();
      return;
    }
    // A malformed or unsupported stashbase: URL must not fall through to the
    // ordinary second-launch focus/create behavior.
    if (protocolLaunch === 'inert') return;
    if (!focusLastMainWindow()) {
      void initialWindowFlight.run().then(() => { focusLastMainWindow(); });
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
    installReplacementBoundary();
    installRequestAuthorization({
      rendererOrigins: new Set([RENDERER_ORIGIN]),
      serverOrigin: SERVER_URL,
      session: session.defaultSession,
      windowRegistrationForWebContentsId: (webContentsId) => (
        windowRegistry.registrationForWebContentsId(webContentsId)
      ),
    });
    try {
      await bugReportHandoff.initializeSession();
    } catch {
      console.warn('[electron] bug-report temporary session initialization failed');
    }
    installApplicationMenu();
    await openInitialWindows();
    await desktopUpdates.start();
    app.on('browser-window-focus', () => {
      void desktopUpdates.checkOnActivity();
      revealBackgroundWindows();
    });
    app.on('did-become-active', revealBackgroundWindows);
    app.on('activate', revealBackgroundWindows);
    powerMonitor.on('resume', () => {
      void desktopUpdates.checkOnActivity();
      void scheduledTaskScheduler?.check();
    });
    powerMonitor.on('unlock-screen', () => { void scheduledTaskScheduler?.check(); });
    // Scheduled tasks run only while StashBase is open. The first check, a
    // moment after launch, starts a run whose time passed in the last few
    // minutes; one missed while the app was closed is listed as missed.
    scheduledTaskScheduler?.start();
    if (initialProtocolLaunch === 'oauth-return') focusOAuthReturn();
    if (initialProtocolLaunch === 'billing-return') focusBillingReturn();
  });

  app.on('activate', () => {
    if (mainWindows.size === 0) {
      void initialWindowFlight.run();
    }
  });

  app.on('window-all-closed', () => {
    if (shouldQuitAfterLastWindow(process.platform, quitRequested)) app.quit();
  });
}

// Drag the server down with us on real shutdown. macOS keeps the
// process alive on window-close (Cmd+Q is the actual quit signal), so
// we hook `will-quit` rather than `window-all-closed` here.
//
// We need to **wait** for the server to actually exit before quitting
// Electron — otherwise the Python daemon orphans, still holding the MFS store
// lease, and the next launch fails to open the store.
// Hard 8 s ceiling so the server's 6.5 s cleanup ladder can finish without a
// stuck child pinning Electron forever.
// An async save cancels Electron's initial quit. Keep that intent until the
// last window closes, but revoke it when any save refuses. Ordinary macOS
// Close Window still leaves the application running.
app.on('before-quit', () => { quitRequested = true; });
let quitting = false;
app.on('will-quit', (event) => {
  if (quitting) return;
  authNetworkBridge?.close();
  authNetworkBridge = null;
  // `.killed` only records that a signal was SENT (e.g. the spawn-timeout
  // path's SIGTERM) — the child may still be alive, and skipping the ladder
  // here would orphan it because the timeout path's SIGKILL timer is unref'd
  // and dies with us. Only a child that actually exited skips the ladder.
  if (!serverProc || serverProc.exitCode != null || serverProc.signalCode != null) {
    if (relaunchAfterServerExit) app.relaunch();
    return;
  }
  event.preventDefault();
  quitting = true;
  void requestJson(SERVER_PORT, '/api/internal/shutdown', 1500, {
    method: 'POST',
    headers: { 'x-stashbase-shutdown-token': SERVER_SHUTDOWN_TOKEN,
      'x-stashbase-shutdown-reason': desktopUpdates.getState().phase === 'installing' ? 'app_update' : 'app_shutdown' },
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
    if (relaunchAfterServerExit) app.relaunch();
    app.exit(process.exitCode || 0);
  });
});

app.on('quit', () => {
  desktopUpdates.dispose();
  scheduledTaskScheduler?.dispose();
});
