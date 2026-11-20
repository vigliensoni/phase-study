// ═══════════════════════════════════════════════════════════════════════════════
// SMOKE TEST — `npm run smoke -- --link=<server link>` (add `--count=8` for more
// clients, `--shots=<folder>` to save screenshots of the window).
//
// Runs the real app end to end against the site at that link (your tunnel, or
// a local server such as http://localhost:8080) and the site's broker, and
// drives it the way a person would (clicks on the card buttons, Space in the
// panel). The clients' pages are muted, so the test makes no sound in the
// room; their meters and read-backs are checked instead. Prints each check,
// then quits with 0 (all passed) or 1.
// ═══════════════════════════════════════════════════════════════════════════════

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const arg = name => (process.argv.find(a => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=');
const COUNT = +(arg('count') || 4);
const SHOTS = arg('shots') || null;
const MOD = process.platform === 'darwin' ? 'meta' : 'control'; // ⌘-click / Ctrl-click

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Waits until fn() is truthy (checking every 200 ms), or fails after `ms`
async function until(what, fn, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (e) {}
    await sleep(200);
  }
  throw new Error('timed out waiting for: ' + what);
}

async function run({ conductor, panel, phones, snapshot }) {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  };
  const conduct = js => conductor.webContents.executeJavaScript(js);
  const inPanel = js => panel.webContents.executeJavaScript(js);
  const snaps = () => phones().map(p => p.snapshot());
  const page = (p, js) => p.wc.executeJavaScript(js);
  const gains = async () => (await Promise.all(phones().map(p => page(p, 'window.__sim.info().gain')))).map(g => +g.toFixed(2));

  // The loudest each client plays over `ms`
  async function levels(ms = 1500) {
    const pre = phones().map(() => 0);
    for (let t = 0; t < ms; t += 150) {
      await sleep(150);
      snaps().forEach((p, k) => { if (p.levels) pre[k] = Math.max(pre[k], p.levels.pre); });
    }
    return pre;
  }

  // Clicks, the way the mouse sends them
  async function click(selector, modifiers = []) {
    const r = await inPanel(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    panel.webContents.focus();
    for (const type of ['mouseDown', 'mouseUp']) panel.webContents.sendInputEvent({ type, x: Math.round(r.x), y: Math.round(r.y), button: 'left', clickCount: 1, modifiers });
    await sleep(250);
  }
  const soloS = (n, modifiers) => click(`.card[data-n="${n}"] .sm-btn.solo`, modifiers);
  const soloed = () => snapshot().solo.sort((a, b) => a - b).join(',');
  const space = async () => {
    await inPanel('document.activeElement && document.activeElement.blur()');
    panel.webContents.focus();
    panel.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    panel.webContents.sendInputEvent({ type: 'char', keyCode: ' ' });
    panel.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await sleep(300);
  };

  async function shot(name) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    for (const [what, view] of [['panel', panel], ['conductor', conductor]]) {
      view.webContents.invalidate();
      const img = await view.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      fs.writeFileSync(path.join(SHOTS, `${name}-${what}.png`), img.toPNG());
    }
  }

  // Errors in the panel would otherwise go unseen
  panel.webContents.on('console-message', ({ level, message, lineNumber, sourceId }) => {
    if (level === 'error') console.log(`      panel error: ${message} (${String(sourceId).split('/').pop()}:${lineNumber})`);
  });

  try {
    const snap0 = snapshot();
    if (!snap0.site) throw new Error('give the server link: npm run smoke -- --link=https://…');
    await until('the panel', () => inPanel('!!window.sim && !!snap'), 15000);
    await inPanel(`sim.setCount(${COUNT})`);

    // ── Connecting through the link ───────────────────────────────────────────
    await until('the conductor to connect', () => conduct('client.connected'), 20000);
    const url = conductor.webContents.getURL();
    check('the conductor loads from the server link', url.startsWith(snap0.site + '/ensemble/conductor.html'), url);
    check('the conductor is in the simulator’s room', (await conduct('room')) === snapshot().room, snapshot().room);
    const broker = await conduct('BROKER_URL');
    check('the conductor uses the site’s broker (no server of its own)', /^wss:\/\//.test(broker) && !/127\.0\.0\.1|localhost/.test(broker), broker);

    await until(`${COUNT} clients to join and sync`, () => snaps().length === COUNT && snaps().every(p => p.joined && p.synced), 60000);
    check(`${COUNT} clients joined and synced without a tap`, true);
    const urls = phones().map(p => p.wc.getURL());
    check('every client loads the performer page from the same link and room',
      urls.every(u => u.startsWith(snap0.site + '/ensemble/index.html') && new URL(u).searchParams.get('room') === snapshot().room));
    const ids = await Promise.all(phones().map(p => page(p, 'myId')));
    check('every client has its own identity', new Set(ids).size === COUNT, ids.join(' '));
    await until('the conductor to list every client', async () => (await conduct('awakeIds().length')) >= COUNT, 20000);
    check('the conductor lists every client', true);

    // ── Outputs ───────────────────────────────────────────────────────────────
    await until('the output menus', () => inPanel(`document.querySelectorAll('.card .out option').length > 0`), 10000);
    const devices = await inPanel('devices.map(d => d.label)');
    check('audio outputs are listed', true, devices.join(' | ') || 'only the default output');
    // The opened list's colours: solid, and its text far from its background
    const menu = await inPanel(`(() => { const o = getComputedStyle(document.querySelector('.card .out option'));
      return { bg: o.backgroundColor, fg: o.color }; })()`);
    const rgb = c => c.match(/[\d.]+/g).map(Number);
    const lum = c => { const [r, g, b] = rgb(c).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const [l1, l2] = [lum(menu.bg), lum(menu.fg)].sort((a, b) => b - a);
    const contrast = (l1 + 0.05) / (l2 + 0.05);
    check('the output menu’s list is readable (solid background, high contrast)',
      (rgb(menu.bg)[3] ?? 1) === 1 && contrast >= 7, `${menu.fg} on ${menu.bg}, contrast ${contrast.toFixed(1)}:1`);
    if (devices.length) {
      const dev = devices[0];
      await inPanel(`sim.setOutputs({ 1: { device: ${JSON.stringify(dev)}, channels: null } })`);
      await until('client 1 to move', () => phones()[0].snapshot().playingTo === dev, 5000).catch(() => {});
      check('a client plays to the device it was given', phones()[0].snapshot().playingTo === dev, phones()[0].snapshot().playingTo);
      await inPanel(`sim.setOutputs({ 1: { device: '', channels: null } })`);
    }
    await shot('1-joined');

    // ── Playing ───────────────────────────────────────────────────────────────
    // A short piece where every group plays from the start, if there is one
    await conduct(`(() => { const s = document.getElementById('scoreSel');
      const o = [...s.options].find(o => /quick test/i.test(o.textContent)) || s.options[0];
      s.value = o.value; s.dispatchEvent(new Event('change')); })()`);
    await sleep(800);
    await space();
    await until('the piece to start', () => conduct('S.playing'), 5000);
    check('Space in the panel starts the conductor', true);
    await until('the clients to play', () => snaps().every(p => p.status === 'PLAYING'), 10000);
    check('every client is playing', true);
    // Some groups come in later in the piece: each client must be heard at some point
    const heard = phones().map(() => 0);
    for (let t = 0; t < 25000 && !heard.every(v => v > 0.01); t += 1500) (await levels()).forEach((v, k) => { heard[k] = Math.max(heard[k], v); });
    check('every client is making sound', heard.every(v => v > 0.01), heard.map(v => v.toFixed(2)).join(' '));

    // ── Solo and mute, with the card buttons ──────────────────────────────────
    const epoch = await conduct('S.epoch');
    await soloS(2);
    check('S on client 2 solos it alone', soloed() === '2' && (await gains()).every((g, i) => (i === 1 ? g > 0.9 : g < 0.1)), (await gains()).join(' '));
    await soloS(3, [MOD]);
    check(`${MOD === 'meta' ? '⌘' : 'Ctrl'}-click S on client 3 adds it`, soloed() === '2,3');
    await soloS(2);
    check('a lit S unsolos that client', soloed() === '3');
    await click(`.card[data-n="1"] .sm-btn.mute`);
    check('M mutes a client', snapshot().mute.includes(1));
    check('the clear button shows while anything is soloed or muted', await inPanel(`!document.getElementById('clearBtn').hidden`));
    await click('#clearBtn');
    await sleep(300);
    check('clear: everyone is heard again', !snapshot().solo.length && !snapshot().mute.length && (await gains()).every(g => g > 0.9), (await gains()).join(' '));
    check('solo and mute never restart the piece', (await conduct('S.epoch')) === epoch && (await conduct('S.playing')));
    await shot('2-playing');

    await space();
    await until('the piece to stop', async () => !(await conduct('S.playing')), 5000);
    check('Space again stops it', true);

    // ── Adding and removing ───────────────────────────────────────────────────
    const first = phones()[0];
    await click(`.card[data-n="2"] .sm-btn[title^="Remove"]`).catch(async () => inPanel('sim.remove([2])'));
    await until('client 2 to go', () => !phones().some(p => p.n === 2), 5000);
    check('removing a client leaves the others as they are', phones()[0] === first);
    await click('#more');
    await until('a client to be added', () => phones().some(p => p.n === 2), 5000);
    check('adding a client gives it the free number', true);

    // ── A bad link ────────────────────────────────────────────────────────────
    const err = await inPanel(`sim.setLink('not a link').then(() => '', e => e.message)`);
    check('a bad link is refused with a message', /web address/.test(err), err.replace(/^.*Error: /, ''));
  } catch (e) {
    check('smoke test', false, e.message);
  }

  const failed = results.filter(ok => !ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  app.exit(failed ? 1 : 0);
}

module.exports = { run };
