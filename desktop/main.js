// ═══════════════════════════════════════════════════════════════════════════════
// PHASE STUDY SIMULATOR — Electron main process.
//
// One window: the simulator panel (a grid of clients, the speakers, the
// transport) and the ensemble's real conductor page in a column beside it.
// Behind them, a local backend (the room's MQTT broker) and any number of
// simulated phones, each the real performer page, joined automatically and
// playing to its own speaker.
//
//   backend.js     the room's MQTT broker, on 127.0.0.1
//   site.js        serves the repo to the pages at phase://site/…
//   guard.js       keeps pages from navigating away
//   instances.js   the simulated phones
//   inject/        added to the pages: each phone's output stage (speaker,
//                  channels, solo), and Helvetica for every page
//   config.js      saved settings
//   preload.js     the panel's bridge to this process
//   keys.js        sends the simulator's shortcuts from the conductor's and clients' pages
//   panel/         the simulator panel
//   smoke.js       the automated test (npm run smoke)
// ═══════════════════════════════════════════════════════════════════════════════

const { app, BaseWindow, WebContentsView, ipcMain, dialog, session, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const site = require('./site');
const config = require('./config');
const backend = require('./backend');
const { lockNavigation, SAFE_PREFS } = require('./guard');
const { Instance } = require('./instances');

const SMOKE = process.argv.includes('--smoke'); // automated test: default settings, quits when done
const SMOKE_SITE = (process.argv.find(a => a.startsWith('--site=')) || '').slice(7); // test against another copy of the site
const MAX_CLIENTS = 40;
const POLL_MS = 150;         // how often the panel's view of the clients refreshes
const IDENTIFY_GAP = 600;    // ms between clients when identifying
const LEAD_CHANGE = 0.4;     // s: the conductor's delay before a stop takes effect (net.js)
const GLASS = process.platform === 'darwin'; // native translucent window

site.registerScheme();

// Every page in the app is set in Helvetica, the site's pages included (inject/fonts.css)
const FONTS = fs.readFileSync(path.join(__dirname, 'inject', 'fonts.css'), 'utf8');
app.on('web-contents-created', (ev, wc) => wc.on('dom-ready', () => wc.insertCSS(FONTS).catch(() => {})));

let cfg = SMOKE ? { ...config.DEFAULTS, site: SMOKE_SITE, backend: SMOKE_SITE ? 'site' : 'local' } : null;
let room = null;          // the room every page joins
let local = null;         // the local backend, while it runs
let win = null, conductor = null, panel = null;
const phones = new Map(); // number → Instance
const solo = new Set();   // soloed client numbers (none: everyone plays)
const mute = new Set();   // muted client numbers
let conductorInfo = null; // the latest CONDUCTOR snapshot
let quitting = false;

// Same alphabet as the conductor's own room codes (no 0/O, 1/I)
function newRoom() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...crypto.randomBytes(4)].map(x => abc[x % abc.length]).join('');
}

// ── Page addresses ────────────────────────────────────────────────────────────
const base = () => site.siteBase(cfg.site);
function query() {
  const q = new URLSearchParams({ room });
  const broker = cfg.backend === 'local' && local ? local.url : cfg.broker;
  if (broker) q.set('broker', broker);
  return q;
}
const conductorURL = () => `${base()}/ensemble/conductor.html?${query()}`;
const phoneURL     = () => `${base()}/ensemble/index.html?${query()}`;

