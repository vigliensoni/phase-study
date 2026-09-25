# Phase Study

An interactive browser-based exploration of Steve Reich's phasing technique, inspired by *It's Gonna Rain* (1965).

## Concept

*It's Gonna Rain* is a landmark work of early minimalism. Reich recorded a street preacher in San Francisco and discovered — by accident — that two tape loops of the same recording, played simultaneously on slightly out-of-sync machines, drifted apart and realigned in ways that produced hypnotic rhythmic and harmonic interference patterns. This became the defining technique of **phase music**: two identical loops, one running marginally faster than the other, continuously shifting in and out of alignment.

This study makes that process visible and audible in real time: any audio file you drop in is looped in both channels simultaneously, with Voice II playing at a slightly higher playback rate.

## Files

```
reich-phase.html   Main HTML document
style.css          All visual styling
script.js          Audio engine, UI logic, and visualizations
controller.html    Mobile touch controller (served via the Node server)
server.js          Local HTTP + WebSocket relay server
package.json       Node dependencies (ws)
```

## Features

### Two voices, one loop
Both voices play the same sample. Voice II runs at a ratio slightly above 1.0, causing it to drift ahead of Voice I over time. The offset accumulates until the voices realign — completing a full phase cycle.

### Audio sample
- Drop or browse any WAV / AIFF / MP3 / OGG file (AIFF is decoded in JavaScript, so it works in every browser)
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

### Without the server

Open `reich-phase.html` directly in any modern browser. No build step required — the file loads `style.css` and `script.js` from the same directory. The WebSocket layer is skipped silently when the page is opened as a `file://` URL.

When the page is opened this way, some browsers block local audio decoding over `file://`; use the server instead.

### With the server (enables phone controller)

Requires Node.js.

```bash
npm install   # first time only — installs the ws package
npm start
```

The terminal prints two URLs:

```
Desktop  →  http://localhost:3000
Phone    →  http://192.168.x.x:3000/controller.html
```

Open the desktop URL in Chrome. On your Android phone (same WiFi network), open the phone URL in Chrome. The controller gives you touch sliders for all parameters and transport buttons that stay in sync with the desktop in real time. A small dot (●) in the desktop header turns green when a controller is linked.

## References

- Reich, S. (1965). *It's Gonna Rain*. Tape composition.
- Reich, S. (1968). "Music as a Gradual Process." Essay reprinted in *Writings on Music, 1965–2000*. Oxford University Press.
- Web Audio API — MDN: https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API
