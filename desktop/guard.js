// ═══════════════════════════════════════════════════════════════════════════════
// GUARD — keeps each page where it is during a rehearsal. A stray click can't
// navigate the conductor or a phone away (which would drop it from the room).
// On the conductor, links (the score editor, the join link) open in the
// system browser instead; the phones open nothing.
// ═══════════════════════════════════════════════════════════════════════════════

const { shell } = require('electron');

// Same page, ignoring ?query and #hash (a reload, or the conductor adding ?room=)
const samePage = (a, b) => {
  try { const x = new URL(a), y = new URL(b); return x.origin === y.origin && x.pathname === y.pathname; }
  catch (e) { return false; }
};

const toBrowser = url => { if (/^https?:\/\//.test(url)) shell.openExternal(url); };

// opts.external  true: links open in the system browser (the conductor);
//                false: nothing opens (the simulated phones)
function lockNavigation(wc, { external = false } = {}) {
  const keep = (ev, url) => {
    if (samePage(url, wc.getURL())) return;
    ev.preventDefault();
    if (external) toBrowser(url);
  };
  wc.on('will-navigate', keep);
  wc.on('will-redirect', (ev, url) => { if (!samePage(url, wc.getURL())) ev.preventDefault(); });
  wc.setWindowOpenHandler(({ url }) => {
    if (external) toBrowser(url);
    return { action: 'deny' };
  });
}

// Electron's recommended defaults, spelled out: the pages are web pages and
// get no Node.js access.
const SAFE_PREFS = { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true };

module.exports = { lockNavigation, SAFE_PREFS };
