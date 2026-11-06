import {
  Input, Output, BlobSource, BufferTarget, ALL_FORMATS, Mp4OutputFormat, MovOutputFormat,
  EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource, AudioBufferSource, canEncodeAudio,
} from './vendor/mediabunny.min.mjs';

// 6-Band-EQ: Glockenfilter, d. h. jeder Regler wirkt mit vollem Wert auf seine Frequenz.
const BANDS = [
  { f: 60, type: 'peaking', label: '60 Hz' },
  { f: 200, type: 'peaking', label: '200 Hz' },
  { f: 600, type: 'peaking', label: '600 Hz' },
  { f: 2000, type: 'peaking', label: '2 kHz' },
  { f: 6000, type: 'peaking', label: '6 kHz' },
  { f: 14000, type: 'peaking', label: '14 kHz' },
];
const Q = 1.0;
const AAC_BITRATE = 256000;

let eq = { gains: BANDS.map(() => 0), gain: 0 };
try { Object.assign(eq, JSON.parse(localStorage.getItem('video-eq') || '{}')); } catch (e) {}
const saveEq = () => { try { localStorage.setItem('video-eq', JSON.stringify(eq)); } catch (e) {} };

const $ = (id) => document.getElementById(id);
const video = $('video');
let file = null;

// ---------- Filterkette (für Vorschau und Export identisch) ----------

function buildChain(ctx, input, output) {
  const filters = BANDS.map((b, i) => {
    const f = ctx.createBiquadFilter();
    f.type = b.type;
    f.frequency.value = b.f;
    f.Q.value = Q;
    f.gain.value = eq.gains[i];
    return f;
  });
  const g = ctx.createGain();
  g.gain.value = dbToLin(eq.gain);
  [input, ...filters, g].reduce((a, b) => (a.connect(b), b)).connect(output);
  return { filters, g };
}

// ---------- Vorschau ----------

let actx = null, src = null, chain = null;

function ensureAudio() {
  if (actx) { if (actx.state !== 'running') actx.resume(); return; }
  // iOS: Wiedergabe auch bei Stummschalter, wie bei normalen Videos
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
  const AC = window.AudioContext || window.webkitAudioContext;
  actx = new AC();
  src = actx.createMediaElementSource(video);
  routePreview();
  actx.resume();
}

function routePreview() {
  if (!actx) return;
  src.disconnect();
  if (chain) { chain.filters.forEach((f) => f.disconnect()); chain.g.disconnect(); }
  chain = null;
  if ($('eqOn').checked) chain = buildChain(actx, src, actx.destination);
  else src.connect(actx.destination);
}

function updatePreview() {
  if (!chain) return;
  chain.filters.forEach((f, i) => { f.gain.value = eq.gains[i]; });
  chain.g.gain.value = dbToLin(eq.gain);
}

document.addEventListener('pointerdown', () => { if (actx && actx.state !== 'running') actx.resume(); });
video.addEventListener('play', ensureAudio);

// ---------- Bedienelemente ----------

const bandEls = BANDS.map((b, i) => {
  const lab = document.createElement('label');
  lab.className = 'slider';
  lab.innerHTML = `<span class="lbl">${b.label}</span><input type="range" min="-12" max="12" step="0.5"><output></output>`;
  const inp = lab.querySelector('input'), out = lab.querySelector('output');
  inp.addEventListener('input', () => { eq.gains[i] = Number(inp.value); out.textContent = fmtDb(eq.gains[i]); saveEq(); updatePreview(); });
  $('bands').append(lab);
  return { inp, out };
});

function syncUI() {
  bandEls.forEach((el, i) => { el.inp.value = eq.gains[i]; el.out.textContent = fmtDb(eq.gains[i]); });
  $('gain').value = eq.gain;
  $('gainOut').textContent = fmtDb(eq.gain);
}
$('gain').addEventListener('input', (e) => { eq.gain = Number(e.target.value); $('gainOut').textContent = fmtDb(eq.gain); saveEq(); updatePreview(); });
$('eqOn').addEventListener('change', routePreview);
$('btnReset').addEventListener('click', () => { eq = { gains: BANDS.map(() => 0), gain: 0 }; saveEq(); syncUI(); updatePreview(); });
syncUI();

$('btnPick').addEventListener('click', () => { ensureAudio(); $('file').click(); });
$('file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  file = f;
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(f);
  video.hidden = false;
  $('btnExport').disabled = false;
  setStatus(`${f.name} (${fmtMb(f.size)})`);
});

// ---------- Export ----------
// Videospur: Pakete werden unverändert kopiert (kein Neukodieren).
// Tonspur: Original-Pakete → kleine Audiodatei → dekodieren → EQ offline → neu kodieren.

async function pickAudioTrack(input) {
  const tracks = await input.getAudioTracks();
  const ok = tracks.filter((t) => t.codec);
  return ok.find((t) => t.codec === 'aac') || ok[0] || null;
}

async function extractAudio(track) {
  const out = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const src = new EncodedAudioPacketSource(track.codec);
  out.addAudioTrack(src);
  await out.start();
  const cfg = await track.getDecoderConfig();
  let first = true;
  for await (const p of new EncodedPacketSink(track).packets()) {
    await src.add(p, first ? { decoderConfig: cfg } : undefined);
    first = false;
  }
  src.close();
  await out.finalize();
  return out.target.buffer;
}

