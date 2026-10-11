'use strict';

// Alle Maße beziehen sich auf eine Basisbreite von 1080 px (Instagram-Standard).
const BASE_W = 1080;
const FORMATS = { '1:1': 1, '4:5': 1.25, '3:4': 4 / 3, '9:16': 16 / 9 };
const MAX_ZOOM = 5;
const MAX_IMG_SIDE = 3240; // Importgröße begrenzen (Speicher auf dem iPhone)
const CENTER = 4;

const defaults = {
  format: '4:5',
  border: 12,
  color: '#ffffff',
  outer: true,
  centerOn: true,
  centerSize: 42,
  centerShape: 'canvas',
  exportScale: 1,
};
let settings = { ...defaults };
try { Object.assign(settings, JSON.parse(localStorage.getItem('collage-settings') || '{}')); } catch (e) {}
const saveSettings = () => { try { localStorage.setItem('collage-settings', JSON.stringify(settings)); } catch (e) {} };

// slots[0..3] = Viertel (oben links, oben rechts, unten links, unten rechts), slots[4] = Mitte
// ox/oy: Verschiebung relativ zur Feldbreite/-höhe, damit sie bei jeder Auflösung gilt.
const slots = Array.from({ length: 5 }, () => ({ img: null, zoom: 1, ox: 0, oy: 0 }));
let selected = -1;

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

// ---------- Layout ----------

function layout(W, k) {
  const H = Math.round(W * FORMATS[settings.format]);
  const b = settings.border * k;
  const o = settings.outer ? b : 0;
  const cw = (W - 2 * o - b) / 2;
  const ch = (H - 2 * o - b) / 2;
  const cells = [
    { x: o, y: o, w: cw, h: ch },
    { x: o + cw + b, y: o, w: cw, h: ch },
    { x: o, y: o + ch + b, w: cw, h: ch },
    { x: o + cw + b, y: o + ch + b, w: cw, h: ch },
  ];
  const mw = W * settings.centerSize / 100;
  const mh = settings.centerShape === 'canvas' ? mw * H / W : mw;
  cells.push({ x: (W - mw) / 2, y: (H - mh) / 2, w: mw, h: mh, circle: settings.centerShape === 'circle' });
  return { W, H, b, cells };
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

function render(c, W, k, preview) {
  const L = layout(W, k);
  c.fillStyle = settings.color;
  c.fillRect(0, 0, L.W, L.H);
  for (let i = 0; i < 4; i++) drawSlot(c, slots[i], L.cells[i], preview);
  if (settings.centerOn) {
    const m = L.cells[CENTER];
    if (L.b > 0) {
      c.fillStyle = settings.color;
      shapePath(c, m, L.b);
      c.fill();
    }
    drawSlot(c, slots[CENTER], m, preview);
  }
  if (preview && selected >= 0) {
    const r = L.cells[selected];
    c.save();
    c.strokeStyle = '#2563eb';
    c.lineWidth = 6;
    c.setLineDash([18, 12]);
    shapePath(c, r, -3);
    c.stroke();
    c.restore();
  }
  return L;
}

let pending = false;
function draw() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    const H = Math.round(BASE_W * FORMATS[settings.format]);
    if (canvas.width !== BASE_W || canvas.height !== H) { canvas.width = BASE_W; canvas.height = H; }
    render(ctx, BASE_W, 1, true);
  });
}

// ---------- Bilder laden ----------

async function loadImage(file) {
  const url = URL.createObjectURL(file);
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

function setImage(i, img) {
  const old = slots[i].img;
  if (old) { old.width = 0; old.height = 0; } // Speicher sofort freigeben (iOS)
  slots[i] = { img, zoom: 1, ox: 0, oy: 0 };
}

let fileTarget = -1;
$('fileOne').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || fileTarget < 0) return;
  try {
    setImage(fileTarget, await loadImage(f));
    select(fileTarget);
  } catch (err) { alert('Bild konnte nicht geladen werden.'); }
  draw();
});

