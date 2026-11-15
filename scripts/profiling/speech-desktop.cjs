// Private profiling launcher; never included in the desktop package. A parent
// signal drives BrowserWindow.close(), the actual native lifecycle entry.
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
app.setAppPath(path.resolve(__dirname, '../..'));
require('../../electron/main.cjs');
process.on('SIGUSR2', () => {
  const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().startsWith('app://renderer'));
  window?.close();
});
