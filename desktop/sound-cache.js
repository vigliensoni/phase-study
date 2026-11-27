// ═══════════════════════════════════════════════════════════════════════════════
// SOUND CACHE — every simulated phone has its own session, so without this
// each one would download every sound file itself: 12 phones and a 14 MB score
// make 170 MB through one connection, and the piece waits for all of it.
//
// Here the sound files (by extension) are downloaded once, in this process,
// and every page that asks gets the same bytes. Everything else (pages,
// scripts, score.json) goes to the network as usual. The phones still decode
// the sounds themselves, as real phones would.
//
// Kept until the link changes (clear()), so a fixed file on the site is picked
// up by loading the link again.
// ═══════════════════════════════════════════════════════════════════════════════

const { net } = require('electron');

const SOUND = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|aiff?|webm)$/i;
const KEEP = ['content-type', 'access-control-allow-origin', 'cache-control', 'last-modified', 'etag'];

const files = new Map(); // url → Promise<{ body: Buffer, headers }>
const shared = new WeakSet();

// One download per URL, however many pages ask at once. Failures aren't kept,
// so the next request tries again.
function download(url) {
  if (!files.has(url)) {
    const p = net.fetch(url, { bypassCustomProtocolHandlers: true }).then(async r => {
      if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status });
      const headers = {};
      for (const k of KEEP) if (r.headers.has(k)) headers[k] = r.headers.get(k);
      return { body: Buffer.from(await r.arrayBuffer()), headers };
    });
    p.catch(() => files.delete(url));
    files.set(url, p);
  }
  return files.get(url);
}

function shareSounds(ses) {
  if (shared.has(ses)) return;
  shared.add(ses);
  const handler = async req => {
    const pass = () => ses.fetch(req, { bypassCustomProtocolHandlers: true });
    let path;
    try { path = new URL(req.url).pathname; } catch (e) { return pass(); }
    if (req.method !== 'GET' || req.headers.has('range') || !SOUND.test(path)) return pass();
    try {
      const { body, headers } = await download(req.url);
      return new Response(body, { status: 200, headers });
    } catch (e) {
      if (e.status) return new Response(null, { status: e.status }); // the site's own answer (404…)
      return pass();                                                   // a network error: let the page see it
    }
  };
  ses.protocol.handle('https', handler);
  ses.protocol.handle('http', handler); // a local server
}

function clear() { files.clear(); }

module.exports = { shareSounds, clear };
