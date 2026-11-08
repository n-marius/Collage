'use strict';

// Alle Maße beziehen sich auf eine Basisbreite von 1080 px (Instagram-Standard).
const BASE_W = 1080;
const FORMATS = { '1:1': 1, '4:5': 1.25, '3:4': 4 / 3, '9:16': 16 / 9 };
const MAX_ZOOM = 5;
const MAX_IMG_SIDE = 3240; // Arbeitsgröße begrenzen (Speicher auf dem iPhone)

// Zwei Funktionen teilen sich diesen Code: Foto-Collage ('still') und bewegte Collage ('motion', ?m=motion).
const MODE = new URLSearchParams(location.search).get('m') === 'motion' ? 'motion' : 'still';
const KEY = (k) => (MODE === 'motion' ? 'motion-' : 'collage-') + k;
const LIVE_LEN = 3;      // Standardlänge eines Livebilds in Sekunden
const LIVE_MAX = 4;      // kürzere Videos gelten zunächst als Livebild
const FPS = 30;

// ---------- Layouts ----------
// Neues Layout = neuer Eintrag. cells() liefert die Felder in Zeichenreihenfolge:
//   x, y, w, h       Feld in Pixeln
//   overlay: true    liegt über anderen Feldern und bekommt einen eigenen Rahmen
//   circle: true     runder Ausschnitt (Breite = Durchmesser)
//   hidden: true     Feld derzeit ausgeblendet (Slot bleibt erhalten)
// slotNames bestimmt die Anzahl der Bildplätze; controls blendet zugehörige
// Einstellungsgruppen ein (data-control="…" im HTML).
const LAYOUTS = {
  'grid4-center': {
    name: '4 + Mitte',
    slotNames: ['Oben links', 'Oben rechts', 'Unten links', 'Unten rechts', 'Mitte'],
    controls: ['center'],
    cells(W, H, b, o, s) {
      const cw = (W - 2 * o - b) / 2;
      const ch = (H - 2 * o - b) / 2;
      const mw = W * s.centerSize / 100;
      const mh = s.centerShape === 'canvas' ? mw * H / W : mw;
      return [
        { x: o, y: o, w: cw, h: ch },
        { x: o + cw + b, y: o, w: cw, h: ch },
        { x: o, y: o + ch + b, w: cw, h: ch },
        { x: o + cw + b, y: o + ch + b, w: cw, h: ch },
        { x: (W - mw) / 2, y: (H - mh) / 2, w: mw, h: mh, overlay: true,
          circle: s.centerShape === 'circle', hidden: !s.centerOn },
      ];
    },
  },
};

const DEFAULTS = {
  layout: 'grid4-center',
  format: '4:5',
  border: 12,
  color: '#ffffff',
  outer: true,
  centerOn: true,
  centerSize: 42,
  centerShape: 'canvas',
  length: 1, // nur bewegte Collage: 1 = einfache, 2 = doppelte Livebild-Länge
};

// Projektbezogene Einstellungen; zuletzt benutzte dienen als Vorlage für neue Projekte.
let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem(KEY('settings')) || '{}')); } catch (e) {}
if (!LAYOUTS[settings.layout]) settings.layout = DEFAULTS.layout;
let exportScale = 1;
try { exportScale = Number(localStorage.getItem('collage-export-scale')) || 1; } catch (e) {}

// Laufzeit-Slots: img = Arbeitsbild (Canvas) oder vid = Video-Element; imageId = Original in der Datenbank.
// live: Clip wird wie ein Livebild behandelt; start: Startpunkt eines Videos in Sekunden.
// ox/oy: Verschiebung relativ zur Feldbreite/-höhe, damit sie bei jeder Auflösung gilt.
const emptySlot = () => ({ img: null, vid: null, imageId: null, kind: null, live: false, start: 0, zoom: 1, ox: 0, oy: 0 });
const hasMedia = (s) => !!(s.img || s.vid);
function mediaDims(s) {
  if (s.img) return { w: s.img.width, h: s.img.height };
  if (s.vid && s.vid.videoWidth) return { w: s.vid.videoWidth, h: s.vid.videoHeight };
  return null;
}
const mediaSource = (s) => s.img || (s.vid && s.vid.readyState >= 2 ? s.vid : null);
let slots = [];
let selected = -1;
let project = null; // { id, name, created, updated }

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const layoutDef = () => LAYOUTS[settings.layout];

function ensureSlots() {
  const n = layoutDef().slotNames.length;
  while (slots.length < n) slots.push(emptySlot());
}

// ---------- Geometrie & Zeichnen ----------

function layout(W, k) {
  const H = Math.round(W * FORMATS[settings.format]);
  const b = settings.border * k;
  const o = settings.outer ? b : 0;
  return { W, H, b, cells: layoutDef().cells(W, H, b, o, settings) };
}

