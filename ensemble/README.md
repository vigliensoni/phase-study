# Ensemble

Phase music across many phones. One laptop conducts a timed score; the phones in the room are dealt into groups, and each group plays its part, drifting slowly out of phase, inside the group and against the other groups.

There are three pages:

- `conductor.html` — on the laptop / projector: runs the piece.
- `index.html` — on each phone: plays its group's part (phones get here from the conductor's QR code).
- `editor.html` — writes a score, previews it, and saves it for a GitHub repo.

## Running a session

1. Open `conductor.html`. It shows a room code and a QR code; click the QR code to fill the screen with it for the projector (Esc closes it).
2. Performers scan it and tap **Join** (browsers only start audio after a tap).
3. Press **Calibrate levels** and match the phones' volumes (see *Calibrating levels*).
4. Pick a score from the menu, or paste a GitHub link to a piece and press **Load** (see *Pieces from a GitHub link*).
5. Press **Start**. The piece starts 1.5 s later, on every phone at once.

The conductor's controls:

- **Groups:** a score says how many groups it needs (`groups: 3` → A, B, C). Phones are dealt into them in join order (1st → A, 2nd → B, 3rd → C, 4th → A…), and each phone shows its group and number. A phone that reloads keeps its group; **Re-deal groups** evens them out after phones leave.
- **Start from:** type a time or click the timeline, then **Start**, to rehearse a section.
- **Mute a group:** click its letter on the timeline (click again to unmute). Works while playing.
- **Live drift override:** moving the slider overrides every group's scored drift; **Follow score** hands control back.
- **Editor →** (top right) opens the current piece in the score editor.
- **Mistakes** in the score (an unknown group, a missing sound file, a bad time) show in red under the timeline.

The whole score goes to every phone once, with a start time. Each phone schedules its own part ahead, so a network hiccup mid-piece doesn't matter, and anyone joining late or reloading starts exactly where their group is. The conductor can reload too: it picks the piece back up from the broker.

### Running it from your own computer

To test with phones before changes are on GitHub Pages, serve the repo from your computer and open a free Cloudflare *quick tunnel* to it. The tunnel gives an `https://` address any phone can reach, even on networks that keep devices apart (like most university Wi-Fi).

