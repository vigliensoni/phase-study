// ═══════════════════════════════════════════════════════════════════════════════
// NET — shared networking and timing.
//
// One conductor page, many performer phones, dealt into the groups of a score.
//
// Transport: MQTT over secure WebSocket, through a broker (a small relay
// server). The site itself stays static; only the broker is "live".
// ═══════════════════════════════════════════════════════════════════════════════

// ── Config (overridable from the URL: ?room=ABCD&broker=wss://…) ─────────────
const params     = new URLSearchParams(location.search);
const BROKER_URL = params.get('broker') || 'wss://broker.hivemq.com:8884/mqtt';
const TOPIC_BASE = 'cart346/c04-ensemble';

const LEAD_START  = 1500; // ms between pressing Start and the downbeat
const LEAD_CHANGE = 400;  // ms between moving a control and it taking effect
const CALIB_GAP   = 500;  // ms between phones during level calibration

function topics(room) {
  const b = `${TOPIC_BASE}/${room}`;
  return {
    state:    `${b}/state`,    // retained: the whole piece, as one message
    ping:     `${b}/ping`,     // performer → conductor clock request
    pong: id => `${b}/pong/${id}`,
    presence: `${b}/presence`, // performer heartbeat (roster)
    calib:    `${b}/calib`,    // conductor → performers: test-sound round, one phone at a time
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

// ── Ring display (each phone's playhead) ─────────────────────────────────────
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

// ── Theme ─────────────────────────────────────────────────────────────────────
function toggleTheme() {
  const dark = document.documentElement.dataset.theme !== 'dark';
  if (dark) document.documentElement.dataset.theme = 'dark';
  else      delete document.documentElement.dataset.theme;
  try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch (e) {}
}
