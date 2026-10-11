'use strict';

// Alle Maße beziehen sich auf eine Basisbreite von 1080 px (Instagram-Standard).
const BASE_W = 1080;
const FORMATS = { '1:1': 1, '4:5': 1.25, '3:4': 4 / 3, '9:16': 16 / 9 };
const MAX_ZOOM = 5;
const MAX_IMG_SIDE = 3240; // Arbeitsgröße begrenzen (Speicher auf dem iPhone)

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
};

// Projektbezogene Einstellungen; zuletzt benutzte dienen als Vorlage für neue Projekte.
let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('collage-settings') || '{}')); } catch (e) {}
if (!LAYOUTS[settings.layout]) settings.layout = DEFAULTS.layout;
let exportScale = 1;
try { exportScale = Number(localStorage.getItem('collage-export-scale')) || 1; } catch (e) {}

// Laufzeit-Slots: img = Arbeitsbild (Canvas), imageId = Original in der Datenbank.
// ox/oy: Verschiebung relativ zur Feldbreite/-höhe, damit sie bei jeder Auflösung gilt.
const emptySlot = () => ({ img: null, imageId: null, zoom: 1, ox: 0, oy: 0 });
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
  const iw = slot.img.width, ih = slot.img.height;
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
  if (slot.img) {
    const p = placement(slot, r);
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(slot.img, r.x + r.w / 2 - p.dw / 2 + p.px, r.y + r.h / 2 - p.dh / 2 + p.py, p.dw, p.dh);
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

function scheduleSave() {
  if (!project || loading) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProject, 700);
}

async function saveProject() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!project || loading) return;
  try { localStorage.setItem('collage-settings', JSON.stringify(settings)); } catch (e) {}
  const p = project;
  p.updated = Date.now();
  const rec = {
    ...p,
    settings: { ...settings },
    slots: slots.map((s) => ({ imageId: s.imageId, zoom: s.zoom, ox: s.ox, oy: s.oy })),
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

function freeImages() {
  slots.forEach((s) => { if (s.img) { s.img.width = 0; s.img.height = 0; } });
}

function applyProject(rec) {
  freeImages();
  project = { id: rec.id, name: rec.name, created: rec.created, updated: rec.updated };
  settings = { ...DEFAULTS, ...rec.settings };
  if (!LAYOUTS[settings.layout]) settings.layout = DEFAULTS.layout;
  slots = (rec.slots || []).map((s) => ({ ...emptySlot(), ...s, img: null }));
  ensureSlots();
  selected = -1;
  try { localStorage.setItem('collage-current', rec.id); } catch (e) {}
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
      const img = im && await loadImage(im.blob);
      if (token !== loadToken) { if (img) img.width = img.height = 0; return; }
      s.img = img || null;
      if (!img) s.imageId = null;
    } catch (e) { s.imageId = null; }
    draw();
  }));
  if (token === loadToken) { loading = false; draw(); }
  return true;
}

async function newProject() {
  if (saveTimer) await saveProject();
  loadToken++;
  loading = false;
  const now = Date.now();
  applyProject({ id: uid(), name: 'Projekt ' + fmtDate(now), created: now, updated: now, settings: { ...settings }, slots: [] });
  await saveProject();
}

async function deleteProject(id) {
  const rec = await dbGet('projects', id);
  if (!rec) return;
  await Promise.all((rec.slots || []).filter((s) => s.imageId).map((s) => dbDel('images', s.imageId).catch(() => {})));
  await dbDel('projects', id);
  if (project && project.id === id) {
    project = null;
    const rest = (await dbAll('projects')).sort((a, b) => b.updated - a.updated);
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
    try { id = localStorage.getItem('collage-current'); } catch (e) {}
    if (!(id && await openProject(id))) {
      const all = (await dbAll('projects')).sort((a, b) => b.updated - a.updated);
      if (!(all.length && await openProject(all[0].id))) await newProject();
    }
  } catch (e) {
    storageOk = false;
  }
}

