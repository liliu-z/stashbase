'use strict';

function isAllowedApplicationUrl(rawUrl, expectedOrigin) {
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password) return false;
    if (expectedOrigin === 'app://renderer') {
      return url.protocol === 'app:' && url.hostname === 'renderer' && !url.port;
    }
    return url.origin === expectedOrigin;
  } catch {
    return false;
  }
}

function applicationWindowWebPreferences({
  preloadPath,
  additionalArguments = [],
}) {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    experimentalFeatures: false,
    allowRunningInsecureContent: false,
    additionalArguments,
  };
}

/**
 * Clipboard writes are granted only to the application origin. Microphone
 * access has its separate capability-armed, main-frame-only check below.
 *
 * This is the write, and only the write. Chromium sanitizes the payload, and
 * the app never reads the clipboard through this API — a paste arrives as an
 * event, which needs no permission — so reading stays denied along with
 * everything else. The grant reaches the bundled renderer and nothing else:
 * document content renders at an opaque origin with no permission capability
 * at all, which is one more reason that frame may never take
 * `allow-same-origin`.
 *
 * The name is the one Chromium asks under, not the one that reads best. Verify
 * a change to it by driving the real window: a handler that answers the wrong
 * name denies silently, and the renderer reports only that the clipboard could
 * not be reached.
 */
const CLIPBOARD_PERMISSION = 'clipboard-sanitized-write';
const microphoneWindows = new WeakMap();

/** Only the capability-checked preload may arm this short permission window.
 * BrowserWindow destruction and explicit capture cleanup revoke it. */
function authorizeApplicationMicrophone(win, active) {
  const authority = microphoneWindows.get(win.webContents);
  if (!authority || win.webContents.isDestroyed?.()) return false;
  authority.until = active ? Date.now() + 60_000 : 0;
  return true;
}

function isApplicationMicrophoneRequest(webContents, permission, details, check) {
  const authority = webContents && microphoneWindows.get(webContents);
  if (permission !== 'media' || !authority || authority.until <= Date.now()
    || details?.isMainFrame !== true
    || !isAllowedApplicationUrl(details.requestingUrl, authority.origin)) return false;
  return check ? details.mediaType === 'audio'
    : Array.isArray(details.mediaTypes) && details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio';
}

/** The requesting document decides this, not the window: `requestingUrl` is
 *  the frame that asked, so a frame at any other origin is refused even
 *  though the window around it is the application's. */
function isApplicationClipboardRequest(permission, details, expectedOrigin) {
  if (permission !== CLIPBOARD_PERMISSION) return false;
  const requestingUrl = details && details.requestingUrl;
  return typeof requestingUrl === 'string' && isAllowedApplicationUrl(requestingUrl, expectedOrigin);
}

function secureApplicationWindow(win, expectedOrigin) {
  const contents = win.webContents;
  microphoneWindows.set(contents, { origin: expectedOrigin, until: 0 });
  contents.once('destroyed', () => microphoneWindows.delete(contents));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const denyUnexpectedNavigation = (event, url) => {
    if (!isAllowedApplicationUrl(url, expectedOrigin)) event.preventDefault();
  };
  win.webContents.on('will-navigate', denyUnexpectedNavigation);
  win.webContents.on('will-redirect', denyUnexpectedNavigation);
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  // Clipboard writes remain request-only. Audio checks require the same
  // short-lived capture grant as requests; no camera or subframe inherits it.
  win.webContents.session.setPermissionCheckHandler((webContents, permission, _origin, details) =>
    isApplicationMicrophoneRequest(webContents, permission, details, true));
  win.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      callback(isApplicationClipboardRequest(permission, details, expectedOrigin)
        || isApplicationMicrophoneRequest(webContents, permission, details, false));
    },
  );
}

module.exports = {
  authorizeApplicationMicrophone,
  applicationWindowWebPreferences,
  isAllowedApplicationUrl,
  secureApplicationWindow,
};