function shapePath(c, r, pad) {
  c.beginPath();
  if (r.circle) c.arc(r.x + r.w / 2, r.y + r.h / 2, r.w / 2 + pad, 0, Math.PI * 2);
  else c.rect(r.x - pad, r.y - pad, r.w + 2 * pad, r.h + 2 * pad);
}

// Liefert Skalierung und auf gültigen Bereich begrenzte Verschiebung in Pixeln.
function placement(slot, r) {
  const d = mediaDims(slot);
  if (!d) return null;
  const iw = d.w, ih = d.h;
  const s = Math.max(r.w / iw, r.h / ih) * slot.zoom;
  const dw = iw * s, dh = ih * s;
  const mx = (dw - r.w) / 2, my = (dh - r.h) / 2;
  const px = clamp(slot.ox * r.w, -mx, mx);
  const py = clamp(slot.oy * r.h, -my, my);
  return { s, dw, dh, px, py };
}

function drawSlot(c, slot, r, preview) {
  c.save();
  shapePath(c, r, 0);
  c.clip();
  const src = mediaSource(slot), p = src && placement(slot, r);
  if (p) {
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(src, r.x + r.w / 2 - p.dw / 2 + p.px, r.y + r.h / 2 - p.dh / 2 + p.py, p.dw, p.dh);
  } else if (hasMedia(slot)) {
    c.fillStyle = '#3f3f46'; // Video lädt noch
    c.fillRect(r.x, r.y, r.w, r.h);
  } else if (preview) {
    c.fillStyle = '#d4d4d8';
    c.fillRect(r.x, r.y, r.w, r.h);
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2, a = Math.min(r.w, r.h) * 0.12;
    c.strokeStyle = '#71717a';
    c.lineWidth = Math.max(3, a * 0.18);
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(cx - a, cy); c.lineTo(cx + a, cy);
    c.moveTo(cx, cy - a); c.lineTo(cx, cy + a);
    c.stroke();
  } else {
    c.fillStyle = settings.color;
    c.fillRect(r.x, r.y, r.w, r.h);
  }
  c.restore();
}

// mode: 'edit' (Vorschau mit Platzhaltern und Auswahl), 'thumb' (Platzhalter, keine Auswahl), 'export'
function render(c, W, k, mode) {
  const L = layout(W, k);
  const preview = mode !== 'export';
  c.fillStyle = settings.color;
  c.fillRect(0, 0, L.W, L.H);
  L.cells.forEach((r, i) => {
    if (r.hidden) return;
    if (r.overlay && L.b > 0) {
      c.fillStyle = settings.color;
      shapePath(c, r, L.b);
      c.fill();
    }
    drawSlot(c, slots[i], r, preview);
  });
  if (mode === 'edit' && selected >= 0 && !L.cells[selected].hidden) {
    c.save();
    c.strokeStyle = '#2563eb';
    c.lineWidth = 6;
    c.setLineDash([18, 12]);
    shapePath(c, L.cells[selected], -3);
    c.stroke();
    c.restore();
  }
  return L;
}

let pending = false;
function draw() {
  scheduleSave();
  requestRender();
}
function requestRender() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    const H = Math.round(BASE_W * FORMATS[settings.format]);
    if (canvas.width !== BASE_W || canvas.height !== H) { canvas.width = BASE_W; canvas.height = H; }
    render(ctx, BASE_W, 1, 'edit');
  });
}

// ---------- Speicher (IndexedDB) ----------
// projects: { id, name, created, updated, settings, slots: [{ imageId, zoom, ox, oy }], thumb }
// images:   { id, blob } – Originaldatei, einmal beim Import geschrieben

const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('collage', 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore('projects', { keyPath: 'id' });
    r.result.createObjectStore('images', { keyPath: 'id' });
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
dbp.catch(() => {});

async function idb(store, mode, fn) {
  const d = await dbp;
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const dbPut = (store, v) => idb(store, 'readwrite', (s) => s.put(v));
const dbGet = (store, id) => idb(store, 'readonly', (s) => s.get(id));
const dbDel = (store, id) => idb(store, 'readwrite', (s) => s.delete(id));
const dbAll = (store) => idb(store, 'readonly', (s) => s.getAll());

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

let saveTimer = null, loading = false, storageOk = true;

// Projekte der jeweiligen Funktion, neueste zuerst (ältere Projekte ohne mode gehören zur Foto-Collage)
async function myProjects() {
  return (await dbAll('projects')).filter((p) => (p.mode || 'still') === MODE).sort((a, b) => b.updated - a.updated);
}

function scheduleSave() {
  if (!project || loading) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProject, 700);
}

async function saveProject() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!project || loading) return;
  try { localStorage.setItem(KEY('settings'), JSON.stringify(settings)); } catch (e) {}
  const p = project;
  p.updated = Date.now();
  const rec = {
    ...p,
    settings: { ...settings },
    mode: MODE,
    slots: slots.map((s) => ({ imageId: s.imageId, kind: s.kind, live: s.live, start: s.start, zoom: s.zoom, ox: s.ox, oy: s.oy })),
    thumb: await thumbnail(),
  };
  try { await dbPut('projects', rec); storageOk = true; } catch (e) { storageOk = false; }
}

