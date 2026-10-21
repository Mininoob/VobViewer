'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CACHE_ROOT = path.join(
  process.env.LOCALAPPDATA || require('os').homedir(),
  'VobViewer',
  'cache'
);

// Cache key: identity of the disc folder = its path + every IFO/VOB name/size/mtime.
function cacheKeyFor(dvdRoot) {
  const files = fs
    .readdirSync(dvdRoot)
    .filter((n) => /\.(IFO|VOB)$/i.test(n))
    .sort()
    .map((n) => {
      const st = fs.statSync(path.join(dvdRoot, n));
      return { name: n.toUpperCase(), size: st.size, mtimeMs: Math.round(st.mtimeMs) };
    });
  const payload = JSON.stringify({ root: dvdRoot.toLowerCase(), files });
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

function cacheDirFor(key) {
  return path.join(CACHE_ROOT, key);
}

function ensureCacheDir(key) {
  const dir = cacheDirFor(key);
  fs.mkdirSync(dir, { recursive: true });
  // A crash mid-transcode may leave .part files behind; they are garbage.
  for (const n of fs.readdirSync(dir)) {
    if (n.endsWith('.part')) {
      try {
        fs.unlinkSync(path.join(dir, n));
      } catch {}
    }
  }
  return dir;
}

function clipPaths(key, index) {
  const dir = cacheDirFor(key);
  const nn = String(index + 1).padStart(2, '0');
  return {
    thumb: path.join(dir, `thumb_${nn}.jpg`),
    mp4: path.join(dir, `clip_${nn}.mp4`),
    part: path.join(dir, `clip_${nn}.mp4.part`),
  };
}

function manifestPath(key) {
  return path.join(cacheDirFor(key), 'manifest.json');
}

function readManifest(key) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(key), 'utf8'));
  } catch {
    return null;
  }
}

function writeManifest(key, manifest) {
  fs.writeFileSync(manifestPath(key), JSON.stringify(manifest, null, 2));
}

module.exports = {
  CACHE_ROOT,
  cacheKeyFor,
  cacheDirFor,
  ensureCacheDir,
  clipPaths,
  manifestPath,
  readManifest,
  writeManifest,
};
