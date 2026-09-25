# Phase Study

An interactive browser-based exploration of Steve Reich's phasing technique, inspired by *It's Gonna Rain* (1965).

## Concept

*It's Gonna Rain* is a landmark work of early minimalism. Reich recorded a street preacher in San Francisco and discovered — by accident — that two tape loops of the same recording, played simultaneously on slightly out-of-sync machines, drifted apart and realigned in ways that produced hypnotic rhythmic and harmonic interference patterns. This became the defining technique of **phase music**: two identical loops, one running marginally faster than the other, continuously shifting in and out of alignment.

This study makes that process visible and audible in real time: any audio file you drop in is looped in both channels simultaneously, with Voice II playing at a slightly higher playback rate.

## Files

```
index.html         Main HTML document
style.css          All visual styling
script.js          Audio engine, UI logic, and visualization
```

## Features

### Two voices, one loop
Both voices play the same sample. Voice II runs at a ratio slightly above 1.0, causing it to drift ahead of Voice I over time. The offset accumulates until the voices realign — completing a full phase cycle.

### Audio sample
- Pick one of five built-in sounds (`assets/1.wav`–`5.wav`) from the sidebar, or drop or browse any WAV / AIFF / MP3 / OGG file (AIFF is decoded in JavaScript, so it works in every browser)
- Waveform thumbnail, plus a circular playhead display: the loop is one turn around a ring, with one hand per voice and the phase offset shown as an arc between them
- Voice II's position is tracked across speed changes, so pausing phasing holds the current offset

### Controls
| Control | Description |
|---|---|
| Start / Stop | Launch or halt both voices |
| Pause phasing | Freeze Voice II at its current offset |
| Sync voices | Reset both voices to the same position |
| Speed ratio | Voice II playback rate (1.000–1.030) |
| Volume | Master output gain |

## Usage

Live version: https://vigliensoni.github.io/phase-study/

It's a static site with no build step or dependencies: `index.html` loads `style.css` and `script.js` from the same directory. To run it locally, open `index.html` in any modern browser. The built-in sounds need the folder to be served over http, and some browsers also block decoding dropped files on a `file://` page, so serving it is the most reliable option:

```bash
python3 -m http.server   # then open http://localhost:8000
```

Audio files are decoded in the browser and never uploaded anywhere.

## Sound credits

| File | Source | License |
|---|---|---|
| `assets/3.wav` | [arpegio01_loop.wav](https://freesound.org/s/428857/) by supervanz | [Creative Commons 0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `assets/4.wav` | [Bitcrushed Melody Dry](https://freesound.org/s/404959/) by mahammed | [Creative Commons 0](https://creativecommons.org/publicdomain/zero/1.0/) |

## References

- Reich, S. (1965). *It's Gonna Rain*. Tape composition.
- Reich, S. (1968). "Music as a Gradual Process." Essay reprinted in *Writings on Music, 1965–2000*. Oxford University Press.
- Web Audio API — MDN: https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API
