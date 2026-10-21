'use strict';

const fs = require('fs');
const path = require('path');
const ffmpeg = require('./ffmpeg');

// Resolve the folder that actually holds the VIDEO_TS files.
// Accepts a folder with the files directly inside, or one with a VIDEO_TS subfolder.
function looksLikeDvdDir(dir) {
  if (fs.existsSync(path.join(dir, 'VIDEO_TS.IFO'))) return true;
  try {
    // No IFO (unfinalized/partial copy) still counts if content VOBs exist.
    return fs.readdirSync(dir).some((n) => /^VTS_\d+_[1-9]\.VOB$/i.test(n));
  } catch {
    return false;
  }
}

function resolveDvdRoot(droppedPath) {
  const base = path.resolve(droppedPath); // normalize slashes so cache keys are stable
  if (looksLikeDvdDir(base)) return base;
  const sub = path.join(base, 'VIDEO_TS');
  if (fs.existsSync(sub) && looksLikeDvdDir(sub)) return sub;
  return null;
}

// Content VOBs for the fallback path: VTS_xx_1.VOB and up, sorted.
// Excludes VIDEO_TS.VOB (first-play menu) and VTS_xx_0.VOB (title-set menu).
function contentVobs(dvdRoot) {
  return fs
    .readdirSync(dvdRoot)
    .filter((n) => /^VTS_\d+_[1-9]\.VOB$/i.test(n))
    .sort()
    .map((n) => path.join(dvdRoot, n));
}

function hasSecondTitleSet(dvdRoot) {
  return fs.existsSync(path.join(dvdRoot, 'VTS_02_0.IFO'));
}

// Build the clip list for a DVD folder.
// Returns { mode: 'chapters'|'concat', clips: [{index, chapter, label, start, duration}] }
// or throws with a user-facing message.
async function discoverClips(dvdRoot) {
  const probed = await ffmpeg.probeChapters(dvdRoot);
  if (probed && probed.chapters.length > 0) {
    const clips = probed.chapters
      .map((ch, i) => {
        const start = parseFloat(ch.start_time);
        const end = parseFloat(ch.end_time);
        return {
          index: i,
          chapter: i + 1, // dvdvideo -chapter_start/-chapter_end is 1-based
          label: `Scene ${i + 1}`,
          start,
          duration: end - start,
        };
      })
      .filter((c) => c.duration >= 0.5); // drop authored stub chapters
    if (clips.length > 0) {
      // Re-number labels/indices after filtering so the UI stays contiguous.
      clips.forEach((c, i) => {
        c.index = i;
        c.label = `Scene ${i + 1}`;
      });
      return { mode: 'chapters', clips };
    }
  }

  // Fallback: whole title as one clip from concatenated content VOBs.
  const vobs = contentVobs(dvdRoot);
  if (vobs.length === 0) {
    throw new Error('No playable VOB files found in this folder.');
  }
  return {
    mode: 'concat',
    clips: [
      { index: 0, chapter: null, label: 'Full disc', start: 0, duration: null, vobs },
    ],
  };
}

module.exports = { resolveDvdRoot, contentVobs, hasSecondTitleSet, discoverClips };
