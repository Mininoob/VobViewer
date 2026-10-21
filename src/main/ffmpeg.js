'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const FFMPEG_DIR = process.env.VOBVIEWER_FFMPEG_DIR || 'C:\\ffmpeg\\bin';
const FFMPEG = path.join(FFMPEG_DIR, 'ffmpeg.exe');
const FFPROBE = path.join(FFMPEG_DIR, 'ffprobe.exe');

function checkBinaries() {
  const missing = [FFMPEG, FFPROBE].filter((p) => !fs.existsSync(p));
  return missing.length === 0
    ? null
    : `ffmpeg not found: ${missing.join(', ')}\nInstall ffmpeg or set VOBVIEWER_FFMPEG_DIR.`;
}

// Runs a binary, collects stdout fully, keeps only the tail of stderr for
// error messages. libdvdread prints copious warnings on stderr even on
// success, so callers must judge by exit code + output only.
function run(exe, args, { onStdoutLine, signal } = {}) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true });
    let stdout = '';
    let stderrTail = '';
    let lineBuf = '';

    child.stdout.on('data', (d) => {
      const text = d.toString('utf8');
      stdout += text;
      if (onStdoutLine) {
        lineBuf += text;
        let nl;
        while ((nl = lineBuf.indexOf('\n')) >= 0) {
          onStdoutLine(lineBuf.slice(0, nl).trim());
          lineBuf = lineBuf.slice(nl + 1);
        }
      }
    });
    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString('utf8')).slice(-2048);
    });
    child.on('error', (err) => resolve({ code: -1, stdout, stderrTail: String(err) }));
    child.on('close', (code) => resolve({ code, stdout, stderrTail }));

    if (signal) {
      const kill = () => {
        try {
          child.kill();
        } catch {}
        // Ensure the whole tree dies on Windows.
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true });
        } catch {}
      };
      if (signal.aborted) kill();
      else signal.addEventListener('abort', kill, { once: true });
    }
  });
}

// ffprobe the DVD folder for title-1 chapters. Resolves to parsed JSON or null.
async function probeChapters(dvdRoot) {
  const { code, stdout } = await run(FFPROBE, [
    '-hide_banner', '-v', 'error',
    '-f', 'dvdvideo', '-title', '1',
    '-i', dvdRoot,
    '-show_chapters', '-show_format', '-of', 'json',
  ]);
  if (code !== 0) return null;
  try {
    const data = JSON.parse(stdout);
    return Array.isArray(data.chapters) ? data : null;
  } catch {
    return null;
  }
}

// Duration (seconds) of an arbitrary media file, or null.
async function probeDuration(file) {
  const { code, stdout } = await run(FFPROBE, [
    '-hide_banner', '-v', 'error', '-show_format', '-of', 'json', file,
  ]);
  if (code !== 0) return null;
  try {
    const d = parseFloat(JSON.parse(stdout).format?.duration);
    return Number.isFinite(d) ? d : null;
  } catch {
    return null;
  }
}

const ENCODE_ARGS = [
  '-map', '0:v:0', '-map', '0:a:0?',
  '-vf', 'yadif=0:-1:0,scale=640:480,setsar=1',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
  '-movflags', '+faststart',
  // Output goes to a ".part" file, so the container can't be inferred from the name.
  '-f', 'mp4',
];

function thumbnailArgs(dvdRoot, chapterStartSec, chapterDurationSec, outJpg) {
  // Seek a second in for a representative frame; clamp for very short clips.
  const seek = chapterStartSec + Math.min(1.0, chapterDurationSec / 2);
  return [
    '-hide_banner', '-v', 'error', '-y',
    '-f', 'dvdvideo', '-title', '1', '-ss', seek.toFixed(3),
    '-i', dvdRoot,
    '-frames:v', '1',
    '-vf', 'yadif=0:-1:0,scale=192:144,setsar=1',
    outJpg,
  ];
}

function transcodeChapterArgs(dvdRoot, chapterNumber1Based, outPart) {
  return [
    '-hide_banner', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-y',
    '-f', 'dvdvideo', '-preindex', '1', '-title', '1',
    '-chapter_start', String(chapterNumber1Based),
    '-chapter_end', String(chapterNumber1Based),
    '-i', dvdRoot,
    ...ENCODE_ARGS,
    outPart,
  ];
}

function transcodeConcatArgs(vobFiles, outPart) {
  return [
    '-hide_banner', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-y',
    '-fflags', '+genpts',
    '-i', 'concat:' + vobFiles.join('|'),
    ...ENCODE_ARGS,
    outPart,
  ];
}

function thumbnailConcatArgs(vobFile, outJpg) {
  return [
    '-hide_banner', '-v', 'error', '-y',
    '-ss', '1.0', '-i', vobFile,
    '-frames:v', '1',
    '-vf', 'yadif=0:-1:0,scale=192:144,setsar=1',
    outJpg,
  ];
}

// Parse one "-progress pipe:1" key=value line; returns seconds or null.
function parseProgressLine(line) {
  if (line.startsWith('out_time_us=')) {
    const us = parseInt(line.slice('out_time_us='.length), 10);
    if (Number.isFinite(us) && us >= 0) return us / 1e6;
  } else if (line.startsWith('out_time=')) {
    const m = line.match(/^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
  }
  return null;
}

module.exports = {
  FFMPEG,
  FFPROBE,
  checkBinaries,
  run,
  probeChapters,
  probeDuration,
  thumbnailArgs,
  thumbnailConcatArgs,
  transcodeChapterArgs,
  transcodeConcatArgs,
  parseProgressLine,
};
