// ═══════════════════════════════════════════════════════════════════════════════
// THEME
// ═══════════════════════════════════════════════════════════════════════════════
function themeColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function toggleTheme() {
  const dark = document.documentElement.dataset.theme !== 'dark';
  if (dark) document.documentElement.dataset.theme = 'dark';
  else      delete document.documentElement.dataset.theme;
  try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch (e) {}
  updateThemeBtn();
  drawSampleThumb();
  drawCircle();
}

function updateThemeBtn() {
  const dark = document.documentElement.dataset.theme === 'dark';
  document.getElementById('themeBtn').textContent = dark ? '◐   Light' : '◐   Dark';
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED STATE
// ═══════════════════════════════════════════════════════════════════════════════
let audioCtx   = null;
let masterGain = null;
const panners  = [null, null];

let isPlaying    = false;
let phasingPaused = false;
let animFrame     = null;
let startTime     = 0;

let speedRatio = 1.002;

// ═══════════════════════════════════════════════════════════════════════════════
// SAMPLE STATE
// ═══════════════════════════════════════════════════════════════════════════════
let sampleBuffer  = null;  // decoded AudioBuffer
let sampleSources = [null, null]; // AudioBufferSourceNode per voice
let playheadPos   = [0, 0]; // loop position 0–1 per voice
// Voice II's position is integrated across rate changes (pause/resume, ratio
// slider) so the display matches what's heard: sample time v2Base at context
// time v2BaseTime, advancing at v2Rate.
let v2Base = 0, v2BaseTime = 0, v2Rate = 1;

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIO INIT
// ═══════════════════════════════════════════════════════════════════════════════
function initAudio() {
  audioCtx   = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = +document.getElementById('volCtrl').value;
  masterGain.connect(audioCtx.destination);

  panners[0] = audioCtx.createStereoPanner();
  panners[1] = audioCtx.createStereoPanner();
  panners[0].pan.value = -1;
  panners[1].pan.value =  1;
  panners[0].connect(masterGain);
  panners[1].connect(masterGain);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SAMPLE — file loading + looped playback
// ═══════════════════════════════════════════════════════════════════════════════
// Drag & drop
const dropZone = document.getElementById('dropZone');
dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});

let loadId = 0; // ignore results from a load that a newer one has replaced

function loadFile(file) {
  if (!file) return;
  if (isPlaying) togglePlay();
  setActiveSound(null);
  const id = ++loadId;

  document.getElementById('sampleName').textContent = file.name;
  document.getElementById('sampleInfo').classList.add('visible');

  const reader = new FileReader();
  reader.onload = e => decodeSample(e.target.result, id);
  reader.readAsArrayBuffer(file);
}