Install once (needs [Node.js](https://nodejs.org)):

```powershell
npm install -g http-server
winget install --id Cloudflare.cloudflared     # macOS: brew install cloudflared
```

Then, from the repo's root folder (the one holding `style.css` and `ensemble/`), in two terminals:

```powershell
http-server -p 8000 -c-1                         # terminal 1: serve the site, no caching
cloudflared tunnel --url http://localhost:8000   # terminal 2: prints https://<random>.trycloudflare.com
```

Open `https://<random>.trycloudflare.com/ensemble/conductor.html` on the computer. Use the tunnel's address, not `localhost`, since the QR code points at the page's own address. Keep both terminals running (Ctrl+C stops them); the address changes each time the tunnel starts.

On Windows: if a command is *not recognized*, reopen the terminal (or VS Code) after installing; if *running scripts is disabled*, use `http-server.cmd`.

## Before a performance

### Phone setup

A web page can't stay connected while a phone is locked, so phones must never lock:

- **iPhone:** Settings → Display & Brightness → **Auto-Lock: Never**, and **Low Power Mode off** (it blocks the wake lock). For shows, **Guided Access** (Settings → Accessibility) locks the phone into the page; set its own display auto-lock to *Never*, then triple-click the side button on the page to start it.
- **Android:** Settings → Display → **Screen timeout** at the maximum, and **Battery saver off**. For shows, **app pinning** (usually under Settings → Security) keeps the phone on the page.
- **Everyone:** plug in or start with a full battery; turn on **Do Not Disturb**; volume up, silent switch off, no Bluetooth speakers. Join, then leave the page open in front.

The page helps: it holds a wake lock (asking again whenever the system takes it back), and where that isn't available it plays `keepawake.mp4`, a tiny muted video that keeps most phones awake.

- **Standby:** between pieces, press **Standby** on the conductor. Phones go black apart from a status dot (green connected, amber syncing, red offline) but stay awake, synced and able to play and calibrate. A performer can tap the screen to see the normal view for 5 s.
- **Asleep phones:** a phone that stops reporting (locked, switched app, closed tab) stays in the Performers table marked *asleep*, with when it was last seen. Unlocking it is enough: it resyncs and rejoins without another tap. Asleep phones are skipped by calibration and group dealing, and forgotten after 30 minutes.

### Calibrating levels

**Calibrate levels** makes every phone play its test sound in turn, 0.5 s apart, in the order of the Performers table. Each phone flashes on its turn and its row lights up on the conductor. Adjust each phone's **Volume** until they match, then press again for another round. The turns run on the shared clock, so the gaps stay even whatever the network does; a phone that isn't synced yet sits the round out.

## Writing a piece

There are three ways:

- **The score editor** (`editor.html`): forms instead of code, with a live timeline and a preview. Easiest for students; it saves a folder ready for GitHub.
- **A `score.json` in a GitHub repo**, loaded from its link on the conductor.
- **An entry in `scores.js`**, built into the site.

All three use the same score format, below.

### The score editor

- **Open:** a GitHub link, a folder or ZIP on your computer, a built-in score, or a new piece.
- **Piece:** title, number of groups, end time, credit line.
- **Sounds:** add audio files; each gets a name the events use (renaming one renames it in the events).
- **Effects:** each group's chain, in order; *Copy to every group* gives the others the same chain.
- **Events:** time, groups, and what happens (play, stop, ratio, spread, level, set). *Play once* makes a one-shot, with an optional *Fade out end*.
- **Timeline and Preview:** the conductor's timeline, updated as you type, with mistakes listed under it. **Preview** plays the ticked groups here, as several phones each, with drift and effects; press it again to hear changes.
- **Save:** **Download ZIP** gives the piece's folder (`score.json` and its sounds); upload its contents to your repo. **Copy score.json** if you only changed the score.

### Pieces from a GitHub link

A piece is a folder in a **public** GitHub repo, holding `score.json` and its sounds:

```
my-piece/
  score.json
  audio/
    rain.mp3
    door.wav
```

Paste the repo's link into the conductor and press **Load**: `https://github.com/you/my-piece`, or `https://github.com/you/repo/tree/main/my-piece` for a subfolder or another branch. The piece appears in the menu as *Linked: …* and goes to every phone; the conductor and the phones load the files straight from GitHub.

- The repo must be **public** (a private one answers "not found", like a wrong path).
- After pushing a change, allow GitHub up to 5 minutes before loading again.
- Paths are case-sensitive on GitHub: `Audio/Rain.mp3` is not `audio/rain.mp3`.
- Keep files under 100 MB, don't use Git LFS, and prefer `.mp3` or `.ogg`: every phone downloads the sounds.
- A file that can't be found is named in red under the timeline. Phones play the rest and show *COULD NOT LOAD …*.

### The score format

In `scores.js` a score is a JavaScript object; in `score.json` it's the same thing written as JSON (keys and strings in double quotes):

```json
{
  "title": "Rain and door",
  "groups": 2,
  "credit": "Sounds recorded by the class.",
  "sounds": { "rain": "audio/rain.mp3" },
  "events": [
    { "at": "0:00", "play": "rain", "ratio": 1.01, "fade": 5 },
    { "at": "0:20", "groups": "B", "play": "audio/door", "loop": false, "fadeOut": 2 },
    { "at": "0:30", "spread": 1.001, "glide": 30 },
    { "at": "1:00", "stop": "all", "fade": 10 }
  ],
  "end": "1:10"
}
```

On the score:

| Field | Meaning |
|---|---|
| `title` | Shown in the menu |
| `groups` | How many groups (A, B, C…) |
| `events` | What happens when (below) |
| `end` | When the piece ends (optional) |
| `credit` | A credit line, shown on the conductor and the phones (optional) |
| `sounds` | Short names for sound files, `{ "rain": "audio/rain.mp3" }` (optional) |
| `effects` | Each group's effect chain (optional, see *Effects*) |

On each event, `at` (`"m:ss"` or seconds), `groups` (`"ABC"`, `["A","D"]`, or `"all"`, the default), and one action:

| Action | Does | Options |
|---|---|---|
| `play: "name"` | Starts a sound | `ratio`, `fade` (s), `level` (0–1), `loop: false` (play once instead of looping), `fadeOut` (s, fades a one-shot over the end of its file) |
| `stop: "name"` or `"all"` | Fades a sound out | `fade` (s) |
| `ratio: r` | Drift inside the groups | `glide` (s), `sound` (only that sound) |
| `spread: s` | Drift across groups (whole piece) | `glide` (s) |
| `level: v` | Changes loudness | `fade` (s), `sound` |
| `set: "id.setting"` | Changes an effect setting | `to` (the new value), `glide` (s) |

A group can play several sounds at once, which is how crossfades work: stop one sound with a long fade while another fades in.

### Sounds

A sound is named by its file path without `.wav`; other formats need their extension (`rain.mp3`). In `scores.js` paths are inside `assets/` (`demo/door` is `assets/demo/door.wav`): drop a file in and use it, with no list to update. In a GitHub piece, paths are inside the piece's folder, or given short names in `sounds`. Phones download only the sounds of the score being played.

### Effects

Each group can run its sounds through a chain of effects, in order (`BC` gives B and C a chain each, `all` every group):

```js
effects: {
  A:  [{ type: 'lowpass', frequency: 300, q: 4 }],
  B:  [{ type: 'bandpass', lfo: { rate: 0.25, min: 300, max: 3000 } }],
  CD: [{ type: 'delay', time: 0.375, feedback: 0.5, mix: 0.4 },
       { type: 'reverb', decay: 6, mix: 0.2 }],
},
```

Change a setting during the piece with `set`, instantly or with a `glide`:

```js
{ at: '0:00', groups: 'A', set: 'lowpass.frequency', to: 6000, glide: 20 },
```

| Type | Settings (default, range) | Fixed (set once) |
|---|---|---|
| `lowpass` `highpass` `bandpass` | `frequency` (1000 Hz, 20–20000), `q` (1, 0.1–30) | `lfo: { rate: 0.2, min: 200, max: 2000 }` sweeps the cutoff; `rate` then replaces `frequency` as a setting |
| `reverb` | `mix` (0.3, 0–1) | `decay` (4 s, 0.1–20), `preDelay` (0.01 s, 0–1) |
| `delay` | `time` (0.25 s, 0.01–5), `feedback` (0.4, 0–0.95), `mix` (0.3, 0–1) | |
| `pan` | `pan` (0, −1 left … 1 right) | |

A setting is named `id.setting`; the id is the effect's type unless you give it an `id` (two effects of the same type in a group need different ids: `id: 'low2'` → `low2.frequency`). *Effects study* in the menu uses every type.

### Credits

Give every PTC score (titled *PTC …*, using `assets/PTC/`) `credit: PTC_CREDIT`, defined in `scores.js`, so the required credit is shown during the piece. Other sound credits are in the [main README](../README.md#sound-credits).

## Troubleshooting

- **No sound on a phone:** check the volume and silent switch, and that it shows *PLAYING*. *COULD NOT LOAD …* names a missing file (check its path and case).
- **A phone dropped off:** it locked or switched apps; unlock it and it rejoins. See *Phone setup*.
- **Phones out of time:** Bluetooth speakers add 150–300 ms; avoid them, or use the phone's latency trim.
- **Phones can't connect:** some campus guest Wi-Fi blocks WebSockets. Use a phone hotspot or cellular data.
- **A GitHub piece won't load:** the repo must be public, the link must point at the folder holding `score.json`, and a fresh push can take 5 minutes to appear.
- **Monitor on the laptop:** open the phone page (the conductor's join link) in another tab and join.

## How it works

### Timing

- **Clock:** each phone pings the conductor through the broker every 2.5 s and keeps the offset from the fastest round trips (NTP-style). The phone shows `sync ±x ms` and `rtt`.
- **Play at T:** the conductor never says "play now". It publishes a retained *state* message with the score and its start time, from which any phone can work out where its group should be at any moment.
- **Audio clock:** `getOutputTimestamp()` maps shared time to when sound leaves the speaker, so output latency is included where the browser reports it.
- **Drift:** every 4 s each phone checks how far its audio has slipped; past 20 ms it re-seats with a 30 ms crossfade.
- **Latency trim:** a per-phone slider, saved on the device, for phones whose reported latency is wrong (some Android models, anything on Bluetooth).

Expect 5–20 ms of spread across mixed phones on decent Wi-Fi; sound itself takes about 3 ms per metre.

### The broker

The conductor and phones talk through an MQTT broker over a secure WebSocket; the site itself stays static.

**Default:** HiveMQ's free public broker (`wss://broker.hivemq.com:8884/mqtt`). Nothing to install, fine for class, but shared and unauthenticated (anyone who guesses the room code could send commands) and without guaranteed uptime.

**Another broker:** add `?broker=` to the conductor's URL (it passes it on to the phones):

```
conductor.html?broker=wss://broker.emqx.io:8084/mqtt
conductor.html?broker=wss://test.mosquitto.org:8081/mqtt
```

**Your own (for performances):** Mosquitto with WebSockets behind a TLS reverse proxy. A broker on the phones' local network also gives the tightest sync.

```conf
# /etc/mosquitto/conf.d/ws.conf
listener 9001 127.0.0.1
protocol websockets
allow_anonymous true          # or password_file + acl_file for real shows
```

```nginx
location /mqtt {
  proxy_pass http://127.0.0.1:9001;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_read_timeout 3600s;
}
```

Then open `conductor.html?broker=wss://your.server/mqtt`.

### Files

```
index.html       Performer page (each phone)
conductor.html   Conductor page (laptop / projector)
editor.html      Score editor
scores.js        The built-in scores, and the sound folder
net.js           Broker connection, topics, clock, ring drawing
score-engine.js  Compiles a score into each group's layers; drift maths
effects.js       Each group's effect chain
pieces.js        Loads a piece from a GitHub link
playback.js      Schedules one phone's sounds (phones and the editor's preview)
timeline.js      Draws a score's timeline (conductor and editor)
performer.js     Phone: clock sync, scheduling, drift correction, audio
conductor.js     Conductor: shared clock, state of the piece, roster, controls
editor.js        Editor: form, preview, open and save
ensemble.css     Layout (on top of ../style.css)
keepawake.mp4    Silent video that keeps screens on where Wake Lock isn't available
```

Sounds live in `../assets/`; the built-in ones are in `../assets/demo/`.

## Ideas to extend

- Quantize cues to the loop boundary instead of a fixed lead time.
- Per-phone gain or filtering sent from the conductor, to shape the spatial mix.
