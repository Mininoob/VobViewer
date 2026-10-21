'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('vobviewer', {
  // Electron >= 32: File.path is gone; this is the only way to get a dropped path.
  getDroppedPath: (file) => webUtils.getPathForFile(file),
  // Local media paths -> file: URLs (CSP allows file: for img/media only).
  toMediaUrl: (p) => 'file:///' + encodeURI(String(p).replace(/\\/g, '/')),
  openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),
  loadFolder: (p, opts) => ipcRenderer.invoke('folder:load', p, opts),
  cancelJobs: () => ipcRenderer.invoke('jobs:cancel'),
  exportClip: (index) => ipcRenderer.invoke('clip:export', index),
  onClipUpdate: (cb) => ipcRenderer.on('clip:update', (_e, d) => cb(d)),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  library: {
    get: () => ipcRenderer.invoke('library:get'),
    scan: () => ipcRenderer.invoke('library:scan'),
    addRoot: () => ipcRenderer.invoke('library:addRoot'),
    forget: (id) => ipcRenderer.invoke('library:forget', id),
    setTitle: (id, title) => ipcRenderer.invoke('library:setTitle', id, title),
    setSpread: (n) => ipcRenderer.invoke('library:setSpread', n),
    precache: (id) => ipcRenderer.invoke('library:precache', id),
    onDisc: (cb) => ipcRenderer.on('library:disc', (_e, d) => cb(d)),
    removeRoot: (root) => ipcRenderer.invoke('library:removeRoot', root),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    chooseImportDir: () => ipcRenderer.invoke('settings:chooseImportDir'),
    cacheSize: () => ipcRenderer.invoke('cache:size'),
    cacheClear: () => ipcRenderer.invoke('cache:clear'),
  },
  disc: {
    getState: () => ipcRenderer.invoke('disc:getState'),
    onDetected: (cb) => ipcRenderer.on('disc:detected', (_e, d) => cb(d)),
    onEjected: (cb) => ipcRenderer.on('disc:ejected', (_e, d) => cb(d)),
  },
  importer: {
    start: (dvdRoot, name) => ipcRenderer.invoke('import:start', dvdRoot, name),
    cancel: () => ipcRenderer.invoke('import:cancel'),
    onProgress: (cb) => ipcRenderer.on('import:progress', (_e, d) => cb(d)),
    onDone: (cb) => ipcRenderer.on('import:done', (_e, d) => cb(d)),
  },
});