// Built-in sounds: assets/1.wav … assets/5.wav
async function loadSound(n) {
  if (isPlaying) togglePlay();
  setActiveSound(n);
  const id = ++loadId;

  document.getElementById('sampleName').textContent = `Sound ${n}`;
  document.getElementById('sampleInfo').classList.add('visible');

  try {
    const res = await fetch(`assets/${n}.wav`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    decodeSample(await res.arrayBuffer(), id);
  } catch(err) {
    if (id !== loadId) return;
    setActiveSound(null);
    alert(`Could not load sound ${n}: ${err.message}` +
      (location.protocol === 'file:' ? '\nBuilt-in sounds need the page to be served over http (see README).' : ''));
  }
}

function setActiveSound(n) {
  document.querySelectorAll('.sound-btn').forEach(b =>
    b.classList.toggle('active', +b.dataset.sound === n));
}

async function decodeSample(data, id) {
  if (!audioCtx) initAudio();
  try {
    // Most browsers can't decode AIFF natively, so parse it ourselves
    const buffer = isAiff(data) ? decodeAiff(data)
                                : await audioCtx.decodeAudioData(data.slice(0));
    if (id !== loadId) return;
    sampleBuffer = buffer;
    document.getElementById('sampleDur').textContent =
      sampleBuffer.duration.toFixed(2) + 's';
    drawSampleThumb();
    drawCircle();
  } catch(err) {
    if (id !== loadId) return;
    alert('Could not decode audio file: ' + err.message);
  }
}

// ── AIFF / AIFF-C decoding ──
function isAiff(buf) {
  if (buf.byteLength < 12) return false;
  const tag = (o) => String.fromCharCode(...new Uint8Array(buf, o, 4));
  return tag(0) === 'FORM' && (tag(8) === 'AIFF' || tag(8) === 'AIFC');
}

// 80-bit IEEE 754 extended float (big-endian), used for the sample rate
function readExtended(dv, o) {
  const exp  = dv.getUint16(o) & 0x7fff;
  const hi   = dv.getUint32(o + 2);
  const lo   = dv.getUint32(o + 6);
  if (exp === 0 && hi === 0 && lo === 0) return 0;
  return (hi * 2 ** -31 + lo * 2 ** -63) * 2 ** (exp - 16383);
}

function decodeAiff(buf) {
  const dv   = new DataView(buf);
  const tag  = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  const aifc = tag(8) === 'AIFC';
  let channels, frames, bits, rate, comp = 'NONE', ssnd = -1;

  for (let o = 12; o + 8 <= buf.byteLength; ) {
    const id = tag(o), size = dv.getUint32(o + 4), body = o + 8;
    if (id === 'COMM') {
      channels = dv.getInt16(body);
      frames   = dv.getUint32(body + 2);
      bits     = dv.getInt16(body + 6);
      rate     = readExtended(dv, body + 8);
      if (aifc) comp = tag(body + 18);
    } else if (id === 'SSND') {
      ssnd = body + 8 + dv.getUint32(body); // skip offset + blockSize fields
    }
    o = body + size + (size & 1); // chunks are padded to even length
  }
  if (!channels || ssnd < 0) throw new Error('Invalid AIFF file');

  const little = comp === 'sowt';
  const float  = comp === 'fl32' || comp === 'FL32' || comp === 'fl64' || comp === 'FL64';
  if (!['NONE', 'sowt', 'fl32', 'FL32', 'fl64', 'FL64'].includes(comp))
    throw new Error(`Unsupported AIFF-C compression "${comp}"`);
  if (comp.toLowerCase() === 'fl64') bits = 64;
  else if (float) bits = 32;

  const bytes = Math.ceil(bits / 8);
  frames = Math.min(frames, Math.floor((buf.byteLength - ssnd) / (bytes * channels)));
  const out  = audioCtx.createBuffer(channels, frames, rate);
  const chs  = Array.from({ length: channels }, (_, c) => out.getChannelData(c));
  const norm = 2 ** (bytes * 8 - 1);

  let p = ssnd;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++, p += bytes) {
      let v;
      if (float)            v = bytes === 8 ? dv.getFloat64(p, little) : dv.getFloat32(p, little);
      else if (bytes === 1) v = dv.getInt8(p) / norm;
      else if (bytes === 2) v = dv.getInt16(p, little) / norm;
      else if (bytes === 4) v = dv.getInt32(p, little) / norm;
      else { // 24-bit
        const b0 = dv.getUint8(p), b1 = dv.getUint8(p + 1), b2 = dv.getUint8(p + 2);
        let n = little ? (b2 << 16) | (b1 << 8) | b0 : (b0 << 16) | (b1 << 8) | b2;
        if (n & 0x800000) n -= 0x1000000;
        v = n / norm;
      }
      chs[c][i] = v;
    }
  }
  return out;
}

function drawSampleThumb() {
  if (!sampleBuffer) return;
  const canvas = document.getElementById('sampleWaveThumb');
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width  = r.width  * dpr;
  canvas.height = r.height * dpr;
  const ctx2 = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const data = sampleBuffer.getChannelData(0);
  const step = Math.ceil(data.length / W);

  ctx2.clearRect(0, 0, W, H);
  ctx2.strokeStyle = themeColor('--c1');
  ctx2.globalAlpha = 0.4;
  ctx2.lineWidth = 1;
  ctx2.beginPath();
  for (let x = 0; x < W; x++) {
    let max = 0;
    for (let j = 0; j < step; j++) {
      const v = Math.abs(data[x * step + j] || 0);
      if (v > max) max = v;
    }
    const h = max * H * 0.9;
    ctx2.moveTo(x, H / 2 - h / 2);
    ctx2.lineTo(x, H / 2 + h / 2);
  }
  ctx2.stroke();
  ctx2.globalAlpha = 1;
}

