// ═══════════════════════════════════════════════════════════════════════════════
// MODE
// ═══════════════════════════════════════════════════════════════════════════════
let currentMode = 'symbolic'; // 'symbolic' | 'sample'

function setMode(mode) {
  if (isPlaying) togglePlay(); // stop before switching
  currentMode = mode;
  const body = document.getElementById('mainBody');
  body.classList.toggle('mode-sample', mode === 'sample');
  document.getElementById('sampleSection').classList.toggle('visible', mode === 'sample');
  document.getElementById('tabSymbolic').classList.toggle('active', mode === 'symbolic');
  document.getElementById('tabSample').classList.toggle('active', mode === 'sample');
}

// ═══════════════════════════════════════════════════════════════════════════════
// PITCH TABLE + PRESETS
// ═══════════════════════════════════════════════════════════════════════════════
const PITCHES = [
  { name: 'E5',  freq: 659.26, black: false },
  { name: 'D#5', freq: 622.25, black: true  },
  { name: 'D5',  freq: 587.33, black: false },
  { name: 'C#5', freq: 554.37, black: true  },
  { name: 'C5',  freq: 523.25, black: false },
  { name: 'B4',  freq: 493.88, black: false },
  { name: 'A#4', freq: 466.16, black: true  },
  { name: 'A4',  freq: 440.00, black: false },
  { name: 'G#4', freq: 415.30, black: true  },
  { name: 'G4',  freq: 392.00, black: false },
  { name: 'F#4', freq: 369.99, black: true  },
  { name: 'F4',  freq: 349.23, black: false },
  { name: 'E4',  freq: 329.63, black: false },
  { name: 'D#4', freq: 311.13, black: true  },
  { name: 'D4',  freq: 293.66, black: false },
  { name: 'C#4', freq: 277.18, black: true  },
  { name: 'C4',  freq: 261.63, black: false },
  { name: 'B3',  freq: 246.94, black: false },
  { name: 'A#3', freq: 233.08, black: true  },
  { name: 'A3',  freq: 220.00, black: false },
];

const PRESETS = {
  rain:       ['E4','F#4','B4','C#5',null,'A4',null,'F#4','E4',null,'D4','A3'],
  piano:      ['E4','F#4','B4','C#5','D5',null,'F#4',null,'E4','B4','A4',null],
  pentatonic: ['E5','C#5','A4','G#4',null,'E4','F#4',null,'B4',null,'A4',null],
  clear:      [],
};

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
// SYMBOLIC STATE
// ═══════════════════════════════════════════════════════════════════════════════
let MELODY = [];
let STEPS  = 12;
let baseBPM = 132;
let numHarm = 5;
let noteDur = 0.08;

let schedulerTimer = null;
const V = [{ step: 0, nextTime: 0 }, { step: 0, nextTime: 0 }];
const LOOKAHEAD = 0.1;
const INTERVAL  = 25;

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
// SYMBOLIC — PIANO ROLL + SCHEDULER
// ═══════════════════════════════════════════════════════════════════════════════
function buildPianoRoll() {
  const roll = document.getElementById('pianoRoll');
  roll.innerHTML = '';
  PITCHES.forEach((pitch, pi) => {
    const row = document.createElement('div');
    row.className = 'pr-row';
    const lbl = document.createElement('div');
    lbl.className = 'pr-pitch-label' + (pitch.black ? ' black-key' : '');
    lbl.textContent = pitch.name;
    row.appendChild(lbl);
    const cells = document.createElement('div');
    cells.className = 'pr-cells';
    for (let si = 0; si < STEPS; si++) {
      const cell = document.createElement('div');
      cell.className = 'pr-cell' + (pitch.black ? ' black-key-row' : '');
      cell.id = `prc_${pi}_${si}`;
      if (MELODY[si] && MELODY[si].name === pitch.name) cell.classList.add('selected');
      cell.addEventListener('click', () => toggleCell(pi, si));
      cells.appendChild(cell);
    }
    row.appendChild(cells);
    roll.appendChild(row);
  });
}