// ═══════════════════════════════════════════════════════════════════════════════
// WINDOW
// ═══════════════════════════════════════════════════════════════════════════════
function createWindow() {
  win = new BaseWindow({
    width: 1600, height: 980, minWidth: 980, minHeight: 620, title: 'Phase Study Simulator',
    ...(GLASS ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 20 },
                  vibrancy: 'under-window', visualEffectState: 'active', backgroundColor: '#00000000' }
              : { backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0c0e' : '#f1efe9' }),
  });

  panel = new WebContentsView({ webPreferences: { ...SAFE_PREFS, preload: path.join(__dirname, 'preload.js'),
    autoplayPolicy: 'no-user-gesture-required' } }); // it measures the speakers' channels with an AudioContext
  conductor = new WebContentsView({ webPreferences: { ...SAFE_PREFS, preload: path.join(__dirname, 'keys.js'),
    backgroundThrottling: false } });
  if (GLASS) panel.setBackgroundColor('#00000000');
  win.contentView.addChildView(panel);
  win.contentView.addChildView(conductor); // on top, in the slot the panel leaves for it
  conductor.setVisible(false);             // until the panel says where
  fitPanel();
  win.on('resize', fitPanel);

  // The conductor page starts light; until its own theme button is used,
  // it follows the system, like the panel
  conductor.webContents.on('did-finish-load', () => conduct(`(() => {
    try { if (localStorage.getItem('theme')) return; } catch (e) { return; }
    if (${nativeTheme.shouldUseDarkColors}) document.documentElement.dataset.theme = 'dark';
    else delete document.documentElement.dataset.theme;
    themeChanged(); themeChanged(); // refreshes its button's label (toggles twice), and saves the choice
  })()`).catch(() => {}));

  lockNavigation(conductor.webContents, { site: base() });
  lockNavigation(panel.webContents, { site: base(), popups: false });
  conductor.webContents.loadURL(conductorURL());
  panel.webContents.loadFile(path.join(__dirname, 'panel', 'index.html'),
    { query: { glass: GLASS ? '1' : '', platform: process.platform } });

  win.on('close', confirmClose);
  win.on('closed', () => { win = null; app.quit(); });
}

function fitPanel() {
  const { width, height } = win.getContentBounds();
  panel.setBounds({ x: 0, y: 0, width, height });
}

// The panel lays out the window and keeps a space for the conductor; it
// sends that space's rectangle (or null to hide the conductor)
function placeConductor(rect) {
  if (!rect || rect.width < 50 || rect.height < 50) return conductor.setVisible(false);
  const r = v => Math.round(v);
  conductor.setBounds({ x: r(rect.x), y: r(rect.y), width: r(rect.width), height: r(rect.height) });
  conductor.setVisible(true);
}