function startSample() {
  if (!sampleBuffer) return;
  const t = audioCtx.currentTime + 0.05;
  startTime = t;
  v2Base = 0; v2BaseTime = t; v2Rate = speedRatio;

  // Stop any existing sources
  sampleSources.forEach(s => { if (s) try { s.stop(); } catch(e){} });

  for (let v = 0; v < 2; v++) {
    const src = audioCtx.createBufferSource();
    src.buffer = sampleBuffer;
    src.loop   = true;
    // Voice I plays at rate 1.0; Voice II at speedRatio (slightly faster → drifts ahead)
    src.playbackRate.value = v === 0 ? 1.0 : speedRatio;
    src.connect(panners[v]);
    src.start(t);
    sampleSources[v] = src;
  }
}

function stopSample() {
  sampleSources.forEach((s, i) => {
    if (s) { try { s.stop(); } catch(e){} sampleSources[i] = null; }
  });
}

// When phasing is paused: set voice II playbackRate back to 1.0
// When resumed: restore speedRatio
function applySampleRate() {
  if (!sampleSources[1]) return;
  setVoice2Rate(phasingPaused ? 1.0 : speedRatio);
}

function setVoice2Rate(rate) {
  const now = audioCtx.currentTime;
  v2Base     = v2Base + Math.max(0, now - v2BaseTime) * v2Rate;
  v2BaseTime = Math.max(now, v2BaseTime);
  v2Rate     = rate;
  sampleSources[1].playbackRate.value = rate;
}

// Playhead positions
function updatePlayheads() {
  if (!sampleBuffer || !audioCtx) return;
  const elapsed = audioCtx.currentTime - startTime;
  const bufDur  = sampleBuffer.duration;
  const now     = audioCtx.currentTime;
  const v2Time  = v2Base + Math.max(0, now - v2BaseTime) * v2Rate;
  playheadPos = [
    (Math.max(0, elapsed) % bufDur) / bufDur,
    (v2Time % bufDur) / bufDur,
  ];
  drawCircle();
}

