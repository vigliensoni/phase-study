// ═══════════════════════════════════════════════════════════════════════════════
// SIMULATOR PANEL — the window's own interface, around the conductor page.
// Everything goes through window.sim (preload.js). The main process sends a
// snapshot of the conductor and every client a few times a second; the panel
// builds its cards when the clients or the devices change, and otherwise only
// updates them in place (so a menu isn't rebuilt under you).
//
// Solo, mute and outputs live in the main process, which applies them to the
// clients (a solo only changes their level).
// ═══════════════════════════════════════════════════════════════════════════════

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
if (params.get('glass')) document.documentElement.classList.add('glass');
if (params.get('platform') === 'darwin') document.documentElement.classList.add('mac');
const MAC = params.get('platform') === 'darwin';

let snap = null;              // the latest snapshot
let devices = [];             // connected outputs: [{ label, channels }] (without the default)
let defaultChannels = 2;      // the default output's channels
let creatingRoom = false;

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
// OUTPUTS — devices, and their channels
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
const shortName = label => label ? label.replace(/\s*\((Built-in|Virtual|Bluetooth)\)$/i, '') : 'Default output';
const connected = label => !label || devices.some(d => d.label === label);
const channelsFor = label => (!label ? defaultChannels : (devices.find(d => d.label === label) || {}).channels || 2);

// The outputs in the menus: the default, every device, and any a client was
// given that isn't plugged in right now
function outputList() {
  const given = snap ? snap.phones.map(p => p.output.device) : [];
  return [...new Set(['', ...devices.map(d => d.label), ...given])];
}

// ── Channels ──────────────────────────────────────────────────────────────────
// null = as is (the client's stereo, laid out by the device); [n] = channel n;
// [n, n + 1] = a stereo pair
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

// The output menu of a card: one group per output, with its channels. The
// channel comes first, so it still shows when a long name is cut off.
function outputOptions() {
  return outputList().map(label => {
    const total = channelsFor(label);
    const name = shortName(label) + (connected(label) ? '' : ' (not connected)');
    return el('optgroup', { label: `${name} · ${total} ch` },
      ...channelChoices(total).map(ch =>
        el('option', { value: outValue({ device: label, channels: ch }), textContent: `${cap(chName(ch, total))} · ${shortName(label)}` })));
  });
}
const cap = t => t.charAt(0).toUpperCase() + t.slice(1);

// ═══════════════════════════════════════════════════════════════════════════════
// SOLO AND MUTE (as on a mixing desk)
// ═══════════════════════════════════════════════════════════════════════════════
// The change shows at once; the next snapshot confirms it
function setSolo(ns) { snap.solo = ns; sim.solo(ns); update(); }
function setMute(ns, on) {
  snap.mute = on ? [...new Set([...snap.mute, ...ns])] : snap.mute.filter(n => !ns.includes(n));
  sim.mute(ns, on); update();
}

// A card's S: solo this one alone (a lit S: unsolo it); with ⌘ / Ctrl, add it to the solo or take it out
function soloButton(n, ev) {
  if (MAC ? ev.metaKey : ev.ctrlKey) setSolo(isSolo(n) ? snap.solo.filter(k => k !== n) : [...snap.solo, n]);
  else setSolo(isSolo(n) ? snap.solo.filter(k => k !== n) : [n]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUILD — cards, when the clients or the devices change
// ═══════════════════════════════════════════════════════════════════════════════
let builtCards = '';
const order = () => (snap ? snap.phones.map(p => p.n) : []);

function build() {
  if (!snap) return;
  const cardsKey = JSON.stringify([order(), outputList(), devices, defaultChannels]);
  if (cardsKey !== builtCards) {
    builtCards = cardsKey;
    $('grid').replaceChildren(...snap.phones.map(p => card(p.n)));
  }
  update();
}

function card(n) {
  const out = el('select', { class: 'out', title: 'Where this client plays',
    onchange: () => sim.setOutputs({ [n]: JSON.parse(out.value) }) }, ...outputOptions());
  const btn = (cls, text, title, onclick) => el('button', { class: 'sm-btn ' + cls, textContent: text, title, onclick });
  return el('div', { class: 'card', data: { n } },
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
      btn('solo', 'S', `Solo (${MAC ? '⌘' : 'Ctrl'}-click: add to the solo)`, ev => soloButton(n, ev)),
      btn('mute', 'M', 'Mute', () => setMute([n], !isMuted(n))),
      btn('plain', '♪', 'Test tone on its output', () => sim.test(n)),
      el('span', { class: 'grow' }),
      btn('plain extra', '⧉', 'Show this client’s page', () => sim.show(n)),
      btn('plain extra', '↻', 'Reload and join again', () => sim.rejoin(n)),
      btn('plain extra', '×', 'Remove this client', () => sim.remove([n]))));
}

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
  if (!p.connected) return ['off', 'Not connected to the broker'];
  if (!p.synced) return ['wait', 'Syncing its clock'];
  return ['ok', 'Connected and in sync'];
}