// Closing the window mid-rehearsal drops every client from the room: ask first
function confirmClose(ev) {
  if (SMOKE || quitting || !phones.size) return;
  const answer = dialog.showMessageBoxSync(win, {
    type: 'question', buttons: ['Quit', 'Cancel'], defaultId: 1, cancelId: 1,
    message: 'Quit the simulator?',
    detail: `${phones.size} simulated client${phones.size === 1 ? '' : 's'} will leave room ${room}, and the local backend will stop.`,
  });
  if (answer === 1) ev.preventDefault();
  else quitting = true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLIENTS
// ═══════════════════════════════════════════════════════════════════════════════
const numbers = () => [...phones.keys()].sort((a, b) => a - b);
const outputOf = n => cfg.outputs[n] || { device: '', channels: null };

// Who you hear: not muted, and soloed if anything is (as on a mixing desk)
const audible = n => !mute.has(n) && (!solo.size || solo.has(n));

function addClient(n) {
  phones.set(n, new Instance(n, {
    url: phoneURL(), site: base(), output: outputOf(n), audible: audible(n), muted: SMOKE, // the test unmutes them once they're on its loopback device
  }));
}

function removeClient(n) {
  const p = phones.get(n);
  if (!p) return;
  p.destroy();
  phones.delete(n);
  solo.delete(n); mute.delete(n);
  applyMix();
}

// Adds the lowest free numbers, or removes the highest, so the others stay in
// the room as they are
function setCount(count) {
  count = Math.max(0, Math.min(MAX_CLIENTS, count | 0));
  while (phones.size > count) removeClient(Math.max(...phones.keys()));
  for (let n = 1; phones.size < count; n++) if (!phones.has(n)) addClient(n);
  cfg.count = phones.size;
  saveConfig();
}

// Every page again, from scratch, in the same room (after changing the backend or site)
async function reloadAll() {
  const ns = numbers();
  for (const n of ns) { phones.get(n).destroy(); phones.delete(n); }
  if (cfg.backend === 'local' && !local) local = await backend.start();
  if (cfg.backend !== 'local' && local) { await local.stop(); local = null; }
  conductor.webContents.loadURL(conductorURL());
  for (const n of ns) addClient(n);
}

// Solo and mute only change each client's level, never its playback
function applyMix() {
  return Promise.all([...phones.values()].map(p => p.audible !== audible(p.n) && p.setAudible(audible(p.n))));
}

// Plays each client's test tone in turn, so you can hear which speaker it's on
let identifyTimers = [];
function identify(ns) {
  identifyTimers.forEach(clearTimeout);
  identifyTimers = ns.filter(n => phones.has(n)).sort((a, b) => a - b)
    .map((n, i) => setTimeout(() => phones.has(n) && phones.get(n).test(), i * IDENTIFY_GAP));
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSPORT — through the conductor page's own controls
// ═══════════════════════════════════════════════════════════════════════════════
// The conductor starts a piece from its "Start from" time, on the shared
// clock, with a 1.5 s lead (from 0:00 that's a count-in; from later on, the
// 1.5 s before it play as a pre-roll); a stop lands 0.4 s after Stop.
// Pause is a stop that leaves "Start from" where the sound stopped, so Play
// carries on from there: a resume skips the lead, so nothing is heard twice.
const conduct = js => conductor.webContents.executeJavaScript(js);
const FROM = `document.getElementById('fromCtrl')`;
const mss = t => `(Math.floor(${t} / 60) + ':' + (${t} % 60).toFixed(2).padStart(5, '0'))`;
const TRANSPORT = {
  play: `(() => {
    if (S.playing) return;
    const shown = ${FROM}.value, from = parseTime(shown) || 0;
    if (from >= comp.end) ${FROM}.value = '0:00'; // at the end: from the top
    const resume = window.__simPausedAt === shown && from > 0;
    if (resume) ${FROM}.value = ${mss(`(from + LEAD_START / 1000)`)};
    togglePlay();
    if (resume) ${FROM}.value = shown;
    window.__simPausedAt = null;
  })()`,
  pause: `(() => {
    if (!S.playing) return;
    const from = parseTime(${FROM}.value) || 0, t = Math.max(from, scoreNow() + ${LEAD_CHANGE});
    togglePlay();
    ${FROM}.value = window.__simPausedAt = t >= comp.end ? '0:00' : ${mss('t')};
  })()`,
  stop: `(() => { if (S.playing) togglePlay(); ${FROM}.value = '0:00'; window.__simPausedAt = null; })()`,
};
TRANSPORT.toggle = `(S.playing ? ${TRANSPORT.pause} : ${TRANSPORT.play})`;

// What the panel shows of the conductor, from the conductor page's globals
const CONDUCTOR = `({
  playing: S.playing, title: comp.title, groups: comp.groups, end: comp.end,
  time: S.playing ? scoreNow() : null, from: parseTime(${FROM}.value) || 0,
  status: document.getElementById('statusTxt').textContent,
  online: client.connected, net: document.getElementById('netTxt').textContent,
  roster: awakeIds().length,
})`;

// ═══════════════════════════════════════════════════════════════════════════════
// PANEL UPDATES
// ═══════════════════════════════════════════════════════════════════════════════
// Refreshes the panel a few times a second (one round at a time: no pile-up if a page is slow)
async function poll() {
  try {
    await Promise.all([...phones.values()].map(p => p.poll()));
    conductorInfo = await conduct(CONDUCTOR).catch(() => null); // null while it loads
    const wc = panel && panel.webContents;
    if (wc && !wc.isDestroyed()) wc.send('update', snapshot());
  } catch (e) {
    // a page went away mid-round (quitting, reloading): try again next round
  } finally {
    if (!quitting) setTimeout(poll, POLL_MS);
  }
}

const snapshot = () => ({
  room, cfg, maxClients: MAX_CLIENTS,
  backend: cfg.backend === 'local'
    ? { mode: 'local', ...(local ? local.status() : { running: false }) }
    : { mode: 'site', url: cfg.broker || 'the site’s broker', running: true },
  conductor: conductorInfo,
  solo: [...solo], mute: [...mute],
  phones: numbers().map(n => phones.get(n).snapshot()),
});

function saveConfig() { if (!SMOKE) config.save(cfg); }

// ═══════════════════════════════════════════════════════════════════════════════
// PANEL → MAIN (see preload.js for the other side)
// ═══════════════════════════════════════════════════════════════════════════════
// Only the panel may call these
function handle(name, fn) {
  ipcMain.handle(name, (ev, ...args) => {
    if (!panel || ev.sender !== panel.webContents) throw new Error('not allowed');
    return fn(...args);
  });
}

const phone = n => phones.get(n | 0) || null;
const list = ns => (Array.isArray(ns) ? ns : []).map(n => n | 0).filter(n => phones.has(n));

// { device, channels } from the panel: a label, and null or 1–2 channel numbers
function cleanOutput(o) {
  const device = String((o && o.device) || '');
  let channels = o && Array.isArray(o.channels) ? o.channels.map(c => c | 0).filter(c => c >= 1 && c <= 64) : null;
  if (!channels || !channels.length || channels.length > 2) channels = null;
  return { device, channels };
}

function registerIPC() {
  handle('snapshot', snapshot);
  handle('count', n => setCount(n));
  handle('add', k => setCount(phones.size + Math.max(1, k | 0)));
  handle('remove', ns => { list(ns).forEach(removeClient); cfg.count = phones.size; saveConfig(); });

  // { client number: { device, channels } }
  handle('outputs', map => Promise.all(Object.entries(map || {}).map(([n, o]) => {
    o = cleanOutput(o);
    if (o.device || o.channels) cfg.outputs[n] = o; else delete cfg.outputs[n];
    return phone(n) && phone(n).setOutput(o);
  })).then(saveConfig));

  // A speaker's place in the room
  handle('speaker', (label, { name }) => {
    cfg.speakers[String(label)] = { name: String(name || '').slice(0, 60) };
    saveConfig();
  });

  // A device appeared or went away: route every client again
  handle('devices-changed', () => Promise.all([...phones.values()].map(p => p.route())));

  // Solo: these clients alone (an empty list clears it). Mute: on or off for these.
  handle('solo', ns => { solo.clear(); list(ns).forEach(n => solo.add(n)); return applyMix(); });
  handle('mute', (ns, on) => { list(ns).forEach(n => (on ? mute.add(n) : mute.delete(n))); return applyMix(); });

  handle('test',     n => phone(n) && phone(n).test());
  handle('identify', ns => identify(list(ns)));
  handle('show',     n => phone(n) && phone(n).show());
  handle('rejoin',   n => phone(n) && phone(n).rejoin());

  handle('transport', what => TRANSPORT[what] && conduct(TRANSPORT[what]));

  handle('conductor-slot', rect => placeConductor(rect));
  handle('conductor-layout', ({ shown, width }) => {
    cfg.conductor = { shown: !!shown, width: Math.max(360, Math.min(1400, width | 0)) };
    saveConfig();
  });

  // Backend: 'local' or 'site'; site and broker: '' for the defaults, otherwise http(s) / ws(s) URLs only
  handle('connection', async ({ backend: mode, site: s, broker }) => {
    s = String(s || '').trim(); broker = String(broker || '').trim();
    if (s && !/^https?:\/\//.test(s)) throw new Error('The site must be an http(s):// address');
    if (broker && !/^wss?:\/\//.test(broker)) throw new Error('The broker must be a ws(s):// address');
    cfg.backend = mode === 'site' ? 'site' : 'local';
    cfg.site = s; cfg.broker = broker;
    saveConfig();
    await reloadAll();
  });
}

// The conductor's and the clients' pages send the simulator's shortcuts
// (keys.js); the panel handles them as if they were pressed there
ipcMain.on('shortcut', (ev, key) => {
  const fromPage = (conductor && ev.sender === conductor.webContents) || [...phones.values()].some(p => p.wc === ev.sender);
  if (!fromPage) return;
  if (panel && !panel.webContents.isDestroyed()) panel.webContents.send('shortcut', String(key));
});

// ═══════════════════════════════════════════════════════════════════════════════
// BOOT AND QUIT
// ═══════════════════════════════════════════════════════════════════════════════
app.whenReady().then(async () => {
  if (!cfg) cfg = config.load();
  room = newRoom();
  if (cfg.backend === 'local') local = await backend.start();
  site.prepareSession(session.defaultSession); // the conductor's and the panel's
  registerIPC();
  createWindow();
  setCount(cfg.count);
  poll();
  if (SMOKE) require('./smoke').run({
    conductor, panel, phones: () => numbers().map(n => phones.get(n)), setCount, snapshot,
    backend: () => local, transport: w => conduct(TRANSPORT[w]),
  });
});

// Leave the room cleanly: close every client (the conductor sees them go),
// then the backend, so its port is free for the next launch
app.on('will-quit', ev => {
  if (!local && !phones.size) return;
  ev.preventDefault();
  quitting = true;
  for (const p of phones.values()) p.destroy();
  phones.clear();
  const b = local;
  local = null;
  Promise.resolve(b && b.stop()).finally(() => app.exit(process.exitCode || 0)); // the test sets exitCode
});

app.on('window-all-closed', () => app.quit());
