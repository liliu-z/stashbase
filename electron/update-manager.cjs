const DEFAULT_RELEASE_URL = 'https://github.com/liliu-z/stashbase/releases/latest';
const DEFAULT_STARTUP_DELAY_MS = 30_000;
const DEFAULT_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || 'Update check failed');
}

/**
 * Main-process desktop update state machine. The renderer receives snapshots;
 * it never talks to GitHub or electron-updater directly.
 */
function createUpdateManager(options) {
  const {
    updater,
    currentVersion,
    platform = 'unknown',
    isPackaged,
    readAutoCheck,
    beforeInstall,
    installUpdate,
    afterInstallFailure = () => {},
    openReleasePage,
    onStateChange = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    startupDelayMs = DEFAULT_STARTUP_DELAY_MS,
    checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
  } = options;

  let state = {
    phase: isPackaged ? 'idle' : 'unsupported',
    currentVersion,
    platform,
    autoCheckEnabled: true,
    releaseUrl: DEFAULT_RELEASE_URL,
    ...(isPackaged ? {} : { message: 'Update checks are available in packaged builds.' }),
  };
  let timer = null;
  let disposed = false;
  let started = false;

  function snapshot() {
    return { ...state };
  }

  function publish(patch) {
    if (disposed) return snapshot();
    state = { ...state, ...patch };
    onStateChange(snapshot());
    return snapshot();
  }

  function cancelScheduledCheck() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function scheduleCheck(delayMs = checkIntervalMs) {
    cancelScheduledCheck();
    if (disposed || !isPackaged || !state.autoCheckEnabled) return;
    timer = setTimer(() => {
      timer = null;
      void check({ manual: false });
    }, delayMs);
    timer?.unref?.();
  }

  function onChecking() {
    publish({ phase: 'checking', message: undefined });
  }

  function onAvailable(info = {}) {
    publish({
      phase: 'available',
      availableVersion: typeof info.version === 'string' ? info.version : state.availableVersion,
      releaseName: typeof info.releaseName === 'string' ? info.releaseName : undefined,
      releaseDate: typeof info.releaseDate === 'string' ? info.releaseDate : undefined,
      percent: undefined,
      message: undefined,
    });
  }

  function onNotAvailable() {
    publish({
      phase: 'current',
      availableVersion: undefined,
      releaseName: undefined,
      releaseDate: undefined,
      percent: undefined,
      message: undefined,
    });
  }

  function onDownloadProgress(progress = {}) {
    const percent = Number.isFinite(progress.percent)
      ? Math.max(0, Math.min(100, Math.round(progress.percent)))
      : undefined;
    publish({ phase: 'downloading', percent, message: undefined });
  }

  function onDownloaded(info = {}) {
    publish({
      phase: 'ready',
      availableVersion: typeof info.version === 'string' ? info.version : state.availableVersion,
      percent: 100,
      message: undefined,
    });
  }

  function onError(error) {
    if (state.phase === 'installing') afterInstallFailure();
    publish({ phase: 'error', message: errorMessage(error), percent: undefined });
  }

  const listeners = [
    ['checking-for-update', onChecking],
    ['update-available', onAvailable],
    ['update-not-available', onNotAvailable],
    ['download-progress', onDownloadProgress],
    ['update-downloaded', onDownloaded],
    ['error', onError],
  ];

  async function readPreference() {
    try {
      return await readAutoCheck() === true;
    } catch {
      // Keep the last known choice when the local config service is briefly
      // unavailable. A fresh install begins with the documented default-on.
      return state.autoCheckEnabled;
    }
  }

  async function start() {
    if (started || disposed) return snapshot();
    started = true;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    for (const [name, listener] of listeners) updater.on(name, listener);
    const autoCheckEnabled = await readPreference();
    publish({ autoCheckEnabled });
    if (autoCheckEnabled) scheduleCheck(startupDelayMs);
    return snapshot();
  }

  async function refreshPreference({ checkIfEnabled = true } = {}) {
    if (!started) await start();
    const wasEnabled = state.autoCheckEnabled;
    const autoCheckEnabled = await readPreference();
    publish({ autoCheckEnabled });
    if (!autoCheckEnabled) {
      cancelScheduledCheck();
    } else if (checkIfEnabled && !wasEnabled) {
      void check({ manual: false });
    } else {
      scheduleCheck(checkIntervalMs);
    }
    return snapshot();
  }

  async function check({ manual = true } = {}) {
    if (!started) await start();
    cancelScheduledCheck();
    if (!isPackaged) {
      publish({
        phase: 'unsupported',
        message: 'Update checks are available in packaged builds.',
      });
      return snapshot();
    }
    if (state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'ready' || state.phase === 'installing') {
      return snapshot();
    }
    if (!manual && !state.autoCheckEnabled) return snapshot();
    publish({ phase: 'checking', message: undefined });
    try {
      await updater.checkForUpdates();
    } catch (error) {
      onError(error);
    } finally {
      if (state.autoCheckEnabled) scheduleCheck(checkIntervalMs);
    }
    return snapshot();
  }

  async function installReadyUpdate() {
    if (state.phase !== 'ready') return snapshot();
    publish({ phase: 'installing', message: undefined });
    try {
      const mayInstall = await beforeInstall();
      if (!mayInstall) {
        publish({ phase: 'ready' });
        return snapshot();
      }
      installUpdate();
    } catch (error) {
      // Platform adapters may both emit electron-updater's error event and
      // throw the same synchronous failure. onError already rolled back the
      // close approvals in that case.
      if (state.phase !== 'error') onError(error);
    }
    return snapshot();
  }

  async function primaryAction() {
    if (!started) await start();
    if (state.phase === 'ready') return installReadyUpdate();
    if (!state.availableVersion) return snapshot();
    if (state.phase === 'downloading' || state.phase === 'installing') return snapshot();
    publish({ phase: 'downloading', percent: 0, message: undefined });
    try {
      await updater.downloadUpdate();
      // electron-updater emits update-downloaded before downloadUpdate()
      // resolves. One explicit click therefore grants consent for this whole
      // download/install/relaunch operation.
      if (state.phase === 'ready') await installReadyUpdate();
    } catch (error) {
      onError(error);
    }
    return snapshot();
  }

  async function openDownloadPage() {
    await openReleasePage(DEFAULT_RELEASE_URL);
    return true;
  }

  function dispose() {
    disposed = true;
    cancelScheduledCheck();
    for (const [name, listener] of listeners) updater.removeListener(name, listener);
  }

  return {
    start,
    check,
    refreshPreference,
    primaryAction,
    openDownloadPage,
    getState: snapshot,
    dispose,
  };
}

module.exports = {
  DEFAULT_CHECK_INTERVAL_MS,
  DEFAULT_RELEASE_URL,
  DEFAULT_STARTUP_DELAY_MS,
  createUpdateManager,
};
