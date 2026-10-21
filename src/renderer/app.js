'use strict';

const api = window.vobviewer;

const $ = (id) => document.getElementById(id);
const video = $('video');
const seek = $('seek');
const volume = $('volume');
const sceneList = $('scenelist');
const rowTemplate = $('scenerow-t');

const state = {
  clips: [], // {index, label, duration, thumbPath, mp4Path, status, row}
  current: -1,
  seeking: false,
  loading: false,
};

/* ---------- formatting ---------- */

function scenes(n) {
  return `${n} SCENE${n === 1 ? '' : 'S'}`;
}

function fmt(sec) {
  if (sec == null || !Number.isFinite(sec)) return '--:--';
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function setStatusline(text, alert = false) {
  const el = $('statusline');
  el.textContent = text;
  el.classList.toggle('alert', alert);
}

function flashBigStatus(text, ms = 2200, isError = false) {
  const el = $('bigstatus');
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(flashBigStatus.t);
  flashBigStatus.t = setTimeout(() => el.classList.add('hidden'), ms);
}

function setLcdState(text, cls = '') {
  const el = $('lcd-state');
  el.textContent = text;
  el.className = cls;
}

// Main glass empty-state copy: 'insert' (no disc) vs 'reading' (disc loaded, nothing ready yet)
function setEmptyMode(mode) {
  const reading = mode === 'reading';
  $('emptytitle').textContent = reading ? 'READING DISC' : 'INSERT DISC';
  $('emptyhint').textContent = reading
    ? 'SCENES CONVERTING — SEE VISUAL INDEX'
    : 'DROP A DISC FOLDER (VIDEO_TS) ANYWHERE ON THE DECK';
  $('browse').classList.toggle('hidden', reading);
}

function updateAccessLamp() {
  const busy = state.clips.some((c) => c.status === 'queued' || c.status === 'transcoding');
  $('accesslamp').classList.toggle('busy', busy);
}

/* ---------- scene list ---------- */

function renderList() {
  sceneList.replaceChildren();
  $('indexempty').classList.toggle('hidden', state.clips.length > 0);
  $('indexcount').textContent = state.clips.length ? scenes(state.clips.length) : '';
  for (const clip of state.clips) {
    const row = rowTemplate.content.firstElementChild.cloneNode(true);
    clip.row = row;
    row.querySelector('.scenename').textContent = clip.label;
    row.addEventListener('click', () => trySelect(clip.index, true));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation(); // keep the global Space=play/pause handler out of it
        trySelect(clip.index, true);
      }
    });
    row.querySelector('.exportbtn').addEventListener('click', (e) => {
      e.stopPropagation();
      exportClip(clip.index);
    });
    updateRow(clip);
    sceneList.appendChild(row);
  }
}

function updateRow(clip) {
  const row = clip.row;
  if (!row) return;
  row.classList.toggle('active', clip.index === state.current);
  row.classList.toggle('unready', clip.status !== 'ready');

  const thumbwell = row.querySelector('.thumbwell');
  if (clip.thumbPath && !thumbwell.classList.contains('has-thumb')) {
    thumbwell.querySelector('img').src = api.toMediaUrl(clip.thumbPath);
    thumbwell.classList.add('has-thumb');
  }

  row.querySelector('.sceneduration').textContent =
    clip.duration != null ? fmt(clip.duration) : '--:--';

  const status = row.querySelector('.scenestatus');
  const progress = row.querySelector('.sceneprogress');
  progress.classList.toggle('hidden', clip.status !== 'transcoding');
  status.className = 'scenestatus';
  switch (clip.status) {
    case 'queued':
      status.textContent = 'QUEUED';
      break;
    case 'transcoding': {
      status.classList.add('converting');
      const p = clip.percent ?? 0;
      status.textContent = `CONVERTING ${String(p).padStart(2, '0')}%`;
      const cells = progress.children;
      const on = Math.round((p / 100) * cells.length);
      for (let i = 0; i < cells.length; i++) cells[i].classList.toggle('on', i < on);
      break;
    }
    case 'ready':
      status.classList.add('ready');
      status.textContent = 'READY';
      break;
    case 'error':
      status.classList.add('error');
      status.textContent = 'ERROR';
      status.title = clip.message || '';
      break;
  }
  row.querySelector('.exportbtn').disabled = clip.status !== 'ready';
}

/* ---------- selection & playback ---------- */

function trySelect(index, autoplay) {
  stopReel(); // a hand on the controls ends the reel's programming
  const clip = state.clips[index];
  if (!clip) return;
  if (clip.status !== 'ready') {
    setStatusline(
      clip.status === 'error'
        ? `${clip.label} FAILED TO CONVERT — ${clip.message || 'SEE CONSOLE'}`
        : `${clip.label} IS STILL CONVERTING — IT WILL BE PLAYABLE SHORTLY`,
      clip.status === 'error'
    );
    return;
  }
  selectClip(index, autoplay);
}

