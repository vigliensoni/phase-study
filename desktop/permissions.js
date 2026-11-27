// ═══════════════════════════════════════════════════════════════════════════════
// PERMISSIONS — what each page may use. Simulated phones need to see the audio
// devices' names ('media' check) and pick one (speaker-selection); nothing may
// use the microphone or camera, so 'media' *requests* (getUserMedia) are refused.
//
// Permissions belong to a session, and every simulated phone has its own, so
// each one is set up before its page loads.
// ═══════════════════════════════════════════════════════════════════════════════

const CHECKS   = new Set(['media', 'speaker-selection']);
const REQUESTS = new Set(['speaker-selection', 'screen-wake-lock', 'fullscreen']);

const ready = new WeakSet();
function prepareSession(ses) {
  if (ready.has(ses)) return;
  ready.add(ses);
  ses.setPermissionCheckHandler((wc, permission) => CHECKS.has(permission));
  ses.setPermissionRequestHandler((wc, permission, done) => done(REQUESTS.has(permission)));
}

module.exports = { prepareSession };
