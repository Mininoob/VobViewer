'use strict';

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

// Pure disk I/O — deliberately outside the ffmpeg JobQueue: a queued transcode
// must never stall a time-critical optical copy, and there's no CPU contention.
let getWin = () => null;
let active = null; // { source, controller, partDir }

function sendTo(channel, payload) {
  const win = getWin();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function sanitizeName(name) {
  const clean = String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return clean || 'DISC';
}

function uniqueDest(importDir, name) {
  let dest = path.join(importDir, name);
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(importDir, `${name} (${n})`);
  return dest;
}

async function freeBytes(dir) {
  try {
    const s = await fs.promises.statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return Infinity; // unknown — don't block the import on a stat failure
  }
}

async function runImport(dvdRoot, requestedName) {
  const library = require('./library');
  const importDir = library.getSettings().importDir;
  if (active) return { error: 'AN IMPORT IS ALREADY RUNNING' };
  try {
    fs.mkdirSync(importDir, { recursive: true }); // the Videos\VobViewer default may not exist yet
  } catch {
    return { error: 'IMPORT FOLDER CANNOT BE CREATED — CHECK SETUP' };
  }

  const name = sanitizeName(requestedName);
  const dest = uniqueDest(importDir, name);
  const partDir = dest + '.part';

  const files = fs
    .readdirSync(dvdRoot)
    .filter((n) => /\.(IFO|BUP|VOB)$/i.test(n))
    .sort();
  if (files.length === 0) return { error: 'NO DVD FILES FOUND ON THE DISC' };

  const stats = files.map((n) => fs.statSync(path.join(dvdRoot, n)));
  const totalBytes = stats.reduce((s, st) => s + st.size, 0);
  if ((await freeBytes(importDir)) < totalBytes + 100 * 1024 * 1024) {
    return { error: 'NOT ENOUGH FREE SPACE IN THE IMPORT FOLDER' };
  }

  const controller = new AbortController();
  active = { source: dvdRoot, controller, partDir };

  // The copy itself runs detached from the invoke so the renderer gets an
  // immediate ack; progress and completion arrive as events.
  (async () => {
    let failure = null;
    try {
      await fs.promises.rm(partDir, { recursive: true, force: true });
      await fs.promises.mkdir(partDir, { recursive: true });

      let copied = 0;
      let lastPercent = -1;
      for (let i = 0; i < files.length; i++) {
        const src = path.join(dvdRoot, files[i]);
        const dst = path.join(partDir, files[i]);
        const read = fs.createReadStream(src, { highWaterMark: 4 * 1024 * 1024 });
        read.on('data', (chunk) => {
          copied += chunk.length;
          const percent = Math.min(99, Math.floor((copied / totalBytes) * 100));
          if (percent > lastPercent) {
            lastPercent = percent;
            sendTo('import:progress', { percent, file: files[i] });
          }
        });
        await pipeline(read, fs.createWriteStream(dst), { signal: controller.signal });
        const st = stats[i];
        await fs.promises.utimes(dst, st.atime, st.mtime);
        if ((await fs.promises.stat(dst)).size !== st.size) {
          throw new Error(`SIZE MISMATCH COPYING ${files[i]}`);
        }
      }

      await fs.promises.rename(partDir, dest);
      const id = library.addImported(dest);
      sendTo('import:done', { ok: true, dvdRoot: dest, id });
    } catch (err) {
      failure = err;
    }

    if (failure) {
      try {
        await fs.promises.rm(partDir, { recursive: true, force: true });
      } catch {}
      sendTo('import:done', {
        ok: false,
        canceled: controller.signal.aborted,
        message: controller.signal.aborted
          ? 'IMPORT CANCELED'
          : `IMPORT FAILED — ${String(failure.message || failure).toUpperCase().slice(0, 120)}`,
      });
    }
    active = null;
  })();

  return { started: true, dest };
}

function cancel() {
  active?.controller.abort();
}

// Called by the disc watcher when the source drive disappears mid-copy.
function abortIfSource(driveRoot) {
  if (active && active.source.toLowerCase().startsWith(driveRoot.toLowerCase())) {
    active.controller.abort();
  }
}

function register(getWindow) {
  getWin = getWindow;
  ipcMain.handle('import:start', (_e, dvdRoot, name) => runImport(String(dvdRoot), name));
  ipcMain.handle('import:cancel', () => cancel());
}

module.exports = { register, cancel, abortIfSource };