function thumbnail() {
  const W = 216, c = document.createElement('canvas');
  c.width = W;
  c.height = Math.round(W * FORMATS[settings.format]);
  render(c.getContext('2d'), W, W / BASE_W, 'thumb');
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.8));
}

function freeMedia(s) {
  if (s.img) { s.img.width = 0; s.img.height = 0; } // Speicher sofort freigeben (iOS)
  if (s.vid) {
    s.vid.pause();
    URL.revokeObjectURL(s.vid.src);
    s.vid.removeAttribute('src');
    s.vid.load();
  }
}

function applyProject(rec) {
  setPlaying(false);
  slots.forEach(freeMedia);
  project = { id: rec.id, name: rec.name, created: rec.created, updated: rec.updated };
  settings = { ...DEFAULTS, ...rec.settings };
  if (!LAYOUTS[settings.layout]) settings.layout = DEFAULTS.layout;
  slots = (rec.slots || []).map((s) => ({ ...emptySlot(), ...s, img: null, vid: null }));
  ensureSlots();
  selected = -1;
  try { localStorage.setItem(KEY('current'), rec.id); } catch (e) {}
  syncUI();
  select(-1);
}

let loadToken = 0;
async function openProject(id) {
  if (saveTimer) await saveProject();
  const rec = await dbGet('projects', id);
  if (!rec) return false;
  const token = ++loadToken;
  loading = true;
  applyProject(rec);
  // Bilder nachladen
  await Promise.all(slots.map(async (s) => {
    if (!s.imageId) return;
    try {
      const im = await dbGet('images', s.imageId);
      const m = im && await loadMedia(im.blob);
      if (token !== loadToken) { if (m) freeMedia(m); return; }
      if (m) Object.assign(s, m); else s.imageId = null;
    } catch (e) { s.imageId = null; }
    requestRender();
  }));
  if (token === loadToken) { loading = false; syncTimeline(); draw(); }
  return true;
}

async function newProject() {
  if (saveTimer) await saveProject();
  loadToken++;
  loading = false;
  const now = Date.now();
  applyProject({ id: uid(), name: (MODE === 'motion' ? 'Bewegt ' : 'Projekt ') + fmtDate(now), created: now, updated: now, settings: { ...settings }, slots: [] });
  syncTimeline();
  await saveProject();
}

async function deleteProject(id) {
  const rec = await dbGet('projects', id);
  if (!rec) return;
  await Promise.all((rec.slots || []).filter((s) => s.imageId).map((s) => dbDel('images', s.imageId).catch(() => {})));
  await dbDel('projects', id);
  if (project && project.id === id) {
    project = null;
    const rest = await myProjects();
    if (!rest.length || !(await openProject(rest[0].id))) await newProject();
  }
}

// Datenbank nicht verfügbar (z. B. privates Surfen): App läuft trotzdem, nur ohne Speicherung.
async function init() {
  ensureSlots();
  syncUI();
  draw();
  try {
    let id = null;
    try { id = localStorage.getItem(KEY('current')); } catch (e) {}
    if (!(id && await openProject(id))) {
      const all = await myProjects();
      if (!(all.length && await openProject(all[0].id))) await newProject();
    }
  } catch (e) {
    storageOk = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  setPlaying(false);
  if (saveTimer) saveProject();
});
window.addEventListener('pagehide', () => { if (saveTimer) saveProject(); });

// ---------- Projektliste ----------

