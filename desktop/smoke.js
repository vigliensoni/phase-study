// ═══════════════════════════════════════════════════════════════════════════════
// SMOKE TEST — `npm run smoke` (add `-- --count=8` for more clients,
// `-- --shots=<folder>` to save screenshots of the window).
//
// Runs the real app end to end against its local backend, and drives it the
// way a person would (clicks on the cards, keys in the panel and on the
// conductor page). Prints each check, then quits with 0 (all passed) or 1.
//
// Sound: if the computer has a loopback device (VB-Cable, BlackHole,
// Loopback…), every client plays into it and the test records it back, so
// solo and channel routing are checked on what really comes out of the
// device. Without one, the clients are silenced and only their own meters and
// read-backs are checked; the recording checks are skipped (and say so).
// ═══════════════════════════════════════════════════════════════════════════════

const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');
const site = require('./site');

const arg = name => (process.argv.find(a => a.startsWith(`--${name}=`)) || '').split('=')[1];
const COUNT = +(arg('count') || 4);
const SHOTS = arg('shots') || null;
const LOOPBACK = /VB-Cable|BlackHole|Loopback|Soundflower/i;
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

// ── Recording the loopback device ─────────────────────────────────────────────
// A hidden page that records the device's input side and reports each
// channel's level (RMS) over a stretch of time
async function recorder(label) {
  const ses = session.fromPartition('smoke-recorder');
  site.prepareSession(ses);
  ses.setPermissionCheckHandler(() => true);
  ses.setPermissionRequestHandler((wc, p, done) => done(p === 'media')); // this page only
  const w = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true,
    backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  await w.loadURL(`${site.ORIGIN}/LICENSE.md`);
  const channels = await w.webContents.executeJavaScript(`(async () => {
    const dev = (await navigator.mediaDevices.enumerateDevices()).find(d => d.kind === 'audioinput' && d.label === ${JSON.stringify(label)});
    if (!dev) return 0;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: dev.deviceId },
      channelCount: { ideal: 32 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const n = stream.getAudioTracks()[0].getSettings().channelCount || 1;
    const ctx = new AudioContext();
    const split = ctx.createChannelSplitter(n);
    ctx.createMediaStreamSource(stream).connect(split);
    const an = [...Array(n)].map((_, i) => { const a = ctx.createAnalyser(); a.fftSize = 2048; split.connect(a, i); return a; });
    const buf = new Float32Array(2048);
    let sums = an.map(() => 0), count = 0;
    setInterval(() => {
      an.forEach((a, i) => { a.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; sums[i] += s / buf.length; });
      count++;
    }, 40);
    window.measure = async ms => { sums = an.map(() => 0); count = 0; await new Promise(r => setTimeout(r, ms)); return sums.map(s => Math.sqrt(s / Math.max(1, count))); };
    await ctx.resume();
    return n;
  })()`);
  return channels ? { channels, measure: ms => w.webContents.executeJavaScript(`measure(${ms})`), close: () => w.close() } : null;
}

