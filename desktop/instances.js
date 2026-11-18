// ═══════════════════════════════════════════════════════════════════════════════
// INSTANCES — the simulated phones.
//
// Each one is the real performer page (ensemble/index.html), unchanged, in a
// WebContentsView that isn't shown anywhere: its own renderer process, its own
// session (so its own id and storage, like a separate phone), its own
// AudioContext, clock sync and broker connection. Nothing is shared between
// them, so the room behaves exactly as it would with real phones.
//
// The simulator drives a phone by running small snippets in its page, using
// the performer's own globals (join(), ctx, master, testSound(), state…), so
// performer.js needs no changes for the simulator.
// ═══════════════════════════════════════════════════════════════════════════════

const { WebContentsView, BaseWindow, session } = require('electron');
const { prepareSession } = require('./site');
const { lockNavigation, SAFE_PREFS } = require('./guard');

// ── Snippets run inside a phone's page ────────────────────────────────────────
// What tapping Join does (no tap needed: these pages may start audio on their
// own), plus a level meter on the phone's output, so the panel can show that
// each phone is really making sound.
const JOIN = `(async () => {
  if (!joined) await join();
  if (!window.__simPeak) {
    const an = ctx.createAnalyser(), buf = new Float32Array(512);
    an.fftSize = 512;
    master.connect(an);
    let peak = 0;
    setInterval(() => { an.getFloatTimeDomainData(buf); for (const v of buf) peak = Math.max(peak, Math.abs(v)); }, 20);
    window.__simPeak = () => { const p = peak; peak = 0; return p; }; // loudest since the last read
  }
})()`;

// Sends this phone's AudioContext to the device called `label` ('' = the
// system default), then reads back where it really goes. Device ids are
// different in every session, so the device is found by its name, inside
// the phone's own session.
const SINK = label => `(async () => {
  const outs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput');
  const want = ${JSON.stringify(label)};
  const dev = want ? outs.find(d => d.label === want) : null;
  if (want && !dev) return { ok: false, error: 'speaker not found' };
  const id = dev ? dev.deviceId : '';
  if (ctx.sinkId !== id) await ctx.setSinkId(id);
  const now = outs.find(d => d.deviceId === (ctx.sinkId || 'default'));
  return { ok: true, playingTo: now ? now.label : '' };
})()`;

// What the panel shows for a phone. The performer page draws its own identity
// in an animation frame, which a hidden page doesn't get, so it's worked out
// here from the same globals.
const STATUS = `(() => {
  const S = state, score = !!(S && S.mode === 'score'), a = score ? myAssign(S) : null;
  return {
    status: document.getElementById('statusTxt').textContent,
    label: score ? (a ? a[0] + a[1] : '…') : 'V' + voice, // group + phone (A2), or voice (V3)
    color: score ? (a ? groupColor(a[0], compiledFor(S).groups) : '') : voiceColor(voice),
    group: a ? a[0] : null,
    synced, audio: ctx ? ctx.state : 'off',
    flash: document.body.classList.contains('pinged'),
    peak: window.__simPeak ? window.__simPeak() : 0,
  };
})()`;

// ═══════════════════════════════════════════════════════════════════════════════
// ONE PHONE
// ═══════════════════════════════════════════════════════════════════════════════
class Instance {
  // n      1, 2, 3… (also names its session)
  // url    the performer page, with ?room=
  // sink   the device label it plays to ('' = the system default)
  // muted  silence its output (the automated test), while still metering it
  constructor(n, { url, site, sink = '', muted = false }) {
    this.n = n;
    this.sink = sink;
    this.joined = false;
    this.error = null;     // join or speaker problem, shown on the panel
    this.playingTo = null; // the device it really plays to, read back after routing it
    this.info = null;      // the latest STATUS
    this.window = null;    // the window showing it, while it's shown

    // In memory only, so each launch starts with fresh phones
    const ses = session.fromPartition(`sim-${n}`);
    prepareSession(ses);
    this.view = new WebContentsView({ webPreferences: {
      ...SAFE_PREFS, session: ses,
      backgroundThrottling: false,                 // keep its timers (clock pings, drift checks) running while hidden
      autoplayPolicy: 'no-user-gesture-required',  // so it can join without a tap
    } });
    this.wc = this.view.webContents;
    lockNavigation(this.wc, { site, popups: false });
    this.wc.setAudioMuted(muted);
    this.wc.on('did-finish-load', () => this.join()); // also after a reload
    this.wc.on('render-process-gone', (ev, d) => { this.joined = false; this.error = 'crashed: ' + d.reason; });
    this.wc.loadURL(url);
  }

  async join() {
    this.joined = false;
    this.error = null;
    try {
      await this.wc.executeJavaScript(JOIN);
      this.joined = true;
      await this.route();
    } catch (e) { this.error = 'could not join: ' + e.message; }
  }

  setSink(label) {
    this.sink = label;
    return this.route();
  }

  // Applies `sink` (once joined; join() calls this too)
  async route() {
    if (!this.joined) return;
    try {
      const r = await this.wc.executeJavaScript(SINK(this.sink));
      this.error = r.ok ? null : r.error;
      this.playingTo = r.ok ? r.playingTo : null;
    } catch (e) { this.error = 'speaker: ' + e.message; this.playingTo = null; }
  }

  async poll() {
    if (!this.joined || this.wc.isDestroyed()) return;
    try { this.info = await this.wc.executeJavaScript(STATUS); }
    catch (e) { this.info = null; }
  }

  test()   { return this.joined && this.wc.executeJavaScript('testSound()'); }
  rejoin() { this.wc.reload(); } // same phone (its id survives a reload), joins again on load

  // Shows the phone's own page in a small window, to look at it closely.
  // Closing the window only hides it again: the phone keeps playing.
  show() {
    if (this.window) return this.window.focus();
    const win = this.window = new BaseWindow({ width: 400, height: 760, title: `Phone ${this.n}` });
    win.contentView.addChildView(this.view);
    const fit = () => { const { width, height } = win.getContentBounds(); this.view.setBounds({ x: 0, y: 0, width, height }); };
    fit();
    win.on('resize', fit);
    win.on('close', () => { win.contentView.removeChildView(this.view); this.window = null; });
  }

  destroy() {
    if (this.window) this.window.close();
    if (!this.wc.isDestroyed()) this.wc.close();
  }

  // For the panel (plain data: it goes over IPC)
  snapshot() {
    return { n: this.n, sink: this.sink, joined: this.joined, error: this.error,
             playingTo: this.playingTo, shown: !!this.window, ...(this.info || {}) };
  }
}

module.exports = { Instance };
