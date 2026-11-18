// ═══════════════════════════════════════════════════════════════════════════════
// BACKEND — the room's MQTT broker, inside the app.
//
// The site's only live part is an MQTT broker reached over WebSocket (net.js);
// the conductor page owns the clock and the piece, and everything else is
// messages between pages. So the local backend is just that broker, running
// here on 127.0.0.1: the pages are given its address with ?broker=, and talk
// to it exactly as they talk to the public one (same topics, retained state,
// last-will "gone" messages, clock pings). Rehearsals then work offline, and
// clock sync gets the loopback's sub-millisecond round trip.
//
// The broker is aedes (from the mqtt.js team); `ws` carries it over WebSocket.
// ═══════════════════════════════════════════════════════════════════════════════

const http = require('http');
const { WebSocketServer, createWebSocketStream } = require('ws');

const HOST = '127.0.0.1'; // this computer only: real phones can't reach it (see README)

// Starts the broker on a free port. Returns { url, stop(), status() }.
async function start() {
  const { Aedes } = await import('aedes'); // an ES module
  const broker = await Aedes.createBroker();

  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({
    server, path: '/mqtt',
    handleProtocols: protocols => (protocols.has('mqtt') ? 'mqtt' : false), // what mqtt.js asks for
  });
  wss.on('connection', (ws, req) => broker.handle(createWebSocketStream(ws), req));

  // Who's connected: the conductor (cond-…) and every performer (perf-…)
  const clients = new Set();
  broker.on('client', c => clients.add(c.id));
  broker.on('clientDisconnect', c => clients.delete(c.id));
  let messages = 0;
  broker.on('publish', (packet, client) => { if (client) messages++; });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, resolve);
  });
  const { port } = server.address();

  // Drops every connection (their last wills fire, as when a phone leaves),
  // then closes the port
  let stopping = null;
  function stop() {
    if (!stopping) stopping = new Promise(resolve => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.close(() => broker.close(resolve));
      server.closeAllConnections();
    });
    return stopping;
  }

  const status = () => ({
    url: `ws://${HOST}:${port}/mqtt`, running: !stopping, messages,
    conductors: [...clients].filter(id => id.startsWith('cond-')).length,
    performers: [...clients].filter(id => id.startsWith('perf-')).length,
  });

  return { url: `ws://${HOST}:${port}/mqtt`, stop, status };
}

module.exports = { start };
