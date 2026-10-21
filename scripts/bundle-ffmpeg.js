'use strict';

// Copies ffmpeg into the packaged app so release zips run out of the box.
// Runs after electron-packager (see the "pack" script). Skips with a warning
// when no ffmpeg install is found, since the app also works with a system
// ffmpeg or VOBVIEWER_FFMPEG_DIR.

const fs = require('fs');
const path = require('path');

const binDir = process.env.VOBVIEWER_FFMPEG_DIR || 'C:\\ffmpeg\\bin';
const outDir = path.join(__dirname, '..', 'release', 'VobViewer-win32-x64', 'ffmpeg');

if (!fs.existsSync(path.join(binDir, 'ffmpeg.exe'))) {
  console.warn(`bundle-ffmpeg: no ffmpeg at ${binDir}; the packaged app will need a system ffmpeg.`);
  process.exit(0);
}
if (!fs.existsSync(path.dirname(outDir))) {
  console.error('bundle-ffmpeg: run "npm run pack" first; packaged app not found.');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
  fs.copyFileSync(path.join(binDir, name), path.join(outDir, name));
}
// ffmpeg is GPL-licensed; its license text ships beside the binaries.
for (const name of ['LICENSE', 'README.txt']) {
  const src = path.join(binDir, '..', name);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, name));
}
console.log('bundle-ffmpeg: copied ffmpeg.exe, ffprobe.exe and license into', outDir);
