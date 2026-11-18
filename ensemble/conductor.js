// ═══════════════════════════════════════════════════════════════════════════════
// CONDUCTOR — owns the shared clock and the state of the piece.
// Two modes:
//   Free   one sound, live controls (the original ensemble)
//   Score  a timed piece, played by groups of phones: one of scores.js, or a
//          piece loaded from a link (a student's GitHub repo; see pieces.js)
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
  standby: false, // every phone shows a black screen (stays awake and connected)
  // free mode
  sound: LOOP_SOUNDS[0], T0: 0, tA: 0, phiA: 0, ratio: 1.002, paused: false,
  // score mode
  scoreIdx: 0, score: SCORES[0], overrides: [], assign: {}, nextSlot: 0,
  source: null, // folder of a piece loaded from a link (its sounds are there); null for scores.js
  link: null,   // the link it was loaded from
  muted: [], // groups silenced from the timeline (click a group's letter)
};
let adoptedRetained = false; // after a reload, pick up where the room was
let durations = {};          // sound URL → seconds (ring display, one-shots on the timeline)
const missing = new Set();   // sound URLs whose file couldn't be loaded
let comp = compileScore(S.score);

// Where the score's sounds are: the built-in folder, or the linked piece's own
const scoreURL = n => soundURL(n, S.score, S.source);

const roster = new Map();    // id → { voice, assign, rtt, jitter, lat, ready, first, last, gone }

