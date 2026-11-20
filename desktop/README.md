# Phase Study Simulator

A desktop app for testing the ensemble without a room full of phones. It shows the conductor and a grid of simulated phones in one window. Each simulated phone joins the room like a real one, and you can send each one to its own speaker or audio channel.

## Running it

You need [Node.js](https://nodejs.org) 20 or later.

```bash
cd desktop
npm install
npm start
```

## Using it

1. Serve the site and open a Cloudflare tunnel to it (see the main [README](../README.md)).
2. Paste the tunnel link into **Server link** and press **Load**. The conductor appears on the right and the simulated phones join.
   - To join a room that already exists, add `?room=ABCD` to the link.
   - Real phones can join the same room from the conductor's QR code.
3. Set the number of phones with **− / +**.
4. Use the menu on each card to choose where that phone plays: stereo on an output, or a single channel.
5. Start the piece from the conductor, or press **Space**.

On each card:

| | |
|---|---|
| **S** | Solo this phone. Ctrl-click (⌘-click on Mac) to solo several |
| **M** | Mute this phone |
| **♪** | Play a test tone on its output |
| **⧉** / **↻** / **×** | Show its page / reload it / remove it |

Solo and mute only change what you hear. Every phone keeps playing in time.

## Testing

```bash
npm run smoke -- --link=http://localhost:8080
```

## Building the app

```bash
npm run dist
```

This builds a portable `.exe` on Windows or a `.dmg` on macOS, in `dist/`. Each platform has to build its own.