let thumbUrls = [];
async function showProjects() {
  if (saveTimer) await saveProject();
  thumbUrls.forEach((u) => URL.revokeObjectURL(u));
  thumbUrls = [];
  const list = $('projectList');
  list.textContent = '';
  let all = [];
  try { all = await myProjects(); } catch (e) { storageOk = false; }
  $('storageHint').textContent = storageOk
    ? 'Projekte werden automatisch auf diesem Gerät gespeichert.'
    : 'Speichern auf diesem Gerät ist nicht möglich (z. B. privates Surfen).';
  for (const p of all) {
    const li = document.createElement('li');
    if (project && p.id === project.id) li.className = 'current';
    let thumb;
    if (p.thumb) {
      thumb = document.createElement('img');
      const u = URL.createObjectURL(p.thumb);
      thumbUrls.push(u);
      thumb.src = u;
      thumb.alt = '';
    } else {
      thumb = document.createElement('div');
      thumb.className = 'noimg';
    }
    const meta = document.createElement('div');
    meta.className = 'meta';
    const nm = document.createElement('div');
    nm.className = 'name';
    nm.textContent = p.name;
    const dt = document.createElement('div');
    dt.className = 'date';
    dt.textContent = 'Geändert ' + fmtDate(p.updated);
    meta.append(nm, dt);
    const acts = document.createElement('div');
    acts.className = 'acts';
    const bRen = button('Umbenennen', async () => {
      const n = prompt('Projektname', p.name);
      if (!n || !n.trim()) return;
      if (project && project.id === p.id) { project.name = n.trim(); $('projName').textContent = project.name; await saveProject(); }
      else { p.name = n.trim(); await dbPut('projects', p); }
      showProjects();
    });
    const bDel = button('Löschen', async () => {
      if (!confirm(`„${p.name}“ endgültig löschen?`)) return;
      await deleteProject(p.id);
      showProjects();
    });
    acts.append(bRen, bDel);
    const open = async () => { $('projects').hidden = true; if (!project || project.id !== p.id) await openProject(p.id); };
    thumb.addEventListener('click', open);
    meta.addEventListener('click', open);
    li.append(thumb, meta, acts);
    list.append(li);
  }
  $('projects').hidden = false;
}

function button(label, fn) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  return b;
}

$('btnProjects').addEventListener('click', showProjects);
$('btnCloseProjects').addEventListener('click', () => { $('projects').hidden = true; });
$('btnNewProject').addEventListener('click', async () => { $('projects').hidden = true; await newProject(); });

// ---------- Bilder laden ----------

async function loadImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth, h = img.naturalHeight;
    const s = Math.min(1, MAX_IMG_SIDE / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * s);
    c.height = Math.round(h * s);
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const isVideo = (b) => /^video\//.test(b.type) || /\.(mov|mp4|m4v)$/i.test(b.name || '');

function once(el, ok, ms) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => done(rej, new Error('Zeitüberschreitung')), ms);
    const onOk = () => done(res);
    const onErr = () => done(rej, new Error('Medium nicht lesbar'));
    function done(f, v) { clearTimeout(t); el.removeEventListener(ok, onOk); el.removeEventListener('error', onErr); f(v); }
    el.addEventListener(ok, onOk);
    el.addEventListener('error', onErr);
  });
}

async function seekTo(v, t) {
  t = clamp(t, 0, Math.max(0, v.duration - 0.04));
  if (Math.abs(v.currentTime - t) < 0.002 && v.readyState >= 2 && !v.seeking) return;
  const p = once(v, 'seeked', 4000).catch(() => {});
  v.currentTime = t;
  await p;
}

async function loadVideo(blob) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.preload = 'auto';
  v.src = URL.createObjectURL(blob);
  try {
    await once(v, 'loadedmetadata', 15000);
    if (!v.videoWidth || !isFinite(v.duration)) throw new Error('Video nicht lesbar');
    // iOS lädt Bilddaten teils erst nach einem Abspielversuch
    if (v.readyState < 2) { try { await v.play(); v.pause(); } catch (e) {} }
    await seekTo(v, 0);
  } catch (e) {
    URL.revokeObjectURL(v.src);
    throw e;
  }
  v.addEventListener('seeked', requestRender);
  v.addEventListener('loadeddata', requestRender);
  return v;
}

async function loadMedia(blob) {
  if (isVideo(blob)) {
    if (MODE !== 'motion') throw new Error('Videos nur in der bewegten Collage');
    return { vid: await loadVideo(blob), kind: 'video' };
  }
  return { img: await loadImage(blob), kind: 'image' };
}

// Medium in Slot setzen (file = null entfernt es).
async function setImage(i, file) {
  const m = file ? await loadMedia(file) : {};
  let imageId = null;
  if (file) {
    imageId = uid();
    try { await dbPut('images', { id: imageId, blob: file }); } catch (e) { storageOk = false; }
  }
  const old = slots[i];
  freeMedia(old);
  if (old.imageId) dbDel('images', old.imageId).catch(() => {});
  slots[i] = { ...emptySlot(), ...m, imageId };
  if (m.vid) slots[i].live = m.vid.duration <= LIVE_MAX;
  syncTimeline();
}

let fileTarget = -1;
$('fileOne').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || fileTarget < 0) return;
  try {
    await setImage(fileTarget, f);
    select(fileTarget);
  } catch (err) { alert('Datei konnte nicht geladen werden.'); }
  draw();
});

