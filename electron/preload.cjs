/**
 * Preload bridge. The renderer is sandboxed (no Node, no Electron
 * globals); this exposes a narrow, auditable surface via
 * `window.electron`. Only what the renderer actually needs goes here —
 * never the raw ipcRenderer.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { windowIdFromArgv } = require('./multi-window.cjs');

const windowId = windowIdFromArgv(process.argv);
const contextReleaseHandlers = new Set();
const folderRemovedHandlers = new Set();
const libraryFolderAddedHandlers = new Set();

ipcRenderer.on('window:prepare-context-release', async (_event, payload) => {
  if (!payload || typeof payload.requestId !== 'string') return;
  let ok = contextReleaseHandlers.size > 0;
  for (const handler of contextReleaseHandlers) {
    try {
      if (await handler(payload.reason) !== true) ok = false;
    } catch {
      ok = false;
    }
  }
  ipcRenderer.send('window:context-release-ready', {
    requestId: payload.requestId,
    ok,
  });
});

ipcRenderer.on('window:folder-removed', (_event, folder) => {
  if (typeof folder !== 'string') return;
  for (const handler of folderRemovedHandlers) handler(folder);
});

ipcRenderer.on('window:library-folder-added', (_event, folder) => {
  if (typeof folder !== 'string') return;
  for (const handler of libraryFolderAddedHandlers) handler(folder);
});

// Mark the document as running under Electron so CSS can reserve room
// for the traffic-light buttons, opt into the drag region, etc. Done
// pre-DOMContentLoaded by toggling a class once the body exists.
window.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add('is-electron', `platform-${process.platform}`);
});

// macOS green-button fullscreen hides the traffic lights, so the sidebar
// drops its top drag-zone clearance (the `is-fullscreen` body class). Own
// this in the preload, not a renderer React effect: the listener is registered at
// preload top-level — before the page loads — so the initial state push
// (main sends it on did-finish-load) is caught even when the window STARTS
// in fullscreen. A React effect can attach its listener after that push has
// already fired and miss it, leaving the inset stuck on.
function applyFullscreenClass(isFullScreen) {
  const set = () => document.body.classList.toggle('is-fullscreen', isFullScreen === true);
  if (document.body) set();
  else window.addEventListener('DOMContentLoaded', set, { once: true });
}
ipcRenderer.on('fullscreen-change', (_e, isFullScreen) => applyFullscreenClass(isFullScreen));

contextBridge.exposeInMainWorld('electron', {
  /** Stable identity assigned by the Electron main process. HTTP and
   *  WebSocket calls use it to keep each window's folder context isolated. */
  windowId,
  /** Show the OS folder picker. Returns the picked absolute path or
   *  null if the user cancelled. Accepts `defaultPath` and
   *  `allowCreateDirectory`. */
  openFolderDialog: (opts) => ipcRenderer.invoke('dialog:openFolder', opts),
  /** Hand an http(s) URL to the OS default browser. Replaces an earlier
   *  in-app webview overlay; too many sites block iframing for it to
   *  be reliable, and the system browser already has user cookies. */
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  reportBug: () => ipcRenderer.invoke('bug-report:open'),
  openFolderWindow: (name) => ipcRenderer.invoke('window:openFolder', name),
  /** Keep the main-process folder → BrowserWindow registry current so
   *  "Open in New Window" can focus an existing matching context. */
  setWindowFolder: (folder) => ipcRenderer.invoke('window:setFolder', folder),
  /** Flush renderer-owned edits before main releases this window's server
   * context. Returning false cancels close/removal. */
  onPrepareContextRelease: (handler) => {
    const wasReady = contextReleaseHandlers.size > 0;
    contextReleaseHandlers.add(handler);
    if (!wasReady && contextReleaseHandlers.size > 0) {
      ipcRenderer.send('window:context-release-handler-state', { ready: true });
    }
    return () => {
      const removed = contextReleaseHandlers.delete(handler);
      if (removed && contextReleaseHandlers.size === 0) {
        ipcRenderer.send('window:context-release-handler-state', { ready: false });
      }
    };
  },
  contextReleaseReady: () => contextReleaseHandlers.size > 0,
  /** Before removing a library member, ask every window currently showing it
   * to flush its editor. */
  prepareFolderRemoval: (folder) => ipcRenderer.invoke('window:prepareFolderRemoval', folder),
  notifyFolderRemoved: (folder) => ipcRenderer.invoke('window:notifyFolderRemoved', folder),
  onFolderRemoved: (handler) => {
    folderRemovedHandlers.add(handler);
    return () => folderRemovedHandlers.delete(handler);
  },
  /** A folder joined the library without any window opening it (Agent
   * create_project). Every window's sidebar shows the membership list, so
   * all of them refresh it. */
  notifyLibraryFolderAdded: (folder) => ipcRenderer.invoke('window:notifyLibraryFolderAdded', folder),
  onLibraryFolderAdded: (handler) => {
    libraryFolderAddedHandlers.add(handler);
    return () => libraryFolderAddedHandlers.delete(handler);
  },
  /** Subscribe to "an image is on the clipboard, offer to import it"
   *  pushes fired when a main window regains focus. The renderer shows a
   *  confirm modal and, on accept, imports via the normal upload path. */
  onClipboardImage: (handler) => {
    const wrapped = (_event, payload) => {
      if (payload && typeof payload === 'object') handler(payload);
    };
    ipcRenderer.on('clipboard:image-available', wrapped);
    return () => ipcRenderer.removeListener('clipboard:image-available', wrapped);
  },
  /** Enable / disable clipboard-image watching (privacy toggle). */
  setClipboardWatch: (enabled) => ipcRenderer.invoke('clipboard:setWatch', enabled),
  /** Tell main an offered clipboard image was handled so it isn't
   *  re-offered on the next focus. */
  markClipboardHandled: (hash) => ipcRenderer.send('clipboard:markHandled', hash),
  /** Mark the image currently being pasted as handled without exposing the
   * native clipboard bytes to the renderer a second time. */
  markCurrentClipboardImageHandled: () => ipcRenderer.send('clipboard:markCurrentImageHandled'),
  /** While the Agent composer owns focus, pasted images become temporary
   * chat context instead of candidates for library import. */
  setAgentComposerFocused: (focused) => ipcRenderer.send('clipboard:setAgentComposerFocused', focused === true),
  /** Get absolute path for file from sandboxed renderer drop. */
  getPathForFile: (file) => webUtils.getPathForFile(file),
  registerPreviewGrant: (filePath) => ipcRenderer.invoke('grant:register', filePath),
  revokePreviewGrant: (grantId) => ipcRenderer.invoke('grant:revoke', grantId),
  onOpenExternalFiles: (handler) => {
    const wrapped = (_event, paths) => {
      if (Array.isArray(paths)) handler(paths);
    };
    ipcRenderer.on('window:open-external-files', wrapped);
    return () => ipcRenderer.removeListener('window:open-external-files', wrapped);
  },
  notifyRendererReadyForNativeFiles: () => ipcRenderer.send('renderer:ready-for-native-files'),
});