export async function renderEq(buffer, sampleRate, channels) {
  const dec = new OfflineAudioContext(channels, 1, sampleRate);
  const audio = await dec.decodeAudioData(buffer);
  const off = new OfflineAudioContext(audio.numberOfChannels, audio.length, audio.sampleRate);
  const s = off.createBufferSource();
  s.buffer = audio;
  buildChain(off, s, off.destination);
  s.start();
  const res = await off.startRendering();
  // Übersteuerung vermeiden: nur wenn Spitzen über 0 dBFS liegen, insgesamt leicht absenken.
  let peak = 0;
  for (let c = 0; c < res.numberOfChannels; c++) {
    const d = res.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
  }
  if (peak > 0.99) {
    const k = 0.99 / peak;
    for (let c = 0; c < res.numberOfChannels; c++) {
      const d = res.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= k;
    }
  }
  return { audio: res, limitedDb: peak > 0.99 ? 20 * Math.log10(0.99 / peak) : 0 };
}

export async function exportVideo(f, onProgress) {
  const input = new Input({ source: new BlobSource(f), formats: ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  if (!vt || !vt.codec) throw new Error('Keine lesbare Videospur gefunden.');
  const at = await pickAudioTrack(input);
  if (!at) throw new Error('Keine lesbare Tonspur gefunden.');

  onProgress('Ton wird gelesen …');
  const audioStart = Math.max(0, await at.getFirstTimestamp());
  const { audio, limitedDb } = await renderEq(await extractAudio(at), at.sampleRate, at.numberOfChannels);

  const aac = await canEncodeAudio('aac', { numberOfChannels: audio.numberOfChannels, sampleRate: audio.sampleRate, bitrate: AAC_BITRATE });
  const isMov = (await input.getMimeType()).startsWith('video/quicktime');
  // AAC nicht verfügbar → unkomprimierter Ton (PCM) im QuickTime-Container
  const useMov = isMov || !aac;
  const output = new Output({
    format: useMov ? new MovOutputFormat({ fastStart: 'in-memory' }) : new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });
  const vSrc = new EncodedVideoPacketSource(vt.codec);
  output.addVideoTrack(vSrc, { transformationMatrix: await vt.getTransformationMatrix(), languageCode: vt.languageCode });
  const aSrc = new AudioBufferSource(aac ? { codec: 'aac', bitrate: AAC_BITRATE } : { codec: 'pcm-s16' }, { startTimestamp: audioStart });
  output.addAudioTrack(aSrc, { languageCode: at.languageCode });
  try { output.setMetadataTags(await input.getMetadataTags()); } catch (e) {}
  await output.start();

  const duration = await input.computeDuration();
  const cfg = await vt.getDecoderConfig();
  const copyVideo = async () => {
    let first = true;
    for await (const p of new EncodedPacketSink(vt).packets()) {
      await vSrc.add(p, first ? { decoderConfig: cfg } : undefined);
      first = false;
      onProgress(`Video wird geschrieben … ${Math.min(100, Math.round(100 * p.timestamp / duration))} %`);
    }
    vSrc.close();
  };
  const writeAudio = async () => { await aSrc.add(audio); aSrc.close(); };
  await Promise.all([copyVideo(), writeAudio()]);
  await output.finalize();

  const base = f.name.replace(/\.[^.]+$/, '');
  const ext = useMov ? 'mov' : 'mp4';
  return {
    file: new File([output.target.buffer], `${base}-eq.${ext}`, { type: useMov ? 'video/quicktime' : 'video/mp4' }),
    aac, limitedDb,
  };
}

let result = null;
$('btnExport').addEventListener('click', async () => {
  if (!file) return;
  video.pause();
  const btn = $('btnExport');
  btn.disabled = true;
  $('btnPick').disabled = true;
  try {
    result = await exportVideo(file, setStatus);
    const notes = [];
    if (!result.aac) notes.push('Ton unkomprimiert (AAC-Kodierung auf diesem Gerät nicht verfügbar).');
    if (result.limitedDb < -0.05) notes.push(`Gegen Übersteuerung um ${(-result.limitedDb).toFixed(1)} dB abgesenkt.`);
    $('resultInfo').textContent = `Fertig: ${result.file.name} (${fmtMb(result.file.size)}). ${notes.join(' ')}`;
    $('sheet').hidden = false;
    setStatus(`${file.name} (${fmtMb(file.size)})`);
  } catch (err) {
    console.error(err);
    setStatus('Export fehlgeschlagen: ' + (err && err.message ? err.message : err));
  } finally {
    btn.disabled = false;
    $('btnPick').disabled = false;
  }
});

$('btnShare').addEventListener('click', async () => {
  if (!result) return;
  const f = result.file;
  if (navigator.canShare && navigator.canShare({ files: [f] })) {
    try { await navigator.share({ files: [f] }); } catch (err) {}
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
});
$('btnClose').addEventListener('click', () => { $('sheet').hidden = true; });

// ---------- Hilfsfunktionen ----------

function setStatus(t) { $('status').textContent = t; }
function dbToLin(db) { return Math.pow(10, db / 20); }
function fmtDb(v) { return (v > 0 ? '+' : '') + v.toFixed(1) + ' dB'; }
function fmtMb(b) { return (b / 1048576).toFixed(1).replace('.', ',') + ' MB'; }

document.addEventListener('gesturestart', (e) => e.preventDefault());
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

