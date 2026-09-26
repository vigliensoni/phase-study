// ═══════════════════════════════════════════════════════════════════════════════
// CONDUCTOR — owns the shared clock and the state of the piece.
// Two modes:
//   Free   one sound, live controls (the original ensemble)
//   Score  a timed piece from scores.js, played by groups of phones
// The conductor never plays sound itself; open a phone tab too to monitor.
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
  v: 1, mode: 'free', epoch: null, playing: false, stopAt: 0,
  // free mode
  sound: 1, T0: 0, tA: 0, phiA: 0, ratio: 1.002, paused: false,
  // score mode
  scoreIdx: 0, score: SCORES[0], overrides: [], assign: {}, nextSlot: 0,
};
let adoptedRetained = false; // after a reload, pick up where the room was
let durations = {};          // sound n → seconds (for the ring display)
let comp = compileScore(S.score, SOUNDS.length);

const roster = new Map();    // id → { voice, assign, rtt, jitter, lat, ready, first, last }

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
    if (!prev && S.mode === 'score') ensureAssigned();
    return;
  }
  if (topic === T.state && !adoptedRetained) {
    adoptedRetained = true;
    if (m.v === 1 && m.epoch) {
      S = { ...S, ...m, mode: m.mode || 'free' };
      comp = compileScore(S.score, SOUNDS.length);
      refreshUI();
    }
  }
});

function publishState() {
  adoptedRetained = true; // our own actions win from now on
  client.publish(T.state, JSON.stringify(S), { retain: true, qos: 1 });
  refreshUI();
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODE
// ═══════════════════════════════════════════════════════════════════════════════
function setMode(mode) {
  if (S.mode === mode) return;
  if (S.playing) { S.playing = false; S.stopAt = localNow() + LEAD_CHANGE; }
  S.mode = mode;
  if (mode === 'score') rebalance(false);
  publishState();
}

// ═══════════════════════════════════════════════════════════════════════════════
// FREE MODE
// ═══════════════════════════════════════════════════════════════════════════════
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
  } else if (S.mode === 'score') {
    startScore();
  } else {
    launch();
  }
}

function resync() { if (S.playing && S.mode === 'free') launch(); }

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

function togglePhasing() { if (S.playing && S.mode === 'free') changeDrift(() => { S.paused = !S.paused; }); }

let ratioTimer = null, ratioPending = null;
function updateRatio() {
  const v = +document.getElementById('ratioCtrl').value;
  document.getElementById('ratioVal').textContent = v.toFixed(4);
  ratioPending = v;
  if (ratioTimer) return; // throttle: at most one message every 150 ms
  const flush = () => {
    if (ratioPending === null) { ratioTimer = null; return; }
    const r = ratioPending; ratioPending = null;
    if (S.mode === 'score') addOverride(r - 1);
    else changeDrift(() => { S.ratio = r; });
    ratioTimer = setTimeout(flush, 150);
  };
  flush();
}

function selectSound(n) {
  S.sound = n;
  if (S.playing) launch(); else publishState();
}

