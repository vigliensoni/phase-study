// ═══════════════════════════════════════════════════════════════════════════════
// SMOKE TEST — `npm run smoke` (add `-- --count=8` for more phones).
//
// Runs the real app end to end, with every phone muted (their level meters
// still see the sound): phones join on their own, each is routed to a
// different speaker, Space starts and stops them all, Space is ignored while
// typing, score mode deals the phones into groups, and pages can't be
// navigated away. Prints each check, then quits with 0 (all passed) or 1.
// Needs the network: the pages use the public MQTT broker.
// ═══════════════════════════════════════════════════════════════════════════════

const { app } = require('electron');

const arg = process.argv.find(a => a.startsWith('--count='));
const COUNT = arg ? +arg.split('=')[1] : 4;

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

async function run({ conductor, panel, phones, setCount }) {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  };
  const conduct = js => conductor.webContents.executeJavaScript(js);
  const playing = () => conduct('S.playing');
  const statuses = () => phones().map(p => p.snapshot().status);

  // Presses Space in a page, the way the keyboard would
  const space = wc => {
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    wc.sendInputEvent({ type: 'char', keyCode: ' ' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
  };

  try {
    // ── Phones join on their own ──────────────────────────────────────────────
    setCount(COUNT);
    await until('every phone to join and sync', () =>
      statuses().every(s => s === 'READY — WAITING FOR START'), 60000);
    check(`${COUNT} phones joined and synced without a tap`, true, statuses()[0]);
    await until('the conductor to list them', () =>
      conduct(`[...roster.values()].filter(awake).length`).then(n => n === COUNT), 15000);
    check('the conductor lists every phone', true);

    // ── Every phone on its own speaker ────────────────────────────────────────
    const devices = await panel.webContents.executeJavaScript(`navigator.mediaDevices.enumerateDevices()
      .then(ds => ds.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.label).map(d => d.label))`);
    check('audio outputs are listed with their names', devices.length > 0, devices.join(', '));
    await Promise.all(phones().map((p, i) => p.setSink(devices[i % devices.length])));
    const routed = phones().map(p => p.snapshot());
    check('each phone plays to the speaker it was given',
      routed.every(p => !p.error && p.playingTo === p.sink),
      routed.map(p => `${p.n}→${p.playingTo}`).join(' · '));

    // ── Space in the panel starts and stops every phone ───────────────────────
    space(panel.webContents);
    await until('the conductor to start', playing, 3000);
    check('Space in the panel starts the piece', true);
    await until('every phone to play', () => statuses().every(s => s === 'PLAYING'), 15000);
    // The loudest each phone gets over 2 s (a loop can have quiet moments)
    app.getAppMetrics(); // starts the CPU measurement below
    const levels = phones().map(() => 0);
    for (let i = 0; i < 10; i++) {
      await sleep(200);
      phones().forEach((p, k) => { levels[k] = Math.max(levels[k], p.snapshot().peak || 0); });
    }
    check('every phone is playing and making sound', levels.every(v => v > 0.05),
      'peaks ' + levels.map(v => v.toFixed(2)).join(' '));
    // What the whole app costs while playing (for the README's numbers)
    const metrics = app.getAppMetrics();
    const mb = metrics.reduce((s, m) => s + m.memory.workingSetSize, 0) / 1024;
    const cpu = metrics.reduce((s, m) => s + m.cpu.percentCPUUsage, 0);
    console.log(`      ${metrics.length} processes · ${Math.round(mb)} MB · ${Math.round(cpu)}% CPU`);
    space(panel.webContents);
    await until('the conductor to stop', async () => !(await playing()), 3000);
    await until('every phone to stop', () => statuses().every(s => s.startsWith('READY')), 5000);
    check('Space again stops every phone', true);

    // ── Space on the conductor page ───────────────────────────────────────────
    await conduct(`setMode('score')`);
    await until('phones to be dealt into groups', () => phones().every(p => p.snapshot().group), 10000);
    check('score mode deals the phones into groups', true, phones().map(p => p.snapshot().label).join(' '));

    await conduct(`document.getElementById('fromCtrl').focus()`);
    space(conductor.webContents);
    await sleep(800);
    check('Space while typing in a field does not start', !(await playing()));

    await conduct(`document.getElementById('calibBtn').focus()`);
    space(conductor.webContents);
    await until('the score to start', playing, 3000);
    check('Space on a focused button starts, without clicking the button',
      await conduct('calib === null'));
    await until('every phone to play the score', () => statuses().every(s => s.startsWith('PLAYING')), 20000);
    check('every phone plays the score', true);
    space(conductor.webContents);
    await until('the score to stop', async () => !(await playing()), 3000);
    check('Space on the conductor stops the score', true);

    // ── Pages stay where they are ─────────────────────────────────────────────
    const before = conductor.webContents.getURL();
    await conduct(`location.href = 'https://example.com/'`);
    await sleep(800);
    check('the conductor cannot be navigated away', conductor.webContents.getURL() === before);

    // ── Showing a phone, then closing its window, leaves it in the room ───────
    const p1 = phones()[0];
    p1.show();
    await sleep(500);
    p1.window.close();
    await sleep(1000);
    check('closing a shown phone keeps it running', !p1.wc.isDestroyed() && p1.snapshot().joined && p1.snapshot().synced);

    // ── Fewer phones ──────────────────────────────────────────────────────────
    setCount(2);
    check('removing phones keeps the first ones', phones().length === 2 && phones()[0] === p1);
  } catch (e) {
    check('smoke test', false, e.message);
  }

  const failed = results.filter(ok => !ok).length;
  console.log(failed ? `\n${failed} of ${results.length} checks failed` : `\nAll ${results.length} checks passed`);
  app.exit(failed ? 1 : 0);
}

module.exports = { run };
