// ═══════════════════════════════════════════════════════════════════════════════
// SIMULATOR PANEL — the window's own interface, around the conductor page.
// Everything goes through window.sim (preload.js). The main process sends a
// snapshot of the conductor, the backend and every client a few times a
// second; the panel builds its cards and speakers when the clients or the
// devices change, and otherwise only updates them in place (so a menu or a
// text field isn't rebuilt under you).
//
// Selection lives here; solo, mute and outputs live in the main process,
// which applies them to the clients (a solo only changes their level).
// ═══════════════════════════════════════════════════════════════════════════════

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
if (params.get('glass')) document.documentElement.classList.add('glass');
if (params.get('platform') === 'darwin') document.documentElement.classList.add('mac');
const MAC = params.get('platform') === 'darwin';

let snap = null;              // the latest snapshot
let devices = [];             // connected outputs: [{ label, channels }] (without the system default)
let defaultChannels = 2;      // the system default's channels
const selected = new Set();   // selected client numbers
let anchor = null;            // where a shift-click range starts

const isSolo = n => snap && snap.solo.includes(n);
const isMuted = n => snap && snap.mute.includes(n);
const audible = n => !isMuted(n) && (!snap.solo.length || isSolo(n));

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k === 'data') Object.assign(e.dataset, v);
    else e[k] = v;
  }
  e.append(...children.filter(c => c != null));
  return e;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SPEAKERS — output devices, and their channels
// ═══════════════════════════════════════════════════════════════════════════════
// Chromium lists the default device twice ('default', then its real entry), and
// on Windows a 'communications' one too; the real entries are enough.
// The channels are what Chromium will open the device with: on macOS that's
// its speaker setup in Audio MIDI Setup, which may be fewer than the hardware has.
const channelCache = new Map();
async function channelsOf(deviceId) {
  if (channelCache.has(deviceId)) return channelCache.get(deviceId);
  let ctx = null, n = 2;
  try {
    ctx = new AudioContext(deviceId ? { sinkId: deviceId } : {});
    n = ctx.destination.maxChannelCount || 2;
  } catch (e) { /* can't open it: assume stereo */ }
  finally { if (ctx) ctx.close().catch(() => {}); }
  channelCache.set(deviceId, n);
  return n;
}

async function loadDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  const outs = all.filter(d => d.kind === 'audiooutput' && d.label &&
    d.deviceId !== 'default' && d.deviceId !== 'communications');
  const next = [];
  for (const d of outs) next.push({ label: d.label, channels: await channelsOf(d.deviceId) });
  defaultChannels = await channelsOf('');
  devices = next;
  build();
}

// Shorter names for the menus: "MacBook Pro Speakers (Built-in)" → "MacBook Pro Speakers"
const shortName = label => label ? label.replace(/\s*\((Built-in|Virtual|Bluetooth)\)$/i, '') : 'System default';
const connected = label => !label || devices.some(d => d.label === label);
const channelsFor = label => (!label ? defaultChannels : (devices.find(d => d.label === label) || {}).channels || 2);
const roomName = label => (snap && snap.cfg.speakers[label] && snap.cfg.speakers[label].name) || '';

// The speakers to show: the default, every device, and any a client was given
// that isn't plugged in right now (so its clients are still listed somewhere)
function speakerList() {
  const given = snap ? snap.phones.map(p => p.output.device) : [];
  return [...new Set(['', ...devices.map(d => d.label), ...given])];
}

// ── Channels ──────────────────────────────────────────────────────────────────
// null = as is (the client's stereo, laid out by the device); [n] = channel n;
// [n, n + 1] = a stereo pair
const chKey = ch => (ch ? ch.join('-') : '');
function chName(ch, total) {
  if (!ch) return total > 2 ? 'ch 1–2' : 'stereo';
  if (ch.length === 2) return `ch ${ch[0]}–${ch[1]}`;
  if (total === 2) return ch[0] === 1 ? 'ch 1 · L' : 'ch 2 · R';
  return `ch ${ch[0]}`;
}
function channelChoices(total) {
  const list = [null];
  for (let c = 1; c <= total; c++) list.push([c]);
  if (total > 2) for (let c = 1; c < total; c += 2) list.push([c, c + 1]);
  return list;
}

