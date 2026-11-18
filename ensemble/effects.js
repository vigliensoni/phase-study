// ═══════════════════════════════════════════════════════════════════════════════
// EFFECTS — a group's effect chain, as Web Audio nodes. Shared by the phones
// and the score editor's preview.
//
//   sounds → [effect 1] → [effect 2] → … → destination
//
// compileScore() gives each group's effects as curves over score time (see
// compileEffects in score-engine.js); scheduleChain() lays those curves onto
// the nodes' AudioParams ahead of time, the same way the phones schedule the
// gain envelopes, so every phone changes in step.
// ═══════════════════════════════════════════════════════════════════════════════

// Reverb impulse responses: decaying stereo noise, made once per length
const impulses = new Map(); // `${sampleRate}/${decay}` → AudioBuffer
function impulse(ctx, decay) {
  const key = `${ctx.sampleRate}/${decay}`;
  if (!impulses.has(key)) {
    const n = Math.max(1, Math.round(ctx.sampleRate * decay));
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
    }
    impulses.set(key, buf);
  }
  return impulses.get(key);
}

// One effect → { input, output, params: { setting: [{ param, map }] }, tail }
// `params` lists the AudioParams each score setting drives (mix drives two:
// the wet level, and the dry level as 1 − mix). `tail` is how long it keeps
// sounding after its input stops, in seconds.
function effectNodes(ctx, fx) {
  const same = v => v;
  switch (fx.type) {
    case 'lowpass': case 'highpass': case 'bandpass': {
      const f = ctx.createBiquadFilter();
      f.type = fx.type;
      const params = { q: [{ param: f.Q, map: same }] };
      const extra = [];
      if (fx.lfo) {
        // Sweep the cutoff: centre ± depth, driven by a sine oscillator
        const { min, max } = fx.lfo;
        f.frequency.value = (min + max) / 2;
        const lfo = ctx.createOscillator(), depth = ctx.createGain();
        depth.gain.value = Math.abs(max - min) / 2;
        lfo.connect(depth).connect(f.frequency);
        lfo.start();
        params.rate = [{ param: lfo.frequency, map: same }];
        extra.push(lfo, depth);
      } else {
        params.frequency = [{ param: f.frequency, map: same }];
      }
      return { input: f, output: f, params, extra, tail: 0 };
    }

    case 'reverb': {
      const input = ctx.createGain(), output = ctx.createGain();
      const dry = ctx.createGain(), wet = ctx.createGain();
      const pre = ctx.createDelay(1), conv = ctx.createConvolver();
      pre.delayTime.value = fx.fixed.preDelay;
      conv.buffer = impulse(ctx, fx.fixed.decay);
      input.connect(dry).connect(output);
      input.connect(pre).connect(conv).connect(wet).connect(output);
      return {
        input, output, extra: [dry, wet, pre, conv],
        params: { mix: [{ param: wet.gain, map: same }, { param: dry.gain, map: v => 1 - v }] },
        tail: fx.fixed.decay + fx.fixed.preDelay,
      };
    }

    case 'delay': {
      const input = ctx.createGain(), output = ctx.createGain();
      const dry = ctx.createGain(), wet = ctx.createGain();
      const delay = ctx.createDelay(5), fb = ctx.createGain();
      input.connect(dry).connect(output);
      input.connect(delay).connect(wet).connect(output);
      delay.connect(fb).connect(delay); // echoes feed back into the delay
      return {
        input, output, extra: [dry, wet, delay, fb],
        params: {
          time: [{ param: delay.delayTime, map: same }],
          feedback: [{ param: fb.gain, map: same }],
          mix: [{ param: wet.gain, map: same }, { param: dry.gain, map: v => 1 - v }],
        },
        tail: 10, // echoes at feedback ≤ 0.95 are inaudible well before this
      };
    }

  }
  return null;
}

// A group's whole chain → { input, effects: [{ fx, nodes }], tail, dispose() }.
// Connect the group's sounds to `input`; the chain ends at `destination`.
function buildChain(ctx, effects, destination) {
  const input = ctx.createGain();
  let last = input, tail = 0;
  const built = [];
  for (const fx of effects || []) {
    const nodes = effectNodes(ctx, fx);
    if (!nodes) continue;
    last.connect(nodes.input);
    last = nodes.output;
    tail += nodes.tail;
    built.push({ fx, nodes });
  }
  last.connect(destination);
  return {
    input, effects: built, tail,
    dispose() {
      for (const n of [input, ...built.flatMap(b => [b.nodes.input, b.nodes.output, ...b.nodes.extra])]) {
        try { if (n.stop) n.stop(); } catch (e) {}
        try { n.disconnect(); } catch (e) {}
      }
    },
  };
}

// Lays every effect setting's curve onto its AudioParams, from score time `st`
// (which is context time `at`) onwards. `c` maps score time → context time.
// Safe to call again on the same chain (a phone re-seating mid-piece).
function scheduleChain(chain, st, at, c) {
  for (const { fx, nodes } of chain.effects) {
    for (const [setting, targets] of Object.entries(nodes.params)) {
      const pts = fx.curves[setting];
      if (!pts) continue;
      for (const { param, map } of targets) {
        param.cancelScheduledValues(at);
        param.setValueAtTime(map(valueAt(pts, st)), at);
        scheduleCurve(param, pts.filter(p => p.t > st), c, map); // performer.js
      }
    }
  }
}

// Disconnects a chain once whatever was still sounding through it has died away
function retireChain(ctx, chain, at) {
  if (!chain) return;
  const ms = (Math.max(0, at - ctx.currentTime) + chain.tail + 1) * 1000;
  setTimeout(() => chain.dispose(), ms);
}
