// ═══════════════════════════════════════════════════════════════════════════════
// SCORES — add your own to this list. The conductor shows them in a menu.
//
// Phones are dealt into groups in join order (A, B, C, D, A, B, …). Inside a
// group, each phone drifts a little faster than the previous one:
//   phone k of a group plays at 1 + (k − 1) · (ratio − 1)
// so the first phone of each group is the reference, and `ratio` sets how
// quickly the group spreads apart.
//
// Event fields
//   at      when: "m:ss" or seconds from the start
//   groups  which groups: "ABC", ["A","D"], or "all" (default: all)
//   play    start sound n (1–5) in those groups
//     ratio   drift for this group (default: the group's last ratio, or 1)
//     fade    fade-in, seconds
//     level   0–1 (default 1)
//   stop    fade out sound n, or "all"
//     fade    fade-out, seconds
//   ratio   change drift of the sounds playing in those groups
//     glide   seconds to move to the new ratio (default: instant)
//     sound   only this sound (default: all playing in the group)
//   level   change loudness; with fade (and optionally sound)
//
// `end` (optional) is when the conductor shows the piece as finished.
// ═══════════════════════════════════════════════════════════════════════════════

const SCORES = [
  {
    title: 'Rain Study I',
    groups: ['A', 'B', 'C', 'D'],
    events: [
      // Sound 1 in A, B and C, spreading slowly
      { at: '0:00', groups: 'A',  play: 4, ratio: 1.01, fade: 0 },
      // At 2:00 sound 2 fades in on D over a minute…
      { at: '0:30', groups: 'B', play: 1, ratio: 1.010, fade: 60 },
      // …while A, B, C crossfade from sound 1 to sound 2 over the same minute
      { at: '2:00', groups: 'ABC',  stop: 1, fade: 60 },
      { at: '2:00', groups: 'ABC',  play: 2, ratio: 1.004, fade: 60 },
      // Everyone accelerates the drift, then freezes the phases
      { at: '4:00', groups: 'all',  ratio: 1.015, glide: 20 },
      { at: '5:00', groups: 'all',  ratio: 1.000, glide: 30 },
      // Sound 3 enters on A and C only, still frozen
      { at: '5:30', groups: 'AC',   play: 3, ratio: 1.000, fade: 10, level: 0.8 },
      { at: '6:00', groups: 'all',  stop: 'all', fade: 20 },
    ],
    end: '6:20',
  },

  {
    title: 'Quick test (1 min)',
    groups: ['A', 'B', 'C', 'D'],
    events: [
      { at: '0:00', groups: 'AB', play: 1, ratio: 1.01, fade: 2 },
      { at: '0:15', groups: 'CD', play: 2, ratio: 1.02, fade: 10 },
      { at: '0:30', groups: 'AB', stop: 1, fade: 10 },
      { at: '0:30', groups: 'AB', play: 4, ratio: 1.005, fade: 10 },
      { at: '0:45', groups: 'all', ratio: 1.0, glide: 5 },
      { at: '0:55', groups: 'all', stop: 'all', fade: 5 },
    ],
  },
];
