// ═══════════════════════════════════════════════════════════════════════════════
// PHASE STUDY SIMULATOR — Electron main process.
//
// One window: the ensemble's conductor page on the left, the simulator panel
// on the right. Behind them, any number of simulated phones (instances.js),
// each joined automatically and playing to the speaker the panel gives it.
//
//   site.js       serves the repo to the pages at phase://site/…
//   guard.js      keeps pages from navigating away
//   instances.js  the simulated phones
//   config.js     saved settings
//   preload.js    the panel's bridge to this process
//   panel/        the simulator panel
//   smoke.js      the automated test (npm run smoke)
// ═══════════════════════════════════════════════════════════════════════════════

const { app, BaseWindow, WebContentsView, ipcMain, dialog, session } = require('electron');
const path = require('path');
const crypto = require('crypto');
const site = require('./site');
const config = require('./config');
const { lockNavigation, SAFE_PREFS } = require('./guard');
const { Instance } = require('./instances');

const SMOKE = process.argv.includes('--smoke'); // automated test: muted, default settings, quits when done
const SMOKE_SITE = (process.argv.find(a => a.startsWith('--site=')) || '').slice(7); // test against another copy of the site
const PANEL_WIDTH = 480;
const MAX_PHONES = 40;
const POLL_MS = 250; // how often the panel's view of the phones refreshes

site.registerScheme();

let cfg = SMOKE ? { ...config.DEFAULTS, site: SMOKE_SITE } : null; // loaded once the app is ready
let room = null;          // the room every page joins
let win = null, conductor = null, panel = null;
let phones = [];          // Instance, phone 1 first
let conductorInfo = null; // the latest CONDUCTOR snapshot

// Same alphabet as the conductor's own room codes (no 0/O, 1/I)
function newRoom() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...crypto.randomBytes(4)].map(x => abc[x % abc.length]).join('');
}

// ── Page addresses ────────────────────────────────────────────────────────────
const base = () => site.siteBase(cfg.site);
function query() {
  const q = new URLSearchParams({ room });
  if (cfg.broker) q.set('broker', cfg.broker);
  return q;
}
const conductorURL = () => `${base()}/ensemble/conductor.html?${query()}`;
const phoneURL     = () => `${base()}/ensemble/index.html?${query()}`;

// ═══════════════════════════════════════════════════════════════════════════════
// WINDOW
// ═══════════════════════════════════════════════════════════════════════════════
function createWindow() {
  win = new BaseWindow({ width: 1560, height: 940, minWidth: 1000, minHeight: 600, title: 'Phase Study Simulator' });

  conductor = new WebContentsView({ webPreferences: { ...SAFE_PREFS, backgroundThrottling: false } });
  panel = new WebContentsView({ webPreferences: { ...SAFE_PREFS, preload: path.join(__dirname, 'preload.js') } });
  win.contentView.addChildView(conductor);
  win.contentView.addChildView(panel);
  layout();
  win.on('resize', layout);

  lockNavigation(conductor.webContents, { site: base() });
  lockNavigation(panel.webContents, { site: base(), popups: false });
  conductor.webContents.loadURL(conductorURL());
  panel.webContents.loadFile(path.join(__dirname, 'panel', 'index.html'));

  win.on('close', confirmClose);
  win.on('closed', () => app.quit());
}

// Conductor fills the left, the panel a fixed column on the right
function layout() {
  const { width, height } = win.getContentBounds();
  conductor.setBounds({ x: 0, y: 0, width: width - PANEL_WIDTH, height });
  panel.setBounds({ x: width - PANEL_WIDTH, y: 0, width: PANEL_WIDTH, height });
}

