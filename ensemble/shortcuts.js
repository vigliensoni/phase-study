// ═══════════════════════════════════════════════════════════════════════════════
// SHORTCUTS — keyboard shortcuts on the conductor page.
//
// Space starts and stops the piece (the Start / Stop button), like a media
// player. It's left alone while typing in a field or using a menu. On a
// focused button it replaces that button's own click, so after clicking, say,
// Calibrate, Space still means Start / Stop rather than "Calibrate again".
// ═══════════════════════════════════════════════════════════════════════════════

// Where Space has a job of its own: typing, ticking a box, opening a menu
const TYPES_SPACE = 'input:not([type=range]), textarea, select, [contenteditable]';

document.addEventListener('keydown', ev => {
  if (ev.code !== 'Space' || ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
  if (ev.target.closest && ev.target.closest(TYPES_SPACE)) return;
  if (document.querySelector('dialog[open]')) return; // the large QR code is showing
  ev.preventDefault(); // no page scroll, no click on the focused button
  if (!ev.repeat) togglePlay(); // holding Space down toggles once
});
