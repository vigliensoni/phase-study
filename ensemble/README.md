# It’s Gonna Rain — Ensemble

The phase study, spread across many phones. One laptop conducts; every phone in the room is one voice. Voice 1 plays the loop at its original speed, and voice *k* plays at

```
rate_k = 1 + (k − 1) · (ratio − 1)
```

so with ratio 1.002, voice 2 is 0.2 % faster, voice 3 is 0.4 % faster, and so on. The phasing happens in the room, between the phones, not inside one browser.

## Files

```
index.html       Performer page (open on each phone)
conductor.html   Conductor page (open on the laptop / projector)
editor.html      Score editor: write a piece, preview it, download its folder
net.js           Shared: broker connection, topics, the phase math, ring drawing
score-engine.js  Shared: compiles a score into per-group layers; drift maths
scores.js        Sound folder, Free-mode sound buttons, and the scores (edit this to write your own)
effects.js       Shared: each group's effect chain (filters, reverb, delay, pan)
pieces.js        Shared: loads a piece (score.json + sounds) from a GitHub link
playback.js      Shared: schedules one phone's sounds (used by phones and the editor's preview)
timeline.js      Shared: draws a score's timeline (conductor and editor)
performer.js     Clock sync, scheduling, drift correction, audio
conductor.js     Shared clock, state of the piece, roster, controls
editor.js        The score editor's form, preview, open and save
ensemble.css     Layout (on top of ../style.css)
keepawake.mp4    3 KB silent video: keeps screens on where Wake Lock isn't available
```

Sounds come from `../assets/`; the built-in ones are in `../assets/demo/`.

## Running a session

1. Open `conductor.html`. It makes a room code and shows a QR code. Click the code to fill the screen with it, for the projector; press Esc or click again to close it.
2. Performers scan it and tap **Join**. The tap is required, because browsers only start audio after a gesture.
3. In Free mode, each phone gets the lowest free voice number as it joins (in Score mode, it is dealt into a group). **Number voices 1…N** renumbers everyone 1…N in join order, e.g. after phones have left; a performer can still nudge their own voice with − / +.
4. **Start** lands 1.5 s after you press it. The ratio slider and **Pause phasing** take effect 0.4 s after you use them, on every phone at the same moment. **Sync voices** restarts everyone aligned.

Anyone joining late, or reloading, jumps straight to where their voice should be. The conductor can reload too; it picks the piece back up from the broker.

## Keeping phones awake

A web page can't stay connected while the phone is locked: iOS suspends it within seconds (Android a little later), and the phone drops off the broker. So the phones must never lock, and the page works hard at that:

- **Wake lock.** On Join, the page asks the phone to keep the screen on. The system can take that back (low battery, a notification, a call), so the page asks again whenever it's released, and checks every 10 s.
- **Fallback.** Where Wake Lock isn't available or is refused, the page plays `keepawake.mp4`, a tiny muted looping video, which keeps most phones awake.
- **Standby.** Between pieces, press **Standby** on the conductor: every phone goes black except for a small status dot (green connected, amber syncing, red offline). Phones stay awake, connected and synced, and still play and flash, so calibration and the next piece work as usual. Black pixels use almost no power on OLED screens. A performer can tap the black screen to see the normal view for 5 s. Standby is part of the piece's state, so phones that join or reload while it's on go straight to black.
- **Asleep phones.** A phone that stops reporting (locked, app switched, tab closed) stays in the Performers table marked *asleep*, with how long ago it was last seen, so you know which one to go and wake. Unlocking it is enough: it resyncs and rejoins without another tap. Asleep phones are left out of calibration rounds and of voice/group dealing, and are forgotten after 30 minutes.

A phone that someone locks by hand will still disconnect; the page can only catch it quickly. The setup checklist below prevents most of it.

### Setup checklist for performers

- **iPhone**
  - Settings → Display & Brightness → **Auto-Lock: Never**.
  - Turn **Low Power Mode off** (it blocks the wake lock).
  - For shows, use **Guided Access** (Settings → Accessibility → Guided Access): it locks the phone into the page, blocks accidental swipes and buttons, and has its own display auto-lock setting (set it to *Never*). Triple-click the side button on the page to start it.
- **Android**
  - Settings → Display → **Screen timeout**: the maximum.
  - Turn **Battery saver off**.
  - For shows, use **app pinning** (usually Settings → Security, sometimes under *More security settings*; the name and place vary by brand) to keep the phone on the page.