// Closing the window mid-rehearsal drops every phone from the room: ask first
function confirmClose(ev) {
  if (SMOKE || !phones.length) return;
  const answer = dialog.showMessageBoxSync(win, {
    type: 'question', buttons: ['Quit', 'Cancel'], defaultId: 1, cancelId: 1,
    message: 'Quit the simulator?',
    detail: `${phones.length} simulated phone${phones.length === 1 ? '' : 's'} will leave room ${room}.`,
  });
  if (answer === 1) ev.preventDefault();
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHONES
// ═══════════════════════════════════════════════════════════════════════════════
// Adds or removes phones from the end, so the others stay in the room as they are
function setCount(n) {
  n = Math.max(0, Math.min(MAX_PHONES, n | 0));
  while (phones.length > n) phones.pop().destroy();
  while (phones.length < n) {
    const k = phones.length + 1;
    phones.push(new Instance(k, { url: phoneURL(), site: base(), sink: cfg.sinks[k] || '', muted: SMOKE }));
  }
  cfg.count = n;
  saveConfig();
}

// Every page again, from scratch, in the same room (after changing the site or broker)
function reloadAll() {
  const n = phones.length;
  setCount(0);
  conductor.webContents.loadURL(conductorURL());
  setCount(n);
}

// Sends the conductor page a call to one of its own functions (togglePlay, …)
const conduct = js => conductor.webContents.executeJavaScript(js);

// What the panel shows of the conductor, from the conductor page's globals
const CONDUCTOR = `({
  playing: S.playing, mode: S.mode, groups: comp.groups,
  piece: S.mode === 'score' ? comp.title : S.sound,
  status: document.getElementById('statusTxt').textContent,
  net: document.getElementById('netTxt').textContent,
})`;

// Refreshes the panel a few times a second (one at a time: no pile-up if a page is slow)
async function poll() {
  try {
    await Promise.all(phones.map(p => p.poll()));
    conductorInfo = await conduct(CONDUCTOR).catch(() => null); // null while it loads
    const wc = panel && panel.webContents;
    if (wc && !wc.isDestroyed()) wc.send('update', snapshot());
  } catch (e) {
    // a page went away mid-round (quitting, reloading): try again next round
  } finally {
    setTimeout(poll, POLL_MS);
  }
}

const snapshot = () => ({ room, cfg, conductor: conductorInfo, phones: phones.map(p => p.snapshot()) });

function saveConfig() { if (!SMOKE) config.save(cfg); }

// ═══════════════════════════════════════════════════════════════════════════════
// PANEL → MAIN (see preload.js for the other side)
// ═══════════════════════════════════════════════════════════════════════════════
// Only the panel may call these
function handle(name, fn) {
  ipcMain.handle(name, (ev, ...args) => {
    if (ev.sender !== panel.webContents) throw new Error('not allowed');
    return fn(...args);
  });
}

const phone = n => phones[(n | 0) - 1] || null;

function registerIPC() {
  handle('snapshot', snapshot);
  handle('count', n => setCount(n));

  // { phone number: device label }; '' = system default
  handle('sinks', map => Promise.all(Object.entries(map).map(([n, label]) => {
    label = String(label || '');
    if (label) cfg.sinks[n] = label; else delete cfg.sinks[n];
    return phone(n) && phone(n).setSink(label);
  })).then(saveConfig));

  // A device's name in the room, and whether "Spread" uses it
  handle('speaker', (label, { name, use }) => {
    cfg.speakers[String(label)] = { name: String(name || ''), use: !!use };
    saveConfig();
  });

  // A device appeared or went away: route every phone again
  handle('devices-changed', () => Promise.all(phones.map(p => p.route())));

  handle('test',   n => phone(n) && phone(n).test());
  handle('show',   n => phone(n) && phone(n).show());
  handle('rejoin', n => phone(n) && phone(n).rejoin());

  handle('toggle-play', () => conduct('togglePlay()'));
  handle('identify',    () => conduct('calibrate()')); // every phone beeps in turn (the conductor's level calibration)

  // site and broker: '' for the defaults; otherwise http(s) / ws(s) URLs only
  handle('connection', ({ site: s, broker }) => {
    s = String(s || '').trim(); broker = String(broker || '').trim();
    if (s && !/^https?:\/\//.test(s)) throw new Error('The site must be an http(s):// address');
    if (broker && !/^wss?:\/\//.test(broker)) throw new Error('The broker must be a ws(s):// address');
    cfg.site = s; cfg.broker = broker;
    saveConfig();
    reloadAll();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════════════
app.whenReady().then(() => {
  if (!cfg) cfg = config.load();
  room = newRoom();
  site.prepareSession(session.defaultSession); // the conductor's and the panel's
  registerIPC();
  createWindow();
  setCount(cfg.count);
  poll();
  if (SMOKE) require('./smoke').run({ conductor, panel, phones: () => phones, setCount, snapshot });
});

app.on('window-all-closed', () => app.quit());
