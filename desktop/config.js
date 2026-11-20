// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG — the simulator's settings, saved in the app's user-data folder so a
// rehearsal setup comes back next time. Solo and mute aren't saved: every
// launch starts with all clients audible.
// ═══════════════════════════════════════════════════════════════════════════════

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

// count       how many simulated clients
// outputs     client number → { device, channels }: the device label it plays
//             to ('' = the system default) and its channels (null = as is,
//             [n] = channel n, [n, n + 1] = a stereo pair)
// speakers    device label → { name }: where that speaker is in the room ("front left")
// backend     'local': the broker built into the app (offline, this computer only)
//             'site':  the site's own broker (the public one, or `broker`), so
//                      real phones can join the same room
// site        the site's base URL ('' = the copy built into the app)
// broker      a broker URL for 'site' ('' = the site's default)
// conductor   { shown, width }: the conductor column
const DEFAULTS = {
  count: 4, outputs: {}, speakers: {},
  backend: 'local', site: '', broker: '',
  conductor: { shown: true, width: 560 },
};

const file = () => path.join(app.getPath('userData'), 'simulator.json');

function load() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file(), 'utf8')); }
  catch (e) {} // first launch, or an unreadable file
  return { ...DEFAULTS, ...saved, outputs: { ...saved.outputs }, speakers: { ...saved.speakers },
           conductor: { ...DEFAULTS.conductor, ...saved.conductor } };
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
