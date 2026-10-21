'use strict';

const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');

const ffmpeg = require('./ffmpeg');
const ipc = require('./ipc');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    title: 'VobViewer',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log(`[did-fail-load] ${code} ${desc} ${url}`);
  });
  win.webContents.on('preload-error', (_e, preloadPath, err) => {
    console.log(`[preload-error] ${preloadPath}: ${err}`);
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  const err = ffmpeg.checkBinaries();
  if (err) {
    dialog.showErrorBox('VobViewer', err);
    app.quit();
    return;
  }
  const library = require('./library');
  const importer = require('./importer');
  const discwatch = require('./discwatch');
  ipc.register(() => win);
  library.register(() => win, { onAutoDetect: (on) => discwatch.setEnabled(on) });
  importer.register(() => win);
  discwatch.register(() => win, importer);
  createWindow();
  discwatch.start(library.getSettings().autoDetect);
});

app.on('before-quit', () => {
  require('./discwatch').stop();
  require('./importer').cancel();
  ipc.shutdown();
});
app.on('window-all-closed', () => app.quit());
