// ═══════════════════════════════════════════════════════════════════════════════
// SIMULATOR PANEL — the column on the right of the window.
// Everything goes through window.sim (preload.js). The main process sends a
// snapshot of the conductor and every phone a few times a second; the panel
// builds its rows when the phones or the speakers change, and otherwise only
// updates them in place (so a menu or a text field isn't rebuilt under you).
// ═══════════════════════════════════════════════════════════════════════════════

const $ = id => document.getElementById(id);
const DEFAULT = '';                  // the system default speaker, as a device label
const speakerName = label => label === DEFAULT ? 'System default' : label;

let snap = null;   // the latest snapshot: { room, cfg, conductor, phones }
let devices = [];  // the audio outputs' labels (without the system default)
let built = '';    // what the rows were built for (see build())

// ═══════════════════════════════════════════════════════════════════════════════
// SPEAKERS
// ═══════════════════════════════════════════════════════════════════════════════
// Chromium lists the default device twice ('default', then its real entry), and
// on Windows a 'communications' one too; the real entries are enough.
async function loadDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  devices = all.filter(d => d.kind === 'audiooutput' && d.label &&
    d.deviceId !== 'default' && d.deviceId !== 'communications').map(d => d.label);
  build();
}

// The speakers shown: the default, every device, and any a phone was given
// that isn't plugged in right now (so its phones are still listed somewhere)
function speakers() {
  const given = snap ? snap.phones.map(p => p.sink) : [];
  return [...new Set([DEFAULT, ...devices, ...given])];
}
const missing = label => label !== DEFAULT && !devices.includes(label);
const speakerCfg = label => (snap && snap.cfg.speakers[label]) || { name: '', use: false };

// The speakers "Spread" deals phones to: the ticked ones, or every device
function usedSpeakers() {
  const ticked = devices.filter(l => speakerCfg(l).use);
  return ticked.length ? ticked : devices.length ? devices : [DEFAULT];
}

// Phone 1 → first speaker, 2 → second… round and round
function spread() {
  const use = usedSpeakers(), map = {};
  snap.phones.forEach((p, i) => { map[p.n] = use[i % use.length]; });
  sim.setSinks(map);
}

// Score mode: group A → first speaker, B → second… (a phone without a group stays put)
function byGroup() {
  const use = usedSpeakers(), groups = snap.conductor.groups, map = {};
  for (const p of snap.phones) if (p.group) map[p.n] = use[groups.indexOf(p.group) % use.length];
  sim.setSinks(map);
}

function allDefault() {
  const map = {};
  for (const p of snap.phones) map[p.n] = DEFAULT;
  sim.setSinks(map);
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUILD — the speaker cards and the phone rows, when either list changes
// ═══════════════════════════════════════════════════════════════════════════════
function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else e[k] = v;
  }
  e.append(...children);
  return e;
}

function build() {
  if (!snap) return;
  const list = speakers();
  const key = JSON.stringify([list, snap.phones.length]);
  if (key === built) return update();
  built = key;

  // One card per speaker: ticked for "Spread", its place in the room, its phones
  $('speakers').replaceChildren(...list.map(label => {
    const c = speakerCfg(label);
    const save = () => sim.setSpeaker(label, { name: name.value, use: use.checked });
    const use = el('input', { type: 'checkbox', checked: c.use, title: 'Use for “Spread phones”', onchange: save });
    const name = el('input', { type: 'text', value: c.name, placeholder: 'where? e.g. front left', onchange: save });
    return el('div', { class: 'speaker' },
      el('div', { class: 'speaker-hd' },
        label === DEFAULT ? '' : use,
        el('span', { class: 'dev' + (missing(label) ? ' bad' : ''), title: label },
          speakerName(label) + (missing(label) ? ' (not connected)' : '')),
        name),
      el('div', { class: 'chips' }));
  }));

  // One row per phone
  $('phones').replaceChildren(...snap.phones.map(p => {
    const sel = el('select', { onchange: () => sim.setSinks({ [p.n]: sel.value }) },
      ...list.map(label => el('option', { value: label, textContent: speakerName(label) })));
    return el('tr', {},
      el('td', { textContent: p.n }),
      el('td', {}, el('span', { class: 'swatch' }), el('span', { class: 'who' })),
      el('td', { class: 'st' }),
      el('td', {}, sel),
      el('td', {}, el('div', { class: 'meter' }, el('div'))),
      el('td', { class: 'acts' },
        el('button', { textContent: '♪', title: 'Test sound', onclick: () => sim.test(p.n) }),
        el('button', { textContent: '⧉', title: 'Show this phone’s page', onclick: () => sim.show(p.n) }),
        el('button', { textContent: '↻', title: 'Reload and join again', onclick: () => sim.rejoin(p.n) })));
  }));
  update();
}

