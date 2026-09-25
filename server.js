const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { WebSocketServer } = require('ws');

const PORT = 3000;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css' : 'text/css',
  '.js'  : 'application/javascript',
};

// ── HTTP: serve static files ──────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url      = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.resolve(path.join(ROOT, url.split('?')[0]));

  // Block path traversal
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

// ── WebSocket: relay any message to every other connected client ──────────────
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  ws.on('message', data => {
    const msg = data.toString();
    wss.clients.forEach(client => {
      if (client !== ws && client.readyState === 1 /* OPEN */) {
        client.send(msg);
      }
    });
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
function localIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = localIP();
  console.log('\nPhase Study — server running\n');
  console.log(`  Desktop  →  http://localhost:${PORT}`);
  console.log(`  Phone    →  http://${ip}:${PORT}/controller.html\n`);
});