function selectClip(index, autoplay) {
  const clip = state.clips[index];
  const prev = state.clips[state.current];
  state.current = index;
  if (prev) updateRow(prev);
  updateRow(clip);

  $('emptystate').classList.add('hidden');
  $('lcd-scene').textContent = clip.label;
  $('tc-total').textContent = fmt(clip.duration);
  $('tc-now').textContent = fmt(0);
  seek.disabled = false;
  seek.value = 0;

  video.src = api.toMediaUrl(clip.mp4Path);
  if (autoplay) video.play();
  else setLcdState('STOP');
  clip.row?.scrollIntoView({ block: 'nearest' });
}

function nearestReady(from, dir) {
  for (let i = from + dir; i >= 0 && i < state.clips.length; i += dir) {
    if (state.clips[i].status === 'ready') return i;
  }
  return -1;
}

function stepScene(dir) {
  if (state.current < 0) return;
  const i = nearestReady(state.current, dir);
  if (i >= 0) selectClip(i, !video.paused || video.ended);
}

function togglePlay() {
  if (state.current < 0) {
    const first = nearestReady(-1, 1);
    if (first >= 0) selectClip(first, true);
    return;
  }
  if (video.paused) video.play();
  else video.pause();
}

/* ---------- video events ---------- */

video.addEventListener('play', () => {
  $('g-play').classList.add('hidden');
  $('g-pause').classList.remove('hidden');
  setLcdState('PLAY', 'playing');
});

video.addEventListener('pause', () => {
  $('g-play').classList.remove('hidden');
  $('g-pause').classList.add('hidden');
  if (state.stopping) {
    state.stopping = false; // Stop key already set the LCD to STOP
  } else if (!video.ended) {
    setLcdState('PAUSE');
  }
});

video.addEventListener('timeupdate', () => {
  if (!state.seeking && video.duration) {
    seek.value = Math.round((video.currentTime / video.duration) * 1000);
  }
  $('tc-now').textContent = fmt(video.currentTime);
});

video.addEventListener('ended', () => {
  if (lib.reel) {
    reelAdvance(1);
    return;
  }
  const next = nearestReady(state.current, 1);
  if (next >= 0) selectClip(next, true);
  else setLcdState('STOP');
});

video.addEventListener('error', () => {
  setLcdState('ERROR', 'error');
  setStatusline('PLAYBACK ERROR — TRY RE-LOADING THE DISC FOLDER', true);
  if (lib.reel) reelAdvance(1); // a bad scene must not stall the reel
});

/* ---------- transport controls ---------- */

$('k-play').addEventListener('click', togglePlay);
$('k-stop').addEventListener('click', () => {
  if (state.current < 0) return;
  state.stopping = !video.paused;
  video.pause();
  video.currentTime = 0;
  seek.value = 0;
  setLcdState('STOP');
});
$('k-prev').addEventListener('click', () => (lib.reel ? reelAdvance(-1) : stepScene(-1)));
$('k-next').addEventListener('click', () => (lib.reel ? reelAdvance(1) : stepScene(1)));

seek.addEventListener('pointerdown', () => (state.seeking = true));
seek.addEventListener('pointerup', () => (state.seeking = false));
seek.addEventListener('input', () => {
  if (!video.duration) return;
  video.currentTime = (seek.value / 1000) * video.duration;
});

volume.addEventListener('input', () => {
  video.volume = volume.value / 100;
  localStorage.setItem('vobviewer.volume', volume.value);
});
volume.value = localStorage.getItem('vobviewer.volume') ?? 80;
video.volume = volume.value / 100;

/* ---------- keyboard ---------- */

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input')) return; // never fight a text field or slider
  if (setup.open) {
    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        moveSetupSel(-1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        moveSetupSel(1);
        break;
      case 'Enter':
        e.preventDefault();
        activateSetupRow();
        break;
      case 'Escape':
        closeSetup();
        break;
    }
    return;
  }
  if (lib.open) {
    switch (e.key) {
      case 'PageUp':
        e.preventDefault();
        flipSpread(-1);
        break;
      case 'PageDown':
        e.preventDefault();
        flipSpread(1);
        break;
      case 'Escape':
        if (lib.pulled) unpullDisc();
        else closeBinder();
        break;
      case 'F2': {
        const pocket = document.activeElement?.closest?.('.pocket');
        if (pocket?.dataset.discId) startRename(pocket.dataset.discId, pocket);
        break;
      }
    }
    return;
  }
  if (e.target.closest('button')) return; // let keys keep their own key behavior
  switch (e.key) {
    case ' ':
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowLeft':
      if (video.duration) video.currentTime = Math.max(0, video.currentTime - 5);
      break;
    case 'ArrowRight':
      if (video.duration) video.currentTime = Math.min(video.duration, video.currentTime + 5);
      break;
    case 'PageUp':
      e.preventDefault();
      lib.reel ? reelAdvance(-1) : stepScene(-1);
      break;
    case 'PageDown':
      e.preventDefault();
      lib.reel ? reelAdvance(1) : stepScene(1);
      break;
    case 'l':
    case 'L':
      openBinder();
      break;
  }
});

