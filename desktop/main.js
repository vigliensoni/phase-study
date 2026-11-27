// ═══════════════════════════════════════════════════════════════════════════════
// PHASE STUDY SIMULATOR — Electron main process.
//
// One window: the simulator panel (a grid of clients) and the ensemble's real
// conductor page in a column beside it. Both come from the server link you
// paste (the site through your Cloudflare tunnel, for example), and they use
// the site's own broker, so the simulated phones join the same room as real
// phones would, and real phones can join it too.
//
//   instances.js   the simulated phones
//   inject/        added to each phone: its output stage (speaker, channels, solo)
//   permissions.js what the pages may use
//   guard.js       keeps pages from navigating away
//   config.js      saved settings
//   preload.js     the panel's bridge to this process
//   panel/         the simulator panel
//   smoke.js       the automated test (npm run smoke -- --link=…)
// ═══════════════════════════════════════════════════════════════════════════════

const { app, BaseWindow, WebContentsView, ipcMain, dialog, session, nativeTheme } = require('electron');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { prepareSession } = require('./permissions');
const { lockNavigation, SAFE_PREFS } = require('./guard');
const { Instance } = require('./instances');

const SMOKE = process.argv.includes('--smoke'); // automated test: default settings, quits when done
const SMOKE_LINK = (process.argv.find(a => a.startsWith('--link=')) || '').slice(7);
const MAX_CLIENTS = 40;
const POLL_MS = 150;         // how often the panel's view of the clients refreshes
const GLASS = process.platform === 'darwin'; // native translucent window

let cfg = SMOKE ? { ...config.DEFAULTS, link: SMOKE_LINK } : null;
let site = null;          // from the link: { base, room, broker }, or null until there's a link
let ownRoom = null;       // the room made up at launch, for a link without ?room=
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

