'use strict';

const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

const ffmpeg = require('./ffmpeg');
const probe = require('./probe');
const cache = require('./cache');
const { queue } = require('./jobqueue');

let session = null; // { key, dvdRoot, mode, clips }

function sendTo(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function fileReady(p) {
  try {
    return fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

function buildClipStates(key, mode, clips) {
  return clips.map((c) => {
    const paths = cache.clipPaths(key, c.index);
    const mp4Done = fileReady(paths.mp4);
    return {
      ...c,
      thumbPath: fileReady(paths.thumb) ? paths.thumb : null,
      mp4Path: mp4Done ? paths.mp4 : null,
      status: mp4Done ? 'ready' : 'queued',
    };
  });
}

function queueWork(win, sess) {
  const { key, dvdRoot, mode, clips } = sess;

  // Fast pass first: every missing thumbnail, so the playlist fills in quickly.
  for (const clip of clips) {
    if (clip.thumbPath) continue;
    queue.push({
      tag: 'player',
      run: async (signal) => {
        if (session !== sess) return;
        const paths = cache.clipPaths(key, clip.index);
        const args =
          mode === 'chapters'
            ? ffmpeg.thumbnailArgs(dvdRoot, clip.start, clip.duration, paths.thumb)
            : ffmpeg.thumbnailConcatArgs(clip.vobs[0], paths.thumb);
        const { code } = await ffmpeg.run(ffmpeg.FFMPEG, args, { signal });
        if (session !== sess) return;
        if (code === 0 && fileReady(paths.thumb)) {
          clip.thumbPath = paths.thumb;
          sendTo(win, 'clip:update', {
            index: clip.index,
            status: clip.status,
            thumbPath: paths.thumb,
          });
        }
      },
    });
  }

  // Then transcodes in disc order.
  for (const clip of clips) {
    if (clip.status === 'ready') continue;
    queue.push({
      tag: 'player',
      run: async (signal) => {
        if (session !== sess) return;
        const paths = cache.clipPaths(key, clip.index);
        // A precache job (memory reel) may have produced this mp4 meanwhile.
        if (fileReady(paths.mp4)) {
          clip.mp4Path = paths.mp4;
          clip.status = 'ready';
          sendTo(win, 'clip:update', {
            index: clip.index,
            status: 'ready',
            mp4Path: paths.mp4,
            duration: clip.duration,
          });
          return;
        }
        clip.status = 'transcoding';
        sendTo(win, 'clip:update', { index: clip.index, status: 'transcoding', percent: 0 });

        const args =
          mode === 'chapters'
            ? ffmpeg.transcodeChapterArgs(dvdRoot, clip.chapter, paths.part)
            : ffmpeg.transcodeConcatArgs(clip.vobs, paths.part);

        let lastPercent = -1;
        const { code, stderrTail } = await ffmpeg.run(ffmpeg.FFMPEG, args, {
          signal,
          onStdoutLine: (line) => {
            const sec = ffmpeg.parseProgressLine(line);
            if (sec == null || !clip.duration) return;
            const percent = Math.min(99, Math.floor((sec / clip.duration) * 100));
            if (percent > lastPercent) {
              lastPercent = percent;
              sendTo(win, 'clip:update', { index: clip.index, status: 'transcoding', percent });
            }
          },
        });

        if (session !== sess) return;
        if (code === 0 && fileReady(paths.part)) {
          fs.renameSync(paths.part, paths.mp4);
          clip.mp4Path = paths.mp4;
          clip.status = 'ready';
          if (!clip.duration) {
            clip.duration = await ffmpeg.probeDuration(paths.mp4);
          }
          cache.writeManifest(key, sessionManifest(sess));
          sendTo(win, 'clip:update', {
            index: clip.index,
            status: 'ready',
            mp4Path: paths.mp4,
            duration: clip.duration,
          });
        } else {
          try {
            fs.unlinkSync(paths.part);
          } catch {}
          if (signal.aborted) return; // canceled, not an error
          clip.status = 'error';
          sendTo(win, 'clip:update', {
            index: clip.index,
            status: 'error',
            message: (stderrTail || `ffmpeg exited with code ${code}`).trim().slice(-300),
          });
        }
      },
    });
  }
}

function sessionManifest(sess) {
  return {
    version: 1,
    dvdRoot: sess.dvdRoot,
    mode: sess.mode,
    clips: sess.clips.map((c) => ({
      index: c.index,
      chapter: c.chapter,
      label: c.label,
      start: c.start,
      duration: c.duration,
      vobs: c.vobs,
    })),
  };
}

async function loadFolder(win, droppedPath, opts = {}) {
  const { remember = true } = opts;
  queue.cancel('player'); // background library indexing survives disc switches

  const dvdRoot = probe.resolveDvdRoot(droppedPath);
  if (!dvdRoot) {
    throw new Error(
      'That folder does not look like a DVD video folder.\nExpected VIDEO_TS.IFO inside it (or in a VIDEO_TS subfolder).'
    );
  }

  const key = cache.cacheKeyFor(dvdRoot);
  cache.ensureCacheDir(key);

  // Manifest hit → skip the (slow) chapter probe entirely.
  const manifest = cache.readManifest(key);
  let mode, clips;
  if (manifest && Array.isArray(manifest.clips) && manifest.clips.length > 0) {
    mode = manifest.mode;
    clips = manifest.clips;
  } else {
    ({ mode, clips } = await probe.discoverClips(dvdRoot));
  }

  const sess = {
    key,
    dvdRoot,
    mode,
    clips: buildClipStates(key, mode, clips),
  };
  session = sess;
  cache.writeManifest(key, sessionManifest(sess));
  queueWork(win, sess);

  // "Remember every drop": any disc opened in the player joins the library —
  // except direct optical-disc playback, which would go stale on eject.
  if (remember) require('./library').rememberDisc(dvdRoot);

  return {
    cacheKey: key,
    folderName: path.basename(droppedPath),
    mode,
    notice: probe.hasSecondTitleSet(dvdRoot)
      ? 'This disc has more than one title set; only the first is shown.'
      : null,
    clips: sess.clips.map((c) => ({
      index: c.index,
      label: c.label,
      duration: c.duration,
      thumbPath: c.thumbPath,
      mp4Path: c.mp4Path,
      status: c.status,
    })),
  };
}

function register(getWindow) {
  ipcMain.handle('dialog:openFolder', async () => {
    const res = await dialog.showOpenDialog(getWindow(), {
      title: 'Open DVD folder',
      properties: ['openDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('folder:load', async (_e, droppedPath, opts) => {
    try {
      return await loadFolder(getWindow(), String(droppedPath), opts || {});
    } catch (err) {
      return { error: err.message || String(err) };
    }
  });

  ipcMain.handle('jobs:cancel', () => {
    queue.cancelAll();
  });

  ipcMain.handle('window:minimize', () => getWindow()?.minimize());
  ipcMain.handle('window:close', () => getWindow()?.close());

  ipcMain.handle('clip:export', async (_e, index) => {
    const clip = session?.clips?.[index];
    if (!clip || !clip.mp4Path) return { error: 'Clip is not ready yet.' };
    const res = await dialog.showSaveDialog(getWindow(), {
      title: 'Export clip',
      defaultPath: `${clip.label.replace(/\s+/g, '')}.mp4`,
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    await fs.promises.copyFile(clip.mp4Path, res.filePath);
    return { savedTo: res.filePath };
  });
}

function shutdown() {
  queue.cancelAll();
}

// Cache key of the disc currently open in the player (cache:clear spares it).
function getSessionKey() {
  return session ? session.key : null;
}

module.exports = { register, shutdown, getSessionKey };
