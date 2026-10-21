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
    // VOBVIEWER_OPAQUE is a dev flag for screen recording: gdigrab can't
    // capture a transparent window cleanly, so this fills the margins with
    // the website's backdrop color instead.
    transparent: !process.env.VOBVIEWER_OPAQUE,
    backgroundColor: process.env.VOBVIEWER_OPAQUE ? '#1b1e23' : '#00000000',
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

// Dev-only self-capture used to record demo clips for the website: the app
// records its own window (immune to occlusion), renderer sends the webm back.
if (process.env.VOBVIEWER_CAPTURE) {
  const fs = require('fs');
  const { ipcMain, desktopCapturer } = require('electron');
  ipcMain.handle('dev:captureId', async () => {
    const sources = await desktopCapturer.getSources({ types: ['window'] });
    return sources.find((s) => s.name === 'VobViewer')?.id || null;
  });
  ipcMain.handle('dev:saveRecording', (_e, name, buf) => {
    const safe = String(name).replace(/[^a-z0-9._-]/gi, '');
    const out = path.join(app.getPath('temp'), safe);
    fs.writeFileSync(out, Buffer.from(buf));
    return out;
  });
}

app.on('before-quit', () => {
  require('./discwatch').stop();
  require('./importer').cancel();
  ipc.shutdown();
});
app.on('window-all-closed', () => app.quit());