/* ---------- folder loading ---------- */

async function loadFolder(path, opts) {
  if (state.loading || !path) return;
  state.loading = true;
  setStatusline('READING DISC…');
  flashBigStatus('READING DISC');
  try {
    const res = await api.loadFolder(path, opts);
    if (res.error) {
      setStatusline(res.error.replace(/\n/g, ' '), true);
      flashBigStatus('DISC ERROR', 2200, true);
      return;
    }
    state.clips = res.clips;
    state.current = -1;
    state.currentRoot = String(path);
    if (lib.pendingScene && lib.pendingScene.root !== state.currentRoot) {
      lib.pendingScene = null; // pending pick belonged to a disc we navigated away from
    }
    video.removeAttribute('src');
    video.load();
    setEmptyMode(res.clips.some((c) => c.status === 'ready') ? 'insert' : 'reading');
    updateAccessLamp();
    $('emptystate').classList.remove('hidden');
    $('disclabel').textContent = res.folderName;
    $('lcd-scene').textContent = 'SELECT A SCENE';
    $('tc-now').textContent = '--:--';
    $('tc-total').textContent = '--:--';
    seek.disabled = true;
    setLcdState('');
    renderList();

    for (const el of document.querySelectorAll('.lcd-surface')) {
      el.classList.remove('power-on');
      void el.offsetWidth; // restart animation
      el.classList.add('power-on');
    }

    const readyCount = res.clips.filter((c) => c.status === 'ready').length;
    setStatusline(
      `${scenes(res.clips.length)} ON ${res.folderName.toUpperCase()}` +
        (readyCount < res.clips.length ? ' — CONVERTING IN BACKGROUND' : '') +
        (res.notice ? ` · ${res.notice.toUpperCase()}` : '')
    );

    const firstReady = res.clips.findIndex((c) => c.status === 'ready');
    if (firstReady >= 0) selectClip(firstReady, false);
  } finally {
    state.loading = false;
  }
}

api.onClipUpdate((u) => {
  const clip = state.clips[u.index];
  if (!clip) return;
  Object.assign(clip, u);
  updateRow(clip);
  updateAccessLamp();
  if (
    u.status === 'ready' &&
    lib.pendingScene &&
    u.index === lib.pendingScene.index &&
    lib.pendingScene.root === state.currentRoot
  ) {
    lib.pendingScene = null;
    selectClip(u.index, true);
  } else if (u.status === 'ready' && state.current === -1 && !lib.pendingScene) {
    selectClip(u.index, false);
  }
  if (state.clips.every((c) => c.status === 'ready' || c.status === 'error')) {
    const ready = state.clips.filter((c) => c.status === 'ready').length;
    if (u.status === 'ready') setStatusline(`${scenes(ready)} READY`);
    if (ready === 0) setEmptyMode('insert'); // every conversion failed; offer the door back
  }
});

/* ---------- export ---------- */

async function exportClip(index) {
  const clip = state.clips[index];
  setStatusline(`EXPORTING ${clip.label}…`);
  const res = await api.exportClip(index);
  if (res.error) setStatusline(res.error, true);
  else if (res.canceled) setStatusline('EXPORT CANCELED');
  else setStatusline(`EXPORTED ${clip.label} → ${res.savedTo}`);
}

/* ---------- drag & drop / browse ---------- */

let dragDepth = 0;

window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (++dragDepth === 1) $('droptarget').classList.remove('hidden');
});
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('droptarget').classList.add('hidden');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('droptarget').classList.add('hidden');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  if (lib.open) closeBinder(); // a dropped disc goes straight into the player
  stopReel();
  loadFolder(api.getDroppedPath(file));
});

$('browse').addEventListener('click', async () => {
  const path = await api.openFolderDialog();
  if (path) loadFolder(path);
});

/* ---------- frameless window controls ---------- */

$('winmin').addEventListener('click', () => api.minimizeWindow());
$('winclose').addEventListener('click', () => api.closeWindow());
document.querySelectorAll('.act-min').forEach((b) => b.addEventListener('click', () => api.minimizeWindow()));
document.querySelectorAll('.act-close').forEach((b) => b.addEventListener('click', () => api.closeWindow()));

/* ==================================================================
   THE DISC WALLET — library surface
   ================================================================== */

const libApi = api.library;
const POCKETS_PER_PAGE = 4;

