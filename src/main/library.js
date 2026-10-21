'use strict';

const { app, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

const ffmpeg = require('./ffmpeg');
const probe = require('./probe');
const cache = require('./cache');
const { queue } = require('./jobqueue');

const STORE_PATH = path.join(
  process.env.LOCALAPPDATA || require('os').homedir(),
  'VobViewer',
  'library.json'
);

// Titles and disc knowledge live in app data, never inside the archive folders.
let store = null;
let getWin = () => null;

function loadStore() {
  if (store) return store;
  try {
    store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    store = null;
  }
  if (!store || store.version !== 1) {
    store = { version: 1, roots: [], remembered: [], titles: {}, known: {}, lastSpread: 0 };
  }
  // Newer fields merge into stores written by older builds.
  store.importDir ??= null;
  store.autoDetect ??= true;
  return store;
}

// Imported discs land in the user's Videos folder unless they picked elsewhere.
function defaultImportDir() {
  try {
    return path.join(app.getPath('videos'), 'VobViewer');
  } catch {
    return path.join(require('os').homedir(), 'Videos', 'VobViewer');
  }
}

function getSettings() {
  const s = loadStore();
  return {
    importDir: s.importDir || defaultImportDir(),
    importDirIsDefault: !s.importDir,
    autoDetect: s.autoDetect,
    roots: s.roots.slice(),
  };
}

function saveStore() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function idOf(dvdRoot) {
  return path.resolve(dvdRoot).toLowerCase();
}

function sendDisc(disc) {
  const win = getWin();
  if (win && !win.isDestroyed()) win.webContents.send('library:disc', disc);
}

/* ---------- discovery ---------- */

// Walk a watched root for DVD folders (depth-limited; never descends into a disc).
function findDiscDirs(root, maxDepth = 4) {
  const found = [];
  const walk = (dir, depth) => {
    const resolved = probe.resolveDvdRoot(dir);
    if (resolved) {
      found.push(resolved);
      return;
    }
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(path.resolve(root), 0);
  return found;
}

function projectFor(discDir, root) {
  const rel = path.relative(root, discDir);
  const first = rel.split(path.sep)[0];
  return first && first !== '..' ? first : path.basename(root);
}

function registerKnown(dvdRoot, root) {
  const s = loadStore();
  // A bare VIDEO_TS dir displays as its parent folder's name.
  const base = path.basename(dvdRoot).toUpperCase() === 'VIDEO_TS'
    ? path.basename(path.dirname(dvdRoot))
    : path.basename(dvdRoot);
  s.known[idOf(dvdRoot)] = {
    dvdRoot: path.resolve(dvdRoot),
    folderName: base,
    project: root ? projectFor(dvdRoot, root) : 'LOOSE DISCS',
  };
}

/* ---------- disc payloads ---------- */

function discPayload(id) {
  const s = loadStore();
  const k = s.known[id];
  if (!k) return null;
  const exists = fs.existsSync(k.dvdRoot);
  const disc = {
    id,
    dvdRoot: k.dvdRoot,
    folderName: k.folderName,
    project: k.project,
    title: s.titles[id] || null,
    missing: !exists,
    indexed: false,
    sceneCount: 0,
    totalDuration: null,
    readyCount: 0,
    scenes: [],
  };
  if (!exists) return disc;

  let key;
  try {
    key = cache.cacheKeyFor(k.dvdRoot);
  } catch {
    return disc;
  }
  disc.cacheKey = key;
  const manifest = cache.readManifest(key);
  if (!manifest || !Array.isArray(manifest.clips) || manifest.clips.length === 0) return disc;

  disc.indexed = true;
  disc.scenes = manifest.clips.map((c) => {
    const paths = cache.clipPaths(key, c.index);
    const ready = fileReady(paths.mp4);
    return {
      index: c.index,
      label: c.label,
      duration: c.duration,
      thumbPath: fileReady(paths.thumb) ? paths.thumb : null,
      ready,
    };
  });
  disc.sceneCount = disc.scenes.length;
  disc.readyCount = disc.scenes.filter((sc) => sc.ready).length;
  const durations = disc.scenes.map((sc) => sc.duration).filter((d) => d != null);
  disc.totalDuration = durations.length ? durations.reduce((a, b) => a + b, 0) : null;
  return disc;
}

function fileReady(p) {
  try {
    return fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

function libraryPayload() {
  const s = loadStore();
  const discs = Object.keys(s.known)
    .map(discPayload)
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.project.localeCompare(b.project) ||
        a.folderName.localeCompare(b.folderName) ||
        a.id.localeCompare(b.id)
    );
  return { roots: s.roots.slice(), discs, lastSpread: s.lastSpread };
}

/* ---------- index pass (probe + thumbnails only; no transcodes) ---------- */

function queueIndex(id) {
  const s = loadStore();
  const k = s.known[id];
  if (!k || !fs.existsSync(k.dvdRoot)) return;

  queue.push({
    tag: 'library',
    run: async () => {
      const key = cache.cacheKeyFor(k.dvdRoot);
      cache.ensureCacheDir(key);
      if (!cache.readManifest(key)) {
        const { mode, clips } = await probe.discoverClips(k.dvdRoot);
        cache.writeManifest(key, {
          version: 1,
          dvdRoot: k.dvdRoot,
          mode,
          clips: clips.map((c) => ({
            index: c.index,
            chapter: c.chapter,
            label: c.label,
            start: c.start,
            duration: c.duration,
            vobs: c.vobs,
          })),
        });
      }
      sendDisc(discPayload(id));
    },
  });

  // Thumbnails as separate short jobs so player work can slot between them.
  queue.push({
    tag: 'library',
    run: async (signal) => {
      const key = cache.cacheKeyFor(k.dvdRoot);
      const manifest = cache.readManifest(key);
      if (!manifest) return;
      let made = false;
      for (const clip of manifest.clips) {
        if (signal.aborted) break;
        const paths = cache.clipPaths(key, clip.index);
        if (fileReady(paths.thumb)) continue;
        const args =
          manifest.mode === 'chapters'
            ? ffmpeg.thumbnailArgs(k.dvdRoot, clip.start, clip.duration, paths.thumb)
            : ffmpeg.thumbnailConcatArgs(clip.vobs[0], paths.thumb);
        await ffmpeg.run(ffmpeg.FFMPEG, args, { signal });
        made = true;
      }
      if (made || !signal.aborted) sendDisc(discPayload(id));
    },
  });
}

/* ---------- precache (memory reel convert-ahead) ---------- */

function queuePrecache(id) {
  const s = loadStore();
  const k = s.known[id];
  if (!k || !fs.existsSync(k.dvdRoot)) return;
  const key = cache.cacheKeyFor(k.dvdRoot);
  const manifest = cache.readManifest(key);
  if (!manifest) return;

  for (const clip of manifest.clips) {
    const paths = cache.clipPaths(key, clip.index);
    if (fileReady(paths.mp4)) continue;
    queue.push({
      tag: 'library',
      run: async (signal) => {
        if (fileReady(paths.mp4) || fs.existsSync(paths.part)) return;
        const args =
          manifest.mode === 'chapters'
            ? ffmpeg.transcodeChapterArgs(k.dvdRoot, clip.chapter, paths.part)
            : ffmpeg.transcodeConcatArgs(clip.vobs, paths.part);
        const { code } = await ffmpeg.run(ffmpeg.FFMPEG, args, { signal });
        if (code === 0 && fileReady(paths.part)) {
          fs.renameSync(paths.part, paths.mp4);
          sendDisc(discPayload(id));
        } else {
          try {
            fs.unlinkSync(paths.part);
          } catch {}
        }
      },
    });
  }
}

/* ---------- scan ---------- */

function scan() {
  const s = loadStore();
  for (const root of s.roots) {
    for (const discDir of findDiscDirs(root)) registerKnown(discDir, root);
  }
  for (const remembered of s.remembered) {
    if (!s.known[idOf(remembered)]) registerKnown(remembered, null);
  }
  saveStore();
  for (const id of Object.keys(s.known)) {
    const p = discPayload(id);
    if (p && !p.missing && !p.indexed) queueIndex(id);
    else if (p && !p.missing) {
      // Backfill any missing thumbnails (e.g. new scenes after re-finalize).
      if (p.scenes.some((sc) => !sc.thumbPath)) queueIndex(id);
    }
  }
}

/* ---------- public API ---------- */

// Called by the player whenever a disc folder is opened directly.
function rememberDisc(dvdRoot) {
  const s = loadStore();
  const resolved = path.resolve(dvdRoot);
  const underRoot = s.roots.find((r) => idOf(resolved).startsWith(idOf(r) + path.sep));
  if (!s.known[idOf(resolved)]) registerKnown(resolved, underRoot || null);
  if (!underRoot && !s.remembered.some((r) => idOf(r) === idOf(resolved))) {
    s.remembered.push(resolved);
  }
  saveStore();
  sendDisc(discPayload(idOf(resolved)));
}

// Full disc payloads for every known disc (used by the disc watcher's dup check).
function knownDiscs() {
  return libraryPayload().discs;
}

// A finished import joins the wallet and gets its index pass immediately.
function addImported(dir) {
  rememberDisc(dir);
  const id = idOf(dir);
  queueIndex(id);
  return id;
}

async function cacheSizeBytes() {
  let total = 0;
  const walk = async (dir) => {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        try {
          total += (await fs.promises.stat(p)).size;
        } catch {}
      }
    }
  };
  await walk(cache.CACHE_ROOT);
  return total;
}

function register(getWindow, hooks = {}) {
  getWin = getWindow;

  ipcMain.handle('library:get', () => libraryPayload());

  ipcMain.handle('library:scan', () => {
    scan();
    return libraryPayload();
  });

  ipcMain.handle('library:addRoot', async () => {
    const res = await dialog.showOpenDialog(getWindow(), {
      title: 'Choose your disc archive folder',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return { canceled: true };
    const s = loadStore();
    const root = path.resolve(res.filePaths[0]);
    if (!s.roots.some((r) => idOf(r) === idOf(root))) s.roots.push(root);
    saveStore();
    scan();
    return libraryPayload();
  });

  ipcMain.handle('library:forget', (_e, id) => {
    const s = loadStore();
    delete s.known[String(id)];
    delete s.titles[String(id)];
    s.remembered = s.remembered.filter((r) => idOf(r) !== String(id));
    saveStore();
    return libraryPayload();
  });

  ipcMain.handle('library:setTitle', (_e, id, title) => {
    const s = loadStore();
    const clean = String(title || '').trim().slice(0, 40);
    if (clean) s.titles[String(id)] = clean;
    else delete s.titles[String(id)];
    saveStore();
    return discPayload(String(id));
  });

  ipcMain.handle('library:setSpread', (_e, n) => {
    const s = loadStore();
    s.lastSpread = Math.max(0, Number(n) || 0);
    saveStore();
  });

  ipcMain.handle('library:precache', (_e, id) => queuePrecache(String(id)));

  ipcMain.handle('library:removeRoot', (_e, root) => {
    const s = loadStore();
    const rootId = idOf(String(root));
    s.roots = s.roots.filter((r) => idOf(r) !== rootId);
    for (const id of Object.keys(s.known)) {
      const isRemembered = s.remembered.some((r) => idOf(r) === id);
      if (!isRemembered && id.startsWith(rootId + path.sep)) {
        delete s.known[id];
        delete s.titles[id];
      }
    }
    saveStore();
    return libraryPayload();
  });

  ipcMain.handle('settings:get', () => getSettings());

  ipcMain.handle('settings:set', (_e, patch) => {
    const s = loadStore();
    if (patch && typeof patch.autoDetect === 'boolean') {
      s.autoDetect = patch.autoDetect;
      hooks.onAutoDetect?.(s.autoDetect);
    }
    if (patch && typeof patch.importDir === 'string') s.importDir = patch.importDir;
    saveStore();
    return getSettings();
  });

  ipcMain.handle('settings:chooseImportDir', async () => {
    const res = await dialog.showOpenDialog(getWindow(), {
      title: 'Where should imported discs be copied?',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!res.canceled && res.filePaths[0]) {
      loadStore().importDir = path.resolve(res.filePaths[0]);
      saveStore();
    }
    return getSettings();
  });

  ipcMain.handle('cache:size', () => cacheSizeBytes());

  ipcMain.handle('cache:clear', async () => {
    queue.cancel('library'); // don't fight jobs writing into files we're deleting
    const keep = require('./ipc').getSessionKey();
    let dirs = [];
    try {
      dirs = await fs.promises.readdir(cache.CACHE_ROOT);
    } catch {}
    for (const name of dirs) {
      if (name === keep) continue; // the disc playing right now keeps its files
      const dir = path.join(cache.CACHE_ROOT, name);
      let files = [];
      try {
        files = await fs.promises.readdir(dir);
      } catch {
        continue;
      }
      // Only the big converted MP4s go; thumbnails and scene manifests stay,
      // so the wallet keeps its imagery and nothing needs re-probing.
      for (const f of files) {
        if (/^clip_\d+\.mp4(\.part)?$/i.test(f)) {
          try {
            await fs.promises.unlink(path.join(dir, f));
          } catch {}
        }
      }
    }
    return cacheSizeBytes();
  });
}

module.exports = { register, rememberDisc, getSettings, knownDiscs, addImported };
