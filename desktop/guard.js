// ═══════════════════════════════════════════════════════════════════════════════
// GUARD — keeps each page where it is during a rehearsal. A stray click can't
// navigate the conductor or a phone away (which would drop it from the room);
// links meant for a new tab open in their own window instead, and links to
// other websites open in the system browser.
// ═══════════════════════════════════════════════════════════════════════════════

const { shell } = require('electron');

// Same page, ignoring ?query and #hash (a reload, or the conductor adding ?room=)
const samePage = (a, b) => {
  try { const x = new URL(a), y = new URL(b); return x.origin === y.origin && x.pathname === y.pathname; }
  catch (e) { return false; }
};

// opts.site   the site's base URL: its pages (the score editor, a phone page)
//             may open in an app window; anything else goes to the browser
// opts.popups false: open nothing at all (the simulated phones)
function lockNavigation(wc, { site, popups = true }) {
  wc.on('will-navigate', (ev, url) => { if (!samePage(url, wc.getURL())) ev.preventDefault(); });
  wc.on('will-redirect', (ev, url) => { if (!samePage(url, wc.getURL())) ev.preventDefault(); });

  wc.setWindowOpenHandler(({ url }) => {
    if (!popups) return { action: 'deny' };
    if (url.startsWith(site + '/')) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 1200, height: 860, webPreferences: SAFE_PREFS } };
    }
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Windows opened from here (the editor) get the same guard
  wc.on('did-create-window', win => lockNavigation(win.webContents, { site, popups }));
}

// Electron's recommended defaults, spelled out: the pages are web pages and
// get no Node.js access.
const SAFE_PREFS = { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true };

module.exports = { lockNavigation, SAFE_PREFS };
