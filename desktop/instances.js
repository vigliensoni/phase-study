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
// the performer's own globals (join(), ctx, master, state…), plus its own
// output stage (inject/output-stage.js) for speaker, channels and solo, so
// performer.js needs no changes for the simulator.
// ═══════════════════════════════════════════════════════════════════════════════

const { WebContentsView, BaseWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { prepareSession } = require('./site');
const { lockNavigation, SAFE_PREFS } = require('./guard');

const OUTPUT_STAGE = fs.readFileSync(path.join(__dirname, 'inject', 'output-stage.js'), 'utf8');

// ── Snippets run inside a phone's page ────────────────────────────────────────
// What tapping Join does (no tap needed: these pages may start audio on their
// own), then the simulator's output stage after the phone's master volume
const JOIN = `(async () => {
  if (!joined) await join();
  ${OUTPUT_STAGE}
})()`;

// What the panel shows for a phone. A hidden page gets no animation frames, so
// what the performer draws in its render loop (identity, ring, "now") is
// worked out here from the same globals and functions.
const STATUS = `(() => {
  const S = state, a = S ? myAssign(S) : null, comp = S ? compiledFor(S) : null;
  const hands = S ? scoreHands(S) : []; // also fills in #nowTxt
  return {
    status: document.getElementById('statusTxt').textContent,
    now: document.getElementById('nowTxt').textContent,
    label: a ? a[0] + a[1] : '·',                    // group + phone in the group: A2
    group: a ? a[0] : null,
    color: a ? groupColor(a[0], comp.groups) : '',
    groupMuted: !!(S && isMuted(S)),                   // muted from the conductor's timeline
    hands: hands.map(h => ({ pos: h.pos, color: h.color, width: h.width })),
    connected: !!(client && client.connected), synced,
    jitter, rtt: minRtt,
    flash: document.body.classList.contains('pinged'),
    levels: window.__sim ? window.__sim.levels() : null,
  };
})()`;

const call = (fn, ...args) => `window.__sim.${fn}(${args.map(a => JSON.stringify(a)).join(', ')})`;

// ═══════════════════════════════════════════════════════════════════════════════
// ONE PHONE
// ═══════════════════════════════════════════════════════════════════════════════
class Instance {
  // n        its number in the simulator (also names its session)
  // url      the performer page, with ?room= and ?broker=
  // output   { device, channels }: the speaker it plays to ('' = the system
  //          default) and which of its channels (null = as is)
  // audible  false: soloed out or muted (it keeps playing, unheard)
  // muted    silence the whole page (the automated test without a loopback device)
  constructor(n, { url, site, output, audible = true, muted = false }) {
    this.n = n;
    this.output = output;
    this.audible = audible;
    this.joined = false;
    this.error = null;     // join or speaker problem, shown on its card
    this.routed = null;    // what the output stage reports after routing: { playingTo, channels, layout, error }
    this.info = null;      // the latest STATUS
    this.window = null;    // the window showing its page, while it's shown
    this.flashUntil = 0;   // lit by a test tone (the page's own flash can be missed between polls)

    // In memory only, so each launch starts with fresh phones
    const ses = session.fromPartition(`sim-${n}`);
    prepareSession(ses);
    this.view = new WebContentsView({ webPreferences: {
      ...SAFE_PREFS, session: ses,
      preload: path.join(__dirname, 'keys.js'),     // the simulator's shortcuts work on its page too (⧉)
      backgroundThrottling: false,                 // keep its timers (clock pings, drift checks) running while hidden
      autoplayPolicy: 'no-user-gesture-required',  // so it can join without a tap
    } });
    this.wc = this.view.webContents;
    lockNavigation(this.wc, { site, popups: false });
    this.wc.setAudioMuted(muted);
    this.wc.on('did-start-loading', () => { this.joined = false; this.info = null; });
    this.wc.on('did-finish-load', () => this.join()); // also after a reload
    this.wc.on('render-process-gone', (ev, d) => { this.joined = false; this.info = null; this.error = 'crashed: ' + d.reason; });
    this.wc.loadURL(url);
  }

  run(js) { return this.wc.isDestroyed() ? Promise.reject(new Error('closed')) : this.wc.executeJavaScript(js); }

  async join() {
    this.joined = false;
    this.error = null;
    try {
      await this.run(JOIN);
      this.joined = true;
      await this.run(call('setAudible', this.audible));
      await this.route();
    } catch (e) { this.error = 'could not join: ' + e.message; }
  }

  setOutput(output) {
    this.output = output;
    return this.route();
  }

  // Applies `output` (once joined; join() calls this too), and reads back
  // where the sound really goes
  async route() {
    if (!this.joined) return;
    try { this.routed = await this.run(call('setOutput', this.output.device, this.output.channels)); }
    catch (e) { this.routed = { error: e.message }; }
  }

  async setAudible(on) {
    this.audible = !!on;
    if (this.joined) await this.run(call('setAudible', this.audible)).catch(() => {});
  }

  async poll() {
    if (!this.joined) return;
    try { this.info = await this.run(STATUS); }
    catch (e) { this.info = null; }
  }

  test() {
    if (!this.joined) return;
    this.flashUntil = Date.now() + 450;
    return this.run(call('test')).catch(() => {});
  }

  rejoin() { this.wc.reload(); } // same phone (its id survives a reload), joins again on load

  // Shows the phone's own page in a small window, to look at it closely.
  // Closing the window only hides it again: the phone keeps playing.
  show() {
    if (this.window) return this.window.focus();
    const win = this.window = new BaseWindow({ width: 400, height: 760, title: `Client ${this.n}` });
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
    const i = this.info || {};
    return {
      n: this.n, output: this.output, joined: this.joined,
      error: this.error || (this.routed && this.routed.error) || null,
      playingTo: this.routed ? this.routed.playingTo : null,
      deviceChannels: this.routed ? this.routed.channels : null,
      ...i,
      flash: !!i.flash || Date.now() < this.flashUntil,
    };
  }
}

module.exports = { Instance };