- **Everyone**
  - Plug in if possible; otherwise start with a full battery.
  - Turn on **Do Not Disturb**, so calls and notifications don't cover the page (or take back the wake lock).
  - Volume up, silent switch off, no Bluetooth speakers.
  - Join, then leave the page open in front: don't switch apps or lock the screen.

## Calibrating levels

Before the piece, press **Calibrate levels** on the conductor. Every phone plays its test sound in turn, 0.5 s apart, in the order of the Performers table (by voice, or by group and phone in score mode). Each phone flashes its screen on its turn, and its row lights up on the conductor, so the room can tell which one is sounding. Adjust each phone's **Volume** until they match, then press again for another round.

The conductor sends one message with the start time and the order; each phone plays on its own turn using the shared clock, so the gaps stay even whatever the network does. A phone that hasn't finished syncing its clock, or gets the message after its turn has passed, sits that round out. Pressing the button again restarts the round from the first phone.

## Score mode

Switch the conductor to **Score** to play a timed piece: pick one of `scores.js` from the menu, or paste a GitHub link to a student's piece and press **Load** (see *Pieces from a GitHub link*).

- **Groups.** The score says how many groups it needs (`groups: 3` → A, B, C). Phones are dealt into them in join order: 1st → A, 2nd → B, 3rd → C, 4th → A… Choosing another score re-deals everyone into its groups. A phone that reloads keeps its group; **Re-deal groups** evens them out after phones leave. Each phone shows its group letter and its number in the group.
- **Two kinds of drift.** `ratio` works *inside* a group: phone *k* drifts from the group’s first phone. `spread` works *across* groups: B drifts from A, C twice as far, and so on. They add up: phone *k* of group *j* plays at `1 + (k − 1)·(ratio − 1) + (j − 1)·(spread − 1)`.
- **One message.** The whole score and a start time go to every phone once. Each phone computes its own part and schedules every fade and drift change ahead, so a network hiccup mid-piece doesn’t matter, and a phone that joins late starts exactly where its group is.
- **Start from.** Type a time or click the timeline, then **Start score**. Handy for rehearsing a section.
- **Mute a group.** Click a group's letter on the timeline to silence its phones; the letter and its lane turn grey. Click again to bring it back. Works while playing; mutes reset when you pick another score.
- **Live drift override.** The slider still works: moving it overrides every group’s scored drift from that moment. **Follow score** hands control back.

### Writing a score

Add an entry to the `SCORES` list in `scores.js`:

```js
{
  title: 'Rain Study I',
  groups: 4,
  events: [
    { at: '0:00', groups: 'ABC', play: 'demo/1', ratio: 1.002, fade: 5 },
    { at: '1:00', spread: 1.001, glide: 30 },                         // groups drift apart
    { at: '2:00', groups: 'D',   play: 'demo/door', ratio: 1.010, fade: 60 },   // 1-min fade-in
    { at: '2:00', groups: 'ABC', stop: 'demo/1', fade: 60 },                 // crossfade…
    { at: '2:00', groups: 'ABC', play: 'demo/door', ratio: 1.004, fade: 60 },   // …into demo/door
    { at: '4:00', groups: 'all', ratio: 1.015, glide: 20 },           // accelerate
    { at: '5:00', groups: 'all', ratio: 1.000, glide: 30 },           // freeze the phases
    { at: '6:00', groups: 'all', stop: 'all', fade: 20 },
  ],
  end: '6:20',
}
```

| Field | Meaning |
|---|---|
| `at` | When: `"m:ss"` or seconds |
| `groups` | On an event: `"ABC"`, `["A","D"]`, or `"all"` (default). On the score: how many groups |
| `credit` | On the score: a credit line, shown on the conductor and on every phone while the score is selected |
| `play: 'name'` | Start a sound in those groups (see *Sounds* below). Options: `ratio`, `fade` (s), `level` (0–1), `loop: false` (play once; default is to loop; playing it again restarts it), `fadeOut` (s; one-shots: fade out over the end of the file) |
| `stop: 'name'` / `stop: "all"` | Fade out. Option: `fade` (s) |
| `ratio: r` | Drift *inside* those groups. Options: `glide` (s), `sound` |
| `spread: s` | Drift *across* groups, for the whole piece. Option: `glide` (s) |
| `level: v` | Change loudness. Options: `fade` (s), `sound` |
| `effects` | On the score (optional): each group's effect chain (see *Effects* below) |
| `set: 'id.setting'` | Change an effect setting in those groups. Options: `to` (the new value), `glide` (s) |