function autoAssign() {
  if (S.mode === 'score') return rebalance(true);
  const ids = [...roster.entries()].sort((a, b) => a[1].first - b[1].first).map(e => e[0]);
  const map = {};
  ids.forEach((id, i) => { map[id] = i + 1; });
  client.publish(T.assign, JSON.stringify({ map }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCORE MODE
// ═══════════════════════════════════════════════════════════════════════════════
const scoreNow = () => (localNow() - S.T0) / 1000;

function selectScore(i) {
  i = +i;
  const oldGroups = comp.groups.join();
  S.scoreIdx = i;
  S.score = SCORES[i];
  comp = compileScore(S.score, SOUNDS.length);
  if (S.playing) { S.playing = false; S.stopAt = localNow() + LEAD_CHANGE; }
  if (comp.groups.join() !== oldGroups) rebalance(false);
  publishState();
}

function startScore() {
  const from = parseTime(document.getElementById('fromCtrl').value || '0') || 0;
  S.epoch = randomId();
  S.playing = true;
  S.overrides = [];
  S.T0 = localNow() + LEAD_START - from * 1000;
  publishState();
}

// Live drift override on top of the score (d = ratio − 1, null = follow score)
function addOverride(d) {
  if (!S.playing || S.mode !== 'score') return;
  const t = Math.max(0, scoreNow() + LEAD_CHANGE / 1000);
  const list = S.overrides.filter(o => o.t < t);
  const last = list[list.length - 1];
  if (d === null && (!last || last.d === null)) return;
  list.push({ t, d });
  S.overrides = list;
  publishState();
}

function followScore() { addOverride(null); }

const overriding = () => {
  const last = S.overrides[S.overrides.length - 1];
  return !!(last && last.d !== null);
};

// Deal every phone present into groups, in join order: A, B, C, D, A, B, …
function rebalance(publish) {
  const ids = [...roster.entries()].sort((a, b) => a[1].first - b[1].first).map(e => e[0]);
  S.assign = {};
  ids.forEach((id, i) => { S.assign[id] = slotToAssign(i, comp.groups); });
  S.nextSlot = ids.length;
  if (publish) publishState();
}

// New phones get the next slot; phones that reload keep theirs
let assignTimer = null;
function ensureAssigned() {
  let changed = false;
  const ids = [...roster.entries()].sort((a, b) => a[1].first - b[1].first).map(e => e[0]);
  for (const id of ids) {
    if (S.assign[id]) continue;
    S.assign[id] = slotToAssign(S.nextSlot++, comp.groups);
    changed = true;
  }
  if (changed && !assignTimer) assignTimer = setTimeout(() => { assignTimer = null; publishState(); }, 300);
}

// ── Durations (for drawing the ring) ──────────────────────────────────────────
async function loadDurations() {
  const ctx = new OfflineAudioContext(1, 1, 44100);
  await Promise.all(SOUNDS.map(async (url, i) => {
    try {
      const buf = await (await fetch(url)).arrayBuffer();
      durations[i + 1] = (await ctx.decodeAudioData(buf)).duration;
    } catch (e) { /* ring just won't show for that sound */ }
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI
// ═══════════════════════════════════════════════════════════════════════════════
function setNet(txt, ok) {
  const el = document.getElementById('netTxt');
  el.textContent = txt;
  el.classList.toggle('ok', ok);
}

function refreshUI() {
  const score = S.mode === 'score';
  document.body.classList.toggle('score-mode', score);
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === S.mode));

  const play = document.getElementById('btnPlay');
  play.textContent = S.playing ? '■   Stop' : score ? '▶   Start score' : '▶   Start';
  play.classList.toggle('on', S.playing);
  const ph = document.getElementById('btnPhase');
  ph.disabled = !S.playing;
  ph.textContent = S.paused ? '▶   Resume phasing' : '⏸   Pause phasing';
  ph.classList.toggle('paused', S.paused);
  document.getElementById('btnSync').disabled = !S.playing;
  document.querySelectorAll('.sound-btn').forEach(b =>
    b.classList.toggle('active', +b.dataset.sound === S.sound));

  document.getElementById('scoreSel').value = S.scoreIdx;
  document.getElementById('scoreErr').textContent = comp.errors.join(' · ');
  document.getElementById('assignBtn').innerHTML = score ? '⇢ &nbsp;Re-deal groups' : '⇢ &nbsp;Number voices 1…N';
  document.getElementById('driftTitle').textContent = score ? 'Live drift override' : 'Drift — Voice 2 speed';
  document.getElementById('driftHint').innerHTML = score
    ? 'Moving the slider overrides every group’s scored drift. “Follow score” hands control back.'
    : 'Voice k runs at 1&nbsp;+&nbsp;(k−1)·(ratio−1). Start lands 1.5&nbsp;s after you press; other changes 0.4&nbsp;s after.';
  document.getElementById('btnFollow').disabled = !overriding();

  const ratioCtrl = document.getElementById('ratioCtrl');
  if (document.activeElement !== ratioCtrl && ratioPending === null) {
    const r = score ? (overriding() ? 1 + S.overrides[S.overrides.length - 1].d : 1) : S.ratio;
    ratioCtrl.value = r;
    document.getElementById('ratioVal').textContent = score && !overriding() ? 'score' : (+r).toFixed(4);
  }
  renderStatus();
}

function renderStatus() {
  let txt;
  if (!S.playing) txt = 'STOPPED';
  else if (S.mode === 'score') {
    const st = scoreNow();
    txt = st < 0 ? `COUNT-IN ${Math.ceil(-st)}` : st > comp.end ? 'END'
        : `${fmtTime(st)} / ${fmtTime(comp.end)}${overriding() ? ' · OVERRIDE' : ''}`;
  } else txt = S.paused ? 'PHASE FROZEN' : 'RUNNING';
  document.getElementById('statusTxt').textContent = txt;
}

function renderRoster() {
  const now = localNow();
  for (const [id, p] of roster) if (now - p.last > 12000) roster.delete(id);
  const score = S.mode === 'score';

  const label = (id, p) => {
    if (!score) return { txt: p.voice, color: voiceColor(p.voice), sort: p.voice * 1000 };
    const a = S.assign[id];
    if (!a) return { txt: '…', color: themeColor('--mid'), sort: 1e9 };
    return { txt: a[0] + a[1], color: groupColor(a[0], comp.groups), sort: comp.groups.indexOf(a[0]) * 1000 + a[1] };
  };
  const rows = [...roster.entries()].map(([id, p]) => ({ id, p, l: label(id, p) }))
    .sort((a, b) => a.l.sort - b.l.sort || a.p.first - b.p.first);
  const labels = rows.map(r => r.l.txt);
  const dupes = new Set(labels.filter((v, i) => labels.indexOf(v) !== i));

  document.getElementById('countTxt').textContent = rows.length;
  document.getElementById('groupCounts').textContent = score
    ? comp.groups.map(g => `${g} ${rows.filter(r => S.assign[r.id] && S.assign[r.id][0] === g).length}`).join(' · ')
    : '';
  document.getElementById('rosterBody').innerHTML = rows.length ? rows.map(({ id, p, l }) => `
    <tr class="${dupes.has(l.txt) ? 'dupe' : ''}">
      <td><span class="swatch" style="background:${l.color}"></span>${l.txt}</td>
      <td>${id.slice(0, 4)}</td>
      <td>${p.rtt == null ? '—' : Math.round(p.rtt)}</td>
      <td>${p.jitter == null ? '—' : '±' + p.jitter.toFixed(1)}</td>
      <td>${p.lat == null ? '—' : Math.round(p.lat)}</td>
      <td>${p.ready ? 'ready' : 'loading'}</td>
    </tr>`).join('')
    : '<tr><td colspan="6" class="empty">Waiting for phones… scan the code to join.</td></tr>';
}

// ── Timeline (score mode) ─────────────────────────────────────────────────────
const soundHue = n => [0, 95, 20, 200, 285, 335][n] ?? 45;

function drawTimeline() {
  const canvas = document.getElementById('timeline');
  const dpr = window.devicePixelRatio || 1;
  const r0 = canvas.getBoundingClientRect();
  if (!r0.width) return;
  const W = Math.round(r0.width * dpr), H = Math.round(r0.height * dpr);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const c = canvas.getContext('2d');
  c.clearRect(0, 0, W, H);

  const G = comp.groups.length, left = 28 * dpr, top = 16 * dpr;
  const laneH = (H - top) / G;
  const end = Math.max(comp.end, 1);
  const x = t => left + (W - left - 6 * dpr) * (t / end);
  c.font = `${10 * dpr}px 'Space Mono', monospace`;
  c.textBaseline = 'middle';

  // Minute grid
  c.strokeStyle = themeColor('--dim'); c.fillStyle = themeColor('--mid'); c.lineWidth = 1;
  const step = end > 600 ? 120 : end > 180 ? 60 : end > 60 ? 15 : 5;
  for (let t = 0; t <= end; t += step) {
    c.beginPath(); c.moveTo(x(t), top); c.lineTo(x(t), H); c.stroke();
    c.fillText(fmtTime(t), x(t) + 3 * dpr, 7 * dpr);
  }

  comp.groups.forEach((g, gi) => {
    const y0 = top + gi * laneH, y1 = y0 + laneH;
    c.fillStyle = groupColor(g, comp.groups);
    c.fillText(g, 8 * dpr, (y0 + y1) / 2);
    c.strokeStyle = themeColor('--dim');
    c.beginPath(); c.moveTo(left, y1); c.lineTo(W, y1); c.stroke();

    for (const L of comp.layers.filter(L => L.group === g)) {
      const tEnd = isFinite(L.stop) ? L.stop : end;
      const hue = soundHue(L.sound);
      // Gain envelope as a filled shape
      c.fillStyle = `hsl(${hue} 65% 50% / 0.35)`;
      c.strokeStyle = `hsl(${hue} 65% 45%)`;
      c.beginPath();
      c.moveTo(x(L.start), y1 - 2 * dpr);
      const N = 120;
      for (let i = 0; i <= N; i++) {
        const t = L.start + (tEnd - L.start) * i / N;
        c.lineTo(x(t), y1 - 2 * dpr - (laneH - 8 * dpr) * valueAt(L.gain, t));
      }
      c.lineTo(x(tEnd), y1 - 2 * dpr);
      c.closePath(); c.fill(); c.stroke();
      // Drift curve (dashed), scaled to the largest drift in the score
      const maxD = Math.max(1e-6, ...comp.layers.flatMap(l => effectiveDrift(l, S.overrides).map(p => p.v)));
      const drift = effectiveDrift(L, S.overrides);
      c.setLineDash([3 * dpr, 3 * dpr]);
      c.strokeStyle = themeColor('--fg'); c.lineWidth = 1 * dpr;
      c.beginPath();
      for (let i = 0; i <= N; i++) {
        const t = L.start + (tEnd - L.start) * i / N;
        const yy = y1 - 2 * dpr - (laneH - 8 * dpr) * Math.max(0, valueAt(drift, t)) / maxD;
        i ? c.lineTo(x(t), yy) : c.moveTo(x(t), yy);
      }
      c.stroke(); c.setLineDash([]); c.lineWidth = 1;
      // Label: sound and starting ratio
      c.fillStyle = themeColor('--fg');
      c.fillText(`${L.sound} · ${(1 + L.drift[0].v).toFixed(3)}`, x(L.start) + 4 * dpr, y0 + 10 * dpr);
    }
  });

  // Overrides: band along the top
  S.overrides.forEach((o, i) => {
    if (o.d === null) return;
    const b = i + 1 < S.overrides.length ? S.overrides[i + 1].t : (S.playing ? Math.min(scoreNow(), end) : o.t);
    c.fillStyle = themeColor('--c2');
    c.fillRect(x(o.t), top - 4 * dpr, Math.max(2, x(b) - x(o.t)), 3 * dpr);
  });

  // Playhead, or the "start from" marker when stopped
  const from = parseTime(document.getElementById('fromCtrl').value || '0') || 0;
  const tHead = S.playing && S.mode === 'score' ? scoreNow() : from;
  if (tHead >= 0 && tHead <= end) {
    c.strokeStyle = themeColor('--cp'); c.lineWidth = 2 * dpr;
    c.beginPath(); c.moveTo(x(tHead), top - 6 * dpr); c.lineTo(x(tHead), H); c.stroke();
  }
  canvas._x2t = px => (px * dpr - left) / (W - left - 6 * dpr) * end;
}

function timelineClick(ev) {
  if (S.playing) return;
  const canvas = document.getElementById('timeline');
  const r = canvas.getBoundingClientRect();
  const t = Math.max(0, Math.min(comp.end, Math.round(canvas._x2t(ev.clientX - r.left))));
  document.getElementById('fromCtrl').value = fmtTime(t);
}

// ── Ring (free mode) ──────────────────────────────────────────────────────────
function renderLoop() {
  if (S.mode === 'score') {
    drawTimeline();
    renderStatus();
  } else {
    const canvas = document.getElementById('ring');
    const now = localNow(), dur = durations[S.sound];
    let hands = [];
    if (S.playing && dur && now >= S.T0) {
      const vs = [...new Set([1, ...[...roster.values()].map(p => p.voice)])].sort((a, b) => a - b);
      hands = vs.map(k => ({ pos: voicePos(S, k, now, dur) / dur, color: voiceColor(k), width: k === 1 ? 3 : 2 }));
    }
    drawRing(canvas, hands);
  }
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

document.getElementById('scoreSel').innerHTML =
  SCORES.map((s, i) => `<option value="${i}">${s.title || 'Score ' + (i + 1)}</option>`).join('');
document.getElementById('timeline').addEventListener('click', timelineClick);

document.getElementById('themeBtn').textContent =
  document.documentElement.dataset.theme === 'dark' ? '◐   Light' : '◐   Dark';
refreshUI();
renderRoster();
setInterval(renderRoster, 1000);
loadDurations();
requestAnimationFrame(renderLoop);
