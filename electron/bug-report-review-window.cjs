'use strict';

const { applicationWindowWebPreferences, isAllowedApplicationUrl } = require('./window-security.cjs');

const APP_ORIGIN = 'app://renderer';

function createBugReportReviewWindow({
  BrowserWindow,
  preloadPath,
  appUrl,
  appOrigin = APP_ORIGIN,
  backgroundColor = '#fafafa',
  sourceWindow = null,
}) {
  if (
    typeof BrowserWindow !== 'function'
    || typeof preloadPath !== 'string'
    || typeof appUrl !== 'string'
  ) {
    throw new TypeError('Review window dependencies are required.');
  }
  const win = new BrowserWindow({
    width: 720,
    // Tall enough for the whole form — description, three attachments, and the
    // footer — without a scrollbar on first open. A smaller window scrolls.
    height: 812,
    minWidth: 600,
    minHeight: 520,
    show: false,
    title: 'Report a Bug',
    backgroundColor,
    autoHideMenuBar: true,
    fullscreenable: false,
    webPreferences: { ...applicationWindowWebPreferences({ preloadPath }), spellcheck: true },
  });
  if (typeof win.setMenuBarVisibility === 'function') win.setMenuBarVisibility(false);
  // Not a child or modal of the source: an open review must survive the
  // source closing. A full-screen source still needs the review presented in
  // its own space; otherwise macOS switches to a separate desktop.
  const sourceIsFullScreen = Boolean(
    sourceWindow
    && (typeof sourceWindow.isDestroyed !== 'function' || !sourceWindow.isDestroyed())
    && typeof sourceWindow.isFullScreen === 'function'
    && sourceWindow.isFullScreen(),
  );
  if (sourceIsFullScreen) {
    if (typeof win.setAlwaysOnTop === 'function') win.setAlwaysOnTop(true, 'floating');
    if (typeof win.setVisibleOnAllWorkspaces === 'function') {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    }
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const denyUnexpectedNavigation = (event, url) => {
    if (!isAllowedApplicationUrl(url, appOrigin)) event.preventDefault();
  };
  win.webContents.on('will-navigate', denyUnexpectedNavigation);
  win.webContents.on('will-redirect', denyUnexpectedNavigation);
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  const loaded = Promise.resolve(win.loadURL(appUrl));
  return { window: win, loaded };
}

module.exports = { createBugReportReviewWindow };