function update() {
  if (!snap) return;
  const C = snap.conductor;
  colors = { fg: themeColor('--fg'), faint: themeColor('--faint'), track: themeColor('--fill-hover') };

  // ── Toolbar ─────────────────────────────────────────────────────────────────
  if (document.activeElement !== $('link') && !linkEdited) $('link').value = snap.cfg.link;
  $('room').textContent = snap.room || '—';
  $('newRoom').disabled = !snap.site || creatingRoom;
  const online = !!(C && C.online);
  $('netDot').className = 'dot ' + (!snap.site ? '' : online ? 'ok' : 'wait');
  $('roomPill').title = !snap.site ? 'No server link yet'
    : `${snap.site} · ${online ? `connected · the conductor sees ${C.roster} client${C.roster === 1 ? '' : 's'}` : C ? C.net.toLowerCase() : 'loading the conductor…'}`;
  $('start').hidden = !!snap.site;
  document.body.classList.toggle('no-site', !snap.site);

  // ── Bar ─────────────────────────────────────────────────────────────────────
  const count = $('count');
  if (document.activeElement !== count) count.value = snap.site ? snap.phones.length : snap.cfg.count;
  count.max = snap.maxClients;
  const joined = snap.phones.filter(p => p.joined && p.synced).length;
  $('joinedTxt').textContent = !snap.site ? '' : joined < snap.phones.length ? `${joined} of ${snap.phones.length} in sync…`
    : C && online ? `the conductor sees ${C.roster}` : '';
  const soloed = [...snap.solo].sort((a, b) => a - b), muted = [...snap.mute].sort((a, b) => a - b);
  $('soloTxt').textContent = [soloed.length ? `Solo: ${soloed.join(', ')}` : '', muted.length ? `Muted: ${muted.join(', ')}` : ''].filter(Boolean).join(' · ');
  $('clearBtn').hidden = !soloed.length && !muted.length;
  $('empty').hidden = !snap.site || snap.phones.length > 0;
  $('grid').classList.toggle('compact', snap.phones.length > 12);

  // ── Cards ───────────────────────────────────────────────────────────────────
  const cards = $('grid').children;
  snap.phones.forEach((p, i) => {
    const cardEl = cards[i];
    if (!cardEl || +cardEl.dataset.n !== p.n) return;
    const solo = isSolo(p.n), mute = isMuted(p.n), hear = audible(p.n);
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
      if (out.value !== v) { // a channel this output doesn't have (any more)
        out.append(el('option', { value: v, textContent: `${cap(chName(p.output.channels, 0))} · ${shortName(p.output.device)} (unavailable)` }));
        out.value = v;
      }
    }
    out.classList.toggle('bad', !!p.error && p.joined);
    out.title = p.error ? p.error
      : p.playingTo ? `Plays to ${p.playingTo}${p.output.channels ? ', ' + chName(p.output.channels, p.deviceChannels) : ''}` : 'Where this client plays';

    ft.children[0].classList.toggle('on', solo);
    ft.children[1].classList.toggle('on', mute);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONDUCTOR COLUMN — the conductor page is a view of its own, placed over the
// slot this layout keeps for it
// ═══════════════════════════════════════════════════════════════════════════════
let conductorShown = true;
function placeConductor() {
  const r = $('conductorSlot').getBoundingClientRect();
  sim.conductorSlot(conductorShown ? { x: r.left, y: r.top, width: r.width, height: r.height } : null);
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
// The server link
let linkEdited = false;
$('link').addEventListener('input', () => { linkEdited = true; });
$('linkForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const err = $('linkErr');
  err.hidden = true;
  try {
    await sim.setLink($('link').value);
    linkEdited = false;
    $('link').blur();
  } catch (e) {
    err.textContent = e.message.replace(/^.*Error: /, '');
    err.hidden = false;
  }
});

$('newRoom').addEventListener('click', async () => {
  const err = $('linkErr');
  creatingRoom = true;
  $('newRoom').disabled = true;
  err.hidden = true;
  try {
    await sim.newRoom();
  } catch (e) {
    err.textContent = e.message.replace(/^.*Error: /, '');
    err.hidden = false;
  } finally {
    creatingRoom = false;
    $('newRoom').disabled = !snap || !snap.site;
  }
});

// Space: the conductor's Start / Stop. Not while typing in a field or using a menu.
const TYPING = 'input:not([type=range]):not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable]';
document.addEventListener('keydown', ev => {
  if (ev.code !== 'Space' || ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
  if (ev.target.closest && ev.target.closest(TYPING)) return;
  ev.preventDefault(); // no page scroll, no click on the focused button
  if (!ev.repeat) sim.startStop();
});

$('fewer').onclick = () => sim.setCount((snap.site ? snap.phones.length : snap.cfg.count) - 1);
$('more').onclick = () => sim.setCount((snap.site ? snap.phones.length : snap.cfg.count) + 1);
$('count').onchange = ev => sim.setCount(+ev.target.value);
$('count').onkeydown = ev => { if (ev.key === 'Enter') ev.target.blur(); };
$('clearBtn').onclick = () => { setSolo([]); setMute(order(), false); };

navigator.mediaDevices.addEventListener('devicechange', () => {
  channelCache.clear();
  loadDevices().then(() => sim.devicesChanged());
});

// ── Boot ──────────────────────────────────────────────────────────────────────
sim.snapshot().then(s => {
  snap = s;
  document.body.style.setProperty('--conductor-w', s.cfg.conductor.width + 'px');
  showConductor(s.cfg.conductor.shown);
  update();
  if (!s.site) $('link').focus();
  loadDevices();
});
sim.onUpdate(s => { snap = s; build(); });
