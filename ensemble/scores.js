// ═══════════════════════════════════════════════════════════════════════════════
// SCORES — add your own to this list. The conductor shows them in a menu.
//
// `groups` is how many groups the piece needs (3 → A, B, C). Phones are dealt
// into them in join order (A, B, C, A, B, C…), and re-dealt whenever the
// conductor picks another score.
//
// Two kinds of drift:
//   ratio   inside a group — phone k plays (k − 1)·(ratio − 1) faster than
//           the first phone of its group, so the group spreads into a cloud
//   spread  across groups — group B plays (spread − 1) faster than A, C twice
//           that, and so on, so the groups drift against each other
// Both add up: phone k of group j plays at
//   1 + (k − 1)·(ratio − 1) + (j − 1)·(spread − 1)
//
// Event fields
//   at      when: "m:ss" or seconds from the start
//   groups  which groups: "ABC", ["A","D"], or "all" (default: all)
//   play    start sound n (1–5) in those groups
//     ratio   drift inside the group (default: the group's last ratio, or 1)
//     fade    fade-in, seconds
//     level   0–1 (default 1)
//   stop    fade out sound n, or "all"
//     fade    fade-out, seconds
//   ratio   change drift inside the groups
//     glide   seconds to move to the new value (default: instant)
//     sound   only this sound (default: all playing in the group)
//   spread  change drift across groups (the whole piece; `groups` is ignored)
//     glide   seconds to move to the new value
//   level   change loudness; with fade (and optionally sound)
//
// `end` (optional) is when the conductor shows the piece as finished.
// ═══════════════════════════════════════════════════════════════════════════════

const SCORES = [
  {
    title: 'Rain Study I',
    groups: 4,
    events: [
      // Sound 1 in A, B and C: each group spreads slowly, groups stay together
      { at: '0:00', groups: 'AB',  play: 1, ratio: 1.01, fade: 5 },
      // The groups start drifting against each other too
      { at: '0:30', spread: 1.04, glide: 30 },
      // At 2:00 sound 2 fades in on D over a minute…
      { at: '1:00', groups: 'C',    play: 3, ratio: 1.010, fade: 60 },
      { at: '1:00', groups: 'D',    play: 5, ratio: 1.020, fade: 60 },
      // …while A, B, C crossfade from sound 1 to sound 2 over the same minute
      { at: '1:15', groups: 'AB',  stop: 1, fade: 60 },
      { at: '2:15', groups: 'A',  play: 5, ratio: 1.004, fade: 60 },
      // Everyone accelerates inside their group, then everything freezes
      { at: '3:00', groups: 'all',  ratio: 1.03, glide: 20 },
      { at: '4:00', groups: 'all',  ratio: 1.000, glide: 30 },
      { at: '5:00', spread: 1.000, glide: 30 },
      // Sound 3 enters on A and C only, frozen
      { at: '5:30', groups: 'AC',   play: 3, fade: 10, level: 0.8 },
      { at: '6:00', groups: 'all',  stop: 'all', fade: 20 },
    ],
    end: '6:20',
  },

  {
    title: 'Three groups (2 min)',
    groups: 3,
    events: [
      // Both groups in unison, then only the groups drift apart…
      { at: '0:00', groups: 'AB', play: 4, ratio: 1.00, fade: 10 },
      { at: '0:15', ratio: 1.05, glide: 20 },
      { at: '0:15', groups: 'C', play: 7, ratio: 1.05, level: 0.125, fade: 30 },
      // …then each group also blurs inside
      { at: '0:50', ratio: 1.05, glide: 20 },
      { at: '1:30', spread: 1.05, glide: 10 },
      { at: '1:50', stop: 'all', fade: 10 },
    ],
  },

  {
    title: 'Bosque (2 min)',
    groups: 2,
    events: [
      // Both groups in unison, then only the groups drift apart…
      { at: '0:00', groups: 'A', play: 16, ratio: 1.1, fade: 10 },
      { at: '0:10', groups: 'B', play: 16, ratio: 1.1, fade: 20 },
      { at: '1:50', stop: 'all', fade: 10 },
    ],
  },

  {
    title: 'Quick test (1 min)',
    groups: 3,
    events: [
      { at: '0:00', groups: 'AB', play: 1, ratio: 1.01, fade: 2 },
      { at: '0:10', spread: 1.005 },
      { at: '0:15', groups: 'C',  play: 2, ratio: 1.02, fade: 10 },
      { at: '0:30', groups: 'AB', stop: 1, fade: 10 },
      { at: '0:30', groups: 'AB', play: 4, ratio: 1.005, fade: 10 },
      { at: '0:45', groups: 'all', ratio: 1.0, glide: 5 },
      { at: '0:45', spread: 1.0, glide: 5 },
      { at: '0:55', groups: 'all', stop: 'all', fade: 5 },
    ],
  },
];
