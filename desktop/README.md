# Phase Study Simulator (desktop)

A desktop app for rehearsing and testing the ensemble without a room full of phones. One window holds the conductor and a panel that runs any number of **simulated phones**: each joins the room on its own and plays through the speaker you give it. With a multichannel audio interface, that's one phone per physical speaker.

## Running it

Needs [Node.js](https://nodejs.org) 20 or later.

```bash
cd desktop
npm install          # once: downloads Electron
npm start            # opens the simulator
```

1. The window opens with the conductor (left) and the simulator panel (right). The phones join by themselves, with no Join tap.
2. Set the number of phones with **− / +**.
3. Give each phone a speaker: pick one per row, or tick speakers and press **Spread phones** (phone 1 → first speaker, 2 → second…). In score mode, **One group per speaker** puts every phone of group A on the first speaker, B on the second, and so on. Name each speaker by where it stands in the room ("front left"); the cards then show which phones play where.
4. Press **♪ Identify** to check: every phone beeps in turn, 0.5 s apart, and its row lights up, so you can hear that each one comes out of the right speaker. **♪** on a row beeps that phone alone.
5. **Space**, or the Start button in either column, starts and stops the piece.

Settings (the number of phones, speakers, speaker names) are saved and come back next time. **⧉** opens a phone's own page in a small window; **↻** reloads a phone and joins it again.

### Real phones as well

Simulated phones load the site from inside the app (`phase://site/…`), which a real phone can't open. To mix real phones into the same room, open **Connection** and set **Site** to a public copy of the site: GitHub Pages, or your computer through a tunnel (see *Running it from your own computer* in [the ensemble README](../ensemble/README.md)). The conductor's QR code then points there.

### Building a downloadable app

```bash
npm run dist         # dmg on macOS, installer on Windows, AppImage on Linux, in dist/
npm run dist:dir     # just the unpacked app, quicker for a test
```

Each platform builds its own (build the Windows app on Windows, and so on). The site (`index.html`, `ensemble/`, `assets/`) is copied into the app. Builds aren't code-signed (`mac.identity: null` in `package.json`, so building never asks for a signing key), so the first launch needs right-click → **Open** on macOS, or **More info → Run anyway** on Windows.

### Testing

```bash
npm run smoke                  # 4 phones
npm run smoke -- --count=10
npm run smoke -- --site=https://vigliensoni.github.io/phase-study   # against another copy of the site
```

Runs the real app end to end with every phone muted (their meters still see the sound) and prints PASS/FAIL for each check: phones join and sync without a tap, the conductor lists them, each is routed to a different speaker (read back from its `AudioContext`), Space in the panel starts and stops them all, Space is ignored while typing in a field and doesn't click a focused button, score mode deals phones into groups, the conductor can't be navigated away, and closing a phone's window leaves it in the room. Quits with 0 when everything passes. It needs the network, because the pages use the public MQTT broker.

What the test can't do is listen: it proves each phone's audio is sent to the device it was given, but whether that device is the speaker you think it is, only **Identify** in the room can tell.

If you run it from a terminal inside VS Code and Electron behaves like plain Node, unset `ELECTRON_RUN_AS_NODE` (VS Code sets it): `env -u ELECTRON_RUN_AS_NODE npm start`.

## How it works

### One process per phone, no copied code

Each simulated phone is the **real performer page** (`ensemble/index.html`), unchanged, in a hidden `WebContentsView` with its own in-memory session. That gives every phone its own renderer process, `AudioContext`, storage (so its own id), clock sync and broker connection, exactly like separate phones, so what you test is what the room gets. The simulator drives a phone by running short snippets in its page that call the performer's own functions (`join()`, `testSound()`, `ctx.setSinkId()`), so nothing in `ensemble/` had to change for it.

Alternatives considered:

| Option | Why not |
|---|---|
| A browser window per phone | What we had: one window per phone to manage by hand. Hidden views are the same processes without the windows. |
| Several phones in one page (iframes) | Same-origin frames share `sessionStorage` and `localStorage`, so phones would share one id and one voice. Separating them means rewriting `performer.js`. |
| One shared `AudioContext` playing every voice | Most efficient, but it would be a second implementation of the performer (scheduling, drift, effects), and it would hide real problems: clock-sync spread, late joins, one phone dropping out. |

### Audio routing

Chromium can send an `AudioContext` to any output device (`AudioContext.setSinkId`, available since Chromium 110), so each phone's whole output (its sounds, effects and test beep) goes to the device it was given. Device ids are different in every session, so devices are matched by **name**: the panel lists the names, and each phone finds its device by name in its own session. After routing a phone, the simulator reads back which device it really plays to (shown when you hover its speaker menu); a device that isn't connected shows *speaker not found*, and phones are routed again when devices come and go.

Each output device is one speaker. To use several speakers on one multichannel interface, the interface has to show up as several devices: on macOS, make stereo pairs or single outputs with an aggregate device or a router like Loopback or BlackHole; on Windows, ASIO/WDM drivers often list each output pair. Splitting one multichannel device into its separate channels inside the app (a `ChannelMergerNode` per phone) isn't done yet; see *Status*.

### Play / pause

Space and the panel's button call the conductor's own `togglePlay()`. The conductor schedules every start and stop on the shared clock, 1.5 s and 0.4 s ahead, so every phone, simulated or real, starts and stops together. `ensemble/shortcuts.js` adds Space to the conductor page itself, so it works in a browser too (on a site set under Connection, only once that copy has `shortcuts.js`; the panel's Space works with any copy).

### Security

The pages are web pages and get no Node.js: `contextIsolation`, `sandbox`, no `nodeIntegration`. The panel reaches the main process only through the named calls in `preload.js`, and the main process accepts them only from the panel. The site is served by a custom `phase://` scheme rather than a local web server, so no port is opened. Pages may see device names and pick a speaker, but can't use the microphone or camera. Navigation away from the conductor or a phone is blocked: links to the site open in their own window (the score editor) and other links open in the system browser.

### Files

```
main.js       window, layout, phones, the panel's calls
instances.js  one simulated phone
site.js       serves the site at phase://site/…; permissions
guard.js      keeps pages from navigating away
config.js     saved settings
preload.js    the panel's bridge to main.js
panel/        the simulator panel (html, css, js)
smoke.js      the automated test
```

## Measured

On an Apple Silicon MacBook Pro with Electron 45, while playing (from `npm run smoke`):

| Phones | Processes | Memory | CPU |
|---|---|---|---|
| 2 | 9 | 0.9 GB | ~6 % |
| 10 | 17 | 2.2 GB | ~6 % |
| 20 | 27 | 3.3 GB | ~8 % |

That's about 630 MB for the app and 130–160 MB per phone, most of it decoded audio: every phone decodes every Free-mode loop ahead, as a real phone does.

## Status

**Done**
- Desktop app: conductor and simulator panel in one window, packaged for macOS, Windows and Linux (tested on macOS only).
- Any number of simulated phones (up to 40), joined automatically, added or removed without disturbing the others.
- A speaker per phone, verified after routing; Spread, One group per speaker, All to default; speaker names for the room layout; saved setup.
- Identify (every phone in turn) and a test beep per phone; a live level meter per phone.
- Space to start and stop, in the panel and on the conductor page (in a browser too), ignored while typing.
- Pages can't navigate away; closing the window asks first.
- Connection → Site: load the pages from another copy of the site, so real phones can join the same room (the smoke test passes against GitHub Pages; not yet tried with real phones in the room).
- Automated end-to-end test: passes with 2, 4, 10 and 20 phones, in development and in the packaged macOS app.

**Not yet** (tracked as issues)
- Separate channels of one multichannel device as separate speakers.
- A local MQTT broker inside the app, so rehearsals work offline and sync tighter (the public broker adds about 200 ms of round trip).
- Less memory per phone (only decode the sounds the current piece needs).
- Timeline zoom and scroll; drag-and-drop score editing; audio files from cloud storage.
- A visual room map (speakers placed on a floor plan).
- Tests on Windows and Linux; code signing for releases.

**Limits of the platform**
- Speakers can only be told apart by their names. Two identical devices with the same name can't both be used (rename one in the system's sound settings).
- `setSinkId` follows the device, not a channel: one device = one speaker (see *Audio routing*).
- A simulated phone's timing is better than a real one's: no Wi-Fi jitter, and every phone shares the computer's audio clock, so it won't show phone-specific latency problems.
