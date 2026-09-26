// ═══════════════════════════════════════════════════════════════════════════════
// CONDUCTOR — owns the shared clock and the state of the piece.
// It never plays sound itself; open a performer tab too if you want to monitor.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Room ──────────────────────────────────────────────────────────────────────
let room = params.get('room');
if (!room) {
  room = randomId(4, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789');
  params.set('room', room);
  history.replaceState(null, '', `${location.pathname}?${params}`);
}
const T = topics(room);

const performerURL = (() => {
  const u = new URL('./', location.href);
  u.searchParams.set('room', room);
  if (params.get('broker')) u.searchParams.set('broker', params.get('broker'));
  return u.toString();
})();

// ── State of the piece (published retained, so late joiners get it) ──────────
let S = {
  v: 1, epoch: null, playing: false, sound: 1,
  T0: 0, tA: 0, phiA: 0, ratio: 1.002, paused: false, stopAt: 0,
};
let adoptedRetained = false; // after a reload, pick up where the room was
let durations = {};          // sound n → seconds (for the ring display)

const roster = new Map();    // id → { voice, rtt, jitter, lat, ready, first, last }

// ── Broker ────────────────────────────────────────────────────────────────────
const client = connectBroker('cond-' + randomId());

client.on('connect', () => {
  setNet('ONLINE', true);
  client.subscribe([T.state, T.ping, T.presence]);
});
client.on('reconnect', () => setNet('RECONNECTING…', false));
client.on('offline',   () => setNet('OFFLINE', false));
client.on('error', err => setNet('ERROR: ' + err.message, false));

client.on('message', (topic, buf) => {
  // Clock requests: answer as fast as possible, before anything else
  if (topic === T.ping) {
    const m = safeParse(buf);
    if (m && m.id) client.publish(T.pong(m.id), JSON.stringify({ t0: m.t0, tc: localNow() }));
    return;
  }
  const m = safeParse(buf);
  if (!m) return;

  if (topic === T.presence) {
    if (m.gone) { roster.delete(m.id); return; }
    const prev = roster.get(m.id);
    roster.set(m.id, { ...m, first: prev ? prev.first : localNow(), last: localNow() });
    return;
  }
  if (topic === T.state && !adoptedRetained) {
    adoptedRetained = true;
    if (m.v === 1 && m.epoch) { S = m; refreshUI(); }
  }
});

function publishState() {
  adoptedRetained = true; // our own actions win from now on
  client.publish(T.state, JSON.stringify(S), { retain: true, qos: 1 });
  refreshUI();
}

// ── Actions ───────────────────────────────────────────────────────────────────
function launch() {
  const now = localNow();
  S.epoch = randomId();
  S.playing = true;
  S.paused = false;
  S.T0 = S.tA = now + LEAD_START;
  S.phiA = 0;
  publishState();
}

function togglePlay() {
  if (S.playing) {
    S.playing = false;
    S.stopAt = localNow() + LEAD_CHANGE;
    publishState();
  } else {
    launch();
  }
}

function resync() { if (S.playing) launch(); }

// Changing the drift rate mid-piece: freeze the accumulated phase at the
// moment the change takes effect, then continue from there with the new rate.
function changeDrift(mutate) {
  if (S.playing) {
    const tc = Math.max(localNow() + LEAD_CHANGE, S.tA);
    S.phiA = phiAt(S, tc);
    S.tA = tc;
  }
  mutate();
  publishState();
}

function togglePhasing() { if (S.playing) changeDrift(() => { S.paused = !S.paused; }); }

let ratioTimer = null, ratioPending = null;
function updateRatio() {
  const v = +document.getElementById('ratioCtrl').value;
  document.getElementById('ratioVal').textContent = v.toFixed(4);
  ratioPending = v;
  if (ratioTimer) return; // throttle: at most one message every 150 ms
  const flush = () => {
    if (ratioPending === null) { ratioTimer = null; return; }
    const r = ratioPending; ratioPending = null;
    changeDrift(() => { S.ratio = r; });
    ratioTimer = setTimeout(flush, 150);
  };
  flush();
}

function selectSound(n) {
  S.sound = n;
  if (S.playing) launch(); else publishState();
}

function autoAssign() {
  const ids = [...roster.entries()].sort((a, b) => a[1].first - b[1].first).map(e => e[0]);
  const map = {};
  ids.forEach((id, i) => { map[id] = i + 1; });
  client.publish(T.assign, JSON.stringify({ map }));
}

// ── Durations (only for drawing the ring) ─────────────────────────────────────
async function loadDurations() {
  const ctx = new OfflineAudioContext(1, 1, 44100);
  await Promise.all(SOUNDS.map(async (url, i) => {
    try {
      const buf = await (await fetch(url)).arrayBuffer();
      durations[i + 1] = (await ctx.decodeAudioData(buf)).duration;
    } catch (e) { /* ring just won't show for that sound */ }
  }));
}

// ── UI ────────────────────────────────────────────────────────────────────────
function setNet(txt, ok) {
  const el = document.getElementById('netTxt');
  el.textContent = txt;
  el.classList.toggle('ok', ok);
}

function refreshUI() {
  const play = document.getElementById('btnPlay');
  play.textContent = S.playing ? '■   Stop' : '▶   Start';
  play.classList.toggle('on', S.playing);
  const ph = document.getElementById('btnPhase');
  ph.disabled = !S.playing;
  ph.textContent = S.paused ? '▶   Resume phasing' : '⏸   Pause phasing';
  ph.classList.toggle('paused', S.paused);
  document.getElementById('btnSync').disabled = !S.playing;
  document.querySelectorAll('.sound-btn').forEach(b =>
    b.classList.toggle('active', +b.dataset.sound === S.sound));
  const ratioCtrl = document.getElementById('ratioCtrl');
  if (document.activeElement !== ratioCtrl && ratioPending === null) {
    ratioCtrl.value = S.ratio;
    document.getElementById('ratioVal').textContent = S.ratio.toFixed(4);
  }
  document.getElementById('statusTxt').textContent =
    !S.playing ? 'STOPPED' : S.paused ? 'PHASE FROZEN' : 'RUNNING';
}

function renderRoster() {
  const now = localNow();
  for (const [id, p] of roster) if (now - p.last > 12000) roster.delete(id);

  const rows = [...roster.entries()].sort((a, b) => a[1].voice - b[1].voice || a[1].first - b[1].first);
  const voices = rows.map(r => r[1].voice);
  const dupes = new Set(voices.filter((v, i) => voices.indexOf(v) !== i));

  document.getElementById('countTxt').textContent = rows.length;
  document.getElementById('rosterBody').innerHTML = rows.length ? rows.map(([id, p]) => `
    <tr class="${dupes.has(p.voice) ? 'dupe' : ''}">
      <td><span class="swatch" style="background:${voiceColor(p.voice)}"></span>${p.voice}</td>
      <td>${id.slice(0, 4)}</td>
      <td>${p.rtt == null ? '—' : Math.round(p.rtt)}</td>
      <td>${p.jitter == null ? '—' : '±' + p.jitter.toFixed(1)}</td>
      <td>${p.lat == null ? '—' : Math.round(p.lat)}</td>
      <td>${p.ready ? 'ready' : 'loading'}</td>
    </tr>`).join('')
    : '<tr><td colspan="6" class="empty">Waiting for phones… scan the code to join.</td></tr>';
}

function renderLoop() {
  const canvas = document.getElementById('ring');
  const now = localNow(), dur = durations[S.sound];
  let hands = [];
  if (S.playing && dur && now >= S.T0) {
    const vs = [...new Set([1, ...[...roster.values()].map(p => p.voice)])].sort((a, b) => a - b);
    hands = vs.map(k => ({ pos: voicePos(S, k, now, dur) / dur, color: voiceColor(k), width: k === 1 ? 3 : 2 }));
  }
  drawRing(canvas, hands);
  requestAnimationFrame(renderLoop);
}

function themeChanged() {
  toggleTheme();
  document.getElementById('themeBtn').textContent =
    document.documentElement.dataset.theme === 'dark' ? '◐   Light' : '◐   Dark';
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.getElementById('roomTxt').textContent = room;
const link = document.getElementById('joinLink');
link.href = link.textContent = performerURL;
if (/^(localhost|127\.|\[::1\])/.test(location.hostname)) {
  link.insertAdjacentHTML('afterend',
    '<p class="hint" style="color:var(--c2);margin-top:0.5rem">This link says “localhost”, which on a phone means the phone itself. ' +
    'Open this conductor page via your computer’s network address instead (e.g. http://192.168.1.23:8080/…).</p>');
}
try {
  const qr = qrcode(0, 'M');
  qr.addData(performerURL);
  qr.make();
  document.getElementById('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
} catch (e) { /* QR library unavailable: the link is still there */ }

document.getElementById('themeBtn').textContent =
  document.documentElement.dataset.theme === 'dark' ? '◐   Light' : '◐   Dark';
refreshUI();
renderRoster();
setInterval(renderRoster, 1000);
loadDurations();
requestAnimationFrame(renderLoop);