document.addEventListener('visibilitychange', () => { if (document.hidden && saveTimer) saveProject(); });
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
  try { all = (await dbAll('projects')).sort((a, b) => b.updated - a.updated); } catch (e) { storageOk = false; }
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

// Bild in Slot setzen (file = null entfernt das Bild).
async function setImage(i, file) {
  const img = file ? await loadImage(file) : null;
  let imageId = null;
  if (file) {
    imageId = uid();
    try { await dbPut('images', { id: imageId, blob: file }); } catch (e) { storageOk = false; }
  }
  const old = slots[i];
  if (old.img) { old.img.width = 0; old.img.height = 0; } // Speicher sofort freigeben (iOS)
  if (old.imageId) dbDel('images', old.imageId).catch(() => {});
  slots[i] = { ...emptySlot(), img, imageId };
}

let fileTarget = -1;
$('fileOne').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || fileTarget < 0) return;
  try {
    await setImage(fileTarget, f);
    select(fileTarget);
  } catch (err) { alert('Bild konnte nicht geladen werden.'); }
  draw();
});

$('fileMany').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  const cells = layout(BASE_W, 1).cells;
  const order = cells.map((c, i) => i).filter((i) => !cells[i].hidden);
  let free = order.filter((i) => !slots[i].img);
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
    const has = !!slots[i].img;
    $('zoom').disabled = !has;
    $('btnCenter').disabled = !has;
    $('btnRemove').disabled = !has;
    $('btnReplace').textContent = has ? 'Ersetzen' : 'Bild wählen';
  }
  draw();
}

$('zoom').addEventListener('input', (e) => {
  if (selected < 0 || !slots[selected].img) return;
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
  if (!slots.some((s) => s.img) || !confirm('Alle Bilder aus dieser Collage entfernen?')) return;
  for (let i = 0; i < slots.length; i++) if (slots[i].img || slots[i].imageId) await setImage(i, null);
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
  if (active < 0 || !slots[active].img) return;
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
      if (active < 0 || (gesture.wasSelected && slots[active].img)) select(-1);
      else select(active);
    } else if (active >= 0) select(active);
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

// Dateiauswahl nur aus einem echten Klick heraus öffnen (iOS-Vorgabe).
canvas.addEventListener('click', () => {
  if (tapSlot >= 0 && !slots[tapSlot].img) pickFor(tapSlot);
  tapSlot = -1;
});

// Mausrad/Trackpad am Rechner
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = toCanvas(e);
  const i = hitTest(p);
  if (i < 0 || !slots[i].img) return;
  if (i !== selected) select(i);
  setZoom(i, slots[i].zoom * Math.exp(-e.deltaY * 0.002), p);
  draw();
}, { passive: false });

// Safari-eigenes Seitenzoomen unterbinden
document.addEventListener('gesturestart', (e) => e.preventDefault());

// ---------- Export ----------

let lastFile = null, lastUrl = null;

$('btnSave').addEventListener('click', async () => {
  const btn = $('btnSave');
  btn.disabled = true;
  try {
    const W = BASE_W * exportScale;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = Math.round(W * FORMATS[settings.format]);
    render(c.getContext('2d'), W, exportScale, 'export');
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.95));
    c.width = c.height = 0;
    if (!blob) throw new Error('toBlob');
    const d = new Date();
    const name = `collage-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}.jpg`;
    lastFile = new File([blob], name, { type: 'image/jpeg' });
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(blob);
    $('result').src = lastUrl;
    $('sheet').hidden = false;
  } catch (err) {
    alert('Export fehlgeschlagen.');
  } finally {
    btn.disabled = false;
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
$('btnClose').addEventListener('click', () => { $('sheet').hidden = true; });

// ---------- Hilfsfunktionen & Start ----------

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtDate(t) {
  const d = new Date(t);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

init();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
