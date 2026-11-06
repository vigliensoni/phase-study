// ═══════════════════════════════════════════════════════════════════════════════
// PIECES — a piece kept outside this site: a folder holding score.json plus
// the audio it uses, e.g.
//
//   my-piece/
//     score.json        { "title": …, "events": [{ "play": "audio/rain.mp3", … }] }
//     audio/rain.mp3
//
// Sound paths in score.json are relative to the folder (see soundURL in
// score-engine.js). The folder is usually a public GitHub repo, so students
// can keep their piece in their own repo and paste its link into the
// conductor. Every phone fetches the audio straight from that folder.
// Shared by the conductor, the phones and the score editor.
// ═══════════════════════════════════════════════════════════════════════════════

// A link to a piece → the URL of its folder (ending in "/"). Accepts
//   https://github.com/user/repo                      (default branch, top folder)
//   https://github.com/user/repo/tree/branch/folder   (a branch and/or subfolder)
//   https://github.com/user/repo/blob/branch/folder/score.json
//   https://raw.githubusercontent.com/user/repo/branch/folder/
//   any other URL of the folder (or of its score.json), absolute or relative
// GitHub links are turned into raw.githubusercontent.com URLs, which any page
// can fetch from (GitHub sends the CORS header). "HEAD" means the default branch.
function pieceFolder(link) {
  let s = String(link || '').trim();
  if (!s) throw new Error('Paste a link to the piece first.');
  // "github.com/you/piece" without https:// would otherwise be read as a path on this site
  if (/^(www\.)?(github\.com|raw\.githubusercontent\.com)\//i.test(s)) s = 'https://' + s;
  const u = new URL(s, document.baseURI);
  const trail = p => p.replace(/\/?score\.json$/i, '').replace(/\/*$/, '/');

  if (u.hostname === 'github.com' || u.hostname === 'www.github.com') {
    const [owner, repo, kind, ref, ...path] = u.pathname.split('/').filter(Boolean);
    if (!owner || !repo) throw new Error('That GitHub link needs to include the repository, e.g. github.com/you/your-piece');
    const branch = (kind === 'tree' || kind === 'blob') && ref ? ref : 'HEAD';
    const folder = kind === 'tree' || kind === 'blob' ? path.join('/') : '';
    return trail(`https://raw.githubusercontent.com/${owner}/${repo.replace(/\.git$/, '')}/${branch}/${folder}`);
  }
  u.search = ''; u.hash = '';
  return trail(u.href);
}

async function fetchJSON(url) {
  let r;
  try { r = await fetch(url, { cache: 'no-cache' }); }
  catch (e) { throw new Error(`Could not reach ${url} (offline, or the site blocks it).`); }
  if (r.status === 404) throw new Error(`Not found: ${url}. Is the repo public, and is score.json in that folder?`);
  if (!r.ok) throw new Error(`Could not load ${url}: HTTP ${r.status}.`);
  const text = await r.text();
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`score.json is not valid JSON: ${e.message}`); }
}

// Loads a piece from a link → { base, score }. `base` is the folder's URL;
// sound paths in the score are relative to it.
async function loadPiece(link) {
  const base = pieceFolder(link);
  const score = await fetchJSON(base + 'score.json');
  if (!score || typeof score !== 'object' || Array.isArray(score)) throw new Error('score.json should hold one score: { "title": …, "groups": …, "events": [ … ] }');
  return { base, score };
}