function toggleCell(pitchIdx, stepIdx) {
  const pitch = PITCHES[pitchIdx];
  MELODY[stepIdx] = (MELODY[stepIdx] && MELODY[stepIdx].name === pitch.name)
    ? null
    : { freq: pitch.freq, name: pitch.name };
  refreshRollStep(stepIdx);
  buildScoreUI();
}

function refreshRollStep(si) {
  PITCHES.forEach((_, pi) => {
    const cell = document.getElementById(`prc_${pi}_${si}`);
    if (!cell) return;
    cell.classList.toggle('selected', !!(MELODY[si] && MELODY[si].name === PITCHES[pi].name));
  });
}

function resizeMelody() {
  const n = +document.getElementById('stepsCtrl').value;
  document.getElementById('stepsVal').textContent = n;
  while (MELODY.length < n) MELODY.push(null);
  MELODY = MELODY.slice(0, n);
  STEPS = n;
  buildPianoRoll();
  buildScoreUI();
  sendParam('steps', n);
}

function loadPreset(name) {
  const preset = PRESETS[name] || [];
  STEPS = +document.getElementById('stepsCtrl').value;
  MELODY = Array.from({ length: STEPS }, (_, i) => {
    const pname = preset[i] || null;
    if (!pname) return null;
    const p = PITCHES.find(p => p.name === pname);
    return p ? { freq: p.freq, name: p.name } : null;
  });
  buildPianoRoll();
  buildScoreUI();
}

function buildScoreUI() {
  ['steps1','steps2'].forEach(id => {
    document.getElementById(id).innerHTML = MELODY.map((note, i) =>
      `<div class="step${note?' has-note':''}" id="${id}_${i}">
         <span class="nlabel">${note ? note.name.replace(/[0-9]/g,'') : '·'}</span>
       </div>`
    ).join('');
  });
}

function updateScoreUI() {
  const s1 = V[0].step % STEPS;
  const s2 = V[1].step % STEPS;
  for (let i = 0; i < STEPS; i++) {
    const e1 = document.getElementById(`steps1_${i}`);
    const e2 = document.getElementById(`steps2_${i}`);
    if (!e1 || !e2) continue;
    const base = MELODY[i] ? 'step has-note' : 'step';
    e1.className = base + (i === s1 ? ' active1' : '');
    e2.className = base + (i === s2 ? ' active2' : '');
  }
}

function playNote(freq, time, voiceIdx) {
  const totalAmp = 0.3 / numHarm;
  const dest = panners[voiceIdx] || masterGain;
  for (let h = 1; h <= numHarm; h++) {
    const osc = audioCtx.createOscillator();
    const g   = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq * h;
    const amp = totalAmp / h;
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(amp, time + 0.004);
    g.gain.exponentialRampToValueAtTime(0.00001, time + noteDur);
    osc.connect(g);
    g.connect(dest);
    osc.start(time);
    osc.stop(time + noteDur + 0.02);
  }
}

function symbolicStepDur(voiceIdx) {
  const base = 60 / baseBPM / 4;
  if (phasingPaused) return base;
  return voiceIdx === 0 ? base : base / speedRatio;
}

function scheduler() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  for (let v = 0; v < 2; v++) {
    while (V[v].nextTime < now + LOOKAHEAD) {
      const note = MELODY[V[v].step % STEPS];
      if (note) playNote(note.freq, V[v].nextTime, v);
      V[v].step++;
      V[v].nextTime += symbolicStepDur(v);
    }
  }
}

function startSymbolic() {
  const t = audioCtx.currentTime + 0.05;
  startTime = t;
  V[0].step = V[1].step = 0;
  V[0].nextTime = V[1].nextTime = t;
  schedulerTimer = setInterval(scheduler, INTERVAL);
}

