// ═══════════════════════════════════════════════════════════════════════════════
// SITE — serves the Phase Study site (the repo root: index.html, ensemble/,
// assets/) to the app's pages at phase://site/…, the way a web server would.
//
// Why not file://: the pages fetch() their sounds, and Chromium blocks fetch()
// on file:// pages. Why not a local http server: a custom scheme opens no port
// on the machine, and is Electron's recommended way to serve app content.
//
// The pages load three libraries from a CDN (mqtt.js, the QR code generator,
// JSZip for the editor). The app carries the very same versions and answers
// those requests itself, so it works without a network.
// ═══════════════════════════════════════════════════════════════════════════════

const { app, protocol, net } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const SCHEME = 'phase';
const ORIGIN = `${SCHEME}://site`;

// Where the site's files are: the repo root while developing, a copy inside
// the app once packaged (see "extraResources" in package.json)
const ROOT = app.isPackaged ? path.join(process.resourcesPath, 'site') : path.resolve(__dirname, '..');

// The CDN addresses in the pages → the same file from npm (same version, pinned
// in package.json). jsDelivr minifies qrcode.js on the fly; the plain file is
// the same code.
const VENDOR_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'vendor') : path.join(__dirname, 'node_modules');
const VENDOR = {
  'https://cdn.jsdelivr.net/npm/mqtt@5.16.0/dist/mqtt.min.js':                 'mqtt/dist/mqtt.min.js',
  'https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/dist/qrcode.min.js':    'qrcode-generator/dist/qrcode.js',
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js':               'jszip/dist/jszip.min.js',
};

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

const notFound = () => new Response('Not found', { status: 404 }); // pages check r.ok to report missing sounds

// Protocol handlers and permissions belong to a session, and every simulated
// phone has its own, so each one is set up here before its page loads.
const ready = new WeakSet();
function prepareSession(ses) {
  if (ready.has(ses)) return;
  ready.add(ses);

  ses.protocol.handle(SCHEME, async req => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url).pathname));
    if (!file.startsWith(ROOT + path.sep)) return notFound(); // no ../ out of the site
    try { return await net.fetch(pathToFileURL(file).toString()); }
    catch (e) { return notFound(); }
  });

  // Every other https request goes out as usual (pieces from GitHub), except
  // the site's web fonts: the app shows it in Helvetica (inject/fonts.css)
  ses.protocol.handle('https', req => {
    const local = VENDOR[req.url];
    if (local) return net.fetch(pathToFileURL(path.join(VENDOR_ROOT, local)).toString());
    if (req.url.startsWith('https://fonts.googleapis.com/')) return new Response('', { headers: { 'content-type': 'text/css' } });
    return net.fetch(req, { bypassCustomProtocolHandlers: true });
  });

  ses.setPermissionCheckHandler((wc, permission) => CHECKS.has(permission));
  ses.setPermissionRequestHandler((wc, permission, done) => done(REQUESTS.has(permission)));
}

// The base URL the pages load from: the built-in copy, or another copy of the
// site (e.g. GitHub Pages or a tunnel), so real phones can join the same room
const siteBase = custom => (custom || ORIGIN).replace(/\/+$/, '');

module.exports = { registerScheme, prepareSession, siteBase, ORIGIN };
