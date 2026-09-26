// ═══════════════════════════════════════════════════════════════════════════════
// PERFORMER — one phone, one voice.
// Estimates its offset to the conductor's clock, then turns every "at shared
// time T" in the state message into an exact AudioContext time.
// ═══════════════════════════════════════════════════════════════════════════════

const room = params.get('room');
const T = room ? topics(room) : null;

const store = {
  get(k)    { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};

// One id per tab (survives a reload, but two tabs on one device are two phones)
const myId = (() => {
  try {
    const id = sessionStorage.getItem('c04e-id') || randomId(8);
    sessionStorage.setItem('c04e-id', id);
    return id;
  } catch (e) { return randomId(8); }
})();

let voice = Math.max(1, parseInt(params.get('voice') || store.get('c04e-voice') || '1', 10) || 1);
let trimMs = +(store.get('c04e-trim') || 0); // manual latency trim, + = play earlier

let client = null;
let ctx = null, master = null;
let state = null;   // latest state message from the conductor
let cur = null;     // what is currently sounding: { src, gain, epoch, voice, sound, tA, seatK, S }
let joined = false;
let lastPong = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// CLOCK SYNC — NTP-style, over the broker
// ═══════════════════════════════════════════════════════════════════════════════
const samples = []; // { rtt, off, at }
let offset = 0, jitter = null, minRtt = null, synced = false;

function sendPing() {
  if (client && client.connected) client.publish(T.ping, JSON.stringify({ id: myId, t0: localNow() }));
}

function onPong(m) {
  const t1 = localNow(), rtt = t1 - m.t0;
  if (!(rtt >= 0 && rtt < 5000)) return;
  lastPong = t1;
  samples.push({ rtt, off: m.tc - (m.t0 + rtt / 2), at: t1 });
  while (samples.length > 40) samples.shift();

  // The fastest round trips are the most symmetric ones: trust those.
  const best = samples.filter(s => t1 - s.at < 90000).sort((a, b) => a.rtt - b.rtt).slice(0, 5);
  const offs = best.map(s => s.off).sort((a, b) => a - b);
  offset = offs[Math.floor(offs.length / 2)];
  jitter = (offs[offs.length - 1] - offs[0]) / 2;
  minRtt = best[0].rtt;

  if (!synced && samples.length >= 6) { synced = true; applyState(); }
}

const sharedNow = () => localNow() + offset;

// Shared time (ms) → AudioContext time (s) at which that moment is *heard*.
function ctxTimeFor(tShared) {
  const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
  let ctxT, perfT, outLat = 0;
  // Some browsers (older Safari especially) report bogus output timestamps;
  // only trust them when they agree with the live clocks to within 0.5 s.
  const sane = ts && ts.contextTime > 0 && ts.performanceTime > 0 &&
    Math.abs(ts.performanceTime - performance.now()) < 500 &&
    Math.abs(ts.contextTime - ctx.currentTime) < 0.5;
  if (sane) {
    ctxT = ts.contextTime; perfT = ts.performanceTime;       // already includes output latency
  } else {
    ctxT = ctx.currentTime; perfT = performance.now();
    outLat = ctx.outputLatency || ctx.baseLatency || 0;
  }
  const localPerf = tShared - offset - performance.timeOrigin;
  return ctxT + (localPerf - perfT) / 1000 - outLat - trimMs / 1000;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOUNDS
// ═══════════════════════════════════════════════════════════════════════════════
const buffers = new Map(); // n → Promise<AudioBuffer>
const ready = new Set();

function getBuffer(n) {
  if (!buffers.has(n)) {
    buffers.set(n, fetch(SOUNDS[n - 1])
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .then(d => ctx.decodeAudioData(d))
      .then(b => { decoded.set(n, b); ready.add(n); sendPresence(); return b; })
      .catch(e => { buffers.delete(n); throw e; }));
  }
  return buffers.get(n);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLAYBACK
// ═══════════════════════════════════════════════════════════════════════════════
let applying = Promise.resolve();
function applyState() { applying = applying.then(doApply, doApply); }

async function doApply() {
  const S = state;
  if (!joined || !synced || !S) return renderStatus();
  if (!S.playing) { stopAt(S.stopAt); stopScore(S.stopAt); return renderStatus(); }

  if (S.mode === 'score') {
    if (cur) stopAt(0);
    await applyScore(S);
    return renderStatus();
  }
  if (run) stopScore(0);

  let buffer;
  try { buffer = await getBuffer(S.sound); }
  catch (e) { setStatus('COULD NOT LOAD SOUND ' + S.sound); return; }
  if (state !== S) return; // a newer message arrived while loading

  if (cur && cur.epoch === S.epoch && cur.voice === voice && cur.sound === S.sound) {
    // Same run, new drift rate: schedule the change for the exact moment.
    if (cur.tA !== S.tA || cur.S.paused !== S.paused || cur.S.ratio !== S.ratio) {
      const at = ctxTimeFor(S.tA);
      if (at > ctx.currentTime + 0.01) {
        cur.src.playbackRate.setValueAtTime(voiceRate(S, voice), at);
        cur.tA = S.tA; cur.S = S;
      } else {
        seat(S, buffer, true); // message arrived late: jump to the right spot
      }
    }
  } else {
    seat(S, buffer, cur && cur.epoch === S.epoch);
  }
  renderStatus();
}

// Start (or re-start) this phone's voice exactly where the math says it should be.
function seat(S, buffer, smooth) {
  let ts = Math.max(S.T0, S.tA, sharedNow() + 120);
  let at = ctxTimeFor(ts);
  const earliest = ctx.currentTime + 0.03;
  if (at < earliest) { ts += (earliest - at) * 1000; at = earliest; }

  const src  = ctx.createBufferSource();
  const gain = ctx.createGain();
  src.buffer = buffer;
  src.loop = true;
  src.playbackRate.value = voiceRate(S, voice);
  src.connect(gain).connect(master);

  const fade = smooth ? 0.03 : 0.003;
  gain.gain.setValueAtTime(smooth ? 0 : 1, 0);
  if (smooth) gain.gain.linearRampToValueAtTime(1, at + fade);

  if (cur) {
    cur.gain.gain.setValueAtTime(1, at);
    cur.gain.gain.linearRampToValueAtTime(0, at + fade);
    try { cur.src.stop(at + fade + 0.02); } catch (e) {}
  }

  src.start(at, voicePos(S, voice, ts, buffer.duration));
  cur = { src, gain, epoch: S.epoch, voice, sound: S.sound, tA: S.tA, S, seatK: at - ts / 1000, buffer };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCORE MODE — the whole piece arrives in one message; this phone keeps the
// layers of its own group and schedules every fade and drift change ahead.
// ═══════════════════════════════════════════════════════════════════════════════
let run = null; // { key, epoch, nodes, seatK, S, comp, group, rank }
let compiled = { json: null, comp: null };

function compiledFor(S) {
  const json = JSON.stringify(S.score);
  if (compiled.json !== json) compiled = { json, comp: compileScore(S.score, SOUNDS.length) };
  return compiled.comp;
}

function myAssign(S) { return (S.assign && S.assign[myId]) || null; }

async function applyScore(S) {
  const comp = compiledFor(S);
  const a = myAssign(S);
  if (!a) { stopScore(0); return; }
  const [group, rank] = a;
  const mine = comp.layers.filter(L => L.group === group);

  try { await Promise.all([...new Set(mine.map(L => L.sound))].map(getBuffer)); }
  catch (e) { setStatus('COULD NOT LOAD SOUNDS'); return; }
  if (state !== S) return;

  const key = [S.epoch, group, rank, JSON.stringify(S.overrides || [])].join('|');
  if (run && run.key === key) { run.S = S; return; }
  scheduleScore(S, comp, group, rank, key, !!(run && run.epoch === S.epoch));
}

// Build every node for this phone's layers, from "now" to the end of the piece.
function scheduleScore(S, comp, group, rank, key, smooth) {
  let ts = sharedNow() + 150;
  let at = ctxTimeFor(ts);
  const earliest = ctx.currentTime + 0.03;
  if (at < earliest) { ts += (earliest - at) * 1000; at = earliest; }
  const st  = (ts - S.T0) / 1000;               // score time at `at`
  const c   = t => at + (t - st);               // score time → context time
  const fade = smooth ? 0.03 : 0.005;

  if (run) fadeOutNodes(run.nodes, at, fade);

  const nodes = [];
  for (const L of comp.layers) {
    if (L.group !== group || L.stop <= st) continue;
    const buffer = bufferNow(L.sound);
    if (!buffer) continue;
    const drift = effectiveDrift(L, S.overrides);
    const t0 = Math.max(st, L.start);           // when this node starts sounding
    const c0 = t0 === st ? at : c(t0);

    const src = ctx.createBufferSource(), gain = ctx.createGain();
    src.buffer = buffer;
    src.loop = true;
    src.connect(gain).connect(master);

    // Drift → playback rate, following the curve exactly (steps and ramps)
    const rate = v => 1 + (rank - 1) * v;
    src.playbackRate.setValueAtTime(rate(valueAt(drift, t0)), c0);
    scheduleCurve(src.playbackRate, drift.filter(p => p.t > t0), c, rate);

    // Gain envelope (with a short fade-in when re-seating mid-sound)
    const g0 = valueAt(L.gain, t0);
    const midSound = smooth && t0 > L.start;
    gain.gain.setValueAtTime(midSound ? 0 : g0, c0);
    if (midSound) gain.gain.linearRampToValueAtTime(valueAt(L.gain, t0 + fade), c0 + fade);
    scheduleCurve(gain.gain, L.gain.filter(p => p.t > t0 + (midSound ? fade : 0)), c, v => v);

    src.start(c0, layerPos(L, drift, rank, t0, buffer.duration));
    if (isFinite(L.stop)) src.stop(c(L.stop) + 0.05);
    nodes.push({ src, gain, L, drift, buffer });
  }
  run = { key, epoch: S.epoch, nodes, seatK: at - ts / 1000, S, comp, group, rank };
}

function scheduleCurve(param, pts, c, map) {
  let prevT = null;
  for (const p of pts) {
    if (p.t === prevT) param.setValueAtTime(map(p.v), c(p.t));
    else param.linearRampToValueAtTime(map(p.v), c(p.t));
    prevT = p.t;
  }
}

function fadeOutNodes(nodes, at, fade) {
  for (const n of nodes) {
    try {
      const g = n.gain.gain;
      if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(at);
      else { g.cancelScheduledValues(at); g.setValueAtTime(g.value, at); }
      n.gain.gain.linearRampToValueAtTime(0, at + fade);
      n.src.stop(at + fade + 0.02);
    } catch (e) {}
  }
}

function stopScore(tShared) {
  if (!run) return;
  const at = Math.max(ctxTimeFor(tShared || 0), ctx.currentTime + 0.005);
  fadeOutNodes(run.nodes, at, 0.02);
  run = null;
}

// Decoded buffers, synchronously (applyScore awaited them already)
const decoded = new Map();
function bufferNow(n) { return decoded.get(n) || null; }

function stopAt(tShared) {
  if (!cur) return;
  const at = Math.max(ctxTimeFor(tShared || 0), ctx.currentTime + 0.005);
  cur.gain.gain.setValueAtTime(1, at);
  cur.gain.gain.linearRampToValueAtTime(0, at + 0.01);
  try { cur.src.stop(at + 0.03); } catch (e) {}
  cur = null;
}

// Audio hardware clocks and system clocks drift apart (tens of ppm), and the
// clock-offset estimate keeps improving. Every few seconds, check how far the
// running voice has slipped from where it should be; past 20 ms, re-seat it.
let driftMs = 0;
function checkDrift() {
  if (!synced) return;
  if (run) {
    const X = sharedNow() + 200;
    driftMs = ((ctxTimeFor(X) - X / 1000) - run.seatK) * 1000;
    if (Math.abs(driftMs) > 20) {
      scheduleScore(run.S, run.comp, run.group, run.rank, run.key, true);
      driftMs = 0;
    }
    return;
  }
  if (!cur) return;
  const X = sharedNow() + 200;
  driftMs = ((ctxTimeFor(X) - X / 1000) - cur.seatK) * 1000;
  if (Math.abs(driftMs) > 20) { seat(cur.S, cur.buffer, true); driftMs = 0; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// NETWORK
// ═══════════════════════════════════════════════════════════════════════════════
function sendPresence() {
  if (!client || !client.connected) return;
  client.publish(T.presence, JSON.stringify({
    id: myId, voice, rtt: minRtt, jitter,
    lat: ctx ? ((ctx.outputLatency || ctx.baseLatency || 0) * 1000) : null,
    ready: state && state.mode === 'score' ? ready.size === SOUNDS.length
         : state ? ready.has(state.sound) : ready.size > 0,
    assign: state ? myAssign(state) : null,
  }));
}

function connect() {
  client = connectBroker('perf-' + myId + '-' + randomId(3), {
    topic: T.presence, payload: JSON.stringify({ id: myId, gone: true }), qos: 0, retain: false,
  });
  client.on('connect', () => {
    client.subscribe([T.state, T.pong(myId), T.assign]);
    // Burst of pings for a quick first estimate
    for (let i = 0; i < 15; i++) setTimeout(sendPing, i * 120);
    sendPresence();
    renderStatus();
  });
  client.on('reconnect', () => setStatus('RECONNECTING…'));
  client.on('offline',   () => setStatus('OFFLINE'));
  client.on('message', (topic, buf) => {
    const m = safeParse(buf);
    if (!m) return;
    if (topic === T.pong(myId)) return onPong(m);
    if (topic === T.state) {
      if (m.v !== 1) return;
      state = m;
      getBuffer(m.sound).catch(() => {});
      return applyState();
    }
    if (topic === T.assign && m.map && m.map[myId]) setVoice(m.map[myId]);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// JOIN (needs a tap: browsers only start audio after a user gesture)
// ═══════════════════════════════════════════════════════════════════════════════
let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
}

async function join() {
  // iOS: play through the silent switch
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
  // Older iOS: a looping silent <audio> element also switches to the "playback" session
  try {
    const silent = new Audio('data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==');
    silent.loop = true; silent.setAttribute('playsinline', '');
    silent.play().catch(() => {});
  } catch (e) {}

  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  master = ctx.createGain();
  master.gain.value = +document.getElementById('volCtrl').value;
  master.connect(ctx.destination);
  await ctx.resume();
  const unlock = ctx.createBufferSource();          // prime the output on iOS
  unlock.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
  unlock.connect(ctx.destination); unlock.start();

  keepAwake();
  joined = true;
  document.body.classList.add('joined');
  setVoice(+document.getElementById('voiceInput').value || voice);

  connect();
  // Preload every sound so the conductor can switch without a gap
  SOUNDS.forEach((_, i) => getBuffer(i + 1).catch(() => {}));

  setInterval(sendPing, 2500);
  setInterval(sendPresence, 3000);
  setInterval(checkDrift, 4000);
  setInterval(renderStatus, 1000);
  requestAnimationFrame(renderLoop);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !ctx) return;
  ctx.resume();
  keepAwake();
  for (let i = 0; i < 6; i++) setTimeout(sendPing, i * 150);
  setTimeout(checkDrift, 1200);
});

// ═══════════════════════════════════════════════════════════════════════════════
// UI
// ═══════════════════════════════════════════════════════════════════════════════
function setVoice(v) {
  voice = Math.max(1, Math.min(99, v | 0));
  store.set('c04e-voice', voice);
  document.getElementById('voiceInput').value = voice;
  document.getElementById('voiceBig').textContent = voice;
  document.getElementById('voiceBig').style.color = voiceColor(voice);
  sendPresence();
  applyState();
}

function nudgeVoice(d) { setVoice(voice + d); }

// Plays a short beep right now, ignoring the conductor: checks that this
// phone can make sound at all (volume, silent switch, audio unlocked).
function testSound() {
  if (!ctx) return;
  ctx.resume();
  const t = ctx.currentTime + 0.02;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = 880;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.5, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + 0.45);
  renderStatus();
}

function updateVol() {
  const v = +document.getElementById('volCtrl').value;
  document.getElementById('volVal').textContent = v.toFixed(2);
  if (master) master.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
}

function updateTrim() {
  trimMs = +document.getElementById('trimCtrl').value;
  store.set('c04e-trim', trimMs);
  document.getElementById('trimVal').textContent = (trimMs > 0 ? '+' : '') + trimMs + ' ms';
  // checkDrift() notices the change and re-seats the running voice
}

let statusOverride = null;
function setStatus(txt) { statusOverride = txt; renderStatus(); }

function renderStatus() {
  const el = document.getElementById('statusTxt');
  if (!el) return;
  let txt;
  if (!room) txt = 'NO ROOM — OPEN THE LINK FROM THE CONDUCTOR';
  else if (!client || !client.connected) txt = statusOverride || 'CONNECTING…';
  else if (!synced) txt = localNow() - lastPong > 5000 && samples.length === 0
    ? 'WAITING FOR CONDUCTOR' : 'SYNCING CLOCK…';
  else if (state && state.mode === 'score' && !myAssign(state)) txt = 'WAITING FOR A GROUP…';
  else if (!state || !state.playing) txt = 'READY — WAITING FOR START';
  else if (state.mode === 'score') {
    const st = (sharedNow() - state.T0) / 1000, comp = compiledFor(state);
    txt = ctx.state !== 'running' ? 'AUDIO BLOCKED — TAP “TEST SOUND”'
        : st < 0 ? 'COUNT-IN…' : st > comp.end ? 'END' : 'PLAYING';
  }
  else if (!cur) txt = 'LOADING SOUND…';
  else if (ctx.state !== 'running') txt = 'AUDIO BLOCKED — TAP “TEST SOUND”';
  else if (sharedNow() < state.T0) txt = 'COUNT-IN…';
  else txt = state.paused ? 'PHASE FROZEN' : 'PLAYING';
  if (client && client.connected) statusOverride = null;
  el.textContent = txt;

  const stats = document.getElementById('statsTxt');
  if (stats) stats.textContent = synced
    ? `sync ±${jitter.toFixed(1)} ms · rtt ${Math.round(minRtt)} ms · drift ${driftMs.toFixed(1)} ms`
    : '';
}

function renderLoop() {
  const canvas = document.getElementById('ring');
  const S = state, dur = cur && cur.buffer.duration;
  let hands = [];
  if (S && S.playing && dur && synced) {
    const t = sharedNow();
    if (t >= S.T0) {
      hands = [{ pos: voicePos(S, 1, t, dur) / dur, color: voiceColor(1), width: 2 }];
      if (voice !== 1) hands.unshift({ pos: voicePos(S, voice, t, dur) / dur, color: voiceColor(voice), width: 4 });
      else hands[0].width = 4;
    }
  }
  if (S && S.mode === 'score') hands = scoreHands(S);
  drawRing(canvas, hands);
  renderIdentity();
  requestAnimationFrame(renderLoop);
}

// Score mode: ring shows the loudest sound in my group — my hand vs. phone 1's
function scoreHands(S) {
  const nowTxt = document.getElementById('nowTxt');
  if (!run || !S.playing || !synced) { if (nowTxt) nowTxt.textContent = ''; return []; }
  const st = (sharedNow() - S.T0) / 1000;
  let best = null, bestG = 0.001;
  for (const n of run.nodes) {
    const g = st >= n.L.start && st <= n.L.stop ? valueAt(n.L.gain, st) : 0;
    if (g > bestG) { best = n; bestG = g; }
  }
  if (nowTxt) nowTxt.textContent = st < 0 ? `starts in ${Math.ceil(-st)} s`
    : fmtTime(st) + (best ? ` · sound ${best.L.sound} · ratio ${(1 + valueAt(best.drift, st)).toFixed(4)}` : ' · silent');
  if (!best) return [];
  const dur = best.buffer.duration, col = groupColor(run.group, run.comp.groups);
  const hands = [{ pos: layerPos(best.L, best.drift, 1, st, dur) / dur, color: themeColor('--mid'), width: 2 }];
  if (run.rank !== 1) hands.unshift({ pos: layerPos(best.L, best.drift, run.rank, st, dur) / dur, color: col, width: 4 });
  else hands[0] = { ...hands[0], color: col, width: 4 };
  return hands;
}

// Big label: voice number (free mode) or group letter + phone number (score mode)
function renderIdentity() {
  const big = document.getElementById('voiceBig'), sub = document.getElementById('subTxt');
  const S = state, scoreMode = S && S.mode === 'score';
  document.body.classList.toggle('score-mode', !!scoreMode);
  if (scoreMode) {
    const a = myAssign(S), comp = compiledFor(S);
    const txt = a ? a[0] : '·';
    if (big.textContent !== txt) big.textContent = txt;
    big.style.color = a ? groupColor(a[0], comp.groups) : themeColor('--mid');
    sub.textContent = a ? `Group · phone ${a[1]}` : 'Group';
  } else {
    if (big.textContent !== String(voice)) big.textContent = voice;
    big.style.color = voiceColor(voice);
    sub.textContent = 'Voice';
  }
}

function themeChanged() {
  toggleTheme();
  document.getElementById('themeBtn').textContent =
    document.documentElement.dataset.theme === 'dark' ? '◐' : '◑';
  document.getElementById('voiceBig').style.color = voiceColor(voice);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.getElementById('roomTxt').textContent = room || '—';
document.getElementById('voiceInput').value = voice;
document.getElementById('trimCtrl').value = trimMs;
updateTrim();
if (!room) {
  document.getElementById('joinBtn').disabled = true;
  renderStatus();
}