$('fileMany').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  const order = [0, 1, 2, 3, CENTER].filter((i) => i !== CENTER || settings.centerOn);
  let free = order.filter((i) => !slots[i].img);
  if (files.length > free.length) free = order; // alles belegt bzw. zu viele: von vorn überschreiben
  for (let n = 0; n < files.length && n < free.length; n++) {
    try { setImage(free[n], await loadImage(files[n])); } catch (err) {}
    draw();
  }
});

function pickFor(i) {
  fileTarget = i;
  $('fileOne').click();
}

// ---------- Auswahl & Bedienelemente ----------

const SLOT_NAMES = ['Oben links', 'Oben rechts', 'Unten links', 'Unten rechts', 'Mitte'];

function select(i) {
  selected = i;
  const g = $('selGroup');
  g.hidden = i < 0;
  if (i >= 0) {
    $('selTitle').textContent = 'Ausgewählt: ' + SLOT_NAMES[i];
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
$('btnRemove').addEventListener('click', () => {
  if (selected < 0) return;
  setImage(selected, null);
  select(selected);
});
$('btnAddMany').addEventListener('click', () => $('fileMany').click());

function bindSeg(id, key, parse = (v) => v) {
  const el = $(id);
  const sync = () => el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', parse(b.dataset.v) === settings[key]));
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    settings[key] = parse(b.dataset.v);
    saveSettings(); sync(); draw();
  });
  sync();
}
bindSeg('format', 'format');
bindSeg('centerShape', 'centerShape');
bindSeg('exportScale', 'exportScale', Number);

function bindRange(id, key, fmt) {
  const el = $(id), out = $(id + 'Out');
  el.value = settings[key];
  const upd = () => { out.textContent = fmt(settings[key]); };
  el.addEventListener('input', () => { settings[key] = Number(el.value); upd(); saveSettings(); draw(); });
  upd();
}
bindRange('centerSize', 'centerSize', (v) => v + ' %');
bindRange('border', 'border', (v) => v + ' px');

function bindCheck(id, key) {
  const el = $(id);
  el.checked = settings[key];
  el.addEventListener('change', () => {
    settings[key] = el.checked;
    if (key === 'centerOn' && !el.checked && selected === CENTER) select(-1);
    saveSettings(); draw();
  });
}
bindCheck('outer', 'outer');
bindCheck('centerOn', 'centerOn');

function syncColor() {
  let custom = true;
  $('swatches').querySelectorAll('button').forEach((b) => {
    const on = b.dataset.c.toLowerCase() === settings.color.toLowerCase();
    b.classList.toggle('on', on);
    if (on) custom = false;
  });
  const pk = $('swatches').querySelector('.picker');
  pk.classList.toggle('on', custom);
  if (custom) pk.style.background = settings.color;
  $('color').value = settings.color;
}
$('swatches').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  settings.color = b.dataset.c;
  saveSettings(); syncColor(); draw();
});
$('color').addEventListener('input', (e) => {
  settings.color = e.target.value;
  saveSettings(); syncColor(); draw();
});
syncColor();

// ---------- Gesten: Verschieben & Zoomen ----------

function toCanvas(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height };
}

function hitTest(p) {
  const L = layout(BASE_W, 1);
  if (settings.centerOn) {
    const m = L.cells[CENTER], pad = L.b;
    if (m.circle) {
      if (Math.hypot(p.x - (m.x + m.w / 2), p.y - (m.y + m.h / 2)) <= m.w / 2 + pad) return CENTER;
    } else if (p.x >= m.x - pad && p.x <= m.x + m.w + pad && p.y >= m.y - pad && p.y <= m.y + m.h + pad) return CENTER;
  }
  for (let i = 0; i < 4; i++) {
    const c = L.cells[i];
    if (p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h) return i;
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
    gesture = { start: p, t: Date.now(), moved: false, multi: false };
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
    if (!gesture.moved && !gesture.multi && Date.now() - gesture.t < 500) tapSlot = active;
    if (active >= 0) select(active);
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
    const W = BASE_W * settings.exportScale;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = Math.round(W * FORMATS[settings.format]);
    render(c.getContext('2d'), W, settings.exportScale, false);
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

draw();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