A group can play several sounds at once, which is how crossfades work. Mistakes (an unknown group, a missing sound file, a bad time) show in red under the timeline.

### Effects

Each group can run its sounds through a chain of effects, in order. List them per group (`BC` gives B and C a chain each, `all` every group):

```js
effects: {
  A:  [{ type: 'lowpass', frequency: 300, q: 4 }],
  B:  [{ type: 'bandpass', lfo: { rate: 0.25, min: 300, max: 3000 } }],
  CD: [{ type: 'delay', time: 0.375, feedback: 0.5, mix: 0.4 },
       { type: 'reverb', decay: 6, mix: 0.2 }],
},
```

Then change any setting during the piece with `set`, instantly or with a `glide`:

```js
{ at: '0:00', groups: 'A', set: 'lowpass.frequency', to: 6000, glide: 20 },
```

| Type | Settings (default, range) | Fixed (set once) |
|---|---|---|
| `lowpass` `highpass` `bandpass` | `frequency` (1000 Hz, 20–20000), `q` (1, 0.1–30) | `lfo`: `{ rate: 0.2, min: 200, max: 2000 }` sweeps the cutoff; then `rate` replaces `frequency` as a setting |
| `reverb` | `mix` (0.3, 0–1) | `decay` (4 s, 0.1–20), `preDelay` (0.01 s, 0–1) |
| `delay` | `time` (0.25 s, 0.01–5), `feedback` (0.4, 0–0.95), `mix` (0.3, 0–1) | |
| `pan` | `pan` (0, −1 left … 1 right) | |

A setting is named `id.setting`, where the id is the effect's type unless you give it an `id`: two effects of the same type in one group need different ids (`id: 'low2'` → `low2.frequency`). Like the fades and drift, effect changes are worked out from the score in advance, so every phone in a group changes at the same moment, and a phone joining late starts with the right values. The effects are built from Web Audio nodes only (no library). *Effects study* in the menu uses every type, and the conductor's timeline shows each group's chain at the right end of its lane.

### Sounds

A sound is named by its file path inside `assets/`, without `.wav`: `'demo/door'` is `assets/demo/door.wav`, `'P01/03'` is `assets/P01/03.wav`. For other formats, write the extension (`'rain.mp3'`). To add a sound, drop the file into `assets/` (subfolders work well for keeping pieces apart). There is no list to update and no numbering to shift. Phones download only the sounds of the score being played.

The **Sound** buttons in Free mode come from `LOOP_SOUNDS` in `scores.js`.

#### Credits