const outValue = o => JSON.stringify({ device: o.device || '', channels: o.channels || null });

// The output menu of a card: one group per speaker, with its channels
function outputOptions() {
  return speakerList().map(label => {
    const total = channelsFor(label);
    const name = shortName(label) + (connected(label) ? '' : ' (not connected)');
    return el('optgroup', { label: `${name} · ${total} ch` },
      ...channelChoices(total).map(ch =>
        el('option', { value: outValue({ device: label, channels: ch }), textContent: `${shortName(label)} · ${chName(ch, total)}` })));
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SELECTION
// ═══════════════════════════════════════════════════════════════════════════════
const order = () => (snap ? snap.phones.map(p => p.n) : []);

function select(n, ev = {}) {
  const additive = MAC ? ev.metaKey : ev.ctrlKey;
  if (ev.shiftKey && anchor !== null) {
    const o = order(), a = o.indexOf(anchor), b = o.indexOf(n);
    if (!additive) selected.clear();
    o.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(k => selected.add(k));
  } else if (additive) {
    selected.has(n) ? selected.delete(n) : selected.add(n);
    anchor = n;
  } else {
    selected.clear(); selected.add(n); anchor = n;
  }
  update();
}

function selectOnly(ns, ev = {}) {
  if (!((MAC ? ev.metaKey : ev.ctrlKey))) selected.clear();
  ns.forEach(n => selected.add(n));
  anchor = ns[0] ?? null;
  update();
}

function clearSelection() { selected.clear(); anchor = null; update(); }

// Arrow keys move the selection through the grid
function moveSelection(key) {
  const o = order();
  if (!o.length) return;
  const cards = [...$('grid').children];
  const cols = Math.max(1, cards.filter(c => c.offsetTop === cards[0].offsetTop).length);
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[key];
  const from = anchor !== null && o.includes(anchor) ? o.indexOf(anchor) : -step;
  const to = Math.max(0, Math.min(o.length - 1, from + step));
  select(o[to]);
  const card = $('grid').querySelector(`[data-n="${o[to]}"]`);
  if (card) card.scrollIntoView({ block: 'nearest' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOLO AND MUTE (Ableton-style)
// ═══════════════════════════════════════════════════════════════════════════════
// The change shows at once; the next snapshot confirms it
function setSolo(ns) { snap.solo = ns; sim.solo(ns); update(); }
function setMute(ns, on) {
  snap.mute = on ? [...new Set([...snap.mute, ...ns])] : snap.mute.filter(n => !ns.includes(n));
  sim.mute(ns, on); update();
}

// S: solo the selection; again (same selection, or nothing selected) clears it
function soloKey() {
  const sel = [...selected];
  const same = sel.length === snap.solo.length && sel.every(isSolo);
  setSolo(!sel.length || same ? [] : sel);
}

// M: mute the selection, or unmute it if it's all muted already
function muteKey() {
  const sel = [...selected];
  if (sel.length) setMute(sel, !sel.every(isMuted));
}

// A card's S: solo this one alone (again: clear); with ⌘ / Ctrl, add it to the solo or take it out
function soloButton(n, ev) {
  if (MAC ? ev.metaKey : ev.ctrlKey) setSolo(isSolo(n) ? snap.solo.filter(k => k !== n) : [...snap.solo, n]);
  else setSolo(isSolo(n) && snap.solo.length === 1 ? [] : [n]);
}

const targets = () => (selected.size ? [...selected] : order()); // the selection, or everyone

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTING — the Route… menu
// ═══════════════════════════════════════════════════════════════════════════════
function routeActions() {
  const acts = [];
  const live = devices.map(d => d.label);
  if (live.length > 1) acts.push(['spread', 'Each to its own speaker', ns =>
    Object.fromEntries(ns.map((n, i) => [n, { device: live[i % live.length], channels: null }]))]);
  for (const d of devices) if (d.channels > 1) acts.push([`ch:${d.label}`, `Each to its own channel of ${shortName(d.label)}`, ns =>
    Object.fromEntries(ns.map((n, i) => [n, { device: d.label, channels: [(i % d.channels) + 1] }]))]);
  if (live.length > 1) acts.push(['groups', 'One group per speaker', ns => {
    const groups = (snap.conductor && snap.conductor.groups) || [];
    const map = {};
    for (const n of ns) {
      const p = snap.phones.find(q => q.n === n);
      if (p && p.group) map[n] = { device: live[groups.indexOf(p.group) % live.length], channels: null };
    }
    return map;
  }]);
  acts.push(['default', 'All to the system default', ns => Object.fromEntries(ns.map(n => [n, { device: '', channels: null }]))]);
  for (const label of live) acts.push([`all:${label}`, `All to ${shortName(label)}`, ns =>
    Object.fromEntries(ns.map(n => [n, { device: label, channels: null }]))]);
  return acts;
}

function buildRouteMenu() {
  const menu = $('routeMenu');
  const who = selected.size ? `${selected.size} selected` : 'all clients';
  menu.replaceChildren(el('option', { value: '', textContent: 'Route…' }),
    el('optgroup', { label: `Route ${who}` }, ...routeActions().map(([v, t]) => el('option', { value: v, textContent: t }))));
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUILD — cards and speakers, when the clients or the devices change
// ═══════════════════════════════════════════════════════════════════════════════
let builtCards = '', builtSpeakers = '';

function build() {
  if (!snap) return;
  const optsKey = JSON.stringify([speakerList(), devices, defaultChannels]);

  // ── Cards ───────────────────────────────────────────────────────────────────
  const cardsKey = JSON.stringify([order(), optsKey]);
  if (cardsKey !== builtCards) {
    builtCards = cardsKey;
    $('grid').replaceChildren(...snap.phones.map(p => card(p.n)));
  }

  // ── Speakers ────────────────────────────────────────────────────────────────
  const speakersKey = JSON.stringify([optsKey, snap.phones.map(p => [p.n, p.output])]);
  if (speakersKey !== builtSpeakers) {
    builtSpeakers = speakersKey;
    // Speakers in use get a tile; the others, one quiet row of names
    const used = speakerList().filter(l => clientsOn(l).length);
    const spare = speakerList().filter(l => !clientsOn(l).length);
    $('speakers').replaceChildren(...used.map(speakerTile));
    $('spare').replaceChildren(...(spare.length ? [el('span', { class: 'spare-label', textContent: 'Other outputs' }),
      ...spare.map(l => el('span', { class: 'pill' + (connected(l) ? '' : ' missing'), title: l || 'The system’s default output',
        textContent: `${shortName(l)} · ${channelsFor(l)} ch` }))] : []));
  }
  update();
}

function card(n) {
  const out = el('select', { class: 'out', title: 'Where this client plays',
    onchange: () => sim.setOutputs({ [n]: JSON.parse(out.value) }) }, ...outputOptions());
  const btn = (cls, text, title, onclick) => el('button', { class: 'sm-btn ' + cls, textContent: text, title, onclick });
  return el('div', { class: 'card', tabIndex: 0, data: { n }, onmousedown: ev => {
      if (ev.target.closest('button, select, input')) return;
      select(n, ev);
    } },
    el('div', { class: 'card-hd' },
      el('span', { class: 'num', textContent: String(n).padStart(2, '0') }),
      el('span', { class: 'group-badge', textContent: '·', title: 'Group and phone in the group (dealt by the conductor)' }),
      el('span', { class: 'grow' }),
      el('span', { class: 'state-tag' }),
      el('span', { class: 'conn', title: '' })),
    el('div', { class: 'card-body' },
      el('canvas', { class: 'ring', width: 128, height: 128 }),
      el('div', { class: 'readout' },
        el('div', { class: 'status' }),
        el('div', { class: 'now' }),
        el('div', { class: 'meter', title: 'Level: what it plays (grey), what you hear (bright)' }, el('i', { class: 'pre' }), el('i', { class: 'post' })),
        el('div', { class: 'sync' }))),
    el('div', { class: 'out-row' }, out),
    el('div', { class: 'card-ft' },
      btn('solo', 'S', 'Solo (⌘-click: add to the solo)', ev => soloButton(n, ev)),
      btn('mute', 'M', 'Mute', () => setMute([n], !isMuted(n))),
      btn('plain extra', '♪', 'Test tone on its speaker', () => sim.test(n)),
      el('span', { class: 'grow' }),
      btn('plain extra', '⧉', 'Show this client’s page', () => sim.show(n)),
      btn('plain extra', '↻', 'Reload and join again', () => sim.rejoin(n)),
      btn('plain extra', '×', 'Remove this client', () => { selected.delete(n); sim.remove([n]); })));
}

const SPEAKER_ICON = '<svg class="speaker-icon" viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.6 7.6 0 0 1 0 11"/></svg>';

function speakerTile(label) {
  const total = channelsFor(label);
  const place = el('input', { class: 'place', type: 'text', value: roomName(label), placeholder: 'Where is it? e.g. front left',
    onchange: () => sim.setSpeaker(label, { name: place.value }) });
  const tile = el('div', { class: 'speaker glass' + (connected(label) ? '' : ' missing'), data: { label },
    onclick: ev => {
      if (ev.target.closest('input, button')) return;
      const lane = ev.target.closest('.lane');
      const ns = lane ? JSON.parse(lane.dataset.ns) : clientsOn(label).map(p => p.n);
      if (ns.length) selectOnly(ns, ev);
    } },
    el('div', { class: 'speaker-hd' },
      el('span', { innerHTML: SPEAKER_ICON, style: 'display:contents' }),
      el('div', { class: 'speaker-title' },
        el('div', { class: 'speaker-name', textContent: shortName(label), title: label || 'The system’s default output' }),
        el('div', { class: 'speaker-meta' }, connected(label)
          ? `${total} channel${total === 1 ? '' : 's'}${label ? '' : ' · system default'}`
          : el('span', { class: 'bad', textContent: 'Not connected — its clients are silent' }))),
      el('button', { class: 'icon-btn', textContent: '♪', title: 'Identify: its clients’ test tones in turn',
        onclick: () => sim.identify(clientsOn(label).map(p => p.n)) })),
    place,
    el('div', { class: 'lanes' }));

  // One lane per channel layout in use, with its clients
  const lanes = new Map();
  for (const p of clientsOn(label)) {
    const k = chKey(p.output.channels);
    if (!lanes.has(k)) lanes.set(k, { ch: p.output.channels, ns: [] });
    lanes.get(k).ns.push(p.n);
  }
  const sorted = [...lanes.values()].sort((a, b) => (a.ch ? a.ch[0] : 0) - (b.ch ? b.ch[0] : 0));
  tile.querySelector('.lanes').append(...(sorted.length ? sorted.map(({ ch, ns }) =>
    el('div', { class: 'lane', data: { ns: JSON.stringify(ns) }, title: 'Click to select these clients' },
      el('span', { class: 'lane-name', textContent: chName(ch, total) }),
      el('span', { class: 'lane-clients' }, ...ns.map(n => el('span', { class: 'tag', data: { n } }, el('i'), String(n)))),
      el('span', { class: 'lane-meter' }, el('i'))))
    : [el('div', { class: 'lane-empty', textContent: 'No clients' })]));
  return tile;
}

const clientsOn = label => (snap ? snap.phones.filter(p => (p.output.device || '') === label) : []);

// ═══════════════════════════════════════════════════════════════════════════════
// UPDATE — every snapshot
// ═══════════════════════════════════════════════════════════════════════════════
function themeColor(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

// The client's playhead, as on its own screen (net.js drawRing): its hand, and phone 1's
let colors = {}; // theme colours for the rings, read once per update
function drawRing(canvas, hands) {
  const c = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  const cx = w / 2, cy = h / 2, R = w / 2 - 12;
  c.clearRect(0, 0, w, h);
  c.strokeStyle = colors.track;
  c.lineWidth = 3;
  c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
  for (const { pos, width = 2 } of [...hands].reverse()) {
    const a = -Math.PI / 2 + pos * Math.PI * 2, x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
    c.strokeStyle = c.fillStyle = width >= 4 ? colors.fg : colors.faint;
    c.lineWidth = width * 1.3;
    c.lineCap = 'round';
    c.beginPath(); c.moveTo(cx, cy); c.lineTo(x, y); c.stroke();
    c.beginPath(); c.arc(x, y, width * 2.2, 0, Math.PI * 2); c.fill();
  }
  c.fillStyle = colors.fg;
  c.beginPath(); c.arc(cx, cy, 4, 0, Math.PI * 2); c.fill();
}

// The pages' status lines are in capitals ("READY — WAITING FOR START"): "Ready — waiting for start"
const sentence = t => (t ? t.charAt(0) + t.slice(1).toLowerCase() : '');

const pct = v => Math.min(100, Math.sqrt(v || 0) * 110) + '%'; // a rough loudness curve

function connState(p) {
  if (p.error && !p.joined) return ['off', p.error];
  if (!p.joined) return ['wait', 'Joining…'];
  if (!p.connected) return ['off', 'Not connected to the backend'];
  if (!p.synced) return ['wait', 'Syncing its clock'];
  return ['ok', 'Connected and in sync'];
}

function update() {
  if (!snap) return;
  const C = snap.conductor;
  colors = { fg: themeColor('--fg'), faint: themeColor('--faint'), track: themeColor('--fill-hover') };

  // ── Toolbar ─────────────────────────────────────────────────────────────────
  $('room').textContent = snap.room;
  const play = $('play');
  play.classList.toggle('on', !!(C && C.playing));
  play.setAttribute('aria-label', C && C.playing ? 'Pause' : 'Play');
  play.disabled = $('stop').disabled = !C;
  const paused = C && !C.playing && C.from > 0;
  // The conductor's status, unless it's the time (already shown above)
  $('cstatus').textContent = !C ? '—' : paused ? 'Paused' : C.playing && /^\d/.test(C.status) ? 'Playing' : sentence(C.status);
  $('piece').textContent = C ? C.title : 'loading…';
  $('end').textContent = C ? ' / ' + fmt(C.end, false) : '';
  if (C) clock = { t: C.playing ? C.time : C.from, at: performance.now(), playing: C.playing, end: C.end };

  const B = snap.backend, online = !!(C && C.online);
  $('backendDot').className = 'dot ' + (!B.running ? 'off' : online ? 'ok' : 'wait');
  $('backendTxt').textContent = B.mode === 'local'
    ? (B.running ? `Local backend · ${B.performers} + ${B.conductors} connected` : 'Local backend · stopped')
    : `Site broker · ${online ? 'online' : (C ? C.net.toLowerCase() : 'connecting')}`;
  $('backend').title = B.mode === 'local' ? `MQTT broker on this computer: ${B.url || ''}` : `Broker: ${B.url}`;

  // ── Bar ─────────────────────────────────────────────────────────────────────
  const count = $('count');
  if (document.activeElement !== count) count.value = snap.phones.length;
  count.max = snap.maxClients;
  const joined = snap.phones.filter(p => p.joined && p.synced).length;
  $('joinedTxt').textContent = joined < snap.phones.length ? `${joined} of ${snap.phones.length} in sync…` : '';
  for (const n of [...selected]) if (!order().includes(n)) selected.delete(n);
  $('selTxt').textContent = selected.size ? `${selected.size} selected` : 'None selected';
  $('soloBtn').classList.toggle('on', snap.solo.length > 0);
  $('soloBtn').title = snap.solo.length ? `Soloed: ${[...snap.solo].sort((a, b) => a - b).join(', ')} · S again clears` : 'Solo the selected clients (S)';
  $('clearBtn').disabled = !snap.solo.length && !snap.mute.length;
  $('empty').hidden = snap.phones.length > 0;
  $('grid').classList.toggle('compact', snap.phones.length > 12);
  $('perf').textContent = C ? `the conductor sees ${C.roster} client${C.roster === 1 ? '' : 's'}` : '';

  // ── Cards ───────────────────────────────────────────────────────────────────
  const cards = $('grid').children;
  snap.phones.forEach((p, i) => {
    const cardEl = cards[i];
    if (!cardEl || +cardEl.dataset.n !== p.n) return;
    const solo = isSolo(p.n), mute = isMuted(p.n), hear = audible(p.n);
    cardEl.classList.toggle('selected', selected.has(p.n));
    cardEl.classList.toggle('soloed', solo);
    cardEl.classList.toggle('silent', !hear);
    cardEl.classList.toggle('flash', !!p.flash);
    cardEl.classList.toggle('lost', !p.joined || !p.connected);

    const [hd, body, outRow, ft] = cardEl.children;
    const badge = hd.children[1];
    badge.textContent = p.label || '·';
    badge.style.setProperty('--g', p.color || '');
    const tag = hd.children[3];
    const tagText = mute ? 'Muted' : solo ? 'Solo' : !hear ? 'Out' : p.groupMuted ? 'Group off' : '';
    tag.textContent = tagText;
    tag.className = 'state-tag ' + (mute ? 'mute' : solo ? 'solo' : tagText ? 'quiet' : '');
    tag.title = mute ? 'Muted here (still playing)' : !hear ? 'Not heard: other clients are soloed (still playing)'
      : p.groupMuted ? 'Its group is muted on the conductor’s timeline' : '';
    const [cs, ctitle] = connState(p);
    hd.children[4].className = 'conn ' + cs;
    hd.children[4].title = ctitle;

    const [ring, readout] = body.children;
    drawRing(ring, p.hands || []);
    const [status, now, meter, sync] = readout.children;
    status.textContent = p.error || (p.joined ? sentence(p.status) : 'Joining…');
    status.title = status.textContent;
    status.classList.toggle('bad', !!p.error);
    now.textContent = p.now || '';
    now.title = now.textContent;
    const lv = p.levels || {};
    meter.children[0].style.width = pct(lv.pre);
    meter.children[1].style.width = pct(lv.post);
    sync.textContent = p.synced && p.jitter != null ? `sync ±${p.jitter.toFixed(1)} ms · rtt ${Math.round(p.rtt)} ms` : '';

    const out = outRow.firstChild, v = outValue(p.output);
    if (document.activeElement !== out && out.value !== v) {
      out.value = v;
      if (out.value !== v) { // a channel this speaker doesn't have (any more)
        out.append(el('option', { value: v, textContent: `${shortName(p.output.device)} · ${chName(p.output.channels, 0)} (unavailable)` }));
        out.value = v;
      }
    }
    out.classList.toggle('bad', !!p.error && p.joined);
    out.title = p.error ? p.error
      : p.playingTo ? `Plays to ${p.playingTo}${p.output.channels ? ', ' + chName(p.output.channels, p.deviceChannels) : ''}` : 'Where this client plays';

    ft.children[0].classList.toggle('on', solo);
    ft.children[1].classList.toggle('on', mute);
  });

  // ── Speakers: lit while what you hear of their clients is sounding ──────────
  const byN = new Map(snap.phones.map(p => [p.n, p]));
  for (const tile of $('speakers').children) {
    let live = false;
    for (const lane of tile.querySelectorAll('.lane')) {
      const ns = JSON.parse(lane.dataset.ns);
      const level = Math.max(0, ...ns.map(n => ((byN.get(n) || {}).levels || {}).post || 0));
      lane.querySelector('.lane-meter > i').style.width = pct(level);
      live = live || level > 0.01;
    }
    tile.classList.toggle('live', live);
    for (const t of tile.querySelectorAll('.tag')) {
      const p = byN.get(+t.dataset.n);
      if (!p) continue;
      t.firstChild.style.background = p.color || '';
      t.classList.toggle('quiet', !audible(p.n));
      t.classList.toggle('flash', !!p.flash);
      t.classList.toggle('sel', selected.has(p.n));
      t.title = `Client ${p.n}${p.label && p.label !== '·' ? ' · ' + p.label : ''}${audible(p.n) ? '' : ' (not heard)'}`;
    }
  }
}

// ── Clock: smooth between snapshots ───────────────────────────────────────────
let clock = null;
function fmt(t, tenths = true) {
  if (t == null || !isFinite(t)) return '0:00';
  const sign = t < 0 ? '−' : '';
  t = Math.abs(t);
  const m = Math.floor(t / 60), s = t % 60;
  return sign + m + ':' + (tenths ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0'));
}
function tick() {
  if (clock) {
    let t = clock.t;
    if (clock.playing) t = Math.min(clock.end, t + (performance.now() - clock.at) / 1000);
    $('time').textContent = fmt(t);
  }
  requestAnimationFrame(tick);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONDUCTOR COLUMN — the conductor page is a view of its own, placed over the
// slot this layout keeps for it
// ═══════════════════════════════════════════════════════════════════════════════
let conductorShown = true, sheetOpen = false;
function placeConductor() {
  const r = $('conductorSlot').getBoundingClientRect();
  sim.conductorSlot(conductorShown && !sheetOpen ? { x: r.left, y: r.top, width: r.width, height: r.height } : null);
}
new ResizeObserver(placeConductor).observe($('conductorSlot'));
new ResizeObserver(placeConductor).observe(document.body);

function showConductor(on) {
  conductorShown = on;
  document.body.classList.toggle('no-conductor', !on);
  $('toggleConductor').setAttribute('aria-pressed', String(on));
  placeConductor();
}
const saveLayout = () => sim.conductorLayout({ shown: conductorShown, width: parseInt(getComputedStyle(document.body).getPropertyValue('--conductor-w')) || 560 });

$('toggleConductor').onclick = () => { showConductor(!conductorShown); saveLayout(); };

// Drag the splitter to resize the conductor column
$('splitter').addEventListener('pointerdown', ev => {
  const sp = ev.currentTarget;
  sp.setPointerCapture(ev.pointerId);
  sp.classList.add('drag');
  const move = e => {
    const w = Math.max(360, Math.min(window.innerWidth - 420, window.innerWidth - e.clientX - 10));
    document.body.style.setProperty('--conductor-w', w + 'px');
  };
  const up = () => { sp.classList.remove('drag'); sp.removeEventListener('pointermove', move); saveLayout(); };
  sp.addEventListener('pointermove', move);
  sp.addEventListener('pointerup', up, { once: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT
// ═══════════════════════════════════════════════════════════════════════════════
// The shortcuts, from this page or sent from the conductor page (keys.js).
// Not while typing in a field or using a menu.
const TYPING = 'input:not([type=range]):not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable]';

function shortcut(key, ev = {}) {
  if (!snap) return false;
  switch (key) {
    case 'space':  sim.transport('toggle'); return true;
    case 's':      soloKey(); return true;
    case 'm':      muteKey(); return true;
    case 't':      [...selected].forEach(n => sim.test(n)); return true;
    case 'escape': clearSelection(); return true;
  }
  return false;
}

document.addEventListener('keydown', ev => {
  if (sheetOpen) return;
  if (ev.target.closest && ev.target.closest(TYPING)) {
    if (ev.key === 'Escape') ev.target.blur();
    return;
  }
  if (!snap) return;
  const mod = MAC ? ev.metaKey : ev.ctrlKey;
  if (mod && ev.key.toLowerCase() === 'a') { ev.preventDefault(); selectOnly(order()); return; }
  if (ev.key.startsWith('Arrow') && !mod) { ev.preventDefault(); moveSelection(ev.key); return; }
  if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
  const key = { ' ': 'space', Escape: 'escape' }[ev.key] || ev.key.toLowerCase();
  if (!['space', 's', 'm', 't', 'escape'].includes(key)) return;
  ev.preventDefault(); // no page scroll, no click on the focused button
  if (!ev.repeat) shortcut(key, ev);
});
sim.onShortcut(key => { if (!sheetOpen) shortcut(key); });

// A click on the empty workspace clears the selection
$('workspace').addEventListener('mousedown', ev => {
  if (!ev.target.closest('.card, .speaker, .bar, button, select, input')) clearSelection();
});

$('play').onclick = () => sim.transport('toggle');
$('stop').onclick = () => sim.transport('stop');
$('fewer').onclick = () => sim.setCount(snap.phones.length - 1);
$('more').onclick = () => sim.add(1);
$('count').onchange = ev => sim.setCount(+ev.target.value);
$('count').onkeydown = ev => { if (ev.key === 'Enter') ev.target.blur(); };
$('soloBtn').onclick = soloKey;
$('muteBtn').onclick = muteKey;
$('clearBtn').onclick = () => { setSolo([]); setMute(order(), false); };
$('identifyBtn').onclick = () => sim.identify(targets());

$('routeMenu').addEventListener('mousedown', buildRouteMenu);
$('routeMenu').addEventListener('focus', buildRouteMenu);
$('routeMenu').onchange = ev => {
  const act = routeActions().find(([v]) => v === ev.target.value);
  ev.target.value = '';
  if (act) sim.setOutputs(act[2](targets()));
};

// ── Backend sheet ─────────────────────────────────────────────────────────────
const sheet = $('connDialog');
$('backend').onclick = () => {
  const cfg = snap.cfg;
  for (const r of sheet.querySelectorAll('input[name=backend]')) r.checked = r.value === cfg.backend;
  $('site').value = cfg.site;
  $('broker').value = cfg.broker;
  $('connErr').textContent = '';
  const B = snap.backend;
  $('backendInfo').textContent = B.mode === 'local' && B.running
    ? `Running at ${B.url} · ${B.performers} performer${B.performers === 1 ? '' : 's'} and ${B.conductors} conductor connected · ${B.messages} messages so far.` : '';
  sheetOpen = true;
  placeConductor(); // the conductor is a view on top: hide it while the sheet is open
  sheet.showModal();
};
sheet.addEventListener('close', async () => {
  sheetOpen = false;
  placeConductor();
  if (sheet.returnValue !== 'apply') return;
  const mode = (sheet.querySelector('input[name=backend]:checked') || {}).value || 'local';
  try { await sim.setConnection({ backend: mode, site: $('site').value, broker: $('broker').value }); }
  catch (e) { alert(e.message.replace(/^.*Error: /, '')); }
});

navigator.mediaDevices.addEventListener('devicechange', () => {
  channelCache.clear();
  loadDevices().then(() => sim.devicesChanged());
});

// ── Boot ──────────────────────────────────────────────────────────────────────
sim.snapshot().then(s => {
  snap = s;
  document.body.style.setProperty('--conductor-w', s.cfg.conductor.width + 'px');
  showConductor(s.cfg.conductor.shown);
  loadDevices();
});
sim.onUpdate(s => { snap = s; build(); });
requestAnimationFrame(tick);
