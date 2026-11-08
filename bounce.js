import {
  Output, BufferTarget, Mp4OutputFormat, CanvasSource, EncodedVideoPacketSource, canEncodeVideo,
} from './vendor/mediabunny.min.mjs';

// Abpraller: gewählter Bereich läuft vorwärts und wieder rückwärts, so oft wie eingestellt.
// Ein Durchgang (vorwärts + rückwärts) wird einmal kodiert; die Wiederholungen sind Kopien
// dieser Pakete. Dadurch dauert der Export unabhängig von der Anzahl gleich lang.

const FPS = 30;
const MIN_RANGE = 0.2;

let opts = { count: 3, res: 1920 };
try { Object.assign(opts, JSON.parse(localStorage.getItem('bounce-settings') || '{}')); } catch (e) {}
const saveOpts = () => { try { localStorage.setItem('bounce-settings', JSON.stringify(opts)); } catch (e) {} };

const $ = (id) => document.getElementById(id);
const video = $('video');
let file = null, start = 0, end = 0;

// ---------- Zeitachse ----------

function frameTimes() {
  const n = Math.max(2, Math.round((end - start) * FPS));
  return Array.from({ length: n }, (_, i) => Math.min(start + i / FPS, end));
}
// Vorwärts 0 … n-1, rückwärts n-2 … 1 (Wendepunkte nicht doppelt)
function cycleOrder(n) {
  const fwd = Array.from({ length: n }, (_, i) => i);
  const back = Array.from({ length: n - 2 }, (_, i) => n - 2 - i);
  return fwd.concat(back);
}
const cycleLen = () => cycleOrder(frameTimes().length).length / FPS;

// ---------- Video laden ----------

function once(el, ok, ms) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => done(rej, new Error('Zeitüberschreitung')), ms);
    const onOk = () => done(res);
    const onErr = () => done(rej, new Error('Video nicht lesbar'));
    function done(f, v) { clearTimeout(t); el.removeEventListener(ok, onOk); el.removeEventListener('error', onErr); f(v); }
    el.addEventListener(ok, onOk);
    el.addEventListener('error', onErr);
  });
}

async function seekTo(t) {
  t = Math.min(Math.max(0, t), Math.max(0, video.duration - 0.04));
  if (Math.abs(video.currentTime - t) < 0.002 && video.readyState >= 2 && !video.seeking) return;
  const p = once(video, 'seeked', 4000).catch(() => {});
  video.currentTime = t;
  await p;
}

$('btnPick').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  setPlaying(false);
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(f);
  try {
    await once(video, 'loadedmetadata', 15000);
    if (!video.videoWidth || !isFinite(video.duration)) throw new Error('Video nicht lesbar');
    if (video.readyState < 2) { try { await video.play(); video.pause(); } catch (err) {} }
  } catch (err) {
    setStatus('Video konnte nicht geladen werden.');
    return;
  }
  file = f;
  start = 0;
  end = Math.min(video.duration, 3);
  video.hidden = false;
  $('btnExport').disabled = false;
  $('btnPlay').disabled = false;
  setStatus(`${f.name} (${fmtS(video.duration)})`);
  syncUI();
  seekTo(start);
});

// ---------- Bedienelemente ----------

function syncUI() {
  const d = file ? video.duration : 1;
  $('start').max = d;
  $('end').max = d;
  $('start').value = start;
  $('end').value = end;
  $('startOut').textContent = fmtS(start);
  $('endOut').textContent = fmtS(end);
  $('count').value = opts.count;
  $('countOut').textContent = opts.count + '×';
  $('res').querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === opts.res));
  if (file) {
    const c = cycleLen();
    $('lenInfo').textContent = `Ein Durchgang (vorwärts + rückwärts): ${fmtS(c)}. Gesamt: ${fmtS(c * opts.count)}.`;
  } else $('lenInfo').textContent = '';
}

$('start').addEventListener('input', (e) => {
  if (!file) return;
  setPlaying(false);
  start = Math.min(Number(e.target.value), video.duration - MIN_RANGE);
  if (end < start + MIN_RANGE) end = start + MIN_RANGE;
  syncUI();
  seekTo(start);
});
$('end').addEventListener('input', (e) => {
  if (!file) return;
  setPlaying(false);
  end = Math.max(Number(e.target.value), MIN_RANGE);
  if (start > end - MIN_RANGE) start = end - MIN_RANGE;
  syncUI();
  seekTo(end);
});
$('count').addEventListener('input', (e) => { opts.count = Number(e.target.value); saveOpts(); syncUI(); });
$('res').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  opts.res = Number(b.dataset.v);
  saveOpts();
  syncUI();
});
syncUI();

// ---------- Vorschau (vorwärts abspielen, rückwärts per Bildsprung) ----------

