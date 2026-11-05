// ═══════════════════════════════════════════════════════════════════════════════
// PLAYBACK — turns one phone's part of a compiled score into Web Audio nodes:
// a source per sound (looping, or once for a one-shot), with its playback-rate
// curve (drift + spread) and gain envelope scheduled ahead. Shared by the
// phones and the score editor's preview, so the preview plays exactly what a
// phone would.
// ═══════════════════════════════════════════════════════════════════════════════

// Lays a curve's points onto an AudioParam: two points at the same time make
// a step, otherwise a linear ramp. `c` maps score time → context time.
function scheduleCurve(param, pts, c, map) {
  let prevT = null;
  for (const p of pts) {
    if (p.t === prevT) param.setValueAtTime(map(p.v), c(p.t));
    else param.linearRampToValueAtTime(map(p.v), c(p.t));
    prevT = p.t;
  }
}

// Builds every node for the phone of rank `rank` in `group`, from score time
// `st` (= context time `at`) to the end of the piece. Returns the nodes as
// [{ src, gain, L, drift, buffer }].
//   smooth      re-seating while already playing: fade in rather than jump
//   fade        that fade's length (s)
//   overrides   the conductor's live drift overrides
//   bufferFor   L → its decoded AudioBuffer (or null to skip that layer)
//   destination where the sounds go (the group's effect chain)
function scheduleLayers(ctx, comp, { group, rank, st, at, smooth, fade, overrides, bufferFor, destination }) {
  const c = t => at + (t - st);                 // score time → context time
  const nodes = [];
  for (const L of comp.layers) {
    if (L.group !== group || L.stop <= st) continue;
    const buffer = bufferFor(L);
    if (!buffer) continue;
    const drift = effectiveDrift(L, overrides);
    const t0 = Math.max(st, L.start);           // when this node starts sounding
    if (layerDone(L, drift, rank, t0, buffer.duration, comp.spread)) continue; // one-shot already over
    const c0 = t0 === st ? at : c(t0);

    const src = ctx.createBufferSource(), gain = ctx.createGain();
    src.buffer = buffer;
    src.loop = L.loop !== false;
    src.connect(gain).connect(destination);

    // Drift (inside the group) + spread (across groups) → playback rate,
    // following the curves exactly (steps and ramps)
    const rc = rateCurve(L, drift, rank, comp.spread);
    const rate = v => 1 + v;
    src.playbackRate.setValueAtTime(rate(valueAt(rc, t0)), c0);
    scheduleCurve(src.playbackRate, rc.filter(p => p.t > t0), c, rate);

    // Gain envelope (with a short fade-in when re-seating mid-sound)
    const g0 = valueAt(L.gain, t0);
    const midSound = smooth && t0 > L.start;
    gain.gain.setValueAtTime(midSound ? 0 : g0, c0);
    if (midSound) gain.gain.linearRampToValueAtTime(valueAt(L.gain, t0 + fade), c0 + fade);
    scheduleCurve(gain.gain, L.gain.filter(p => p.t > t0 + (midSound ? fade : 0)), c, v => v);

    // One-shot fadeOut: a second gain stage that fades over the end of the file
    const tail = tailCurve(L, L.loop === false ? fileEndTime(L, drift, rank, buffer.duration, comp.spread) : 0);
    if (tail) {
      const tg = ctx.createGain();
      gain.disconnect(); gain.connect(tg).connect(destination);
      tg.gain.setValueAtTime(valueAt(tail, t0), c0);
      scheduleCurve(tg.gain, tail.filter(p => p.t > t0), c, v => v);
    }

    src.start(c0, layerPos(L, drift, rank, t0, buffer.duration, comp.spread));
    if (isFinite(L.stop)) src.stop(c(L.stop) + 0.05);
    nodes.push({ src, gain, L, drift, buffer });
  }
  return nodes;
}