const lib = {
  open: false,
  discs: [],
  roots: [],
  spread: 0,
  pulled: null, // disc id whose scenes are fanned out
  reel: null, // { list: [{discId, index}], pos, shuffle }
  pendingScene: null, // { root, index } — play as soon as it converts
};

const pocketTemplate = $('pocket-t');
const fanTemplate = $('fanscene-t');

function discById(id) {
  return lib.discs.find((d) => d.id === id);
}

function applyLibrary(payload) {
  lib.discs = payload.discs;
  lib.roots = payload.roots;
}

function maxSpread() {
  const pages = Math.max(2, Math.ceil(lib.discs.length / POCKETS_PER_PAGE));
  return Math.max(0, Math.ceil(pages / 2) - 1);
}

async function openBinder() {
  if (lib.open) return;
  lib.open = true;
  $('device').classList.add('hidden');
  $('binder').classList.remove('hidden');
  const payload = await libApi.get();
  applyLibrary(payload);
  if (!lib.everOpened) {
    lib.everOpened = true;
    lib.spread = payload.lastSpread || 0; // the wallet reopens on the spread you left it
  }
  lib.spread = Math.min(lib.spread, maxSpread());
  renderBinder();
  // Scan can take a moment on a big archive; refresh when it lands.
  applyLibrary(await libApi.scan());
  if (lib.open) renderBinder();
}

function closeBinder() {
  lib.open = false;
  unpullDisc();
  $('binder').classList.add('hidden');
  $('device').classList.remove('hidden');
}

function flipSpread(dir) {
  const next = Math.min(Math.max(0, lib.spread + dir), maxSpread());
  if (next === lib.spread) return;
  lib.spread = next;
  libApi.setSpread(next);
  unpullDisc();
  renderBinder(dir > 0 ? 'fwd' : 'back');
}

/* ---------- rendering ---------- */

function renderBinder(turnDir) {
  const empty = lib.roots.length === 0 && lib.discs.length === 0;
  $('binderempty').classList.toggle('hidden', !empty);
  $('spread').classList.toggle('hidden', empty);

  const playable = lib.discs.some((d) => !d.missing && d.indexed && d.sceneCount > 0);
  $('reel-all').disabled = !playable;
  $('reel-shuffle').disabled = !playable;
  $('binderstatus').textContent = lib.discs.length
    ? `${lib.discs.length} DISC${lib.discs.length === 1 ? '' : 'S'}`
    : '';

  const spreadEl = $('spread');
  spreadEl.classList.remove('turn-fwd', 'turn-back');
  if (turnDir) {
    void spreadEl.offsetWidth;
    spreadEl.classList.add(turnDir === 'fwd' ? 'turn-fwd' : 'turn-back');
  }

  const totalSpreads = maxSpread() + 1;
  $('pageindicator').textContent = empty ? '' : `SPREAD ${lib.spread + 1} OF ${totalSpreads}`;
  $('page-prev').disabled = lib.spread === 0;
  $('page-next').disabled = lib.spread >= maxSpread();

  const start = lib.spread * POCKETS_PER_PAGE * 2;
  fillPage($('page-left'), start);
  fillPage($('page-right'), start + POCKETS_PER_PAGE);
  renderTabs();
}

function fillPage(pageEl, start) {
  pageEl.replaceChildren();
  for (let i = 0; i < POCKETS_PER_PAGE; i++) {
    const disc = lib.discs[start + i];
    pageEl.appendChild(disc ? renderPocket(disc) : renderEmptyPocket());
  }
}

function renderEmptyPocket() {
  const el = pocketTemplate.content.firstElementChild.cloneNode(true);
  el.classList.add('empty');
  el.removeAttribute('tabindex');
  el.querySelector('.disc').remove();
  el.querySelector('.indexcard').remove();
  return el;
}

function renderPocket(disc) {
  const el = pocketTemplate.content.firstElementChild.cloneNode(true);
  el.dataset.discId = disc.id;
  el.classList.toggle('missing', disc.missing);
  el.classList.toggle('pulled', lib.pulled === disc.id);

  const title = el.querySelector('.disctitle');
  if (disc.title) {
    title.textContent = disc.title;
  } else {
    title.textContent = disc.folderName;
    title.classList.add('untitled');
  }
  title.title = 'Click to write on the disc (F2)';

  const thumbs = disc.scenes.filter((s) => s.thumbPath).slice(0, 3);
  el.querySelectorAll('.indexcard img').forEach((img, i) => {
    if (thumbs[i]) img.src = api.toMediaUrl(thumbs[i].thumbPath);
  });

  el.querySelector('.chipname').textContent = disc.folderName;
  const info = el.querySelector('.chipinfo');
  if (disc.missing) {
    info.textContent = 'NOT FOUND';
    info.classList.add('error');
  } else if (!disc.indexed) {
    info.textContent = 'INDEXING…';
    info.classList.add('busy');
  } else {
    const dur = disc.totalDuration != null ? ` · ${fmt(disc.totalDuration)}` : '';
    const conv =
      disc.readyCount > 0 && disc.readyCount < disc.sceneCount
        ? ` · ${disc.readyCount}/${disc.sceneCount} CONV`
        : '';
    info.textContent = `${disc.sceneCount} SC${dur}${conv}`;
  }

  if (disc.missing) {
    el.querySelector('.ejectednote').classList.remove('hidden');
    const forget = el.querySelector('.forgetbtn');
    forget.classList.remove('hidden');
    forget.addEventListener('click', async (e) => {
      e.stopPropagation();
      applyLibrary(await libApi.forget(disc.id));
      renderBinder();
    });
  } else {
    el.addEventListener('click', () => pullDisc(disc.id));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        pullDisc(disc.id);
      }
    });
    title.addEventListener('click', (e) => {
      e.stopPropagation();
      startRename(disc.id, el);
    });
  }
  return el;
}

