// ═══════════════════════════════════════════════════════════════════════════════
// KEYS — preload for the conductor's and the clients' pages. The simulator's
// shortcuts (Space to play / pause, S to solo, M to mute, Esc) work wherever
// you last clicked, so on those pages they're sent to the panel instead of the
// page. Typing in a field or using a menu is left alone, as in the panel.
//
// Runs in the preload's isolated world and exposes nothing to the page.
// ═══════════════════════════════════════════════════════════════════════════════

const { ipcRenderer } = require('electron');

const TYPING = 'input:not([type=range]):not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable]';
const KEYS = { ' ': 'space', s: 's', S: 's', m: 'm', M: 'm', Escape: 'escape' };

// Capture on window: before the page's own handlers (shortcuts.js gives Space
// a meaning of its own on the conductor page in a browser)
window.addEventListener('keydown', ev => {
  const key = KEYS[ev.key];
  if (!key || ev.altKey || ev.ctrlKey || ev.metaKey) return;
  if (ev.target.closest && ev.target.closest(TYPING)) return;
  if (document.querySelector('dialog[open]')) return; // the large QR code (Esc closes it)
  ev.preventDefault();
  ev.stopImmediatePropagation();
  if (!ev.repeat) ipcRenderer.send('shortcut', key);
}, true);