$('fileMany').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  const cells = layout(BASE_W, 1).cells;
  const order = cells.map((c, i) => i).filter((i) => !cells[i].hidden);
  let free = order.filter((i) => !hasMedia(slots[i]));
  if (files.length > free.length) free = order; // zu viele: von vorn überschreiben
  for (let n = 0; n < files.length && n < free.length; n++) {
    try { await setImage(free[n], files[n]); } catch (err) {}
    draw();
  }
});

function pickFor(i) {
  fileTarget = i;
  $('fileOne').click();
}

// ---------- Auswahl & Bedienelemente ----------

function select(i) {
  selected = i;
  $('selGroup').hidden = i < 0;
  if (i >= 0) {
    $('selTitle').textContent = 'Ausgewählt: ' + layoutDef().slotNames[i];
    $('zoom').value = slots[i].zoom;
    const has = hasMedia(slots[i]);
    syncClipUI();
    $('zoom').disabled = !has;
    $('btnCenter').disabled = !has;
    $('btnRemove').disabled = !has;
    $('btnReplace').textContent = has ? 'Ersetzen' : 'Bild wählen';
  }
  draw();
}

$('zoom').addEventListener('input', (e) => {
  if (selected < 0 || !mediaDims(slots[selected])) return;
  setZoom(selected, parseFloat(e.target.value));
  draw();
});
$('btnReplace').addEventListener('click', () => selected >= 0 && pickFor(selected));
$('btnCenter').addEventListener('click', () => {
  if (selected < 0) return;
  Object.assign(slots[selected], { zoom: 1, ox: 0, oy: 0 });
  select(selected);
});
$('btnRemove').addEventListener('click', async () => {
  if (selected < 0) return;
  await setImage(selected, null);
  select(selected);
});
$('btnAddMany').addEventListener('click', () => $('fileMany').click());
$('btnClear').addEventListener('click', async () => {
  if (!slots.some(hasMedia) || !confirm('Alle Bilder aus dieser Collage entfernen?')) return;
  for (let i = 0; i < slots.length; i++) if (hasMedia(slots[i]) || slots[i].imageId) await setImage(i, null);
  select(-1);
});

// Einstellungs-Bedienelemente: jedes registriert eine sync-Funktion für syncUI().
const syncers = [];
function syncUI() {
  ensureSlots();
  syncers.forEach((f) => f());
  const ctl = layoutDef().controls;
  document.querySelectorAll('[data-control]').forEach((g) => { g.hidden = !ctl.includes(g.dataset.control); });
  $('projName').textContent = project ? project.name : 'Collage';
}
function changed() {
  if (selected >= 0 && layout(BASE_W, 1).cells[selected].hidden) select(-1);
  syncTimeline();
  syncUI();
  draw();
}

function bindSeg(id, get, set, parse = (v) => v) {
  const el = $(id);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    set(parse(b.dataset.v));
    changed();
  });
  syncers.push(() => el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', parse(b.dataset.v) === get())));
}

for (const [id, def] of Object.entries(LAYOUTS)) {
  const b = document.createElement('button');
  b.dataset.v = id;
  b.textContent = def.name;
  $('layout').append(b);
}
bindSeg('layout', () => settings.layout, (v) => { settings.layout = v; selected = -1; $('selGroup').hidden = true; });
bindSeg('format', () => settings.format, (v) => { settings.format = v; });
bindSeg('centerShape', () => settings.centerShape, (v) => { settings.centerShape = v; });
bindSeg('exportScale', () => exportScale, (v) => {
  exportScale = v;
  try { localStorage.setItem('collage-export-scale', String(v)); } catch (e) {}
}, Number);
bindSeg('length', () => settings.length, (v) => { settings.length = v; }, Number);

function bindRange(id, key, fmt) {
  const el = $(id), out = $(id + 'Out');
  el.addEventListener('input', () => { settings[key] = Number(el.value); out.textContent = fmt(settings[key]); draw(); });
  syncers.push(() => { el.value = settings[key]; out.textContent = fmt(settings[key]); });
}
bindRange('centerSize', 'centerSize', (v) => v + ' %');
bindRange('border', 'border', (v) => v + ' px');

function bindCheck(id, key) {
  const el = $(id);
  el.addEventListener('change', () => { settings[key] = el.checked; changed(); });
  syncers.push(() => { el.checked = settings[key]; });
}
bindCheck('outer', 'outer');
bindCheck('centerOn', 'centerOn');

syncers.push(() => {
  let custom = true;
  $('swatches').querySelectorAll('button').forEach((b) => {
    const on = b.dataset.c.toLowerCase() === settings.color.toLowerCase();
    b.classList.toggle('on', on);
    if (on) custom = false;
  });
  const pk = $('swatches').querySelector('.picker');
  pk.classList.toggle('on', custom);
  pk.style.background = custom ? settings.color : '';
  $('color').value = settings.color;
});
$('swatches').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  settings.color = b.dataset.c;
  changed();
});
$('color').addEventListener('input', (e) => {
  settings.color = e.target.value;
  changed();
});

