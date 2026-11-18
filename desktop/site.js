// ═══════════════════════════════════════════════════════════════════════════════
// SITE — serves the Phase Study site (the repo root: index.html, ensemble/,
// assets/) to the app's pages at phase://site/…, the way a web server would.
//
// Why not file://: the pages fetch() their sounds, and Chromium blocks fetch()
// on file:// pages. Why not a local http server: a custom scheme opens no port
// on the machine, and is Electron's recommended way to serve app content.
// ═══════════════════════════════════════════════════════════════════════════════

const { app, protocol, net } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const SCHEME = 'phase';
const ORIGIN = `${SCHEME}://site`;

// Where the site's files are: the repo root while developing, a copy inside
// the app once packaged (see "extraResources" in package.json)
const ROOT = app.isPackaged ? path.join(process.resourcesPath, 'site') : path.resolve(__dirname, '..');

// Must run before the app is ready. "standard" gives the scheme normal URL
// rules (relative links, origins); "secure" lets pages use APIs that need
// https; "supportFetchAPI" lets them fetch() their sounds.
function registerScheme() {
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  }]);
}

// What each page may use. Simulated phones need to see the audio devices'
// names ('media' check) and pick one (speaker-selection); nothing may use the
// microphone or camera, so 'media' *requests* (getUserMedia) are refused.
const CHECKS   = new Set(['media', 'speaker-selection']);
const REQUESTS = new Set(['speaker-selection', 'screen-wake-lock', 'fullscreen']);

// Protocol handlers and permissions belong to a session, and every simulated
// phone has its own, so each one is set up here before its page loads.
const ready = new WeakSet();
function prepareSession(ses) {
  if (ready.has(ses)) return;
  ready.add(ses);

  ses.protocol.handle(SCHEME, async req => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url).pathname));
    if (!file.startsWith(ROOT + path.sep)) return new Response('Not found', { status: 404 }); // no ../ out of the site
    try { return await net.fetch(pathToFileURL(file).toString()); }
    catch (e) { return new Response('Not found', { status: 404 }); } // pages check r.ok to report missing sounds
  });

  ses.setPermissionCheckHandler((wc, permission) => CHECKS.has(permission));
  ses.setPermissionRequestHandler((wc, permission, done) => done(REQUESTS.has(permission)));
}

// The base URL the pages load from: the built-in copy, or another copy of the
// site (e.g. GitHub Pages or a tunnel), so real phones can join the same room
const siteBase = custom => (custom || ORIGIN).replace(/\/+$/, '');

module.exports = { registerScheme, prepareSession, siteBase, ORIGIN };