function stopSymbolic() {
  clearInterval(schedulerTimer);
  schedulerTimer = null;
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
      sampleBuffer = await audioCtx.decodeAudioData(e.target.result.slice(0));
      document.getElementById('sampleDur').textContent =
        sampleBuffer.duration.toFixed(2) + 's';
      drawSampleThumb();
    } catch(err) {
      alert('Could not decode audio file: ' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
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
  ctx2.strokeStyle = '#c8ff0066';
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

// When phasing is paused in sample mode: set voice II playbackRate back to 1.0
// When resumed: restore speedRatio
function applySampleRate() {
  if (!sampleSources[1]) return;
  sampleSources[1].playbackRate.value = phasingPaused ? 1.0 : speedRatio;
}

// Estimate phase offset for sample mode:
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

  // Guard: sample mode requires a loaded buffer
  if (currentMode === 'sample' && !sampleBuffer) {
    alert('Load an audio file first.');
    return;
  }

  isPlaying = !isPlaying;
  const btn = document.getElementById('btnPlay');

  if (isPlaying) {
    if (currentMode === 'symbolic') startSymbolic();
    else                            startSample();

    btn.classList.add('on');
    btn.textContent = '■   Stop';
    document.getElementById('statusTxt').textContent = 'RUNNING';
    document.getElementById('btnPhase').disabled = false;
    sendParam('statusUpdate', 'RUNNING');
    sendParam('playingUpdate', true);
    startRender();
  } else {
    if (currentMode === 'symbolic') stopSymbolic();
    else                            stopSample();

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

  if (currentMode === 'symbolic') {
    const now = audioCtx.currentTime + 0.05;
    V[0].step = V[1].step = 0;
    V[0].nextTime = V[1].nextTime = now;
    startTime = now;
  } else {
    // Restart both sample sources in sync
    stopSample();
    startSample();
  }
  DRIFT_HIST.fill(0);
  document.getElementById('statusTxt').textContent = 'RUNNING';
  sendParam('statusUpdate', 'RUNNING');
}

function togglePhasing() {
  phasingPaused = !phasingPaused;
  const btn = document.getElementById('btnPhase');

  if (phasingPaused) {
    // Snapshot current phase for display
    if (currentMode === 'symbolic') {
      const elapsed = audioCtx.currentTime - startTime;
      const base = 60 / baseBPM / 4;
      frozenOffset = ((elapsed / (base / speedRatio) - elapsed / base) % STEPS) / STEPS;
    } else {
      frozenOffset = samplePhaseNorm();
    }
    // Sample mode: freeze voice II rate
    if (currentMode === 'sample') applySampleRate();

    btn.textContent = '▶   Resume phasing';
    btn.classList.add('paused');
    document.getElementById('statusTxt').textContent = 'PHASE FROZEN';
    sendParam('statusUpdate', 'PHASE FROZEN');
  } else {
    // Resume
    if (currentMode === 'symbolic') {
      // Rebase startTime from current voice positions
      const now = audioCtx.currentTime;
      const base = 60 / baseBPM / 4;
      const stepsV0 = V[0].step - (V[0].nextTime - now) / base;
      startTime = now - stepsV0 * base;
    } else {
      applySampleRate();
    }
    btn.textContent = '⏸   Pause phasing';
    btn.classList.remove('paused');
    document.getElementById('statusTxt').textContent = 'RUNNING';
    sendParam('statusUpdate', 'RUNNING');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PARAM UPDATES
// ═══════════════════════════════════════════════════════════════════════════════
function updateSynth() {
  numHarm = +document.getElementById('harmCtrl').value;
  noteDur = +document.getElementById('durCtrl').value / 1000;
  document.getElementById('harmVal').textContent = numHarm;
  document.getElementById('durVal').textContent  = Math.round(noteDur * 1000) + ' ms';
  sendParam('harmonics', numHarm);
  sendParam('noteDur', Math.round(noteDur * 1000));
}

function updateRatio() {
  speedRatio = +document.getElementById('ratioCtrl').value;
  document.getElementById('ratioVal').textContent = speedRatio.toFixed(4);
  // Live-update sample source if playing
  if (currentMode === 'sample' && isPlaying && !phasingPaused && sampleSources[1]) {
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

function updateTempo() {
  baseBPM = +document.getElementById('tempoCtrl').value;
  document.getElementById('tempoVal').textContent = baseBPM;
  sendParam('tempo', baseBPM);
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
  wCtx.strokeStyle = '#c8ff00';
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
  dCtx.strokeStyle = '#1e1e1e';
  dCtx.lineWidth = 1;
  dCtx.beginPath();
  dCtx.moveTo(0, H / 2); dCtx.lineTo(W, H / 2);
  dCtx.stroke();
  if (DRIFT_HIST.filter(v => v !== 0).length < 2) return;
  dCtx.beginPath();
  dCtx.strokeStyle = '#00d4ff';
  dCtx.lineWidth = 1.5 * dpr;
  dCtx.shadowColor = '#00d4ff';
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
  } else if (currentMode === 'symbolic') {
    const elapsed = audioCtx.currentTime - startTime;
    const base = 60 / baseBPM / 4;
    const rawOffset = elapsed / (base / speedRatio) - elapsed / base;
    phaseNorm = (rawOffset % STEPS) / STEPS;
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

  if (currentMode === 'symbolic') updateScoreUI();
  else updatePlayheads();

  animFrame = requestAnimationFrame(renderLoop);
}

function startRender() {
  if (animFrame) cancelAnimationFrame(animFrame);
  animFrame = requestAnimationFrame(renderLoop);
}

function stopRender() {
  if (animFrame) cancelAnimationFrame(animFrame);
  animFrame = null;
  // Clear score
  for (let i = 0; i < STEPS; i++) {
    ['steps1','steps2'].forEach(id => {
      const e = document.getElementById(`${id}_${i}`);
      if (e) e.className = MELODY[i] ? 'step has-note' : 'step';
    });
  }
  // Reset playheads
  document.getElementById('ph1').style.left = '0%';
  document.getElementById('ph2').style.left = '0%';
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════════════════════════════════════════════
// params whose updates must not be echoed back (slider sync)
const WS_PARAM_ONLY = new Set(['harmonics','noteDur','tempo','ratio','volume','steps']);

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
        // Commands (togglePlay, togglePhasing, resetPhase, loadPreset):
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
  if (dot) dot.style.background = connected ? '#c8ff00' : '#333';
}

function sendFullState() {
  sendParam('harmonics', numHarm);
  sendParam('noteDur',   Math.round(noteDur * 1000));
  sendParam('tempo',     baseBPM);
  sendParam('ratio',     speedRatio);
  sendParam('volume',    +document.getElementById('volCtrl').value);
  sendParam('steps',     STEPS);
  const status = !isPlaying ? 'STOPPED' : phasingPaused ? 'PHASE FROZEN' : 'RUNNING';
  sendParam('statusUpdate',  status);
  sendParam('playingUpdate', isPlaying);
}

function applyParam(param, value) {
  switch (param) {
    case 'harmonics':
      document.getElementById('harmCtrl').value = value;
      updateSynth(); break;
    case 'noteDur':
      document.getElementById('durCtrl').value = value;
      updateSynth(); break;
    case 'tempo':
      document.getElementById('tempoCtrl').value = value;
      updateTempo(); break;
    case 'ratio':
      document.getElementById('ratioCtrl').value = value;
      updateRatio(); break;
    case 'volume':
      document.getElementById('volCtrl').value = value;
      updateVol(); break;
    case 'steps':
      document.getElementById('stepsCtrl').value = value;
      resizeMelody(); break;
    case 'loadPreset':   loadPreset(value);   break;
    case 'togglePlay':   togglePlay();        break;
    case 'resetPhase':   resetPhase();        break;
    case 'togglePhasing': togglePhasing();    break;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════════════
window.addEventListener('resize', resize);
updateSynth();
updateRatio();
updateTempo();
loadPreset('rain');
setTimeout(resize, 100);
connectWS();
