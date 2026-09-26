// ═══════════════════════════════════════════════════════════════════════════════
// IT'S GONNA RAIN — ENSEMBLE · shared networking + timing
//
// One conductor page, many performer phones. Every phone is one voice of the
// phase piece: voice k plays the loop at rate 1 + (k−1)·(ratio−1), so voice 1
// is the reference and each following voice drifts a little faster.
//
// Transport: MQTT over secure WebSocket, through a broker (a small relay
// server). The site itself stays static; only the broker is "live".
// ═══════════════════════════════════════════════════════════════════════════════

// Built-in sounds (same files as the single-browser study one folder up)
const SOUNDS = [
  '../assets/1.wav',
  '../assets/2.wav',
  '../assets/3.wav',
  '../assets/4.wav',
  '../assets/5.wav',
];

// ── Config (overridable from the URL: ?room=ABCD&broker=wss://…) ─────────────
const params     = new URLSearchParams(location.search);
const BROKER_URL = params.get('broker') || 'wss://broker.hivemq.com:8884/mqtt';
const TOPIC_BASE = 'cart346/c04-ensemble';

const LEAD_START  = 1500; // ms between pressing Start/Sync and the downbeat
const LEAD_CHANGE = 400;  // ms between moving a control and it taking effect

function topics(room) {
  const b = `${TOPIC_BASE}/${room}`;
  return {
    state:    `${b}/state`,    // retained: the whole piece, as one message
    ping:     `${b}/ping`,     // performer → conductor clock request
    pong: id => `${b}/pong/${id}`,
    presence: `${b}/presence`, // performer heartbeat (roster)
    assign:   `${b}/assign`,   // conductor → performers: voice numbers
  };
}

function randomId(n = 6, alphabet = 'abcdefghjkmnpqrstuvwxyz23456789') {
  let s = '';
  const r = crypto.getRandomValues(new Uint8Array(n));
  for (const x of r) s += alphabet[x % alphabet.length];
  return s;
}

function connectBroker(clientId, will) {
  // `mqtt` is the global from mqtt.min.js (loaded in the HTML)
  return mqtt.connect(BROKER_URL, {
    clientId,
    clean: true,
    keepalive: 20,
    reconnectPeriod: 1500,
    connectTimeout: 8000,
    will,
  });
}

// ── Clocks ────────────────────────────────────────────────────────────────────
// Local high-resolution wall clock, in ms. The conductor's version of this is
// the shared clock; performers estimate their offset to it.
const localNow = () => performance.timeOrigin + performance.now();

const safeParse = buf => { try { return JSON.parse(buf.toString()); } catch (e) { return null; } };

// ── The piece as math ─────────────────────────────────────────────────────────
// A state message fully describes where every voice is at any shared time t:
//   phi(t)   = phiA + (t − tA)·d          accumulated drift (seconds)
//   pos_k(t) = (t − T0) + (k−1)·phi(t)    loop position of voice k (seconds)
//   rate_k   = 1 + (k−1)·d
// with d = ratio − 1 (or 0 while phasing is paused). Any phone, joining at any
// moment, can compute exactly where its voice should be.
function drift(S) { return S.paused ? 0 : S.ratio - 1; }

function phiAt(S, t) {
  return S.phiA + Math.max(0, t - S.tA) / 1000 * drift(S);
}

function voicePos(S, voice, t, dur) {
  const p = (t - S.T0) / 1000 + (voice - 1) * phiAt(S, t);
  return ((p % dur) + dur) % dur;
}

function voiceRate(S, voice) { return 1 + (voice - 1) * drift(S); }

// ── Shared ring display ───────────────────────────────────────────────────────
function themeColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// hands: [{ pos: 0–1, color, label }]
function drawRing(canvas, hands) {
  const dpr = window.devicePixelRatio || 1;
  const r0  = canvas.getBoundingClientRect();
  if (!r0.width) return;
  const w = Math.round(r0.width * dpr), h = Math.round(r0.height * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const c  = canvas.getContext('2d');
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 10 * dpr;
  const ang = p => -Math.PI / 2 + p * Math.PI * 2;
  c.clearRect(0, 0, w, h);

  c.strokeStyle = themeColor('--dim');
  c.lineWidth = 1.5 * dpr;
  c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();

  [...hands].reverse().forEach(({ pos, color, width = 2 }) => {
    const a = ang(pos), x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
    c.strokeStyle = color; c.fillStyle = color;
    c.lineWidth = width * dpr;
    c.beginPath(); c.moveTo(cx, cy); c.lineTo(x, y); c.stroke();
    c.beginPath(); c.arc(x, y, (width + 3) * dpr, 0, Math.PI * 2); c.fill();
  });

  c.fillStyle = themeColor('--fg');
  c.beginPath(); c.arc(cx, cy, 3 * dpr, 0, Math.PI * 2); c.fill();
}

// Colour for voice k on the conductor ring: voice 1 = --c1, then a hue walk
function voiceColor(k) {
  if (k === 1) return themeColor('--c1');
  const hues = [20, 200, 285, 335, 40, 170, 245, 0];
  return `hsl(${hues[(k - 2) % hues.length]} 75% 52%)`;
}

// ── Theme (same convention as the study page) ─────────────────────────────────
function toggleTheme() {
  const dark = document.documentElement.dataset.theme !== 'dark';
  if (dark) document.documentElement.dataset.theme = 'dark';
  else      delete document.documentElement.dataset.theme;
  try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch (e) {}
}