// ---------- Bewegte Collage: Zeitachse, Vorschau, Clip-Einstellungen ----------
// Einfache Länge = längstes Livebild (sonst 3 s). Livebilder laufen einmal durch, bei doppelter Länge
// danach rückwärts; leicht abweichende Livebild-Längen werden auf die gemeinsame Länge gedehnt.
// Videos laufen ab ihrem Startpunkt vorwärts über die gesamte Länge.

function videoSlots() {
  if (MODE !== 'motion') return [];
  const cells = layout(BASE_W, 1).cells;
  return slots.map((s, i) => i).filter((i) => slots[i].vid && cells[i] && !cells[i].hidden);
}
function baseLen() {
  let m = 0;
  for (const i of videoSlots()) if (slots[i].live) m = Math.max(m, slots[i].vid.duration);
  return m || LIVE_LEN;
}
const totalLen = () => baseLen() * settings.length;
const maxStart = (s) => Math.max(0, s.vid.duration - totalLen());

function srcTime(s, t) {
  if (s.live) {
    let u = t / baseLen();
    if (u > 1) u = 2 - u;
    return u * s.vid.duration;
  }
  return s.start + t;
}

let playing = false, playT0 = 0, previewT = 0;

function syncVideos(t, play) {
  const L = baseLen();
  for (const i of videoSlots()) {
    const s = slots[i], v = s.vid, st = srcTime(s, t);
    const forward = !s.live || t <= L;
    if (play && forward) {
      v.playbackRate = s.live ? clamp(v.duration / L, 0.5, 2) : 1;
      if (v.paused) { v.currentTime = st; v.play().catch(() => {}); }
      else if (Math.abs(v.currentTime - st) > 0.25) v.currentTime = st;
    } else {
      if (!v.paused) v.pause();
      if (!v.seeking && Math.abs(v.currentTime - st) > 0.02) v.currentTime = st;
    }
  }
}

function setPlaying(on) {
  if (MODE !== 'motion') return;
  on = on && videoSlots().length > 0;
  playing = on;
  $('btnPlay').textContent = on ? '❚❚ Pause' : '▶︎ Abspielen';
  if (on) {
    playT0 = performance.now() - previewT * 1000;
    requestAnimationFrame(tick);
  } else syncVideos(previewT, false);
}
function tick() {
  if (!playing) return;
  previewT = ((performance.now() - playT0) / 1000) % totalLen();
  syncVideos(previewT, true);
  syncTimeUI();
  requestRender();
  requestAnimationFrame(tick);
}

function syncTimeUI() {
  if (MODE !== 'motion') return;
  $('time').max = totalLen();
  $('time').value = previewT;
  $('timeOut').textContent = fmtS(previewT);
}

// Nach jeder Änderung an Clips oder Länge: Grenzen prüfen, Anzeige und Vorschau anpassen.
function syncTimeline() {
  if (MODE !== 'motion') return;
  for (const i of videoSlots()) slots[i].start = clamp(slots[i].start, 0, maxStart(slots[i]));
  previewT = Math.min(previewT, totalLen());
  const L = baseLen();
  $('lengthHint').textContent = `Einfach: ${fmtS(L)}, doppelt: ${fmtS(2 * L)}. Livebilder laufen bei „Doppelt“ vorwärts und zurück, Videos laufen durch.`;
  syncTimeUI();
  syncClipUI();
  if (!playing) syncVideos(previewT, false);
}

function syncClipUI() {
  if (MODE !== 'motion') return;
  const s = selected >= 0 ? slots[selected] : null;
  $('clipCtl').hidden = !(s && s.vid);
  if (!s || !s.vid) return;
  $('clipKind').querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b.dataset.v === 'live') === s.live));
  const m = maxStart(s);
  $('clipStartRow').hidden = s.live;
  $('clipStart').max = m;
  $('clipStart').value = s.start;
  $('clipStart').disabled = m <= 0;
  $('clipStartOut').textContent = `${fmtS(s.start)} – ${fmtS(Math.min(s.vid.duration, s.start + totalLen()))}`;
}