async function run({ conductor, panel, phones, setCount, snapshot, backend, transport }) {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  };
  const skip = (name, why) => console.log(`SKIP  ${name}  — ${why}`);
  const conduct = js => conductor.webContents.executeJavaScript(js);
  const inPanel = js => panel.webContents.executeJavaScript(js);
  const playing = () => conduct('S.playing');
  const snaps = () => phones().map(p => p.snapshot());
  const statuses = () => snaps().map(p => p.status);
  const page = (p, js) => p.wc.executeJavaScript(js);
  const gains = () => Promise.all(phones().map(p => page(p, 'window.__sim.info().gain')));

  // The loudest each client gets over `ms` (what it plays, and what's heard)
  async function levels(ms = 1200) {
    const pre = phones().map(() => 0), post = phones().map(() => 0);
    for (let t = 0; t < ms; t += 150) {
      await sleep(150);
      snaps().forEach((p, k) => {
        if (!p.levels) return;
        pre[k] = Math.max(pre[k], p.levels.pre);
        post[k] = Math.max(post[k], p.levels.post);
      });
    }
    return { pre, post };
  }
  const fmtL = v => v.map(x => x.toFixed(2)).join(' ');

  // Keys and clicks, the way the keyboard and mouse send them
  const key = (wc, keyCode, char) => {
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode });
    if (char) wc.sendInputEvent({ type: 'char', keyCode: char });
    wc.sendInputEvent({ type: 'keyUp', keyCode });
  };
  const space = wc => key(wc, 'Space', ' ');
  const clickCard = async (n, modifiers = []) => {
    const r = await inPanel(`(() => { const r = document.querySelector('.card[data-n="${n}"] .num').getBoundingClientRect(); return { x: r.left + 5, y: r.top + 5 }; })()`);
    panel.webContents.focus();
    for (const type of ['mouseDown', 'mouseUp']) panel.webContents.sendInputEvent({ type, x: Math.round(r.x), y: Math.round(r.y), button: 'left', clickCount: 1, modifiers });
    await sleep(150);
  };
  const solo = () => snapshot().solo.sort((a, b) => a - b).join(',');

  async function shot(name) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    for (const [what, view] of [['panel', panel], ['conductor', conductor]]) {
      view.webContents.invalidate();
      const img = await view.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); // painted even behind other windows
      fs.writeFileSync(path.join(SHOTS, `${name}-${what}.png`), img.toPNG());
    }
  }

  // Errors in the panel would otherwise go unseen
  panel.webContents.on('console-message', ({ level, message, lineNumber, sourceId }) => {
    if (level === 'error') console.log(`      panel error: ${message} (${String(sourceId).split('/').pop()}:${lineNumber})`);
  });

  let rec = null;
  try {
    // ── The local backend ─────────────────────────────────────────────────────
    const B = backend();
    check('the local backend is running', !!(B && B.status().running), B && B.url);
    await until('the conductor to connect to it', () => conduct('client.connected'), 15000);
    check('the conductor uses the local backend', (await conduct('BROKER_URL')) === B.url);

    // ── Clients join on their own ─────────────────────────────────────────────
    setCount(COUNT);
    await until('every client to join and sync', () =>
      statuses().length === COUNT && statuses().every(s => s === 'READY — WAITING FOR START'), 30000 + COUNT * 3000)
      .catch(e => { throw new Error(e.message + ' (' + snaps().map(p => `${p.n}: ${p.error || p.status || (p.joined ? '?' : 'joining')}`).join(', ') + ')'); });
    check(`${COUNT} clients joined and synced without a tap`, true, statuses()[0]);
    check('every client uses the local backend',
      (await Promise.all(phones().map(p => page(p, 'BROKER_URL')))).every(u => u === B.url));
    const ids = await Promise.all(phones().map(p => page(p, 'myId')));
    check('every client has its own identity', new Set(ids).size === COUNT, ids.join(' '));
    await until('the conductor to list them', () =>
      conduct(`[...roster.values()].filter(awake).length`).then(n => n === COUNT), 15000);
    check('the conductor lists every client', true);
    check('the backend counts every client', B.status().performers === COUNT && B.status().conductors === 1,
      `${B.status().performers} performers, ${B.status().conductors} conductor`);
    const rtts = snaps().map(p => p.rtt);
    check('clock sync over the local backend is tight', rtts.every(r => r < 20), 'round trips ' + rtts.map(r => r.toFixed(1)).join(' ') + ' ms');

    // ── Outputs ───────────────────────────────────────────────────────────────
    const devices = await inPanel(`devices`);
    check('audio outputs are listed with their names and channels', devices.length > 0,
      devices.map(d => `${d.label} (${d.channels})`).join(', '));
    // Each to a different device (stopped: nothing sounds)
    await Promise.all(phones().map((p, i) => p.setOutput({ device: devices[i % devices.length].label, channels: null })));
    check('each client plays to the device it was given', snaps().every(p => !p.error && p.playingTo === p.output.device),
      snaps().map(p => `${p.n}→${p.playingTo}`).join(' · '));
    const shared = devices[0].label;
    await Promise.all(phones().map(p => p.setOutput({ device: shared, channels: null })));
    check('several clients can share one device', snaps().every(p => p.playingTo === shared));
    // A device that isn't there: that client goes silent instead of playing elsewhere
    const p1 = phones()[0];
    await p1.setOutput({ device: 'No Such Speaker', channels: null });
    const gone = p1.snapshot(), sinkGone = await page(p1, 'window.__sim.info().sink');
    check('a missing device is reported, and its client is silent (not rerouted)',
      gone.error === 'not connected' && sinkGone === 'none', `${gone.error} · sink ${sinkGone}`);
    await p1.setOutput({ device: shared, channels: null });
    check('it plays again once its device is back', !p1.snapshot().error && p1.snapshot().playingTo === shared);

    // ── Sound goes into the loopback device, or the clients stay silent ───────
    const loop = devices.find(d => LOOPBACK.test(d.label));
    if (loop) {
      await Promise.all(phones().map(p => p.setOutput({ device: loop.label, channels: null })));
      phones().forEach(p => p.wc.setAudioMuted(false));
      rec = await recorder(loop.label).catch(e => { console.log('      recorder: ' + e.message); return null; });
      console.log(`      loopback: ${loop.label}, ${loop.channels} channels out${rec ? `, recording ${rec.channels} in` : ', not recordable'}`);
    } else console.log('      no loopback device: clients stay silent, recordings are skipped');

    // A piece where every client plays from the start (one group, a held tone)
    const sine = await conduct(`SCORES.findIndex(s => s.title === 'Sinewave')`);
    await conduct(`selectScore(${sine})`);
    await until('the clients to get the piece', () => snaps().every(p => p.group === 'A'), 10000);

    // ── Space in the panel plays every client ─────────────────────────────────
    space(panel.webContents);
    await until('the conductor to start', playing, 3000);
    check('Space in the panel starts the piece', true);
    await until('every client to play', () => statuses().every(s => s === 'PLAYING'), 15000);
    const epoch = await conduct('S.epoch');
    check('every client plays the same performance',
      (await Promise.all(phones().map(p => page(p, 'run && run.epoch')))).every(e => e === epoch));
    // Where each client is in the score, all measured at the same moment of the shared clock
    const pos = await Promise.all(phones().map(p => page(p, 'sharedNow() - state.T0')));
    const spread = Math.max(...pos) - Math.min(...pos);
    check('every client is at the same point of the timeline', spread < 50, `spread of the measurements ${spread.toFixed(1)} ms`);
    let L = await levels();
    check('every client is making sound', L.post.every(v => v > 0.05), 'heard ' + fmtL(L.post));

    // ── Solo one client: click its card, press S ──────────────────────────────
    await clickCard(2);
    key(panel.webContents, 'S', 's');
    await until('client 2 alone to be soloed', () => solo() === '2', 2000);
    await sleep(300);
    let g = await gains();
    check('S solos the selected client', g.every((v, i) => (phones()[i].n === 2 ? v > 0.99 : v < 0.01)), 'gains ' + fmtL(g));
    L = await levels();
    check('the others are silent but still playing', L.pre.every(v => v > 0.05) &&
      L.post.every((v, i) => (phones()[i].n === 2 ? v > 0.05 : v < 0.001)), `plays ${fmtL(L.pre)} · heard ${fmtL(L.post)}`);
    check('solo does not restart the piece', (await conduct('S.epoch')) === epoch && statuses().every(s => s === 'PLAYING'));

    // ── Group solo: ⌘-click (Ctrl-click) another card, S again ────────────────
    await clickCard(1);
    await clickCard(3, [MOD]);
    key(panel.webContents, 'S', 's');
    await until('clients 1 and 3 to be soloed', () => solo() === '1,3', 2000);
    await sleep(300);
    g = await gains();
    check(`${MOD === 'meta' ? '⌘' : 'Ctrl'}-click and S solo a group (the solo changes without restarting)`,
      g.every((v, i) => ([1, 3].includes(phones()[i].n) ? v > 0.99 : v < 0.01)) && (await conduct('S.epoch')) === epoch, 'gains ' + fmtL(g));
    await shot('solo-group');

    // ── S again clears the solo ───────────────────────────────────────────────
    key(panel.webContents, 'S', 's');
    await until('the solo to clear', () => solo() === '', 2000);
    await sleep(300);
    L = await levels();
    check('S again restores every client', L.post.every(v => v > 0.05), 'heard ' + fmtL(L.post));

    // ── S on the conductor page works too (keys.js) ───────────────────────────
    await inPanel(`selectOnly([${phones()[COUNT - 1].n}])`);
    key(conductor.webContents, 'S', 's');
    await until('the last client to be soloed', () => solo() === String(phones()[COUNT - 1].n), 2000);
    check('S on the conductor page solos too', true);
    key(conductor.webContents, 'S', 's');
    await until('the solo to clear', () => solo() === '', 2000);

    // ── What really comes out of the device ───────────────────────────────────
    if (rec && loop.channels >= 2 && rec.channels >= 2) {
      // Client 1 on channel 1, client 2 on channel 2, the rest silenced
      await phones()[0].setOutput({ device: loop.label, channels: [1] });
      await phones()[1].setOutput({ device: loop.label, channels: [2] });
      const only = async ns => { await Promise.all(phones().map(p => p.setAudible(ns.includes(p.n)))); await sleep(400); return rec.measure(1200); };
      const both = await only([1, 2]), one = await only([1]), two = await only([2]);
      const f = r => r.slice(0, 2).map(v => v.toFixed(3)).join(' / ');
      check('recorded: client 1 alone on channel 1, client 2 alone on channel 2',
        both[0] > 0.01 && both[1] > 0.01 && one[0] > 0.01 && one[1] < 0.001 && two[0] < 0.001 && two[1] > 0.01,
        `ch1 / ch2 RMS: both ${f(both)} · solo 1 ${f(one)} · solo 2 ${f(two)}`);
      const none = await only([]);
      check('recorded: nothing comes out when every client is muted', none.every(v => v < 0.001), 'RMS ' + none.map(v => v.toFixed(4)).join(' '));
      await Promise.all(phones().map(p => p.setAudible(true)));
      await phones()[0].setOutput({ device: loop.label, channels: null });
      await phones()[1].setOutput({ device: loop.label, channels: null });
      // A test tone on its channel, heard even while its client is muted
      await phones()[1].setOutput({ device: loop.label, channels: [2] });
      await Promise.all(phones().map(p => p.setAudible(false)));
      await sleep(300);
      const m = rec.measure(500);
      await sleep(30);
      phones()[1].test();
      const t = await m;
      check('recorded: a test tone comes out of its own channel, even when muted', t[1] > 0.01 && t[0] < 0.001, 'ch1 / ch2 RMS ' + f(t));
      await Promise.all(phones().map(p => p.setAudible(true)));
      await phones()[1].setOutput({ device: loop.label, channels: null });
    } else if (!loop) skip('recorded channel routing', 'no loopback device');
    else skip('recorded channel routing', 'the loopback device needs 2 channels and to be recordable');

    // ── Space pauses; Space again carries on from there ───────────────────────
    const before = await conduct('scoreNow()');
    space(panel.webContents);
    await until('the conductor to stop', async () => !(await playing()), 3000);
    await until('every client to stop', () => statuses().every(s => s.startsWith('READY')), 5000);
    const from = await conduct(`parseTime(document.getElementById('fromCtrl').value)`);
    check('Space pauses every client, and remembers where', from > before && from < before + 1.5, `paused at ${from.toFixed(2)} s`);
    await sleep(1000);
    space(panel.webContents);
    await until('the conductor to start again', playing, 3000);
    await until('every client to play again', () => statuses().every(s => s === 'PLAYING'), 15000);
    const resumed = await conduct('scoreNow()');
    check('Space again carries on from the pause, not from the top', resumed > from - 0.1 && resumed < from + 4, `now at ${resumed.toFixed(2)} s`);

    // ── Space is left alone while typing ──────────────────────────────────────
    await inPanel(`document.getElementById('count').focus()`);
    space(panel.webContents);
    await sleep(800);
    check('Space while typing in a field does nothing', await playing());
    await inPanel(`document.querySelector('.card .out').focus()`);
    space(panel.webContents);
    await sleep(800);
    await inPanel(`document.activeElement.blur()`);
    check('Space on an output menu does nothing', await playing());

    // ── Space on the conductor page (keys.js), then the stop button ───────────
    space(conductor.webContents);
    await until('the conductor to pause', async () => !(await playing()), 3000);
    check('Space on the conductor page pauses too', true);
    await inPanel(`document.getElementById('stop').click()`);
    await sleep(300);
    check('Stop goes back to the start', (await conduct(`parseTime(document.getElementById('fromCtrl').value)`)) === 0);

    // ── Pages stay where they are ─────────────────────────────────────────────
    const url = conductor.webContents.getURL();
    await conduct(`location.href = 'https://example.com/'`);
    await sleep(800);
    check('the conductor cannot be navigated away', conductor.webContents.getURL() === url);

    // ── Showing a client, then closing its window, leaves it in the room ──────
    const first = phones()[0];
    first.show();
    await sleep(500);
    space(first.wc);
    await until('Space on a client’s page to start the piece', playing, 3000);
    check('Space on a shown client’s page plays too', true);
    await inPanel(`document.getElementById('stop').click()`);
    await until('the piece to stop', async () => !(await playing()), 3000);
    first.window.close();
    await sleep(1000);
    check('closing a shown client keeps it running', !first.wc.isDestroyed() && first.snapshot().joined && first.snapshot().synced);

    // ── Removing and adding clients ───────────────────────────────────────────
    await inPanel(`sim.remove([2])`);
    await until('the backend to see it leave', () => B.status().performers === COUNT - 1, 5000);
    await until('the conductor to see it leave', () =>
      conduct(`[...roster.values()].filter(awake).length`).then(n => n === COUNT - 1), 5000);
    check('removing a client leaves the room (the others stay)', phones()[0] === first && !phones().some(p => p.n === 2));
    await inPanel(`sim.add(1)`);
    await until('the new client to join', () => phones().length === COUNT && phones().every(p => p.snapshot().synced), 30000);
    check('adding a client joins it on its own, under the free number', phones()[1].n === 2);
  } catch (e) {
    check('smoke test', false, e.message);
  }
  if (rec) rec.close();

  // What the whole app costs (for the README's numbers)
  const metrics = app.getAppMetrics();
  const mb = metrics.reduce((s, m) => s + m.memory.workingSetSize, 0) / 1024;
  console.log(`      ${COUNT} clients: ${metrics.length} processes · ${Math.round(mb)} MB`);
  const port = backend() && new URL(backend().url).port;

  const failed = results.filter(ok => !ok).length;
  console.log(failed ? `\n${failed} of ${results.length} checks failed` : `\nAll ${results.length} checks passed`);
  console.log(`backend port ${port}`);
  process.exitCode = failed ? 1 : 0;
  app.quit(); // the normal way out: clients leave, the backend stops
}

module.exports = { run };
