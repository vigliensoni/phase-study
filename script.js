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
  drawDrift();
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
let analyser   = null;
const panners  = [null, null];

let isPlaying    = false;
let phasingPaused = false;
let frozenOffset  = 0;
let animFrame     = null;
let startTime     = 0;

const DRIFT_HIST = new Array(400).fill(0);

let speedRatio = 1.002;

// ── WebSocket ──
let ws         = null;
let wsUpdating = false; // true while applying a received param → suppress echo

// ═══════════════════════════════════════════════════════════════════════════════
// SAMPLE STATE
// ═══════════════════════════════════════════════════════════════════════════════
let sampleBuffer  = null;  // decoded AudioBuffer
let sampleSources = [null, null]; // AudioBufferSourceNode per voice

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIO INIT
// ═══════════════════════════════════════════════════════════════════════════════
function initAudio() {
  audioCtx   = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = +document.getElementById('volCtrl').value;
  analyser   = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.82;
  masterGain.connect(analyser);
  analyser.connect(audioCtx.destination);

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

function loadFile(file) {
  if (!file) return;
  if (isPlaying) togglePlay();

  document.getElementById('sampleName').textContent = file.name;
  document.getElementById('sampleInfo').classList.add('visible');

  const reader = new FileReader();
  reader.onload = async e => {
    if (!audioCtx) initAudio();
    try {
      const data = e.target.result;
      // Most browsers can't decode AIFF natively, so parse it ourselves
      sampleBuffer = isAiff(data) ? decodeAiff(data)
                                  : await audioCtx.decodeAudioData(data.slice(0));
      document.getElementById('sampleDur').textContent =
        sampleBuffer.duration.toFixed(2) + 's';
      drawSampleThumb();
    } catch(err) {
      alert('Could not decode audio file: ' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
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
  sampleSources[1].playbackRate.value = phasingPaused ? 1.0 : speedRatio;
}

// Estimate phase offset:
// Both sources started at the same time. Voice II has played
// elapsed * speedRatio seconds of sample time vs elapsed * 1.0 for voice I.
// Offset in sample-time = elapsed * (speedRatio - 1).
// Normalised to buffer duration = (offset % bufDur) / bufDur.
function samplePhaseNorm() {
  if (!sampleBuffer || !audioCtx) return 0;
  const elapsed = audioCtx.currentTime - startTime;
  const bufDur  = sampleBuffer.duration;
  const offset  = (elapsed * (speedRatio - 1)) % bufDur;
  return offset / bufDur;
}

// Playhead positions
function updatePlayheads() {
  if (!sampleBuffer || !audioCtx) return;
  const elapsed = audioCtx.currentTime - startTime;
  const bufDur  = sampleBuffer.duration;
  const pos1 = (elapsed % bufDur) / bufDur * 100;
  const pos2 = (elapsed * (phasingPaused ? 1 : speedRatio) % bufDur) / bufDur * 100;
  document.getElementById('ph1').style.left = pos1 + '%';
  document.getElementById('ph2').style.left = pos2 + '%';
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
    sendParam('statusUpdate', 'RUNNING');
    sendParam('playingUpdate', true);
    startRender();
  } else {
    stopSample();

    btn.classList.remove('on');
    btn.textContent = '▶   Start';
    document.getElementById('statusTxt').textContent = 'STOPPED';
    phasingPaused = false;
    DRIFT_HIST.fill(0);
    const ph = document.getElementById('btnPhase');
    ph.disabled = true;
    ph.classList.remove('paused');
    ph.textContent = '⏸   Pause phasing';
    sendParam('statusUpdate', 'STOPPED');
    sendParam('playingUpdate', false);
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
  DRIFT_HIST.fill(0);
  document.getElementById('statusTxt').textContent = 'RUNNING';
  sendParam('statusUpdate', 'RUNNING');
}

function togglePhasing() {
  phasingPaused = !phasingPaused;
  const btn = document.getElementById('btnPhase');

  if (phasingPaused) {
    // Snapshot current phase for display, then freeze voice II rate
    frozenOffset = samplePhaseNorm();
    applySampleRate();

    btn.textContent = '▶   Resume phasing';
    btn.classList.add('paused');
    document.getElementById('statusTxt').textContent = 'PHASE FROZEN';
    sendParam('statusUpdate', 'PHASE FROZEN');
  } else {
    // Resume
    applySampleRate();
    btn.textContent = '⏸   Pause phasing';
    btn.classList.remove('paused');
    document.getElementById('statusTxt').textContent = 'RUNNING';
    sendParam('statusUpdate', 'RUNNING');
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
    sampleSources[1].playbackRate.value = speedRatio;
  }
  sendParam('ratio', speedRatio);
}

function updateVol() {
  const v = +document.getElementById('volCtrl').value;
  document.getElementById('volVal').textContent = v.toFixed(2);
  if (masterGain) masterGain.gain.value = v;
  sendParam('volume', v);
}

// ═══════════════════════════════════════════════════════════════════════════════
// VISUALIZATION
// ═══════════════════════════════════════════════════════════════════════════════
const waveCanvas  = document.getElementById('waveCanvas');
const driftCanvas = document.getElementById('driftCanvas');
const wCtx = waveCanvas.getContext('2d');
const dCtx = driftCanvas.getContext('2d');

function resize() {
  const dpr = window.devicePixelRatio || 1;
  [waveCanvas, driftCanvas].forEach(c => {
    const r = c.getBoundingClientRect();
    c.width  = r.width  * dpr;
    c.height = r.height * dpr;
  });
}

function drawWave() {
  if (!analyser) return;
  const dpr = window.devicePixelRatio || 1;
  const W = waveCanvas.width, H = waveCanvas.height;
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  wCtx.clearRect(0, 0, W, H);
  wCtx.strokeStyle = themeColor('--c1');
  wCtx.lineWidth = 1.5 * dpr;
  wCtx.globalAlpha = 0.85;
  wCtx.beginPath();
  for (let i = 0; i < buf.length; i++) {
    const x = (i / buf.length) * W;
    const y = H / 2 + buf[i] * H * 0.42;
    i === 0 ? wCtx.moveTo(x, y) : wCtx.lineTo(x, y);
  }
  wCtx.stroke();
  wCtx.globalAlpha = 1;
}

function drawDrift() {
  const dpr = window.devicePixelRatio || 1;
  const W = driftCanvas.width, H = driftCanvas.height;
  dCtx.clearRect(0, 0, W, H);
  dCtx.strokeStyle = themeColor('--grid');
  dCtx.lineWidth = 1;
  dCtx.beginPath();
  dCtx.moveTo(0, H / 2); dCtx.lineTo(W, H / 2);
  dCtx.stroke();
  if (DRIFT_HIST.filter(v => v !== 0).length < 2) return;
  dCtx.beginPath();
  const cp = themeColor('--cp');
  dCtx.strokeStyle = cp;
  dCtx.lineWidth = 1.5 * dpr;
  dCtx.shadowColor = cp;
  dCtx.shadowBlur = 5;
  for (let i = 0; i < DRIFT_HIST.length; i++) {
    const x = (i / DRIFT_HIST.length) * W;
    const y = H / 2 - DRIFT_HIST[i] * H * 0.42;
    i === 0 ? dCtx.moveTo(x, y) : dCtx.lineTo(x, y);
  }
  dCtx.stroke();
  dCtx.shadowBlur = 0;
}

function renderLoop() {
  if (!isPlaying) return;

  let phaseNorm;
  if (phasingPaused) {
    phaseNorm = frozenOffset;
  } else {
    phaseNorm = samplePhaseNorm();
  }

  DRIFT_HIST.push(Math.sin(phaseNorm * Math.PI * 2) * 0.5);
  DRIFT_HIST.shift();

  document.getElementById('phFill').style.width = (phaseNorm * 100).toFixed(1) + '%';
  document.getElementById('phVal').textContent   = phaseNorm.toFixed(3);

  resize();
  drawWave();
  drawDrift();

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
  document.getElementById('ph1').style.left = '0%';
  document.getElementById('ph2').style.left = '0%';
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════════════════════════════════════════════
// params whose updates must not be echoed back (slider sync)
const WS_PARAM_ONLY = new Set(['ratio','volume']);

function connectWS() {
  if (location.protocol === 'file:') return; // opened directly, not via server
  try {
    ws = new WebSocket(`ws://${location.host}`);

    ws.onopen  = () => setWSStatus(true);
    ws.onclose = () => { setWSStatus(false); setTimeout(connectWS, 2000); };
    ws.onerror = () => ws.close();

    ws.onmessage = e => {
      const msg = JSON.parse(e.data);
      // State request: reply without setting wsUpdating so sendParam works
      if (msg.param === 'requestState') { sendFullState(); return; }
      // Param-only messages: suppress echo in the update functions
      if (WS_PARAM_ONLY.has(msg.param)) {
        wsUpdating = true;
        applyParam(msg.param, msg.value);
        wsUpdating = false;
      } else {
        // Commands (togglePlay, togglePhasing, resetPhase):
        // run normally so they can broadcast status updates back
        applyParam(msg.param, msg.value);
      }
    };
  } catch(err) {
    // silently ignore — WS is an optional enhancement
  }
}

function sendParam(param, value) {
  if (!ws || ws.readyState !== WebSocket.OPEN || wsUpdating) return;
  ws.send(JSON.stringify(value !== undefined ? { param, value } : { param }));
}

function setWSStatus(connected) {
  const dot = document.getElementById('wsDot');
  if (dot) dot.classList.toggle('on', connected);
}

function sendFullState() {
  sendParam('ratio',     speedRatio);
  sendParam('volume',    +document.getElementById('volCtrl').value);
  const status = !isPlaying ? 'STOPPED' : phasingPaused ? 'PHASE FROZEN' : 'RUNNING';
  sendParam('statusUpdate',  status);
  sendParam('playingUpdate', isPlaying);
}

function applyParam(param, value) {
  switch (param) {
    case 'ratio':
      document.getElementById('ratioCtrl').value = value;
      updateRatio(); break;
    case 'volume':
      document.getElementById('volCtrl').value = value;
      updateVol(); break;
    case 'togglePlay':   togglePlay();        break;
    case 'resetPhase':   resetPhase();        break;
    case 'togglePhasing': togglePhasing();    break;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════════════
window.addEventListener('resize', resize);
updateThemeBtn();
updateRatio();
setTimeout(resize, 100);
connectWS();