function renderTabs() {
  const strip = $('tabstrip');
  strip.replaceChildren();
  const projects = [...new Set(lib.discs.map((d) => d.project))];
  const currentProjects = new Set(
    lib.discs
      .slice(lib.spread * POCKETS_PER_PAGE * 2, (lib.spread + 1) * POCKETS_PER_PAGE * 2)
      .map((d) => d.project)
  );
  for (const project of projects) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'projecttab';
    tab.textContent = project;
    tab.classList.toggle('current', currentProjects.has(project));
    tab.addEventListener('click', () => {
      const idx = lib.discs.findIndex((d) => d.project === project);
      if (idx < 0) return;
      const spread = Math.floor(idx / (POCKETS_PER_PAGE * 2));
      if (spread === lib.spread) return;
      const dir = spread > lib.spread ? 'fwd' : 'back';
      lib.spread = spread;
      libApi.setSpread(spread);
      unpullDisc();
      renderBinder(dir);
    });
    strip.appendChild(tab);
  }
}

/* ---------- rename: write on the disc ---------- */

function startRename(discId, pocketEl) {
  const disc = discById(discId);
  const discEl = pocketEl.querySelector('.disc');
  if (!disc || !discEl || discEl.querySelector('.disctitle-input')) return;
  const input = document.createElement('input');
  input.className = 'disctitle-input';
  input.maxLength = 40;
  input.value = disc.title || '';
  input.placeholder = disc.folderName;
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.dataset.cancel = '1';
      input.blur();
    }
  });
  input.addEventListener('blur', async () => {
    const cancel = input.dataset.cancel === '1';
    input.remove();
    if (!cancel) {
      const updated = await libApi.setTitle(disc.id, input.value);
      if (updated) upsertDisc(updated);
    }
    if (lib.renderDirty && lib.open) {
      lib.renderDirty = false;
      renderBinder();
      if (lib.pulled) renderFan();
    }
  });
  discEl.appendChild(input);
  input.focus();
  input.select();
}

/* ---------- pull a disc: scenes fan out ---------- */

function pullDisc(discId) {
  if (lib.pulled === discId) return;
  lib.pulled = discId;
  document.querySelectorAll('.pocket').forEach((p) => {
    p.classList.toggle('pulled', p.dataset.discId === discId);
  });
  renderFan();
}

function unpullDisc() {
  lib.pulled = null;
  document.querySelectorAll('.pocket.pulled').forEach((p) => p.classList.remove('pulled'));
  $('fanstrip').classList.add('hidden');
}

function renderFan() {
  const disc = discById(lib.pulled);
  if (!disc) {
    unpullDisc();
    return;
  }
  $('fanstrip').classList.remove('hidden');
  $('fantitle').textContent = disc.title || disc.folderName;
  const dur = disc.totalDuration != null ? ` · ${fmt(disc.totalDuration)}` : '';
  $('faninfo').textContent = disc.indexed
    ? `${scenes(disc.sceneCount)}${dur} · ${disc.readyCount} CONVERTED`
    : 'INDEXING THIS DISC — THUMBNAILS ARE ON THEIR WAY';
  $('fanplay').disabled = !disc.indexed || disc.sceneCount === 0;

  const list = $('fanlist');
  list.replaceChildren();
  for (const scene of disc.scenes) {
    const el = fanTemplate.content.firstElementChild.cloneNode(true);
    if (scene.thumbPath) el.querySelector('.fanthumb img').src = api.toMediaUrl(scene.thumbPath);
    el.querySelector('.fanname').textContent = scene.label;
    el.querySelector('.fanmeta').textContent =
      (scene.duration != null ? fmt(scene.duration) : '--:--') + (scene.ready ? '' : ' · TO CONVERT');
    const open = () => openScene(disc, scene.index);
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.stopPropagation();
        open();
      }
    });
    list.appendChild(el);
  }
}

