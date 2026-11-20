# Phase Study Simulator (desktop)

A desktop app for rehearsing and testing the ensemble without a room full of phones. One window holds a grid of **simulated clients** (each one the real performer page, joined on its own) and the real conductor page beside them. Both load from the **server link** you paste, such as your Cloudflare tunnel, and use the site's own broker, so the simulated clients join the same room real phones would. Each client plays through the output, or the channel of an output, you give it, and you can solo and mute them like tracks on a mixing desk while the piece keeps playing.

## Running it

Needs [Node.js](https://nodejs.org) 20 or later.

```bash
cd desktop
npm install          # once: downloads Electron
npm start            # opens the simulator
```

`npm start` works from VS Code's terminal too (it clears `ELECTRON_RUN_AS_NODE`, which VS Code sets and which would make Electron run as plain Node).

## Using it

1. **Serve the site** and open a tunnel to it, as in the main [README](../README.md) (for example `npx http-server` and `cloudflared tunnel --url http://localhost:8080`).
2. **Server link:** paste the tunnel's address (`https://….trycloudflare.com`), or any page of the site, and press **Load**. The conductor appears on the right and the clients join.
   - With `?room=ABCD` in the link, the simulator joins that room; without it, it makes one up (shown in the toolbar).
   - Real phones can join the same room from the conductor's QR code.
   - Don't also open the conductor for that room in a browser: two conductors would fight over the piece.
3. **Clients:** set how many with **− / +** or type a number. **×** on a card removes that client; the others stay as they are.
4. **Outputs:** each card's menu picks where that client plays: *Stereo* on an output, or one of its channels (*Ch 1 · L*, *Ch 2 · R*, or *Ch 3*, *Ch 3–4*… on a multichannel device). Several clients can share an output. **♪** plays that client's test tone, so you can hear where it is.
5. **Play** with the conductor's own controls. **Space** in the simulator also starts and stops it.

| On a card | |
|---|---|
| **S** | Solo this client alone. A lit **S** unsolos it |
| **Ctrl-click S** (⌘-click on Mac) | Add it to the solo, or take it out |
| **M** | Mute it, or unmute it |
| **♪** | Its test tone, on its output (heard even when muted) |
| **⧉** / **↻** | Show its page in a window / reload it (it keeps its id and group) |

**Clear solo** (shown while anything is soloed or muted) makes everyone audible again.

Solo and mute work like a mixing desk: with nothing soloed every client is heard; once some are soloed only they are, and a muted client stays silent even when soloed. **They only change what you hear.** Every client keeps playing its part on the shared timeline, so a client that comes back in is exactly where it should be. A card that isn't heard is dimmed, and its meter shows both levels: grey for what it plays, bright for what comes out.

The link, the number of clients, their outputs and the conductor's width are saved. Solo and mute aren't: each launch starts with everyone audible.

The conductor's links (the score editor, the join link) open in your web browser, so a click can't take the conductor off its page mid-piece.

## How it works

### One process per client, no copied code

Each simulated client is the **real performer page** (`ensemble/index.html` from your link), unchanged, in a hidden `WebContentsView` with its own in-memory session. That gives every client its own renderer process, `AudioContext`, storage (so its own id), clock sync and broker connection, exactly like separate phones in separate browsers. The simulator drives a client by running short snippets in its page that call the performer's own functions (`join()`, `state`, `scoreHands()`), so nothing in `ensemble/` changes for it.

The cards aren't drawings of clients: everything on them is read from each client's page a few times a second (its status line, group, playhead ring, clock-sync figures, level).

### Audio routing

Each client's page gets a small output stage (`inject/output-stage.js`) after the performer's master volume, which is otherwise untouched:

```
performer:  sounds → effects → master ─┐
simulator:                             ├→ gate (solo / mute) → router (channels) → output device
            test tone ─────────────────┘
```

- **Device:** `AudioContext.setSinkId()` sends the client's whole output to the device. Device ids differ in every session, so devices are matched by name.
- **Channels:** for one channel or a pair, the destination is opened at the device's full channel count with discrete channels, and a `ChannelMergerNode` puts the client's sound on just those channels (mixed down to mono for one channel).
- **Solo / mute** ramp the gate's level (about 30 ms, no click). Playback, scheduling and clock sync carry on underneath.
- **A device that isn't connected:** its clients get no output at all, rather than falling back to another speaker in the room. They keep playing in time, and they're routed back when the device returns.

For many separate channels, use a multichannel interface or a virtual one: [VB-Audio Voicemeeter](https://vb-audio.com/Voicemeeter/) on Windows, [BlackHole](https://existential.audio/blackhole/) on macOS.

### Security

The pages are web pages and get no Node.js: `contextIsolation`, `sandbox`, no `nodeIntegration`. The panel reaches the main process only through the named calls in `preload.js`, accepted only from the panel. Pages may see device names and pick an output, but can't use the microphone or camera. The conductor and the clients can't be navigated away (`guard.js`).

### Look

Calm "liquid glass": neutral translucent layers with a bright rim, rounded capsule controls, sentence case, Helvetica. Colour is kept for state (solo blue, mute orange, a problem red). On macOS the window itself is translucent; elsewhere the same layers sit on a dark or light background, following the system. The site's own pages keep their own look.

### Files

```
main.js              window, server link, clients, solo / mute, the panel's calls
instances.js         one simulated client
inject/output-stage.js   added to each client: device, channels, solo gate, levels, test tone
permissions.js       what the pages may use
guard.js             keeps pages from navigating away
config.js            saved settings
preload.js           the panel's bridge to main.js
panel/               the simulator's interface (html, css, js)
scripts/start.js     npm start / npm run smoke
smoke.js             the automated test
```

## Testing

```bash
npm run smoke -- --link=http://localhost:8080             # 4 clients, against a local copy of the site
npm run smoke -- --link=https://….trycloudflare.com --count=12
npm run smoke -- --link=… --shots=shots                    # also saves screenshots
```

Runs the real app end to end against the site at that link and the site's broker, driving it the way a person would (the card buttons, Space in the panel), and prints PASS / FAIL for each check: the conductor and every client load from the link, in one room, through the site's broker; each client has its own id and the conductor lists them all; outputs are listed and the output menu is readable; a client plays to the device it was given; Space starts and stops the piece and every client makes sound; S, Ctrl-click S, a lit S, M and Clear do what they say without restarting anything; removing and adding a client; a bad link is refused. The clients' pages are muted during the test, so it makes no sound in the room.

## Building a downloadable app

```bash
npm run dist         # portable .exe on Windows, dmg on macOS, AppImage on Linux, in dist/
npm run dist:dir     # just the unpacked app, quicker for a test
```

Each platform builds its own. Pushing a tag such as `simulator-v0.3.0` builds the Windows and macOS apps on GitHub Actions and attaches them to a GitHub Release (`.github/workflows/simulator-release.yml`). Builds aren't code-signed, so the first launch needs right-click → **Open** on macOS, or **More info → Run anyway** on Windows.

## Limitations

- **Needs the internet.** The pages load from your link and use the site's public broker.
- **Channels on macOS follow the speaker setup.** Chromium opens a device with the channels of its *speaker configuration* in Audio MIDI Setup, not every channel the hardware has. Set it to the full channel count (e.g. *Multichannel → 8 channels*) and restart the simulator.
- **Devices are told apart by name.** Two identical devices with the same name can't both be used.
- **Simulated timing is better than real phones'.** No Wi-Fi jitter, and every client shares the computer's audio clock. Mix in real phones for that.
- **Each client is a full browser page** that decodes its own sounds: about 100 MB each.