The PTC compositions (scores titled *PTC …*, using the sounds in `assets/PTC/`): *The work has been produced from sounds that were originally generated by the instruments of Productions Totem Contemporain.* Give every PTC score `credit: PTC_CREDIT` (defined in `scores.js`), so this line is shown on the conductor and the phones during the piece. Other sound credits are in the [main README](../README.md#sound-credits).

### Pieces from a GitHub link

A piece can also live outside this site, in a student's own **public** GitHub repo: a folder holding a `score.json` and the sounds it uses.

```
my-piece/
  score.json
  audio/
    rain.mp3
    door.wav
```

`score.json` is a score as above, written as JSON (keys and strings in double quotes). Sounds are paths relative to the folder, `.wav` implied, like in `scores.js`; a `sounds` list can also give them short names:

```json
{
  "title": "Rain and door",
  "groups": 2,
  "credit": "Sounds recorded by the class.",
  "sounds": { "rain": "audio/rain.mp3" },
  "events": [
    { "at": "0:00", "play": "rain", "ratio": 1.01, "fade": 5 },
    { "at": "0:20", "groups": "B", "play": "audio/door", "loop": false, "fadeOut": 2 },
    { "at": "1:00", "stop": "all", "fade": 10 }
  ],
  "end": "1:10"
}
```

Paste the repo's link into the conductor and press **Load**: `https://github.com/you/my-piece`, or `https://github.com/you/repo/tree/main/my-piece` for a subfolder or another branch (a link to the `score.json` itself works too). The piece shows in the menu as *Linked: …*, and goes to every phone like any other score. The conductor and every phone load the files straight from GitHub (raw.githubusercontent.com, which any page may fetch from); nothing else needs setting up.

- Keep the repo **public**: a private one answers "not found", exactly like a wrong path.
- After pushing a change, give GitHub up to 5 minutes before loading again.
- Keep each file under 100 MB (GitHub's limit), don't use Git LFS, and prefer `.mp3` or `.ogg`: every phone downloads the piece's sounds.
- Paths are case-sensitive on GitHub (`Audio/Rain.mp3` is not `audio/rain.mp3`), even though they aren't on Windows or macOS.
- A sound whose file can't be found is named in red under the timeline, with the address that failed. Phones still play the rest, and show *COULD NOT LOAD …* next to *PLAYING*.

### The score editor

`editor.html` (linked from the conductor) writes a piece without touching JSON:

- **Open** a piece from its GitHub link, a folder or ZIP on your computer, or one of the built-in scores, or start a new one. The conductor's link opens the piece it has loaded.
- **Piece:** title, number of groups, end, and the credit line.
- **Sounds:** add audio files; each gets a name, used by the events. Renaming one renames it in the events.
- **Effects:** each group's chain, in order. *Copy to every group* gives the others the same chain.
- **Events:** time, groups, and what happens (play, stop, ratio, spread, level, set). *Play once* makes a one-shot, with an optional *Fade out end*. *Set* offers the settings of the effects in the chosen groups.
- **Timeline:** the same drawing as the conductor's, updated as you type, with the mistakes listed under it (the engine's own checks, plus missing files, unknown sounds and times that look like typos).
- **Preview:** plays the ticked groups on this computer, as several phones each, so you hear the drift inside a group as well as across groups, with the effects. Start from any time (or click the timeline). Changes apply the next time you press Preview.
- **Save:** *Download ZIP* gives the piece's folder (`score.json` and its sounds, including files already in the repo); upload its contents to your repo. *Copy score.json* if you only changed the score.

## How the timing works

- **Clock.** Each phone pings the conductor through the broker every 2.5 s and keeps the offset from the fastest round trips (NTP-style). The phone shows `sync ±x ms` (the spread of those estimates) and `rtt`.
- **Play at T.** The conductor never says “play now.” It publishes a retained *state* message holding the start time `T0` and the drift history (`tA`, `phiA`, `ratio`, `paused`). From that, any phone can compute exactly where its voice should be at any shared time (see `voicePos` in `net.js`).
- **Audio clock.** `getOutputTimestamp()` maps shared time to the moment sound actually leaves the speaker, so output latency is included where the browser reports it.
- **Drift.** Every 4 s the phone checks how far its audio clock has slipped from the shared clock. Past 20 ms, it re-seats the voice with a 30 ms crossfade.
- **Latency trim.** A per-phone slider, saved on the device, for phones whose reported latency is wrong (some Android models, anything on Bluetooth).

Expect roughly 5–20 ms of spread across mixed phones on decent Wi-Fi. Sound itself travels about 3 ms per metre, so across a room that is already the scale of acoustic delay.

## The broker

A broker is a small relay server: the conductor and phones all connect to it over a secure WebSocket (`wss://`) and it forwards messages by topic (MQTT publish/subscribe). The site stays 100 % static on GitHub Pages; only the broker is live.

**Default:** HiveMQ’s free public broker, `wss://broker.hivemq.com:8884/mqtt`. There’s nothing to install, and it’s fine for class. It’s shared and unauthenticated, though: anyone who guesses the room code could send commands, and uptime isn’t guaranteed.

**Other public brokers:** add `&broker=` to both URLs (the conductor passes it on to the QR link):

```
conductor.html?broker=wss://broker.emqx.io:8084/mqtt
conductor.html?broker=wss://test.mosquitto.org:8081/mqtt
```

**Your own broker (for performances):** Mosquitto with WebSockets behind your existing TLS reverse proxy.

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

Then use `conductor.html?broker=wss://your.server/mqtt`. A broker on the same local network as the phones also gives the tightest sync, because round trips drop to a few milliseconds.

## Practical notes

- **iPhone:** the page asks iOS to play through the silent switch, but check the volume. See *Keeping phones awake* for the screen.
- **Bluetooth speakers** add 150–300 ms. Avoid them, or use the latency trim.
- **Captive-portal Wi-Fi** (like campus guest networks) sometimes blocks WebSockets. A phone hotspot or cellular data works as a fallback.
- **Monitor on the laptop:** open the performer page in another tab and join as voice 1.

## Ideas to extend

- Quantize cues to the loop boundary instead of a fixed lead time.
- Per-phone gain or filtering sent from the conductor, to shape the spatial mix.
- Different samples per voice group (Reich’s *Come Out* uses the same idea with more voices).