let playing = false, t0 = 0;
function setPlaying(on) {
  playing = on && !!file;
  $('btnPlay').textContent = playing ? '❚❚ Pause' : '▶︎ Vorschau';
  if (playing) { t0 = performance.now(); requestAnimationFrame(tick); } else video.pause();
}
function tick() {
  if (!playing) return;
  const half = (frameTimes().length - 1) / FPS;
  const tc = ((performance.now() - t0) / 1000) % cycleLen();
  if (tc < half) {
    const st = start + tc;
    if (video.paused) { video.currentTime = st; video.play().catch(() => {}); }
    else if (Math.abs(video.currentTime - st) > 0.25) video.currentTime = st;
  } else {
    if (!video.paused) video.pause();
    const st = end - (tc - half);
    if (!video.seeking) video.currentTime = Math.max(start, st);
  }
  requestAnimationFrame(tick);
}
$('btnPlay').addEventListener('click', () => setPlaying(!playing));
document.addEventListener('visibilitychange', () => { if (document.hidden) setPlaying(false); });

// ---------- Export ----------

const even = (v) => Math.max(2, Math.round(v / 2) * 2);

async function exportBounce(onProgress) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const k = opts.res ? Math.min(1, opts.res / Math.max(vw, vh)) : 1;
  const W = even(vw * k), H = even(vh * k);
  const bitrate = Math.min(50e6, Math.max(4e6, W * H * FPS * 0.25));
  let codec = null;
  for (const c of ['avc', 'hevc', 'vp9', 'av1']) {
    if (await canEncodeVideo(c, { width: W, height: H })) { codec = c; break; }
  }
  if (!codec) throw new Error('Videokodierung wird auf diesem Gerät nicht unterstützt');

  // 1) Einen Durchgang kodieren und die Pakete einsammeln
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const packets = [];
  let decoderConfig = null;
  const tmp = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const src = new CanvasSource(canvas, {
    codec, bitrate, keyFrameInterval: 3600,
    onEncodedPacket: (p, meta) => {
      packets.push(p);
      if (!decoderConfig && meta && meta.decoderConfig) decoderConfig = meta.decoderConfig;
    },
  });
  tmp.addVideoTrack(src, { frameRate: FPS });
  await tmp.start();
  const times = frameTimes(), order = cycleOrder(times.length);
  for (let i = 0; i < order.length; i++) {
    await seekTo(times[order[i]]);
    ctx.drawImage(video, 0, 0, W, H);
    await src.add(i / FPS, 1 / FPS);
    onProgress(0.95 * (i + 1) / order.length);
  }
  src.close();
  await tmp.finalize();
  canvas.width = canvas.height = 0;
  if (!decoderConfig || !packets.length) throw new Error('Kodierung lieferte keine Daten');

  // 2) Durchgang n-mal hintereinander schreiben
  const cyc = order.length / FPS;
  const out = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const vs = new EncodedVideoPacketSource(codec);
  out.addVideoTrack(vs, { frameRate: FPS });
  await out.start();
  for (let r = 0; r < opts.count; r++) {
    for (let j = 0; j < packets.length; j++) {
      const p = packets[j];
      await vs.add(p.clone({ timestamp: p.timestamp + r * cyc }), r === 0 && j === 0 ? { decoderConfig } : undefined);
    }
  }
  vs.close();
  await out.finalize();
  onProgress(1);
  return new Blob([out.target.buffer], { type: 'video/mp4' });
}

let result = null, resultUrl = null;
$('btnExport').addEventListener('click', async () => {
  if (!file) return;
  setPlaying(false);
  const btn = $('btnExport'), label = btn.textContent;
  btn.disabled = true;
  $('btnPick').disabled = true;
  try {
    const blob = await exportBounce((f) => { btn.textContent = Math.round(f * 100) + ' %'; });
    const base = file.name.replace(/\.[^.]+$/, '');
    result = new File([blob], `${base}-abpraller.mp4`, { type: 'video/mp4' });
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = URL.createObjectURL(blob);
    $('resultVideo').src = resultUrl;
    $('resultVideo').play().catch(() => {});
    $('resultInfo').textContent = `${result.name} (${fmtMb(result.size)}). „Sichern / Teilen“ → „Video sichern“ legt es in Fotos ab.`;
    $('sheet').hidden = false;
  } catch (err) {
    console.error(err);
    setStatus('Export fehlgeschlagen: ' + (err && err.message ? err.message : err));
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    $('btnPick').disabled = false;
    seekTo(start);
  }
});

$('btnShare').addEventListener('click', async () => {
  if (!result) return;
  if (navigator.canShare && navigator.canShare({ files: [result] })) {
    try { await navigator.share({ files: [result] }); } catch (err) {}
  } else {
    const a = document.createElement('a');
    a.href = resultUrl;
    a.download = result.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
});
$('btnClose').addEventListener('click', () => { $('resultVideo').pause(); $('sheet').hidden = true; });

// ---------- Hilfsfunktionen ----------

function setStatus(t) { $('status').textContent = t; }
function fmtS(t) { return t.toFixed(1).replace('.', ',') + ' s'; }
function fmtMb(b) { return (b / 1048576).toFixed(1).replace('.', ',') + ' MB'; }

document.addEventListener('gesturestart', (e) => e.preventDefault());
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
