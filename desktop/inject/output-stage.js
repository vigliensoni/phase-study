// ═══════════════════════════════════════════════════════════════════════════════
// OUTPUT STAGE — run inside a simulated phone's page once it has joined (it
// uses the performer's own `ctx` and `master`). It's the simulator's mixer
// strip for that phone, added after the performer's sound, which is untouched:
//
//   performer: sounds → effects → scoreBus → master ─┐
//   simulator:                                       ├→ gate → bus → router → speaker
//              test tone (preview) ───────────────────────────┘
//
//   gate     solo / mute. Only the level changes: the phone keeps playing its
//            part in time, so un-muting brings it back where it should be.
//   router   which channels of the speaker it plays to: as is (stereo, the
//            speaker's own layout), one channel, or a pair. Discrete channels
//            are routed with a ChannelMerger as wide as the device.
//   levels   peak meters before the gate (what the phone plays) and after it
//            (what you hear), so a muted phone still shows it's playing.
//
// Defines window.__sim; running it again does nothing.
// ═══════════════════════════════════════════════════════════════════════════════

(() => {
  if (window.__sim) return;

  const gate = ctx.createGain();     // 1 = audible, 0 = muted or soloed out
  const preview = ctx.createGain();  // the simulator's test tone, after the gate (heard even when muted)
  const bus = ctx.createGain();      // gate + preview: always stereo, so a mono phone fills both sides
  bus.channelCount = 2; bus.channelCountMode = 'explicit'; bus.channelInterpretation = 'speakers';

  const meter = () => { const a = ctx.createAnalyser(); a.fftSize = 512; return a; };
  const pre = meter(), post = meter();

  master.disconnect();               // the performer connects it to ctx.destination
  master.connect(gate);
  master.connect(pre);
  gate.connect(bus);
  preview.connect(bus);
  bus.connect(post);

  // ── Levels: the loudest sample since the last read ──────────────────────────
  const buf = new Float32Array(512), peaks = { pre: 0, post: 0 };
  const peakOf = a => { a.getFloatTimeDomainData(buf); let p = 0; for (const v of buf) p = Math.max(p, Math.abs(v)); return p; };
  setInterval(() => {
    peaks.pre = Math.max(peaks.pre, peakOf(pre));
    peaks.post = Math.max(peaks.post, peakOf(post));
  }, 25);
  function levels() { const l = { ...peaks }; peaks.pre = peaks.post = 0; return l; }

  // ── Router ──────────────────────────────────────────────────────────────────
  // channels: null = as is; [n] = channel n alone; [n, n + 1] = left on n,
  // right on n + 1 (channels count from 1)
  let routeNodes = [];
  function wire(channels) {
    bus.disconnect(); bus.connect(post);
    for (const n of routeNodes) n.disconnect();
    routeNodes = [];
    const d = ctx.destination, max = d.maxChannelCount;
    if (!channels) {
      // the AudioContext's defaults: stereo, laid out by the speaker
      d.channelCount = Math.min(2, max); d.channelCountMode = 'explicit'; d.channelInterpretation = 'speakers';
      bus.connect(d);
      return null;
    }
    if (channels.some(c => !(c >= 1 && c <= max))) {
      bus.connect(d); // can't: play as is rather than go quiet
      return `this speaker has ${max} channel${max === 1 ? '' : 's'}`;
    }
    d.channelCount = max; d.channelCountMode = 'explicit'; d.channelInterpretation = 'discrete';
    const merger = ctx.createChannelMerger(max); // its inputs are mono: one channel each
    if (channels.length === 1) bus.connect(merger, 0, channels[0] - 1); // mixed down to mono
    else {
      const split = ctx.createChannelSplitter(2);
      bus.connect(split);
      split.connect(merger, 0, channels[0] - 1);
      split.connect(merger, 1, channels[1] - 1);
      routeNodes.push(split);
    }
    merger.connect(d);
    routeNodes.push(merger);
    return null;
  }

  // ── Output device ───────────────────────────────────────────────────────────
  // Device ids differ in every session, so the device is found by its name in
  // this phone's own session. A device that isn't connected gets no sound at
  // all ({ type: 'none' }: the context keeps running and in time, unheard)
  // rather than falling back to another speaker in the room.
  const sinkKey = s => (typeof s === 'string' ? s : 'none');
  async function setOutput(device, channels) {
    const outs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput');
    const dev = device ? outs.find(d => d.label === device) : null;
    const target = !device ? '' : dev ? dev.deviceId : { type: 'none' };
    if (sinkKey(ctx.sinkId) !== sinkKey(target)) await ctx.setSinkId(target);
    const error = device && !dev ? 'not connected' : wire(channels);
    const now = typeof ctx.sinkId === 'string' && outs.find(d => d.deviceId === (ctx.sinkId || 'default'));
    return {
      playingTo: now ? now.label : null,     // read back from the context
      channels: ctx.destination.maxChannelCount,
      error,
    };
  }

  // ── Solo / mute ─────────────────────────────────────────────────────────────
  let audible = true;
  function setAudible(on) {
    audible = !!on;
    gate.gain.setTargetAtTime(audible ? 1 : 0, ctx.currentTime, 0.008); // ~30 ms, no click
  }

  // ── Test tone ───────────────────────────────────────────────────────────────
  // The performer's own test sound (880 Hz, 0.4 s) through this phone's speaker
  // and channels, heard even if it's muted, and its screen flashes.
  function test() {
    ctx.resume();
    const t = ctx.currentTime + 0.02;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(g).connect(preview);
    o.start(t); o.stop(t + 0.45);
    flash(0);
  }

  window.__sim = {
    setOutput, setAudible, test, levels,
    info: () => ({ gain: gate.gain.value, sink: sinkKey(ctx.sinkId) }), // for the automated test
  };
})();