/* ---------- library -> player ---------- */

async function openScene(disc, sceneIndex) {
  closeBinder();
  lib.pendingScene = { root: disc.dvdRoot, index: sceneIndex };
  await loadFolder(disc.dvdRoot);
  const clip = state.clips[sceneIndex];
  if (clip && clip.status === 'ready' && lib.pendingScene) {
    lib.pendingScene = null;
    selectClip(sceneIndex, true);
  } else if (clip && clip.status !== 'ready') {
    setStatusline(`${clip.label} IS CONVERTING — IT WILL PLAY THE MOMENT IT'S READY`);
  }
}

function upsertDisc(disc) {
  const i = lib.discs.findIndex((d) => d.id === disc.id);
  if (i >= 0) lib.discs[i] = disc;
  else {
    lib.discs.push(disc);
    lib.discs.sort(
      (a, b) =>
        a.project.localeCompare(b.project) ||
        a.folderName.localeCompare(b.folderName) ||
        a.id.localeCompare(b.id)
    );
  }
  if (lib.open) {
    // Never re-render mid-rename — it would destroy the input and the typed title.
    if (document.querySelector('.disctitle-input')) {
      lib.renderDirty = true;
      return;
    }
    renderBinder();
    if (lib.pulled === disc.id) renderFan();
  }
}

libApi.onDisc(upsertDisc);

/* ---------- MEMORY REEL ---------- */

function startReel(shuffle) {
  const list = [];
  for (const d of lib.discs) {
    if (d.missing || !d.indexed) continue;
    for (const s of d.scenes) list.push({ discId: d.id, index: s.index });
  }
  if (list.length === 0) return;
  if (shuffle) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }
  lib.reel = { list, pos: -1, shuffle };
  closeBinder();
  reelAdvance(1);
}

function stopReel() {
  lib.reel = null;
}

async function reelPlay(pos) {
  const reel = lib.reel;
  const item = reel.list[pos];
  const disc = discById(item.discId);
  if (!disc) {
    reelAdvance(1);
    return;
  }
  reel.pos = pos;

  // Convert-ahead: warm the next different disc while this one plays.
  const nextOther = reel.list.slice(pos + 1).find((i) => i.discId !== item.discId);
  if (nextOther) libApi.precache(nextOther.discId);

  if (state.currentRoot === disc.dvdRoot) {
    const clip = state.clips[item.index];
    if (clip && clip.status === 'ready') selectClip(item.index, true);
    else lib.pendingScene = { root: disc.dvdRoot, index: item.index };
  } else {
    lib.pendingScene = { root: disc.dvdRoot, index: item.index };
    await loadFolder(disc.dvdRoot);
    const clip = state.clips[item.index];
    if (clip && clip.status === 'ready' && lib.pendingScene) {
      lib.pendingScene = null;
      selectClip(item.index, true);
    }
  }
  // After any disc-switch chatter: the reel owns the status line.
  if (lib.reel === reel) {
    setStatusline(
      `MEMORY REEL ${pos + 1}/${reel.list.length}${reel.shuffle ? ' · SHUFFLE' : ''} — ${disc.title || disc.folderName}`
    );
  }
}

function reelAdvance(dir) {
  const reel = lib.reel;
  if (!reel) return;
  const next = reel.pos + dir;
  if (next < 0) return;
  if (next >= reel.list.length) {
    stopReel();
    setLcdState('STOP');
    setStatusline('MEMORY REEL FINISHED — THAT WAS THE WHOLE ARCHIVE');
    return;
  }
  reelPlay(next);
}

/* ---------- wiring ---------- */

$('k-library').addEventListener('click', openBinder);
$('k-player').addEventListener('click', closeBinder);
$('page-prev').addEventListener('click', () => flipSpread(-1));
$('page-next').addEventListener('click', () => flipSpread(1));
$('fanclose').addEventListener('click', unpullDisc);
$('fanplay').addEventListener('click', () => {
  const disc = discById(lib.pulled);
  if (disc) openScene(disc, 0);
});
$('reel-all').addEventListener('click', () => startReel(false));
$('reel-shuffle').addEventListener('click', () => startReel(true));

async function addRoot() {
  const res = await libApi.addRoot();
  if (res && !res.canceled) {
    applyLibrary(res);
    renderBinder();
  }
  return res;
}
$('addroot').addEventListener('click', addRoot);
$('addroot2').addEventListener('click', addRoot);

/* ==================================================================
   DISC DETECTED — auto-detect prompt + import
   ================================================================== */

const disc = { current: null, importing: false };

function discNote(text, isError) {
  const n = $('dp-note');
  n.textContent = text;
  n.classList.toggle('error', !!isError);
  n.classList.remove('hidden');
}