// ── The server link ───────────────────────────────────────────────────────────
// Accepts the site's address or any page of it: https://x.trycloudflare.com,
// …/ensemble/index.html?room=ABCD, …/ensemble/conductor.html. The site is
// everything before /ensemble/; the room and broker come from the link if it
// has them.
function parseLink(text) {
  let u;
  try { u = new URL(String(text || '').trim()); } catch (e) { throw new Error('That isn’t a web address'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('The link must start with http:// or https://');
  let p = u.pathname;
  const i = p.indexOf('/ensemble/');
  if (i >= 0) p = p.slice(0, i);
  else p = p.replace(/\/[^/]*\.html?$/, '').replace(/\/ensemble\/?$/, '');
  p = p.replace(/\/+$/, '');
  const room = (u.searchParams.get('room') || '').trim().toUpperCase();
  return { base: u.origin + p, room: room || null, broker: u.searchParams.get('broker') || '' };
}

const room = () => (site && site.room) || ownRoom;
function query() {
  const q = new URLSearchParams({ room: room() });
  if (site.broker) q.set('broker', site.broker);
  return q;
}
const conductorURL = () => `${site.base}/ensemble/conductor.html?${query()}`;
const phoneURL     = () => `${site.base}/ensemble/index.html?${query()}`;

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
  conductor = new WebContentsView({ webPreferences: { ...SAFE_PREFS, backgroundThrottling: false } });
  if (GLASS) panel.setBackgroundColor('#00000000');
  win.contentView.addChildView(panel);
  win.contentView.addChildView(conductor); // on top, in the slot the panel leaves for it
  conductor.setVisible(false);             // until there's a link, and the panel says where
  fitPanel();
  win.on('resize', fitPanel);

  lockNavigation(conductor.webContents, { external: true });
  lockNavigation(panel.webContents);
  if (site) conductor.webContents.loadURL(conductorURL());
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
let conductorRect = null;
function placeConductor(rect) {
  conductorRect = rect;
  if (!site || !rect || rect.width < 50 || rect.height < 50) return conductor.setVisible(false);
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
    detail: `${phones.size} simulated client${phones.size === 1 ? '' : 's'} will leave room ${room()}.`,
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
    url: phoneURL(), output: outputOf(n), audible: audible(n), muted: SMOKE, // the test listens to their meters, not the room
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
// the room as they are. Without a link, only the number is kept for later.
function setCount(count) {
  count = Math.max(0, Math.min(MAX_CLIENTS, count | 0));
  cfg.count = count;
  saveConfig();
  if (!site) return;
  while (phones.size > count) removeClient(Math.max(...phones.keys()));
  for (let n = 1; phones.size < count; n++) if (!phones.has(n)) addClient(n);
}

function reloadRoom() {
  for (const p of phones.values()) p.destroy();
  phones.clear();
  solo.clear(); mute.clear();
  conductorInfo = null;
  conductor.webContents.loadURL(conductorURL());
  placeConductor(conductorRect);
  setCount(cfg.count);
}

// A new link: the conductor and every client again, from scratch
function load(link) {
  site = parseLink(link); // throws if it isn't a link
  ownRoom = site.room || newRoom();
  cfg.link = String(link).trim();
  cfg.room = site.room || ownRoom;
  saveConfig();
  reloadRoom();
}

function startNewRoom() {
  if (!site) throw new Error('Load a server link before starting a new room');
  let code;
  do { code = newRoom(); } while (code === room());
  site.room = code;
  ownRoom = code;
  cfg.room = code;
  const link = new URL(cfg.link);
  link.searchParams.set('room', code);
  cfg.link = link.toString();
  saveConfig();
  reloadRoom();
  return code;
}

// Solo and mute only change each client's level, never its playback
function applyMix() {
  return Promise.all([...phones.values()].map(p => p.audible !== audible(p.n) && p.setAudible(audible(p.n))));
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE CONDUCTOR — what the panel shows of it, from the conductor page's globals
// ═══════════════════════════════════════════════════════════════════════════════
const conduct = js => conductor.webContents.executeJavaScript(js);
const CONDUCTOR = `({
  playing: S.playing, title: comp.title,
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
    conductorInfo = site ? await conduct(CONDUCTOR).catch(() => null) : null; // null while it loads
    const wc = panel && panel.webContents;
    if (wc && !wc.isDestroyed()) wc.send('update', snapshot());
  } catch (e) {
    // a page went away mid-round (quitting, reloading): try again next round
  } finally {
    if (!quitting) setTimeout(poll, POLL_MS);
  }
}

const snapshot = () => ({
  room: site ? room() : null, site: site ? site.base : null, cfg, maxClients: MAX_CLIENTS,
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
  handle('link', link => load(link));
  handle('new-room', () => startNewRoom());
  handle('count', n => setCount(n));
  handle('remove', ns => { list(ns).forEach(removeClient); cfg.count = phones.size; saveConfig(); });

  // { client number: { device, channels } }
  handle('outputs', map => Promise.all(Object.entries(map || {}).map(([n, o]) => {
    o = cleanOutput(o);
    if (o.device || o.channels) cfg.outputs[n] = o; else delete cfg.outputs[n];
    return phone(n) && phone(n).setOutput(o);
  })).then(saveConfig));

  // A device appeared or went away: route every client again
  handle('devices-changed', () => Promise.all([...phones.values()].map(p => p.route())));

  // Solo: these clients alone (an empty list clears it). Mute: on or off for these.
  handle('solo', ns => { solo.clear(); list(ns).forEach(n => solo.add(n)); return applyMix(); });
  handle('mute', (ns, on) => { list(ns).forEach(n => (on ? mute.add(n) : mute.delete(n))); return applyMix(); });

  handle('test',   n => phone(n) && phone(n).test());
  handle('show',   n => phone(n) && phone(n).show());
  handle('rejoin', n => phone(n) && phone(n).rejoin());

  // Space in the panel: the conductor's own Start / Stop
  handle('start-stop', () => site && conduct('togglePlay()').catch(() => {}));

  handle('conductor-slot', rect => placeConductor(rect));
  handle('conductor-layout', ({ shown, width }) => {
    cfg.conductor = { shown: !!shown, width: Math.max(360, Math.min(1400, width | 0)) };
    saveConfig();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOT AND QUIT
// ═══════════════════════════════════════════════════════════════════════════════
app.whenReady().then(async () => {
  if (!cfg) cfg = config.load();
  ownRoom = /^[A-Z2-9]{4}$/.test(cfg.room) ? cfg.room : newRoom();
  try {
    if (cfg.link) site = parseLink(cfg.link);
    if (site && site.room) ownRoom = site.room;
    cfg.room = site && site.room ? site.room : ownRoom;
  } catch (e) {
    site = null;
    console.error('Could not restore the saved server link:', e.message);
  }
  prepareSession(session.defaultSession); // the conductor's and the panel's
  registerIPC();
  createWindow();
  setCount(cfg.count);
  poll();
  if (SMOKE) require('./smoke').run({
    conductor, panel, phones: () => numbers().map(n => phones.get(n)), snapshot,
  });
});

// Leave the room cleanly: close every client, so the conductor sees them go
app.on('will-quit', () => {
  quitting = true;
  for (const p of phones.values()) p.destroy();
  phones.clear();
  if (!SMOKE) {
    saveConfig();
    config.flush();
  }
});

app.on('window-all-closed', () => app.quit());
