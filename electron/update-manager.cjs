const DEFAULT_RELEASE_URL = 'https://github.com/liliu-z/stashbase/releases/latest';
const STORE_RELEASE_URL = 'https://apps.microsoft.com/detail/9N1Z6TB2H2P5';
const DEFAULT_STARTUP_DELAY_MS = 30_000;
const DEFAULT_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const UPDATE_SIMULATIONS = new Set(['off', 'available', 'downloading', 'ready', 'installing', 'error']);
const CHECK_NETWORK_ERRORS = new Set([
  'ERR_INTERNET_DISCONNECTED', 'ERR_NETWORK_CHANGED',
  'ERR_NETWORK_IO_SUSPENDED', 'ERR_NAME_NOT_RESOLVED',
]);

function checkNetworkError(error) {
  const code = error?.code ?? /^net::(ERR_[A-Z_]+)(?:\s|$)/.exec(errorMessage(error))?.[1];
  if (CHECK_NETWORK_ERRORS.has(code)) return true;
  // GitHubProvider wraps the request failure, sometimes twice, and appends
  // the release XML. Inspect only its known request wrapper, never feed text
  // or arbitrary errors (in particular integrity/certificate failures).
  if (!['ERR_UPDATER_INVALID_RELEASE_FEED', 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'].includes(code)) return false;
  const explanation = errorMessage(error).split('\nXML:', 1)[0];
  const nested = /Unable to find latest version on GitHub \([^\r\n]+\), please ensure a production release exists: Error: net::(ERR_[A-Z_]+)(?:\s|$)/.exec(explanation)?.[1];
  return CHECK_NETWORK_ERRORS.has(nested);
}

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
    isWindowsStore = false,
    readAutoCheck,
    beforeInstall,
    installUpdate,
    afterInstallFailure = () => {},
    openReleasePage,
    onStateChange = () => {},
    onDiagnostic = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    startupDelayMs = DEFAULT_STARTUP_DELAY_MS,
    checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
    debugEnabled = false,
    now = Date.now,
    activityIntervalMs = 5 * 60 * 1000,
  } = options;

  let state = {
    phase: isWindowsStore ? 'store' : isPackaged ? 'idle' : 'unsupported',
    currentVersion,
    autoCheckEnabled: true,
    ...(isPackaged ? {} : { message: 'Update checks are available in packaged builds.' }),
  };
  let timer = null;
  let disposed = false;
  let started = false;
  let startPromise = null;
  let checking = null;
  let downloading = null;
  let downloadedVersion = null;
  let retainedDownload = null;
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
    if (disposed || !isPackaged || isWindowsStore || !state.autoCheckEnabled) return;
    timer = setTimer(() => {
      timer = null;
      void check({ manual: false });
    }, delayMs);
    timer?.unref?.();
  }

  function onChecking() {
    publish({ phase: 'checking', message: undefined, checkFailed: false });
  }

  function onAvailable(info = {}) {
    if (downloadedVersion && info.version === downloadedVersion) {
      publish({
        phase: 'ready', availableVersion: downloadedVersion, percent: 100,
        message: undefined, checkFailed: false,
      });
      return;
    }
    // Once a different release is selected, the native updater may replace its
    // pending payload. Do not offer the previous installer after a failed download.
    downloadedVersion = null;
    retainedDownload = null;
    publish({
      phase: 'available',
      availableVersion: typeof info.version === 'string' ? info.version : state.availableVersion,
      percent: undefined,
      message: undefined,
    });
  }

  function onNotAvailable() {
    downloadedVersion = null;
    retainedDownload = null;
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
    downloadedVersion = typeof info.version === 'string' ? info.version : state.availableVersion;
    publish({
      checkFailed: false,
      phase: 'ready',
      availableVersion: typeof info.version === 'string' ? info.version : state.availableVersion,
      percent: 100,
      message: undefined,
    });
  }

  const reportedErrors = new WeakSet();
  function onError(error) {
    if (!error || typeof error !== 'object' || !reportedErrors.has(error)) {
      if (error && typeof error === 'object') reportedErrors.add(error);
      const severity = state.phase === 'checking' && checkNetworkError(error) ? 'warning' : 'error';
      try { onDiagnostic(error, { stage: state.phase, target_version: state.availableVersion }, severity); } catch { /* reporting is optional */ }
    }
    if (retainedDownload) {
      publish({
        phase: 'ready', availableVersion: retainedDownload, percent: 100,
        checkFailed: true, message: errorMessage(error),
      });
      return;
    }
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
    // check() starts each download itself: electron-updater's own autoDownload
    // hands back a download promise nobody awaits, so a failure would escape
    // onError as an unhandled rejection.
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    if (!isWindowsStore) {
      for (const [name, listener] of listeners) updater.on(name, listener);
    }
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
    if (isWindowsStore) return snapshot();
    if (checking) return checking;
    if (!isPackaged) {
      return publish({ phase: 'unsupported', message: 'Update checks are available in packaged builds.' });
    }
    if (downloading || ['checking', 'downloading', 'installing'].includes(state.phase)) {
      if (timer === null) scheduleCheck(checkIntervalMs);
      return snapshot();
    }
    if (!manual && !state.autoCheckEnabled) return snapshot();
    cancelScheduledCheck();
    lastCheckAt = now();
    retainedDownload = state.phase === 'ready' ? downloadedVersion : null;
    publish({ phase: 'checking', message: undefined, checkFailed: false });
    const work = Promise.resolve().then(async () => {
      try {
        await updater.checkForUpdates();
        // A found release downloads in the background. The check itself
        // ends here; the download reports through its own phases.
        void download();
      } catch (error) {
        onError(error);
      } finally {
        if (checking === work) {
          checking = null;
          retainedDownload = null;
        }
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
    if (checking || downloading || state.phase !== 'ready') return snapshot();
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

  async function download() {
    if (downloading || state.phase !== 'available') return;
    publish({ phase: 'downloading', percent: 0, message: undefined });
    // update-downloaded can arrive before the dependency's download promise
    // settles. Keep that whole flight exclusive, including its ready tail.
    const work = Promise.resolve().then(() => updater.downloadUpdate()).catch(onError).finally(() => {
      if (downloading === work) downloading = null;
    });
    downloading = work;
    return work;
  }

  async function primaryAction() {
    await start();
    if (isWindowsStore && !disposed) {
      await openDownloadPage();
      return snapshot();
    }
    if (disposed || checking || state.phase !== 'ready') return snapshot();
    // A failed recheck already tells the reader that this installer may be
    // older. Preserve their explicit choice to install that ready download.
    if (state.checkFailed) return installReadyUpdate();
    // Otherwise refresh an offer that may have waited for days. Download its
    // successor before asking windows to save, and never silently install the
    // previous version if this restart's refresh fails.
    await downloading;
    await check();
    await downloading;
    if (disposed || state.checkFailed) return snapshot();
    // A finished download only waits. Restarting is always the reader's own
    // click, never a consequence of the download completing.
    return installReadyUpdate();
  }

  async function openDownloadPage() {
    await openReleasePage(isWindowsStore ? STORE_RELEASE_URL : DEFAULT_RELEASE_URL);
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
  createUpdateManager,
};