if (MODE === 'motion') {
  document.querySelectorAll('[data-only="motion"]').forEach((el) => { el.hidden = false; });
  $('fileOne').accept = 'image/*,video/*';
  $('fileMany').accept = 'image/*,video/*';
  $('btnAddMany').textContent = 'Mehrere Medien hinzufügen';
  $('hint').textContent = 'Leeres Feld antippen: Foto oder Video wählen. Livebilder vorher in Fotos über Teilen → „Als Video sichern“ umwandeln. Ein Finger verschiebt, zwei Finger zoomen.';
  $('btnPlay').addEventListener('click', () => setPlaying(!playing));
  $('time').addEventListener('input', (e) => {
    setPlaying(false);
    previewT = Number(e.target.value);
    syncTimeUI();
    syncVideos(previewT, false);
  });
  $('clipKind').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || selected < 0 || !slots[selected].vid) return;
    slots[selected].live = b.dataset.v === 'live';
    syncTimeline();
    draw();
  });
  $('clipStart').addEventListener('input', (e) => {
    if (selected < 0 || !slots[selected].vid) return;
    setPlaying(false);
    slots[selected].start = Number(e.target.value);
    previewT = 0;
    syncTimeline();
    draw();
  });
}
const tab = document.querySelector(`.tabbar a[data-tab="${MODE}"]`);
if (tab) tab.classList.add('on');

// ---------- Gesten: Verschieben & Zoomen ----------

function toCanvas(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height };
}

// Oberste Felder zuerst prüfen; Überlagerungen einschließlich ihres Rahmens.
function hitTest(p) {
  const L = layout(BASE_W, 1);
  for (let i = L.cells.length - 1; i >= 0; i--) {
    const c = L.cells[i];
    if (c.hidden) continue;
    const pad = c.overlay ? L.b : 0;
    if (c.circle) {
      if (Math.hypot(p.x - (c.x + c.w / 2), p.y - (c.y + c.h / 2)) <= c.w / 2 + pad) return i;
    } else if (p.x >= c.x - pad && p.x <= c.x + c.w + pad && p.y >= c.y - pad && p.y <= c.y + c.h + pad) return i;
  }
  return -1;
}

function cellRect(i) { return layout(BASE_W, 1).cells[i]; }

// Verschiebung auf gültigen Bereich zurückführen und speichern.
function normalize(i) {
  const s = slots[i], r = cellRect(i);
  const p = placement(s, r);
  if (!p) return;
  s.ox = p.px / r.w;
  s.oy = p.py / r.h;
}

// Zoom um einen Fixpunkt f (Canvas-Koordinaten); ohne f: Feldmitte.
function setZoom(i, z, f) {
  const s = slots[i], r = cellRect(i);
  normalize(i);
  z = clamp(z, 1, MAX_ZOOM);
  const fx = f ? f.x - (r.x + r.w / 2) : 0;
  const fy = f ? f.y - (r.y + r.h / 2) : 0;
  const k = z / s.zoom;
  s.ox = (fx - (fx - s.ox * r.w) * k) / r.w;
  s.oy = (fy - (fy - s.oy * r.h) * k) / r.h;
  s.zoom = z;
  normalize(i);
  if (i === selected) $('zoom').value = z;
}

function pan(i, dx, dy) {
  const s = slots[i], r = cellRect(i);
  normalize(i);
  s.ox += dx / r.w;
  s.oy += dy / r.h;
  normalize(i);
}

const pointers = new Map();
let active = -1;
let gesture = null;
let tapSlot = -1;

function twoFinger() {
  const [a, b] = [...pointers.values()];
  return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) };
}

canvas.addEventListener('pointerdown', (e) => {
  const p = toCanvas(e);
  if (pointers.size === 0) {
    active = hitTest(p);
    gesture = { start: p, t: Date.now(), moved: false, multi: false, wasSelected: active >= 0 && active === selected };
    tapSlot = -1;
    if (active >= 0 && active !== selected) select(active);
  }
  pointers.set(e.pointerId, p);
  canvas.setPointerCapture(e.pointerId);
  if (pointers.size === 2) {
    gesture.multi = true;
    gesture.prev = twoFinger();
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  const prevP = pointers.get(e.pointerId);
  const p = toCanvas(e);
  pointers.set(e.pointerId, p);
  if (Math.hypot(p.x - gesture.start.x, p.y - gesture.start.y) > 12) gesture.moved = true;
  if (active < 0 || !mediaDims(slots[active])) return;
  if (pointers.size === 1) {
    pan(active, p.x - prevP.x, p.y - prevP.y);
  } else if (pointers.size === 2) {
    const cur = twoFinger();
    const prev = gesture.prev;
    if (prev.dist > 0) setZoom(active, slots[active].zoom * cur.dist / prev.dist, prev.mid);
    pan(active, cur.mid.x - prev.mid.x, cur.mid.y - prev.mid.y);
    gesture.prev = cur;
  }
  draw();
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size === 1) {
    gesture.prev = null;
  } else if (pointers.size === 0) {
    const tap = !gesture.moved && !gesture.multi && Date.now() - gesture.t < 500;
    if (tap) {
      tapSlot = active;
      // Erneutes Antippen des ausgewählten Bildes oder Tippen daneben blendet den Auswahlrahmen aus.
      if (active < 0 || (gesture.wasSelected && hasMedia(slots[active]))) select(-1);
      else select(active);
    } else if (active >= 0) select(active);
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

// Dateiauswahl nur aus einem echten Klick heraus öffnen (iOS-Vorgabe).
canvas.addEventListener('click', () => {
  if (tapSlot >= 0 && !hasMedia(slots[tapSlot])) pickFor(tapSlot);
  tapSlot = -1;
});

// Mausrad/Trackpad am Rechner
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = toCanvas(e);
  const i = hitTest(p);
  if (i < 0 || !mediaDims(slots[i])) return;
  if (i !== selected) select(i);
  setZoom(i, slots[i].zoom * Math.exp(-e.deltaY * 0.002), p);
  draw();
}, { passive: false });

// Safari-eigenes Seitenzoomen unterbinden
document.addEventListener('gesturestart', (e) => e.preventDefault());

// ---------- Export ----------

let lastFile = null, lastUrl = null;

async function exportStill() {
  const W = BASE_W * exportScale;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = Math.round(W * FORMATS[settings.format]);
  render(c.getContext('2d'), W, exportScale, 'export');
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.95));
  c.width = c.height = 0;
  if (!blob) throw new Error('Bild konnte nicht erzeugt werden');
  return blob;
}

