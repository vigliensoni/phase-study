// ═══════════════════════════════════════════════════════════════════════════════
// TIMELINE — draws a compiled score: one lane per group, each sound's gain
// envelope as a filled shape with its drift curve dashed on top, the spread
// along the top, and the group's effects at the right end of its lane.
// Shared by the conductor and the score editor.
// ═══════════════════════════════════════════════════════════════════════════════

// Colour by the sound's place in the score (first sound, second sound, …)
const soundHue = (comp, n) => [95, 20, 200, 285, 335, 0, 45, 170, 245][Math.max(0, comp.sounds.indexOf(n)) % 9];

// The corners of a piecewise-linear curve between t0 and t1, for drawing it
// exactly (sampling at even steps would smear a 20 ms attack over seconds)
function curvePoints(pts, t0, t1) {
  return [{ t: t0, v: valueAt(pts, t0) }, ...pts.filter(p => p.t > t0 && p.t < t1),
          { t: t1, v: valueLeft(pts, t1) }];
}

// A layer's loudness as drawn: its gain, times a one-shot's fadeOut if any
function envelopePoints(L, tail, tEnd) {
  const pts = curvePoints(L.gain, L.start, tEnd);
  if (!tail) return pts;
  return [...pts.map(p => ({ t: p.t, v: p.v * valueAt(tail, p.t) })),
          ...tail.filter(p => p.t > L.start && p.t < tEnd).map(p => ({ t: p.t, v: p.v * valueAt(L.gain, p.t) }))]
    .sort((a, b) => a.t - b.t);
}