// ═══════════════════════════════════════════════════════════════════════════════
// UPDATE — every snapshot
// ═══════════════════════════════════════════════════════════════════════════════
function update() {
  const C = snap.conductor;
  $('room').textContent = snap.room;
  $('net').textContent = C ? C.net.toLowerCase() : 'loading…';

  // Transport
  const play = $('play');
  play.disabled = !C;
  play.textContent = !C ? '…' : C.playing ? '■ Stop' : C.mode === 'score' ? '▶ Start score' : '▶ Start';
  play.classList.toggle('on', !!(C && C.playing));
  $('cstatus').textContent = C ? C.status : '—';
  $('piece').textContent = C ? (C.mode === 'score' ? 'Score · ' : 'Free · ') + C.piece : '';
  $('byGroup').disabled = !(C && C.mode === 'score');

  // Count
  const count = $('count');
  if (document.activeElement !== count) count.value = snap.phones.length;
  const joined = snap.phones.filter(p => p.joined).length;
  $('joinedTxt').textContent = joined < snap.phones.length ? `${joined} joined…` : '';

  // Phone rows
  const rows = $('phones').children;
  snap.phones.forEach((p, i) => {
    const tr = rows[i];
    if (!tr) return;
    const [, who, st, sp, lvl] = tr.children;
    who.firstChild.style.background = p.color || 'transparent';
    who.lastChild.textContent = p.label || '·';
    st.textContent = p.error || (p.joined ? p.status : 'joining…');
    st.title = st.textContent;
    st.classList.toggle('bad', !!p.error);
    const sel = sp.firstChild;
    if (document.activeElement !== sel && sel.value !== p.sink) sel.value = p.sink;
    sel.title = p.playingTo ? 'Plays to: ' + p.playingTo : '';
    lvl.firstChild.firstChild.style.width = Math.min(100, (p.peak || 0) * 200) + '%';
    tr.classList.toggle('flash', !!p.flash);
  });

  // Each speaker's phones, as chips (lit while that phone sounds its test beep)
  const cards = $('speakers').children;
  speakers().forEach((label, i) => {
    const chips = cards[i] && cards[i].lastChild;
    if (!chips) return;
    const mine = snap.phones.filter(p => p.sink === label);
    chips.replaceChildren(...mine.map(p => {
      const chip = el('span', { class: 'chip' + (p.flash ? ' flash' : ''), textContent: `${p.n} · ${p.label || '·'}` });
      chip.style.borderColor = p.color || '';
      return chip;
    }));
    cards[i].classList.toggle('unused', !mine.length);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT
// ═══════════════════════════════════════════════════════════════════════════════
// Space starts and stops the piece, with the same rule as the conductor page
// (ensemble/shortcuts.js): not while typing in a field, ticking a box or using
// a menu; on a focused button it replaces the button's own click.
document.addEventListener('keydown', ev => {
  if (ev.code !== 'Space' || ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
  if (ev.target.closest('input:not([type=range]), textarea, select, [contenteditable]')) return;
  ev.preventDefault();
  if (!ev.repeat) sim.togglePlay();
});

$('play').onclick = () => sim.togglePlay();
$('identify').onclick = () => sim.identify();
$('spread').onclick = spread;
$('byGroup').onclick = byGroup;
$('allDefault').onclick = allDefault;
$('fewer').onclick = () => sim.setCount(snap.phones.length - 1);
$('more').onclick = () => sim.setCount(snap.phones.length + 1);
$('count').onchange = ev => sim.setCount(+ev.target.value);

$('connect').onclick = async () => {
  $('connErr').textContent = '';
  try { await sim.setConnection({ site: $('site').value, broker: $('broker').value }); }
  catch (e) { $('connErr').textContent = e.message.replace(/^.*Error: /, ''); }
};

navigator.mediaDevices.addEventListener('devicechange', () => { loadDevices(); sim.devicesChanged(); });

// ── Boot ──────────────────────────────────────────────────────────────────────
sim.snapshot().then(s => {
  snap = s;
  $('site').value = s.cfg.site;
  $('broker').value = s.cfg.broker;
  loadDevices();
});
sim.onUpdate(s => { snap = s; build(); });
