// ═══════════════════════════════════════════════════════════════════════════════
// SCORE ENGINE — shared by the conductor (timeline, validation) and the phones
// (playback). A score is a list of timed events per group; compileScore() turns
// it into "layers": one sound playing in one group, with a gain envelope and a
// drift curve. Everything is a deterministic function of score time, so every
// phone can work out its own part, and join at any moment.
//
// Two kinds of drift:
//   ratio   inside a group: phone k drifts from phone 1 of its group
//   spread  across groups:  group j drifts from group A
// Phone k of group j (both counted from 0) plays at
//   rate(t) = 1 + k · d(t) + j · s(t),    d = ratio − 1,  s = spread − 1
// and its loop position is
//   pos(t)  = (t − start) + k · ∫ d + j · ∫ s     (from the layer's start to t)
// ═══════════════════════════════════════════════════════════════════════════════

// "2:30" → 150, "1:02.5" → 62.5, 90 → 90
function parseTime(x) {
  if (typeof x === 'number') return x;
  if (typeof x !== 'string') return NaN;
  const parts = x.trim().split(':').map(Number);
  if (parts.some(isNaN)) return NaN;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function fmtTime(s) {
  if (!isFinite(s)) return '∞';
  const sign = s < 0 ? '−' : '';
  s = Math.abs(s);
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${sign}${m}:${String(r).padStart(2, '0')}`;
}

// ── Piecewise-linear curves: [{t, v}], sorted by t; two points at the same t
//    make a step. Before the first point / after the last, the value is held.
function valueAt(pts, t) {
  if (!pts.length) return 0;
  if (t < pts[0].t) return pts[0].v;
  let i = 0;
  while (i + 1 < pts.length && pts[i + 1].t <= t) i++;
  const a = pts[i], b = pts[i + 1];
  if (!b || b.t === a.t) return a.v;
  return a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t);
}

// ∫ from t0 to t1 of the curve (trapezoids over each linear piece)
function integrate(pts, t0, t1) {
  if (!(t1 > t0) || !pts.length) return 0;
  const xs = [t0, t1, ...pts.map(p => p.t).filter(t => t > t0 && t < t1)]
    .sort((a, b) => a - b);
  let sum = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const a = xs[i], b = xs[i + 1];
    if (b <= a) continue;
    // Evaluate just inside the interval so steps at a boundary are handled
    const eps = (b - a) * 1e-9;
    sum += (b - a) * (valueAt(pts, a + eps) + valueAt(pts, b - eps)) / 2;
  }
  return sum;
}

// Value just *before* t (the left side of a step)
function valueLeft(pts, t) {
  if (!pts.length) return 0;
  if (t <= pts[0].t) return pts[0].v;
  let i = 0;
  while (i + 1 < pts.length && pts[i + 1].t < t) i++;
  const a = pts[i], b = pts.find(p => p.t >= t);
  if (!b) return a.v;
  if (b.t === a.t) return b.v;
  return a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t);
}

// wa·A(t) + wb·B(t) as one piecewise-linear curve (keeps steps from either)
function combineCurves(a, wa, b, wb) {
  const ts = [...new Set([...a.map(p => p.t), ...b.map(p => p.t)])].sort((x, y) => x - y);
  const out = [];
  for (const t of ts) {
    const left  = wa * valueLeft(a, t) + wb * valueLeft(b, t);
    const right = wa * valueAt(a, t)   + wb * valueAt(b, t);
    out.push({ t, v: left });
    if (right !== left) out.push({ t, v: right });
  }
  return out.length ? out : [{ t: 0, v: 0 }];
}

// Replace everything after t with a move from the current value to v over `dur`
function rampTo(pts, t, v, dur) {
  const cur = valueAt(pts, t);
  const kept = pts.filter(p => p.t <= t);
  kept.push({ t, v: cur });
  kept.push({ t: t + Math.max(0, dur), v });
  return kept;
}

// ── Compile ───────────────────────────────────────────────────────────────────
function compileScore(score, nSounds = 5) {
  const errors = [];
  // groups: a number (3 → A, B, C) or a list of names; default 4
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let groups = ['A', 'B', 'C', 'D'];
  if (score && typeof score.groups === 'number') {
    const n = Math.max(1, Math.min(26, Math.floor(score.groups)));
    if (n !== score.groups) errors.push(`groups: ${score.groups} → ${n}`);
    groups = LETTERS.slice(0, n).split('');
  } else if (score && Array.isArray(score.groups) && score.groups.length) {
    groups = score.groups.map(String);
  }

  const expandGroups = (g, i) => {
    if (g === undefined || g === 'all' || g === '*') return groups;
    const list = Array.isArray(g) ? g.map(String) : String(g).split('');
    const bad = list.filter(x => !groups.includes(x));
    if (bad.length) errors.push(`event ${i + 1}: unknown group ${bad.join(', ')}`);
    return list.filter(x => groups.includes(x));
  };

  const events = ((score && score.events) || [])
    .map((e, i) => ({ ...e, i, t: parseTime(e.at) }))
    .filter(e => {
      if (!isFinite(e.t)) { errors.push(`event ${e.i + 1}: bad time "${e.at}"`); return false; }
      return true;
    })
    .sort((a, b) => a.t - b.t || a.i - b.i);

  const layers = [];
  const active = {};                         // group → Map(sound → layer)
  const groupRatio = {};                     // last ratio set per group
  groups.forEach(g => { active[g] = new Map(); groupRatio[g] = 1; });
  let spread = [{ t: 0, v: 0 }];             // spread − 1, over the whole piece

  for (const e of events) {
    const gs = expandGroups(e.groups, e.i);
    const fade = Math.max(0, +(e.fade ?? 0));

    // Spread is piece-wide: it sets how far apart the groups drift
    if (e.spread !== undefined) {
      spread = rampTo(spread, e.t, +e.spread - 1, Math.max(0, +(e.glide ?? 0)));
      if (e.play === undefined && e.stop === undefined && e.ratio === undefined && e.level === undefined) continue;
    }

    if (e.play !== undefined) {
      const n = +e.play;
      if (!(n >= 1 && n <= nSounds)) { errors.push(`event ${e.i + 1}: no sound ${e.play}`); continue; }
      for (const g of gs) {
        if (e.ratio !== undefined) groupRatio[g] = +e.ratio;
        if (active[g].has(n)) { errors.push(`event ${e.i + 1}: sound ${n} already playing in ${g}`); continue; }
        const level = e.level ?? 1;
        const L = {
          id: `${g}${n}@${e.t}`, group: g, gi: groups.indexOf(g), sound: n, start: e.t, stop: Infinity,
          gain:  [{ t: e.t, v: 0 }, { t: e.t + Math.max(fade, 0.02), v: level }],
          drift: [{ t: e.t, v: groupRatio[g] - 1 }],
        };
        active[g].set(n, L);
        layers.push(L);
      }
      continue;
    }

    const targets = g => {
      const m = active[g];
      if (e.sound === undefined || e.sound === 'all') return [...m.values()];
      return m.has(+e.sound) ? [m.get(+e.sound)] : [];
    };

    if (e.stop !== undefined) {
      for (const g of gs) {
        const ls = e.stop === 'all' ? [...active[g].values()]
                 : active[g].has(+e.stop) ? [active[g].get(+e.stop)] : [];
        for (const L of ls) {
          const f = Math.max(fade, 0.05);
          L.gain = rampTo(L.gain, e.t, 0, f);
          L.stop = e.t + f;
          active[g].delete(L.sound);
        }
      }
      continue;
    }

    if (e.ratio !== undefined) {
      const glide = Math.max(0, +(e.glide ?? 0));
      for (const g of gs) {
        groupRatio[g] = +e.ratio;
        for (const L of targets(g)) L.drift = rampTo(L.drift, e.t, +e.ratio - 1, glide);
      }
    }
    if (e.level !== undefined) {
      for (const g of gs) for (const L of targets(g)) L.gain = rampTo(L.gain, e.t, +e.level, fade);
    }
  }

  const lastT = Math.max(0, ...layers.map(L => isFinite(L.stop) ? L.stop : L.start),
                            ...events.map(e => e.t + (+e.fade || 0) + (+e.glide || 0)));
  const end = isFinite(parseTime(score && score.end)) ? parseTime(score.end) : lastT;

  return { title: (score && score.title) || 'Untitled', groups, layers, spread, end, errors };
}

// ── Live override (the conductor's slider) ────────────────────────────────────
// overrides: [{t, d}] in score seconds; d = ratio − 1, or null = back to score.
function effectiveDrift(L, overrides) {
  let pts = L.drift;
  if (!overrides || !overrides.length) return pts;
  for (let i = 0; i < overrides.length; i++) {
    const o = overrides[i];
    if (o.d === null || o.d === undefined) continue;
    const a = o.t, b = i + 1 < overrides.length ? overrides[i + 1].t : Infinity;
    const va = valueAt(pts, a);
    const vb = isFinite(b) ? valueAt(pts, b) : null;
    const before = pts.filter(p => p.t < a);
    const after  = isFinite(b) ? pts.filter(p => p.t > b) : [];
    pts = [...before, { t: a, v: va }, { t: a, v: o.d },
           ...(isFinite(b) ? [{ t: b, v: o.d }, { t: b, v: vb }] : []), ...after];
  }
  return pts;
}

// Loop position (seconds into the buffer) of the phone of rank k at score time t
function layerPos(L, drift, rank, t, dur, spread) {
  const p = (t - L.start) + (rank - 1) * integrate(drift, L.start, t)
          + (spread ? L.gi * integrate(spread, L.start, t) : 0);
  return ((p % dur) + dur) % dur;
}

// Playback-rate curve (minus 1) for phone `rank` of this layer's group
function rateCurve(L, drift, rank, spread) {
  return combineCurves(drift, rank - 1, spread || [{ t: 0, v: 0 }], L.gi);
}

// Round-robin group assignment: slot 0 → A/1, 1 → B/1, … G → A/2, …
function slotToAssign(slot, groups) {
  return [groups[slot % groups.length], Math.floor(slot / groups.length) + 1];
}

// Group colours (A, B, C, D, …)
function groupColor(g, groups) {
  const i = Math.max(0, groups.indexOf(g));
  const hues = [95, 20, 200, 285, 335, 45, 170, 245];
  return `hsl(${hues[i % hues.length]} 70% 50%)`;
}
