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

const myId = store.get('c04e-id') || randomId(8);
store.set('c04e-id', myId);

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
      .then(b => { ready.add(n); sendPresence(); return b; })
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
  if (!S.playing) { stopAt(S.stopAt); return renderStatus(); }

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
  if (!cur || !synced) return;
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
    ready: state ? ready.has(state.sound) : ready.size > 0,
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
  else if (!state || !state.playing) txt = 'READY — WAITING FOR START';
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
  drawRing(canvas, hands);
  requestAnimationFrame(renderLoop);
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