function setImportPct(percent, file) {
  $('dp-pct').textContent = `${percent}%`;
  $('dp-file').textContent = file || '';
  const cells = $('dp-bar').children;
  const on = Math.round((percent / 100) * cells.length);
  for (let i = 0; i < cells.length; i++) cells[i].classList.toggle('on', i < on);
}

function showDiscPrompt(d) {
  if (disc.importing) return; // never replace a running import's screen
  disc.current = d;
  // The deck reacts to an inserted disc: surface the player glass.
  if (setup.open) closeSetup();
  if (lib.open) closeBinder();
  $('dp-title').textContent = 'DISC DETECTED';
  $('dp-label').textContent = `${d.label} · ${d.approxSizeMB} MB`;
  $('dp-dup').classList.toggle('hidden', !d.dupOf);
  if (d.dupOf) $('dp-dup').textContent = `ALREADY IN WALLET AS ${d.dupOf}`;
  $('dp-name').value = /^DISC [A-Z]:$/.test(d.label) ? '' : d.label;
  $('dp-name').placeholder = 'WRITE A DISC LABEL';
  $('dp-keys').classList.remove('hidden');
  $('dp-namerow').classList.remove('hidden');
  $('dp-progress').classList.add('hidden');
  $('dp-note').classList.add('hidden');
  const prompt = $('discprompt');
  prompt.classList.remove('hidden', 'power-on');
  void prompt.offsetWidth;
  prompt.classList.add('power-on');
}

function hideDiscPrompt() {
  disc.current = null;
  disc.importing = false;
  $('discprompt').classList.add('hidden');
}

async function startDiscImport() {
  const d = disc.current;
  if (!d || disc.importing) return;
  const name = $('dp-name').value.trim() || d.label;
  let res = await api.importer.start(d.dvdRoot, name);
  if (res.needsImportDir) {
    const settings = await api.settings.chooseImportDir();
    if (!settings.importDir) {
      discNote('PICK AN IMPORT FOLDER FIRST — OR SET ONE IN SETUP', true);
      return;
    }
    res = await api.importer.start(d.dvdRoot, name);
  }
  if (res.error) {
    discNote(res.error, true);
    return;
  }
  disc.importing = true;
  $('dp-title').textContent = 'IMPORTING DISC';
  $('dp-keys').classList.add('hidden');
  $('dp-namerow').classList.add('hidden');
  $('dp-note').classList.add('hidden');
  $('dp-progress').classList.remove('hidden');
  setImportPct(0, '');
  updateAccessLamp();
  $('accesslamp').classList.add('busy');
}

$('dp-import').addEventListener('click', startDiscImport);
$('dp-cancel').addEventListener('click', () => api.importer.cancel());
$('dp-ignore').addEventListener('click', () => {
  if (disc.importing) return;
  hideDiscPrompt();
});
$('dp-play').addEventListener('click', () => {
  const d = disc.current;
  if (!d || disc.importing) return;
  hideDiscPrompt();
  stopReel();
  loadFolder(d.dvdRoot, { remember: false });
});
$('dp-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startDiscImport();
});

api.disc.onDetected(showDiscPrompt);

api.disc.onEjected(({ driveRoot }) => {
  if (!disc.current || disc.current.driveRoot !== driveRoot) return;
  if (disc.importing) return; // the aborted import's done-event reports it
  hideDiscPrompt();
  setStatusline('DISC EJECTED');
});

api.importer.onProgress(({ percent, file }) => setImportPct(percent, file));

api.importer.onDone(async (r) => {
  disc.importing = false;
  updateAccessLamp();
  if (r.ok) {
    hideDiscPrompt();
    setStatusline('IMPORT COMPLETE — DISC ADDED TO WALLET');
    stopReel();
    await loadFolder(r.dvdRoot);
  } else {
    $('dp-title').textContent = 'DISC DETECTED';
    $('dp-progress').classList.add('hidden');
    $('dp-keys').classList.remove('hidden');
    $('dp-namerow').classList.remove('hidden');
    discNote(r.message || 'IMPORT STOPPED', !r.canceled);
  }
});

// A disc already sitting in the tray when the app opened.
api.disc.getState().then((list) => {
  if (list && list[0]) showDiscPrompt(list[0]);
});

/* ==================================================================
   SETUP — the camcorder's menu screen
   ================================================================== */

const setup = { open: false, sel: 0, rows: [], returnTo: 'player', data: null, cacheBytes: null, cacheArmed: false };

function fmtBytes(b) {
  if (b == null) return 'MEASURING…';
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + ' GB';
  return Math.round(b / 1024 ** 2) + ' MB';
}