// A phone that stops reporting (screen locked, app switched, tab closed) is
// kept in the roster as "asleep" so you can see which one to go and wake;
// it's dropped only after a long silence.
const ASLEEP_MS = 8000, FORGET_MS = 30 * 60 * 1000;
const awake = p => !p.gone && localNow() - p.last < ASLEEP_MS;
const awakeIds = () => [...roster.entries()].filter(([, p]) => awake(p))
  .sort((a, b) => a[1].first - b[1].first).map(e => e[0]);

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
    const prev = roster.get(m.id);
    if (m.gone) { if (prev) prev.gone = true; return; } // broker's last will: connection lost
    roster.set(m.id, { ...m, gone: false, first: prev ? prev.first : localNow(), last: localNow(),
                       // the voice to hand back if this phone reloads: its latest real one
                       given: m.fresh ? prev && prev.given : m.voice });
    if (!prev && S.mode === 'score') ensureAssigned();
    if (S.mode !== 'score' && m.fresh) giveVoice(m.id);
    return;
  }
  if (topic === T.state && !adoptedRetained) {
    adoptedRetained = true;
    if (m.v === 1 && m.epoch) {
      S = { ...S, ...m, mode: m.mode || 'free' };
      comp = compileScore(S.score);
      loadDurations(comp.sounds.map(scoreURL));
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
  S.sound = soundId(n);
  if (S.playing) launch(); else publishState();
}

// Free mode: a phone that just joined gets the lowest voice no other phone has
// (it keeps asking until it hears back, and always gets the same answer)
function giveVoice(id) {
  const p = roster.get(id);
  if (!p.given) {
    const used = new Set([...roster.entries()]
      .filter(([k, q]) => k !== id && awake(q) && (!q.fresh || q.given)).map(([, q]) => q.voice));
    let v = 1;
    while (used.has(v)) v++;
    p.given = v;
  }
  p.voice = p.given;
  client.publish(T.assign, JSON.stringify({ map: { [id]: p.given } }));
}

function autoAssign() {
  if (S.mode === 'score') return rebalance(true);
  const ids = awakeIds();
  const map = {};
  ids.forEach((id, i) => { map[id] = i + 1; });
  client.publish(T.assign, JSON.stringify({ map }));
}

// ── Level calibration ─────────────────────────────────────────────────────────
// Every phone plays its test sound in turn, CALIB_GAP apart, in roster order,
// so the room can hear each one alone and set its volume. One message carries
// the start time and the order; each phone schedules its own turn on the
// shared clock, so the gaps stay even whatever the network does.
let calib = null; // { t0, gap, order: [id…] }

function calibrate() {
  const order = rosterRows().filter(r => awake(r.p)).map(r => r.id);
  if (!order.length) return;
  calib = { t0: localNow() + LEAD_START, gap: CALIB_GAP, order };
  client.publish(T.calib, JSON.stringify(calib));
}

// ── Standby ───────────────────────────────────────────────────────────────────
// Black out every phone between pieces. Carried in the retained state, so
// phones that join or reload while it's on go straight to black.
function toggleStandby() {
  S.standby = !S.standby;
  publishState();
}

// Highlight the phone whose turn it is, and show progress on the button
function renderCalib() {
  const btn = document.getElementById('calibBtn');
  const i = calib ? Math.floor((localNow() - calib.t0) / calib.gap) : -1;
  const active = calib && i < calib.order.length && localNow() < calib.t0 + calib.order.length * calib.gap;
  const id = active && i >= 0 ? calib.order[i] : null;
  document.querySelectorAll('#rosterBody tr[data-id]').forEach(tr =>
    tr.classList.toggle('pinged', tr.dataset.id === id));
  const txt = !active ? '♪   Calibrate levels'
    : i < 0 ? '♪   Calibrating…' : `♪   Calibrating ${i + 1} / ${calib.order.length}`;
  if (btn.textContent !== txt) btn.textContent = txt;
  if (!active) calib = null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCORE MODE
// ═══════════════════════════════════════════════════════════════════════════════
const scoreNow = () => (localNow() - S.T0) / 1000;

function selectScore(i) {
  if (i === 'link') return; // the piece already loaded from a link
  setScore(SCORES[+i], +i, null, null);
}

// Make `score` the piece: one of scores.js (idx), or one loaded from `link`,
// whose sounds are in the folder `source`
function setScore(score, idx, source, link) {
  S.scoreIdx = idx;
  S.score = score;
  S.source = source;
  S.link = link;
  S.muted = [];
  document.getElementById('fromCtrl').value = '0:00'; // a new piece starts from the top
  comp = compileScore(S.score);
  loadDurations(comp.sounds.map(scoreURL));
  if (S.playing) { S.playing = false; S.stopAt = localNow() + LEAD_CHANGE; }
  rebalance(false); // re-deal every phone into this score's groups
  publishState();
}

// Load a piece from a link (a student's GitHub repo, usually): its score.json
// goes to every phone, and each phone fetches its sounds from that folder.
let linkBusy = false;
async function loadLink() {
  const input = document.getElementById('linkCtrl'), status = document.getElementById('linkStatus');
  if (linkBusy) return;
  linkBusy = true;
  status.textContent = 'Loading…';
  status.classList.remove('bad');
  try {
    const link = input.value.trim();
    const { base, score } = await loadPiece(link);
    setScore(score, -1, base, link);
    status.textContent = `Loaded “${comp.title}” from ${base}`;
  } catch (e) {
    status.textContent = e.message;
    status.classList.add('bad');
  } finally { linkBusy = false; }
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
  const ids = awakeIds();
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

// ── Durations (for drawing the ring; also finds sounds whose file is missing) ─
const durCtx = new OfflineAudioContext(1, 1, 44100);
async function loadDurations(urls) {
  urls = urls.filter(u => !(u in durations) && !missing.has(u));
  await Promise.all(urls.map(async u => {
    durations[u] = null; // loading
    try {
      const r = await fetch(u);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      durations[u] = (await durCtx.decodeAudioData(await r.arrayBuffer())).duration;
    } catch (e) { delete durations[u]; missing.add(u); }
  }));
  if (urls.length) refreshUI();
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
  const sb = document.getElementById('standbyBtn');
  sb.textContent = S.standby ? '◼   Standby: on' : '◻   Standby: off';
  sb.classList.toggle('on', !!S.standby);
  document.querySelectorAll('.sound-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.sound === soundId(S.sound)));

  renderScoreMenu();
  document.getElementById('editLink').href = 'editor.html?' +
    (S.source ? 'link=' + encodeURIComponent(S.link || S.source) : 'score=' + S.scoreIdx);
  document.getElementById('scoreCredit').textContent = (S.score && S.score.credit) || '';
  document.getElementById('scoreErr').textContent = [...comp.errors,
    ...comp.sounds.filter(n => missing.has(scoreURL(n))).map(n => `sound "${n}" not found (${scoreURL(n)})`)].join(' · ');
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

// The scores of scores.js, plus the piece loaded from a link (if that's the one)
function renderScoreMenu() {
  const sel = document.getElementById('scoreSel');
  const opts = SCORES.map((s, i) => [String(i), s.title || 'Score ' + (i + 1)]);
  if (S.source) opts.push(['link', `Linked: ${comp.title}`]);
  const html = opts.map(([v, t]) => `<option value="${v}">${escapeHTML(t)}</option>`).join('');
  if (sel.dataset.html !== html) sel.innerHTML = sel.dataset.html = html;
  sel.value = S.source ? 'link' : String(S.scoreIdx);
}

const escapeHTML = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

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

// Roster rows in display order: by voice (free) or group + phone (score)
function rosterRows() {
  const score = S.mode === 'score';
  const label = (id, p) => {
    if (!score) return { txt: p.voice, color: voiceColor(p.voice), sort: p.voice * 1000 };
    const a = S.assign[id];
    if (!a) return { txt: '…', color: themeColor('--mid'), sort: 1e9 };
    return { txt: a[0] + a[1], color: groupColor(a[0], comp.groups), sort: comp.groups.indexOf(a[0]) * 1000 + a[1] };
  };
  return [...roster.entries()].map(([id, p]) => ({ id, p, l: label(id, p) }))
    .sort((a, b) => a.l.sort - b.l.sort || a.p.first - b.p.first);
}

function renderRoster() {
  const now = localNow();
  for (const [id, p] of roster) if (now - p.last > FORGET_MS) roster.delete(id);
  const score = S.mode === 'score';
  const rows = rosterRows();
  const up = rows.filter(r => awake(r.p)), asleep = rows.length - up.length;
  const labels = rows.map(r => r.l.txt);
  const dupes = new Set(labels.filter((v, i) => labels.indexOf(v) !== i));

  document.getElementById('countTxt').textContent = up.length + (asleep ? ` · ${asleep} asleep` : '');
  document.getElementById('qrBigCount').textContent = `${up.length} ${up.length === 1 ? 'phone' : 'phones'} joined`;
  document.getElementById('groupCounts').textContent = score
    ? comp.groups.map(g => `${g} ${up.filter(r => S.assign[r.id] && S.assign[r.id][0] === g).length}`).join(' · ')
    : '';
  document.getElementById('rosterBody').innerHTML = rows.length ? rows.map(({ id, p, l }) => `
    <tr class="${dupes.has(l.txt) ? 'dupe' : ''} ${awake(p) ? '' : 'asleep'}" data-id="${id}">
      <td><span class="swatch" style="background:${l.color}"></span>${l.txt}</td>
      <td>${id.slice(0, 4)}</td>
      <td>${p.rtt == null ? '—' : Math.round(p.rtt)}</td>
      <td>${p.jitter == null ? '—' : '±' + p.jitter.toFixed(1)}</td>
      <td>${p.lat == null ? '—' : Math.round(p.lat)}</td>
      <td>${!awake(p) ? `asleep ${fmtAgo(now - p.last)}` : p.ready ? 'ready' : 'loading'}</td>
    </tr>`).join('')
    : '<tr><td colspan="6" class="empty">Waiting for phones… scan the code to join.</td></tr>';
}

const fmtAgo = ms => ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60000)} min`;

// ── Timeline (score mode; drawn by timeline.js) ───────────────────────────────
function drawTimeline() {
  const from = parseTime(document.getElementById('fromCtrl').value || '0') || 0;
  const playing = S.playing && S.mode === 'score';
  drawScoreTimeline(document.getElementById('timeline'), comp, {
    overrides: S.overrides, now: playing ? scoreNow() : null, head: playing ? scoreNow() : from,
    muted: S.muted || [], duration: n => durations[scoreURL(n)] || null,
  });
}

// The column of group letters (CSS px), same layout as drawTimeline()
function groupAtLetter(ev) {
  const r = document.getElementById('timeline').getBoundingClientRect();
  const x = ev.clientX - r.left, y = ev.clientY - r.top - 16;
  if (x > 28 || y < 0) return null;
  return comp.groups[Math.floor(y / ((r.height - 16) / comp.groups.length))] || null;
}

// Click a group's letter to mute / unmute it (works while playing, too)
function toggleMute(g) {
  const m = new Set(S.muted || []);
  m.has(g) ? m.delete(g) : m.add(g);
  S.muted = [...m];
  publishState();
}

function timelineClick(ev) {
  const g = groupAtLetter(ev);
  if (g) return toggleMute(g);
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
    const now = localNow(), dur = durations[soundURL(S.sound)];
    let hands = [];
    if (S.playing && dur && now >= S.T0) {
      const vs = [...new Set([1, ...[...roster.values()].filter(awake).map(p => p.voice)])].sort((a, b) => a - b);
      hands = vs.map(k => ({ pos: voicePos(S, k, now, dur) / dur, color: voiceColor(k), width: k === 1 ? 3 : 2 }));
    }
    drawRing(canvas, hands);
  }
  renderCalib();
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
  const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  document.getElementById('qr').innerHTML = document.getElementById('qrBig').innerHTML = svg;
} catch (e) { /* QR library unavailable: the link is still there */ }

// Large QR code: a modal <dialog> gives us Esc to close and focus handling
const qrOverlay = document.getElementById('qrOverlay');
document.getElementById('qrBigLink').textContent = performerURL;
document.getElementById('qr').addEventListener('click', ev => {
  if (ev.currentTarget.firstChild) qrOverlay.showModal(); // nothing to enlarge without the library
});
qrOverlay.addEventListener('click', () => qrOverlay.close());

document.getElementById('linkCtrl').addEventListener('keydown', ev => { if (ev.key === 'Enter') loadLink(); });
document.getElementById('timeline').addEventListener('click', timelineClick);
document.getElementById('timeline').addEventListener('mousemove', ev => {
  ev.currentTarget.style.cursor = groupAtLetter(ev) ? 'pointer' : '';
});

// Free-mode sound buttons, from LOOP_SOUNDS (scores.js)
const soundBtns = document.getElementById('soundBtns');
for (const n of LOOP_SOUNDS.map(soundId)) {
  const b = document.createElement('button');
  b.className = 'sound-btn';
  b.dataset.sound = b.textContent = n;
  b.onclick = () => selectSound(n);
  soundBtns.appendChild(b);
}

document.getElementById('themeBtn').textContent =
  document.documentElement.dataset.theme === 'dark' ? '◐   Light' : '◐   Dark';
refreshUI();
renderRoster();
setInterval(renderRoster, 1000);
loadDurations([...LOOP_SOUNDS.map(n => soundURL(n)), ...comp.sounds.map(scoreURL)]);
requestAnimationFrame(renderLoop);
