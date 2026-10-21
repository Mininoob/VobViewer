'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ffmpeg = require('./ffmpeg');
const probe = require('./probe');

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const POLL_MS = 3000;
const SETTLE_SWEEPS = 3; // slow optical mounts expose the root before files are readable

let getWin = () => null;
let timer = null;
let enabled = true;
let inFlight = false;
let importer = null; // set by main.js to break the require cycle

// letter -> { present, phase: 'absent'|'settling'|'announced'|'notdvd', retries, payload }
const drives = new Map();
for (const L of LETTERS) drives.set(L, { present: false, phase: 'absent', retries: 0, payload: null });

function sendTo(channel, payload) {
  const win = getWin();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

async function present(letter) {
  try {
    await fs.promises.access(letter + ':\\');
    return true;
  } catch {
    return false;
  }
}

// Path/mtime-free identity of a disc's content: sorted [NAME, size] of IFO/VOBs.
function contentSignature(dvdRoot) {
  try {
    const pairs = fs
      .readdirSync(dvdRoot)
      .filter((n) => /\.(IFO|VOB)$/i.test(n))
      .map((n) => [n.toUpperCase(), fs.statSync(path.join(dvdRoot, n)).size])
      .sort((a, b) => a[0].localeCompare(b[0]));
    return crypto.createHash('sha1').update(JSON.stringify(pairs)).digest('hex');
  } catch {
    return null;
  }
}

function discSizeMB(dvdRoot) {
  try {
    return Math.round(
      fs
        .readdirSync(dvdRoot)
        .filter((n) => /\.(IFO|BUP|VOB)$/i.test(n))
        .reduce((sum, n) => sum + fs.statSync(path.join(dvdRoot, n)).size, 0) /
        (1024 * 1024)
    );
  } catch {
    return 0;
  }
}

async function volumeLabel(letter) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const { code, stdout } = await ffmpeg.run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-Volume -DriveLetter ${letter}).FileSystemLabel`],
      { signal: controller.signal }
    );
    const label = code === 0 ? stdout.trim() : '';
    return label || `DISC ${letter}:`;
  } catch {
    return `DISC ${letter}:`;
  } finally {
    clearTimeout(timeout);
  }
}

// Find whether this disc's content already lives in the wallet.
function duplicateOf(sig) {
  if (!sig) return null;
  const library = require('./library');
  for (const disc of library.knownDiscs()) {
    if (disc.missing) continue;
    if (contentSignature(disc.dvdRoot) === sig) return disc.title || disc.folderName;
  }
  return null;
}

async function announce(letter, dvdRoot) {
  const payload = {
    driveRoot: letter + ':\\',
    dvdRoot,
    label: await volumeLabel(letter),
    approxSizeMB: discSizeMB(dvdRoot),
    dupOf: duplicateOf(contentSignature(dvdRoot)),
  };
  drives.get(letter).payload = payload;
  sendTo('disc:detected', payload);
}

async function sweep() {
  if (inFlight) return;
  inFlight = true;
  try {
    for (const letter of LETTERS) {
      const state = drives.get(letter);
      const isPresent = await present(letter);

      if (isPresent && !state.present) {
        state.present = true;
        state.phase = 'settling';
        state.retries = 0;
      } else if (!isPresent && state.present) {
        state.present = false;
        if (state.phase === 'announced') {
          sendTo('disc:ejected', { driveRoot: letter + ':\\' });
          if (importer) importer.abortIfSource(letter + ':\\');
        }
        state.phase = 'absent';
        state.payload = null;
        continue;
      }

      if (state.present && state.phase === 'settling') {
        const dvdRoot = probe.resolveDvdRoot(letter + ':\\');
        if (dvdRoot) {
          // At baseline this still announces — only genuine DVD layouts resolve,
          // so a disc already in the tray at launch is offered like any other.
          state.phase = 'announced';
          if (enabled) await announce(letter, dvdRoot);
        } else if (++state.retries >= SETTLE_SWEEPS) {
          state.phase = 'notdvd';
        }
      }
    }
  } finally {
    inFlight = false;
  }
}

function register(getWindow, importerModule) {
  getWin = getWindow;
  importer = importerModule;
  require('electron').ipcMain.handle('disc:getState', () => getState());
}

function start(startEnabled) {
  enabled = startEnabled !== false;
  if (!timer) {
    timer = setInterval(() => {
      if (enabled) sweep();
    }, POLL_MS);
    if (enabled) sweep(); // baseline immediately so a disc-in-tray announces at launch
  }
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function setEnabled(on) {
  enabled = !!on;
  if (enabled) sweep();
}

// Currently-announced discs, for a renderer that loads after detection fired.
function getState() {
  return [...drives.values()].filter((s) => s.phase === 'announced' && s.payload).map((s) => s.payload);
}

module.exports = { register, start, stop, setEnabled, getState };
