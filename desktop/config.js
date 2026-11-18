// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG — the simulator's settings, saved in the app's user-data folder so a
// rehearsal setup comes back next time.
// ═══════════════════════════════════════════════════════════════════════════════

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

// count     how many simulated phones
// sinks     phone number → the device label it plays to ('' or missing = system default)
// speakers  device label → { name, use }: where that speaker is in the room
//           ("front left"), and whether "Spread" deals phones to it
// site      the site's base URL ('' = the copy built into the app)
// broker    the MQTT broker (?broker=; '' = the site's default)
const DEFAULTS = { count: 4, sinks: {}, speakers: {}, site: '', broker: '' };

const file = () => path.join(app.getPath('userData'), 'simulator.json');

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) }; }
  catch (e) { return { ...DEFAULTS }; } // first launch, or an unreadable file
}

// Saves at most every half second (the panel saves on every change)
let timer = null;
function save(cfg) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try { fs.writeFileSync(file(), JSON.stringify(cfg, null, 2)); }
    catch (e) { console.error('Could not save settings:', e.message); }
  }, 500);
}

module.exports = { DEFAULTS, load, save };