async function openSetup() {
  if (setup.open) return;
  setup.returnTo = lib.open ? 'binder' : 'player';
  if (lib.open) closeBinder();
  $('device').classList.add('hidden');
  setup.open = true;
  setup.sel = 0;
  setup.cacheArmed = false;
  $('setup').classList.remove('hidden');
  setup.data = await api.settings.get();
  setup.cacheBytes = null;
  renderSetup();
  api.settings.cacheSize().then((b) => {
    setup.cacheBytes = b;
    if (setup.open) renderSetup();
  });
  for (const el of document.querySelectorAll('#setup .lcd-surface')) {
    el.classList.remove('power-on');
    void el.offsetWidth;
    el.classList.add('power-on');
  }
}

function closeSetup() {
  if (!setup.open) return;
  setup.open = false;
  $('setup').classList.add('hidden');
  if (setup.returnTo === 'binder') openBinder();
  else $('device').classList.remove('hidden');
}

function setupRowsModel() {
  const d = setup.data;
  const rows = [{ heading: 'WATCHED ARCHIVE FOLDERS' }];
  for (const root of d.roots) rows.push({ type: 'root', cap: root, action: 'REMOVE', root });
  rows.push({ type: 'addroot', cap: 'ADD WATCHED FOLDER…', action: 'PICK' });
  rows.push({ heading: 'DISC IMPORT' });
  rows.push({
    type: 'importdir',
    cap: 'IMPORT FOLDER',
    val: d.importDir + (d.importDirIsDefault ? '  · DEFAULT' : ''),
    action: 'CHANGE',
  });
  rows.push({
    type: 'autodetect',
    cap: 'DISC AUTO-DETECT',
    val: d.autoDetect ? 'ON' : 'OFF',
    on: d.autoDetect,
    action: 'SWITCH',
  });
  rows.push({ heading: 'STORAGE' });
  rows.push({
    type: 'cache',
    cap: 'CONVERSION CACHE',
    val: setup.cacheArmed ? 'PRESS CLEAR AGAIN TO CONFIRM' : fmtBytes(setup.cacheBytes),
    action: 'CLEAR',
  });
  return rows;
}

function renderSetup() {
  setup.rows = setupRowsModel();
  const selectable = setup.rows.filter((r) => !r.heading);
  setup.sel = Math.min(setup.sel, selectable.length - 1);
  const list = $('setuprows');
  list.replaceChildren();
  let selIdx = -1;
  for (const row of setup.rows) {
    const li = document.createElement('li');
    li.className = 'setuprow';
    if (row.heading) {
      li.classList.add('heading');
      li.textContent = row.heading;
    } else {
      selIdx++;
      const mySel = selIdx;
      li.classList.toggle('sel', selIdx === setup.sel);
      const cap = document.createElement('span');
      cap.className = 'setupcap';
      cap.textContent = row.cap;
      li.appendChild(cap);
      if (row.val != null) {
        const val = document.createElement('span');
        val.className = 'setupval' + (row.on ? ' on' : '');
        val.textContent = row.val;
        li.appendChild(val);
      }
      const key = document.createElement('button');
      key.type = 'button';
      key.className = 'bluekey';
      key.textContent = row.action;
      key.addEventListener('click', (e) => {
        e.stopPropagation();
        setup.sel = mySel;
        activateSetupRow();
      });
      li.appendChild(key);
      li.addEventListener('click', () => {
        setup.sel = mySel;
        activateSetupRow();
      });
    }
    list.appendChild(li);
  }
}

function moveSetupSel(dir) {
  const count = setup.rows.filter((r) => !r.heading).length;
  setup.sel = Math.min(Math.max(0, setup.sel + dir), count - 1);
  if (setup.cacheArmed) setup.cacheArmed = false; // moving away disarms the clear
  renderSetup();
}

async function activateSetupRow() {
  const row = setup.rows.filter((r) => !r.heading)[setup.sel];
  if (!row) return;
  if (row.type !== 'cache') setup.cacheArmed = false;
  switch (row.type) {
    case 'root': {
      const payload = await libApi.removeRoot(row.root);
      applyLibrary(payload);
      setup.data = await api.settings.get();
      break;
    }
    case 'addroot': {
      const res = await addRoot();
      if (res && !res.canceled) applyLibrary(res);
      setup.data = await api.settings.get();
      break;
    }
    case 'importdir':
      setup.data = await api.settings.chooseImportDir();
      break;
    case 'autodetect':
      setup.data = await api.settings.set({ autoDetect: !setup.data.autoDetect });
      break;
    case 'cache': {
      if (!setup.cacheArmed) {
        setup.cacheArmed = true; // two presses to wipe gigabytes
      } else {
        setup.cacheArmed = false;
        setup.cacheBytes = null;
        renderSetup();
        setup.cacheBytes = await api.settings.cacheClear();
        applyLibrary(await libApi.get()); // ready-counts changed under the wallet
      }
      break;
    }
  }
  if (setup.open) renderSetup();
}

$('k-setup').addEventListener('click', openSetup);
$('k-setup2').addEventListener('click', openSetup);
$('setupclose').addEventListener('click', closeSetup);
