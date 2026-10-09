const DEFAULT_RELEASE_URL = 'https://github.com/liliu-z/stashbase/releases/latest';
const DEFAULT_STARTUP_DELAY_MS = 30_000;
const DEFAULT_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const UPDATE_SIMULATIONS = new Set(['off', 'available', 'downloading', 'ready', 'installing', 'error']);

function nextPatchVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  if (!match) return '9.9.9';
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

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
    debugEnabled = false,
    now = Date.now,
    activityIntervalMs = 5 * 60 * 1000,
  } = options;

  let state = {
    phase: isPackaged ? 'idle' : 'unsupported',
    currentVersion,
    autoCheckEnabled: true,
    ...(isPackaged ? {} : { message: 'Update checks are available in packaged builds.' }),
  };
  let timer = null;
  let disposed = false;
  let started = false;
  let startPromise = null;
  let checking = null;
  let lastCheckAt = null;
  let updateSimulation = 'off';
  let installAttempt = null;

  function snapshot() {
    const simulation = { enabled: debugEnabled, value: updateSimulation };
    if (!debugEnabled || updateSimulation === 'off') return { ...state, simulation };

    const availableVersion = nextPatchVersion(currentVersion);
    const simulated = {
      ...state,
      availableVersion,
      percent: undefined,
      message: undefined,
      simulation,
    };
    switch (updateSimulation) {
      case 'downloading': return { ...simulated, phase: 'downloading', percent: 42 };
      case 'ready': return { ...simulated, phase: 'ready', percent: 100 };
      case 'installing': return { ...simulated, phase: 'installing', percent: 100 };
      case 'error': return { ...simulated, phase: 'error', message: 'Simulated update failure.' };
      default: return { ...simulated, phase: 'available' };
    }
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
      percent: undefined,
      message: undefined,
    });
  }

  function onNotAvailable() {
    publish({
      phase: 'current',
      availableVersion: undefined,
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
    if (state.phase === 'installing') {
      installAttempt = null;
      afterInstallFailure();
    }
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

  function start() {
    if (startPromise) return startPromise;
    if (disposed) return Promise.resolve(snapshot());
    started = true;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    for (const [name, listener] of listeners) updater.on(name, listener);
    startPromise = (async () => {
      const autoCheckEnabled = await readPreference();
      if (disposed) return snapshot();
      publish({ autoCheckEnabled });
      if (autoCheckEnabled) scheduleCheck(startupDelayMs);
      return snapshot();
    })();
    return startPromise;
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
    await start();
    if (disposed) return snapshot();
    if (checking) return checking;
    if (!isPackaged) {
      return publish({ phase: 'unsupported', message: 'Update checks are available in packaged builds.' });
    }
    if (['checking', 'downloading', 'ready', 'installing'].includes(state.phase)) {
      if (timer === null) scheduleCheck(checkIntervalMs);
      return snapshot();
    }
    if (!manual && !state.autoCheckEnabled) return snapshot();
    cancelScheduledCheck();
    lastCheckAt = now();
    publish({ phase: 'checking', message: undefined });
    const work = Promise.resolve().then(async () => {
      try {
        await updater.checkForUpdates();
      } catch (error) {
        onError(error);
      } finally {
        if (checking === work) checking = null;
        if (state.autoCheckEnabled) scheduleCheck(checkIntervalMs);
      }
      return snapshot();
    });
    checking = work;
    return checking;
  }

  async function checkOnActivity() {
    // Focus and resume share one throttle across all windows. They neither
    // postpone the periodic timer when throttled nor override the saved choice.
    if (!started || disposed) return snapshot();
    await start();
    if (lastCheckAt !== null && now() >= lastCheckAt && now() - lastCheckAt < activityIntervalMs) return snapshot();
    return check({ manual: false });
  }

  async function installReadyUpdate() {
    if (state.phase !== 'ready') return snapshot();
    const attempt = {};
    installAttempt = attempt;
    publish({ phase: 'installing', message: undefined });
    try {
      const mayInstall = await beforeInstall();
      // An updater error can arrive while the save replies are pending.
      if (installAttempt !== attempt) return snapshot();
      if (!mayInstall) {
        publish({ phase: 'ready' });
        return snapshot();
      }
      installUpdate();
    } catch (error) {
      // Platform adapters may both emit electron-updater's error event and
      // throw the same synchronous failure. onError already rolled back the
      // close approvals in that case.
      if (installAttempt === attempt && state.phase !== 'error') onError(error);
    }
    return snapshot();
  }

  async function primaryAction() {
    await start();
    if (checking) await checking;
    if (disposed) return snapshot();
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

  function setUpdateSimulation(simulation) {
    if (!debugEnabled) throw new Error('Update test controls are available in development builds only.');
    if (!UPDATE_SIMULATIONS.has(simulation)) throw new Error('Invalid update simulation.');
    updateSimulation = simulation;
    const next = snapshot();
    onStateChange(next);
    return next;
  }

  function dispose() {
    disposed = true;
    cancelScheduledCheck();
    for (const [name, listener] of listeners) updater.removeListener(name, listener);
  }

  return {
    start,
    check,
    checkOnActivity,
    refreshPreference,
    primaryAction,
    openDownloadPage,
    setUpdateSimulation,
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