// opts: {
//   overrides  live drift overrides [{t, d}] (conductor only)
//   now        score time now if playing, else null (ends the open override band)
//   head       where to draw the playhead (or "start from" marker), or null
//   muted      groups drawn grey (muted from the conductor)
//   duration   sound id → its file's length in seconds, if known (one-shots
//              are drawn ending with their file)
// }
// Sets canvas._x2t(px) → score time, for click-to-seek.
function drawScoreTimeline(canvas, comp, { overrides = [], now = null, head = null, muted = [], duration = () => null } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const r0 = canvas.getBoundingClientRect();
  if (!r0.width) return;
  const W = Math.round(r0.width * dpr), H = Math.round(r0.height * dpr);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const c = canvas.getContext('2d');
  c.clearRect(0, 0, W, H);

  const G = comp.groups.length, left = 28 * dpr, top = 16 * dpr;
  const laneH = (H - top) / G;
  const end = Math.max(comp.end, 1);
  const x = t => left + (W - left - 6 * dpr) * (t / end);
  c.font = `${10 * dpr}px 'Space Mono', monospace`;
  c.textBaseline = 'middle';

  // Minute grid
  c.strokeStyle = themeColor('--dim'); c.fillStyle = themeColor('--mid'); c.lineWidth = 1;
  const step = end > 600 ? 120 : end > 180 ? 60 : end > 60 ? 15 : 5;
  for (let t = 0; t <= end; t += step) {
    c.beginPath(); c.moveTo(x(t), top); c.lineTo(x(t), H); c.stroke();
    c.fillText(fmtTime(t), x(t) + 3 * dpr, 7 * dpr);
  }

  // Drift curves are scaled to the largest drift in the score
  const maxD = Math.max(1e-6, ...comp.layers.flatMap(l => effectiveDrift(l, overrides).map(p => p.v)));

  comp.groups.forEach((g, gi) => {
    const y0 = top + gi * laneH, y1 = y0 + laneH;
    const off = muted.includes(g);
    c.fillStyle = off ? themeColor('--dim') : groupColor(g, comp.groups);
    c.fillText(g, 8 * dpr, (y0 + y1) / 2);
    // The group's effect chain, at the right end of its lane
    const fxNames = ((comp.effects && comp.effects[g]) || []).map(fx => fx.id).join(' → ');
    if (fxNames) {
      c.textAlign = 'right'; c.fillStyle = themeColor('--mid');
      c.fillText(fxNames, W - 8 * dpr, y0 + 10 * dpr);
      c.textAlign = 'left';
    }
    c.strokeStyle = themeColor('--dim');
    c.beginPath(); c.moveTo(left, y1); c.lineTo(W, y1); c.stroke();

    // Labels go in rows: a sound starting while another is still playing (or
    // its label still runs on) gets the next row down, so labels never overlap
    const rowH = 12 * dpr, maxRows = Math.max(1, Math.floor((laneH - 4 * dpr) / rowH));
    const rows = [], labels = [];
    for (const L of comp.layers.filter(L => L.group === g).sort((a, b) => a.start - b.start)) {
      // A one-shot ends with its file (shown at normal speed; drift shifts it a little)
      const dur = L.loop === false ? duration(L.sound) : null;
      const fileEnd = dur ? L.start + dur : Infinity;
      const tEnd = Math.min(isFinite(L.stop) ? L.stop : end, fileEnd);
      const hue = soundHue(comp, L.sound);
      // Gain envelope as a filled shape (grey when the group is muted)
      c.fillStyle = off ? 'hsl(0 0% 50% / 0.15)' : `hsl(${hue} 65% 50% / 0.35)`;
      c.strokeStyle = off ? 'hsl(0 0% 50% / 0.5)' : `hsl(${hue} 65% 45%)`;
      c.beginPath();
      c.moveTo(x(L.start), y1 - 2 * dpr);
      for (const p of envelopePoints(L, tailCurve(L, fileEnd), tEnd))
        c.lineTo(x(p.t), y1 - 2 * dpr - (laneH - 8 * dpr) * p.v);
      c.lineTo(x(tEnd), y1 - 2 * dpr);
      c.closePath(); c.fill(); c.stroke();
      // Drift curve (dashed)
      const drift = effectiveDrift(L, overrides);
      c.setLineDash([3 * dpr, 3 * dpr]);
      c.strokeStyle = themeColor(off ? '--dim' : '--fg'); c.lineWidth = 1 * dpr;
      c.beginPath();
      curvePoints(drift, L.start, tEnd).forEach((p, i) => {
        const yy = y1 - 2 * dpr - (laneH - 8 * dpr) * Math.max(0, p.v) / maxD;
        i ? c.lineTo(x(p.t), yy) : c.moveTo(x(p.t), yy);
      });
      c.stroke(); c.setLineDash([]); c.lineWidth = 1;
      // Label: sound and starting ratio, in the first free row (if the lane
      // runs out of rows, the one that frees up soonest)
      const text = `${L.sound} · ${(1 + L.drift[0].v).toFixed(3)}`, lx = x(L.start) + 4 * dpr;
      let row = rows.findIndex(busyTo => busyTo <= lx);
      if (row < 0) row = rows.length < maxRows ? rows.length : rows.indexOf(Math.min(...rows));
      rows[row] = Math.max(lx + c.measureText(text).width + 6 * dpr, x(tEnd));
      labels.push({ text, lx, y: y0 + 10 * dpr + row * rowH });
    }
    // Drawn after the lane's shapes, so no later shape covers them
    c.fillStyle = themeColor(off ? '--mid' : '--fg');
    for (const l of labels) c.fillText(l.text, l.lx, l.y);
  });

  // Spread (across groups): dotted curve + labels in the axis band
  const maxS = Math.max(1e-6, ...comp.spread.map(p => p.v));
  if (comp.spread.some(p => p.v > 0)) {
    c.strokeStyle = themeColor('--cp'); c.lineWidth = 1 * dpr; c.setLineDash([1 * dpr, 2 * dpr]);
    c.beginPath();
    for (let i = 0; i <= 200; i++) {
      const t = end * i / 200, yy = top - 1 * dpr - 5 * dpr * valueAt(comp.spread, t) / maxS;
      i ? c.lineTo(x(t), yy) : c.moveTo(x(t), yy);
    }
    c.stroke(); c.setLineDash([]); c.lineWidth = 1;
    c.fillStyle = themeColor('--cp');
    let prev = null;
    for (const p of comp.spread) {
      if (p.v === prev) continue;
      prev = p.v;
      if (p.t > 0 || p.v > 0) c.fillText(`spread ${(1 + p.v).toFixed(3)}`, x(p.t) + 2 * dpr, top + laneH * G - 8 * dpr);
    }
  }

  // Overrides: band along the top
  overrides.forEach((o, i) => {
    if (o.d === null) return;
    const b = i + 1 < overrides.length ? overrides[i + 1].t : (now !== null ? Math.min(now, end) : o.t);
    c.fillStyle = themeColor('--c2');
    c.fillRect(x(o.t), top - 4 * dpr, Math.max(2, x(b) - x(o.t)), 3 * dpr);
  });

  // Playhead, or the "start from" marker when stopped
  if (head !== null && head >= 0 && head <= end) {
    c.strokeStyle = themeColor('--cp'); c.lineWidth = 2 * dpr;
    c.beginPath(); c.moveTo(x(head), top - 6 * dpr); c.lineTo(x(head), H); c.stroke();
  }
  canvas._x2t = px => (px * dpr - left) / (W - left - 6 * dpr) * end;
}
