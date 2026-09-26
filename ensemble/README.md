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
net.js           Shared: broker connection, topics, the phase math, ring drawing
performer.js     Clock sync, scheduling, drift correction, audio
conductor.js     Shared clock, state of the piece, roster, controls
ensemble.css     Layout (on top of ../style.css)
```

Sounds come from `../assets/` (the same list as the single-browser study).

## Running a session

1. Open `conductor.html`. It makes a room code and shows a QR code.
2. Performers scan it, pick a voice number, and tap **Join**. The tap is required, because browsers only start audio after a gesture.
3. On the conductor, **Number voices 1…N** assigns voices in join order (or let people choose).
4. **Start** lands 1.5 s after you press it. The ratio slider and **Pause phasing** take effect 0.4 s after you use them, on every phone at the same moment. **Sync voices** restarts everyone aligned.

Anyone joining late, or reloading, jumps straight to where their voice should be. The conductor can reload too; it picks the piece back up from the broker.

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

- **iPhone:** the page asks iOS to play through the silent switch, but check the volume. Keep the screen on (the page requests a wake lock; Low Power Mode can block it).
- **Bluetooth speakers** add 150–300 ms. Avoid them, or use the latency trim.
- **Captive-portal Wi-Fi** (like campus guest networks) sometimes blocks WebSockets. A phone hotspot or cellular data works as a fallback.
- **Monitor on the laptop:** open the performer page in another tab and join as voice 1.

## Ideas to extend

- Quantize cues to the loop boundary instead of a fixed lead time.
- Per-phone gain or filtering sent from the conductor, to shape the spatial mix.
- Different samples per voice group (Reich’s *Come Out* uses the same idea with more voices).
