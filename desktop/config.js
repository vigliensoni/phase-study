// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG — the simulator's settings, saved in the app's user-data folder so a
// rehearsal setup comes back next time. Solo and mute aren't saved: every
// launch starts with all clients audible.
// ═══════════════════════════════════════════════════════════════════════════════

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

// link        the server link: the site's address (e.g. the Cloudflare tunnel),
//             or any page of it, optionally with ?room=ABCD ('' = none yet)
// count       how many simulated clients
// outputs     client number → { device, channels }: the device label it plays
//             to ('' = the default output) and its channels (null = as is,
//             [n] = channel n, [n, n + 1] = a stereo pair)
// conductor   { shown, width }: the conductor column
const DEFAULTS = {
  link: '', room: '', count: 4, outputs: {},
  conductor: { shown: true, width: 560 },
};

const file = () => path.join(app.getPath('userData'), 'simulator.json');

function load() {
  let saved = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed;
  }
  catch (e) {
    if (e.code !== 'ENOENT') console.error('Could not load settings:', e.message);
  }
  return {
    link: typeof saved.link === 'string' ? saved.link : DEFAULTS.link,
    room: typeof saved.room === 'string' ? saved.room : DEFAULTS.room,
    count: Number.isFinite(saved.count) ? saved.count : DEFAULTS.count,
    outputs: saved.outputs && typeof saved.outputs === 'object' ? { ...saved.outputs } : {},
    conductor: { ...DEFAULTS.conductor, ...(saved.conductor || {}) },
  };
}

// Saves at most every half second (the panel saves on every change)
let timer = null;
let pending = null;
function write() {
  if (!pending) return;
  try { fs.writeFileSync(file(), JSON.stringify(pending, null, 2)); }
  catch (e) { console.error('Could not save settings:', e.message); }
  pending = null;
}

function save(cfg) {
  clearTimeout(timer);
  pending = cfg;
  timer = setTimeout(write, 500);
}

function flush() {
  clearTimeout(timer);
  write();
}

module.exports = { DEFAULTS, load, save, flush };