// Bewegte Collage: Bild für Bild (30 fps) rendern; Clips werden exakt auf die jeweilige Zeit gesetzt.
async function exportMotion(onProgress) {
  const mb = await import('./vendor/mediabunny.min.mjs');
  setPlaying(false);
  const W = BASE_W * exportScale, H = Math.round(W * FORMATS[settings.format]);
  const bitrate = exportScale === 2 ? 40e6 : 16e6;
  let codec = null;
  for (const c of ['avc', 'hevc', 'vp9', 'av1']) {
    if (await mb.canEncodeVideo(c, { width: W, height: H })) { codec = c; break; }
  }
  if (!codec) throw new Error('Videokodierung wird auf diesem Gerät nicht unterstützt');
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d');
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.BufferTarget() });
  const src = new mb.CanvasSource(c, { codec, bitrate, keyFrameInterval: 1 });
  output.addVideoTrack(src, { frameRate: FPS });
  await output.start();
  const vids = videoSlots();
  const F = Math.round(totalLen() * FPS);
  for (let f = 0; f < F; f++) {
    const t = f / FPS;
    for (const i of vids) await seekTo(slots[i].vid, srcTime(slots[i], t));
    render(x, W, exportScale, 'export');
    await src.add(t, 1 / FPS);
    onProgress((f + 1) / F);
  }
  src.close();
  await output.finalize();
  c.width = c.height = 0;
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}

$('btnSave').addEventListener('click', async () => {
  const btn = $('btnSave'), label = btn.textContent;
  btn.disabled = true;
  try {
    const motion = MODE === 'motion' && videoSlots().length > 0;
    const blob = motion ? await exportMotion((f) => { btn.textContent = Math.round(f * 100) + ' %'; }) : await exportStill();
    const d = new Date();
    const name = `collage-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}.${motion ? 'mp4' : 'jpg'}`;
    lastFile = new File([blob], name, { type: blob.type });
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(blob);
    $('result').hidden = motion;
    $('resultVideo').hidden = !motion;
    if (motion) { $('resultVideo').src = lastUrl; $('resultVideo').play().catch(() => {}); } else $('result').src = lastUrl;
    $('resultHint').textContent = motion
      ? '„Sichern / Teilen“ → „Video sichern“ legt es in Fotos ab.'
      : 'Mit „Sichern / Teilen“ → „Bild sichern“ landet es in Fotos. Alternativ Bild lange drücken.';
    $('sheet').hidden = false;
  } catch (err) {
    console.error(err);
    alert('Export fehlgeschlagen' + (err && err.message ? ': ' + err.message : '.'));
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    if (MODE === 'motion') syncVideos(previewT, false);
  }
});

$('btnShare').addEventListener('click', async () => {
  if (!lastFile) return;
  if (navigator.canShare && navigator.canShare({ files: [lastFile] })) {
    try { await navigator.share({ files: [lastFile] }); } catch (err) {}
  } else {
    const a = document.createElement('a');
    a.href = lastUrl;
    a.download = lastFile.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
});
$('btnClose').addEventListener('click', () => { $('resultVideo').pause(); $('sheet').hidden = true; });

// ---------- Hilfsfunktionen & Start ----------

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtS(t) { return t.toFixed(1).replace('.', ',') + ' s'; }
function fmtDate(t) {
  const d = new Date(t);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

init();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
