# Phase Study Simulator (desktop)

A desktop app for rehearsing and testing the ensemble without a room full of phones. One window holds a grid of **simulated clients** (each one a real performer page, joined on its own), the real conductor page beside them, and a **local backend** they all connect to. Each client plays through the speaker, or the channel of a speaker, you give it, and you can solo and mute them like tracks on a mixing desk while the piece keeps playing.

## Running it

Needs [Node.js](https://nodejs.org) 20 or later.

```bash
cd desktop
npm install          # once: downloads Electron
npm start            # opens the simulator
```

If you run it from a terminal inside VS Code and Electron behaves like plain Node, unset `ELECTRON_RUN_AS_NODE` (VS Code sets it): `env -u ELECTRON_RUN_AS_NODE npm start`.

## Using it

The window has three parts: the **toolbar** (transport, backend, room), the **workspace** (speakers, then one card per client), and the **conductor** on the right (drag its edge to resize it, or hide it with **Conductor**).

1. **Clients.** Set how many with **− / +** or type a number. New clients load, join the room and sync their clock on their own, with no Join tap. **×** on a card removes that client; the others stay as they are.
2. **Speakers.** Each card has an output menu: a device, and either *stereo* (as the client normally plays) or one of the device's channels (*ch 1 · L*, *ch 2 · R*, or *ch 3*, *ch 3–4*… on a multichannel device). **Route…** assigns many at once: each client to its own speaker, each to its own channel of one device, one group per speaker, or all to one place. Several clients can share an output.
3. **Check the room.** The speaker tiles show which clients play where, light up while they sound, and take a name for where the speaker stands ("front left"). **♪ Identify** plays each client's test tone in turn (the selection, or everyone); **♪** on a card or a speaker tile does the same for that client or that speaker's clients. Test tones are heard even on muted clients.
4. **Play.** Pick a piece on the conductor, then press **Space** (or ▶). Space again pauses; ▶ carries on from where it paused. ■ stops and goes back to the start. Space, S and M also work after clicking in the conductor or in a client's own page (except while typing in a field or using a menu).

### Selecting, solo and mute

| | |
|---|---|
| Click a card | select it |
| ⌘-click (Ctrl-click on Windows / Linux) | add it to the selection, or take it out |
| ⇧-click | select a range |
| ⌘A, arrow keys, Esc | select all, move the selection, deselect |
| Click a speaker tile or one of its lanes | select the clients playing there |
| **S** | solo the selection; **S** again (or with nothing selected) clears the solo |
| **M** | mute the selection, or unmute it |
| **T** | test tone of each selected client |
| **S** button on a card | solo that client alone; ⌘-click adds it to the solo |

Solo and mute work like a mixing desk: with nothing soloed every client is heard; once some are soloed only they are, and a muted client stays silent even when soloed. **They only change what you hear.** Every client keeps playing its part on the shared timeline, so a client that's un-soloed comes back in exactly where it should be, and changing the solo never restarts or shifts anything. A card that isn't heard is dimmed and its meter shows both levels: grey for what it plays, bright for what comes out.

Solo and mute aren't saved: each launch starts with everyone audible. The number of clients, their outputs, speaker names and the conductor's width are saved.

### Real phones as well

The local backend runs on this computer only (127.0.0.1), so only simulated clients can join it. To mix real phones into the same room, click the backend pill and choose **Site's broker** (the public broker the site uses), and set **Site** to a public copy of the site (GitHub Pages, or this computer through a tunnel; see the main [README](../README.md)). The conductor's QR code then points there.

## How it works

### One process per client, no copied code

Each simulated client is the **real performer page** (`ensemble/index.html`), unchanged, in a hidden `WebContentsView` with its own in-memory session. That gives every client its own renderer process, `AudioContext`, storage (so its own id), clock sync and broker connection, exactly like separate phones in separate browsers, so what you test is what the room gets. The simulator drives a client by running short snippets in its page that call the performer's own functions (`join()`, `state`, `scoreHands()`), so nothing in `ensemble/` changes for it. **⧉** on a card shows that client's own page in a window; **↻** reloads it (it keeps its id and group).

Alternatives considered:

| Option | Why not |
|---|---|
| A browser window per client | What testing used to be: one window per client to open, join and route by hand. Hidden views are the same processes without the windows. |
| `BrowserView` | Deprecated in favour of `WebContentsView`, which this uses. |
| Several clients in one page (iframes) | Same-origin frames share `sessionStorage` and `localStorage`, so clients would share one id and one group. Separating them means rewriting `performer.js`. |
| One shared `AudioContext` playing every part | Most efficient, but a second implementation of the performer (scheduling, drift, effects) that would hide real problems: clock-sync spread, late joins, one client dropping out. |

The cards aren't drawings of clients: everything on them is read from each client's page a few times a second (its status line, group, playhead ring, clock-sync figures, level).

### Local backend

The site has no server of its own: the conductor page owns the clock and the piece, and every page talks through an MQTT broker over WebSocket (`net.js`). So the local backend is that broker, running inside the app: [aedes](https://github.com/moscajs/aedes) on `ws://127.0.0.1:<free port>/mqtt` (`backend.js`). The pages get its address with `?broker=` and use it exactly as they use the public one: the retained state message, clock pings, presence and the broker's "gone" message when a client disconnects. It starts with the app and stops when it quits (clients first, so the conductor sees them leave); the port is free again afterwards.

Because of it, a rehearsal needs no network: the pages' three CDN libraries (mqtt.js, the QR code generator, JSZip) are the same versions, bundled, and served by the app (`site.js`). Clock sync also gets better: a round trip through the local broker is about 1 ms, against ~200 ms through the public one.

### Shared score and timeline

Nothing is simulated here: the conductor page publishes the whole piece, with its start time on the shared clock, and each client schedules its own group's part, as with phones. The transport uses the conductor's own controls: ▶ is its Start (from its *Start from* time), and pause is a Stop that leaves *Start from* where the sound stopped. A resume skips the conductor's 1.5 s lead, so nothing is heard twice; a *Start from* time you type yourself keeps the lead as a pre-roll.

### Audio routing

Each client's page gets a small output stage (`inject/output-stage.js`) after the performer's master volume, which is otherwise untouched:

```
performer:  sounds → effects → master ─┐
simulator:                             ├→ gate (solo / mute) → router (channels) → output device
            test tone ─────────────────┘
```

- **Device:** `AudioContext.setSinkId()` sends the client's whole output to the device. Device ids differ in every session, so devices are matched by name. The client reads back where it really plays (shown when you hover its menu).
- **Channels:** for one channel or a pair, the destination is opened at the device's full channel count with discrete channels, and a `ChannelMergerNode` puts the client's sound on just those channels (mixed down to mono for one channel). The test records a loopback device and checks that each client's sound comes out of its own channel only.
- **Solo / mute** ramp the gate's level (about 30 ms, no click). Playback, scheduling and clock sync carry on underneath.
- **A device that isn't connected:** its clients get no output at all (`setSinkId({ type: 'none' })`), rather than falling back to another speaker in the room. They keep playing in time, the card and speaker tile say *not connected*, and they're routed back when the device returns.

### Security

The pages are web pages and get no Node.js: `contextIsolation`, `sandbox`, no `nodeIntegration`. The panel reaches the main process only through the named calls in `preload.js`, accepted only from the panel; the conductor's and the clients' preload (`keys.js`) only forwards the shortcut keys and exposes nothing. The site is served through a custom `phase://` scheme, and the backend listens on 127.0.0.1 only. Pages may see device names and pick an output, but can't use the microphone or camera. Navigation away from the conductor or a client is blocked: links to the site open in their own window (the score editor) and other links open in the system browser.

### Look

Calm "liquid glass" in the manner of iOS 26: neutral translucent layers with a bright rim, rounded capsule controls, sentence case. Colour is kept for state (solo blue, mute orange, a problem red); selection is a white ring. On macOS the window itself is translucent; elsewhere the same layers sit on a dark or light background, following the system. Every page in the app is set in Helvetica with −25 tracking (`inject/fonts.css` stands in for the site's own typefaces inside the app; the website itself is unchanged).

### Files

```
main.js              window, clients, solo / mute, transport, the panel's calls
backend.js           the local backend (MQTT broker on 127.0.0.1)
instances.js         one simulated client
inject/output-stage.js   added to each client: device, channels, solo gate, levels, test tone
inject/fonts.css     added to every page: Helvetica
site.js              serves the site at phase://site/…, and the bundled CDN libraries; permissions
guard.js             keeps pages from navigating away
config.js            saved settings
preload.js           the panel's bridge to main.js
keys.js              shortcut keys on the conductor's and clients' pages → the panel
panel/               the simulator's interface (html, css, js)
smoke.js             the automated test
```

## Testing

```bash
npm run smoke                  # 4 clients
npm run smoke -- --count=12
npm run smoke -- --shots=shots # also saves screenshots of the panel and the conductor
```

Runs the real app end to end against its local backend, driving it the way a person would (clicks on cards with ⌘, the S and Space keys, keys on the conductor page), and prints PASS / FAIL for each check:

- the backend runs, and the conductor and every client use it; the backend and the conductor count every client; each client has its own id; clock round trips are under 20 ms
- outputs are listed with their channel counts; each client plays to the device it was given, several can share one, a missing device leaves its client silent (not rerouted) until it's back
- Space starts every client in the same performance, at the same point of the timeline (within a millisecond), all making sound
- S solos the selected client: the others are silent but still playing, and nothing restarts; ⌘-click and S change the solo to a group; S again restores everyone; S on the conductor page works too
- **recorded from a loopback device:** client 1 alone on channel 1, client 2 alone on channel 2 (as solo changes); silence when every client is muted; a test tone on its own channel even when muted
- Space pauses and remembers where, Space again carries on from there; Space is ignored while typing in a field or on an output menu; Space on the conductor page and on a client's own page; ■ goes back to the start
- the conductor can't be navigated away; closing a shown client keeps it running; removing a client takes it out of the room (the backend and conductor see it leave) and adding one joins it under the free number
- the app quits cleanly (it prints the backend's port, which is closed afterwards)

The recording checks need a loopback device (VB-Cable, BlackHole, Loopback…): every client plays into it, so the test makes no sound in the room, and it records the device's input side (on macOS the first run asks for microphone access for that). Without one, the clients are silenced and those checks say SKIP. What the test can't do is stand in the room: whether a device is the speaker you think it is, only **Identify** can tell.

### Measured

On an Apple Silicon MacBook Pro with Electron 45 (Chromium 156), while playing, from `npm run smoke`:

| Clients | Processes | Memory |
|---|---|---|
| 4 | 12 | 1.0–1.3 GB |
| 6 | 14 | 1.3 GB |
| 12 | 20 | 2.2 GB |
| 20 | 28 | 3.0 GB |

All checks pass at each size (with 20 clients on a busy machine, joining takes up to a minute). Each client is a full browser page that decodes its own sounds: about 100 MB each.

## Building a downloadable app

```bash
npm run dist         # dmg on macOS, installer on Windows, AppImage on Linux, in dist/
npm run dist:dir     # just the unpacked app, quicker for a test
```

Each platform builds its own (build the Windows app on Windows, and so on). The site (`index.html`, `ensemble/`, `assets/`) and the bundled CDN libraries are copied into the app. Builds aren't code-signed (`mac.identity: null` in `package.json`), so the first launch needs right-click → **Open** on macOS, or **More info → Run anyway** on Windows.

## Limitations

- **Channels on macOS follow the speaker setup.** Chromium opens a device with the channels of its *speaker configuration* in Audio MIDI Setup (Configure Speakers), not with every channel the hardware has. An 8-output interface set up as stereo shows 2 channels in the menus. Set its configuration to the full channel count (e.g. *Multichannel → 8 channels*) and restart the simulator to route to each one. The menus only offer channels Chromium will really open.
- **Devices are told apart by name.** Two identical devices with the same name can't both be used (rename one in the system's sound settings, or make an aggregate device).
- **Per-client pause isn't offered.** A phone can't pause on its own in the piece's design: it plays whatever the conductor says, at the shared time. The per-client equivalent here is mute, which keeps it in time. Pause is for everyone.
- **Simulated timing is better than real phones'.** No Wi-Fi jitter, and every client shares the computer's audio clock, so phone-specific latency problems won't show. Use **Site's broker** with real phones for that.
- **Tested on macOS only** (Apple Silicon). Windows and Linux builds are configured but not yet tried; there `setSinkId` and multichannel output depend on the drivers (e.g. WASAPI exposes channels by speaker layout, ASIO devices aren't visible to Chromium).
- **Not done yet** (see the issues): timeline zoom and trackpad scrolling, drag-and-drop score editing, audio from cloud storage, a room floor plan, less memory per client, code signing.