// Circular playhead display: the loop wraps once around the ring, starting at
// 12 o'clock and running clockwise. The arc between the hands is the phase offset.
function drawCircle() {
  const canvas = document.getElementById('playheadCircle');
  const dpr = window.devicePixelRatio || 1;
  const r0  = canvas.getBoundingClientRect();
  if (!r0.width) return;
  if (canvas.width !== Math.round(r0.width * dpr) || canvas.height !== Math.round(r0.height * dpr)) {
    canvas.width  = Math.round(r0.width  * dpr);
    canvas.height = Math.round(r0.height * dpr);
  }
  const c  = canvas.getContext('2d');
  const W  = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2;
  const R  = Math.min(W, H) / 2 - 8 * dpr;     // ring radius (room for the dots)
  const ang = p => -Math.PI / 2 + p * Math.PI * 2;
  c.clearRect(0, 0, W, H);

  // Ring
  c.strokeStyle = themeColor('--dim');
  c.lineWidth = 1.5 * dpr;
  c.beginPath();
  c.arc(cx, cy, R, 0, Math.PI * 2);
  c.stroke();

  // Phase offset arc (Voice I → Voice II, clockwise)
  const [p1, p2] = playheadPos;
  const offset = ((p2 - p1) % 1 + 1) % 1;
  if (offset > 0.0005) {
    c.strokeStyle = themeColor('--cp');
    c.lineWidth = 4 * dpr;
    c.beginPath();
    c.arc(cx, cy, R, ang(p1), ang(p1) + offset * Math.PI * 2);
    c.stroke();
  }

  // Hands + dots (Voice II drawn first so Voice I stays visible when aligned)
  [[p2, '--c2'], [p1, '--c1']].forEach(([p, col]) => {
    const a = ang(p), color = themeColor(col);
    const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
    c.strokeStyle = color;
    c.lineWidth = 2 * dpr;
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(x, y);
    c.stroke();
    c.fillStyle = color;
    c.beginPath();
    c.arc(x, y, 6 * dpr, 0, Math.PI * 2);
    c.fill();
  });

  // Hub
  c.fillStyle = themeColor('--fg');
  c.beginPath();
  c.arc(cx, cy, 3 * dpr, 0, Math.PI * 2);
  c.fill();
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSPORT
// ═══════════════════════════════════════════════════════════════════════════════
function togglePlay() {
  if (!audioCtx) initAudio();
  if (audioCtx.state === 'suspended') audioCtx.resume();

  // Guard: requires a loaded buffer
  if (!sampleBuffer) {
    alert('Load an audio file first.');
    return;
  }

  isPlaying = !isPlaying;
  const btn = document.getElementById('btnPlay');

  if (isPlaying) {
    startSample();

    btn.classList.add('on');
    btn.textContent = '■   Stop';
    document.getElementById('statusTxt').textContent = 'RUNNING';
    document.getElementById('btnPhase').disabled = false;
    startRender();
  } else {
    stopSample();

    btn.classList.remove('on');
    btn.textContent = '▶   Start';
    document.getElementById('statusTxt').textContent = 'STOPPED';
    phasingPaused = false;
    const ph = document.getElementById('btnPhase');
    ph.disabled = true;
    ph.classList.remove('paused');
    ph.textContent = '⏸   Pause phasing';
    stopRender();
  }
}

function resetPhase() {
  if (!isPlaying) return;
  phasingPaused = false;
  const ph = document.getElementById('btnPhase');
  ph.classList.remove('paused');
  ph.textContent = '⏸   Pause phasing';

  // Restart both sample sources in sync
  stopSample();
  startSample();
  document.getElementById('statusTxt').textContent = 'RUNNING';
}

function togglePhasing() {
  phasingPaused = !phasingPaused;
  const btn = document.getElementById('btnPhase');

  if (phasingPaused) {
    // Freeze voice II rate
    applySampleRate();

    btn.textContent = '▶   Resume phasing';
    btn.classList.add('paused');
    document.getElementById('statusTxt').textContent = 'PHASE FROZEN';
  } else {
    // Resume
    applySampleRate();
    btn.textContent = '⏸   Pause phasing';
    btn.classList.remove('paused');
    document.getElementById('statusTxt').textContent = 'RUNNING';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PARAM UPDATES
// ═══════════════════════════════════════════════════════════════════════════════
function updateRatio() {
  speedRatio = +document.getElementById('ratioCtrl').value;
  document.getElementById('ratioVal').textContent = speedRatio.toFixed(4);
  // Live-update sample source if playing
  if (isPlaying && !phasingPaused && sampleSources[1]) {
    setVoice2Rate(speedRatio);
  }
}

function updateVol() {
  const v = +document.getElementById('volCtrl').value;
  document.getElementById('volVal').textContent = v.toFixed(2);
  if (masterGain) masterGain.gain.value = v;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VISUALIZATION
// ═══════════════════════════════════════════════════════════════════════════════
function renderLoop() {
  if (!isPlaying) return;
  updatePlayheads();

  animFrame = requestAnimationFrame(renderLoop);
}

function startRender() {
  if (animFrame) cancelAnimationFrame(animFrame);
  animFrame = requestAnimationFrame(renderLoop);
}

function stopRender() {
  if (animFrame) cancelAnimationFrame(animFrame);
  animFrame = null;
  // Reset playheads
  playheadPos = [0, 0];
  drawCircle();
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════════════
window.addEventListener('resize', drawCircle);
updateThemeBtn();
updateRatio();
setTimeout(drawCircle, 100);
