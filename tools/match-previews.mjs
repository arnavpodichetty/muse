// Matches each track in data/muse.js to its recording on Apple Music and
// stores the id as the track's `a`, which index.html uses to play a
// 30-second preview. Run it after adding releases or tracks:
//
//   node tools/match-previews.mjs            fill in tracks with no id yet
//   node tools/match-previews.mjs --all      match every track again
//   add --verbose to list every match
//
// Needs Node 18+ (for fetch). Apple's API allows about 20 requests a minute,
// so a full run takes a few minutes.
import fs from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'muse.js');
const ALL = process.argv.includes('--all');
const VERBOSE = process.argv.includes('--verbose');
const API = 'https://itunes.apple.com/';

const src = fs.readFileSync(DATA, 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(src, sandbox);
const M = sandbox.window.MUSE, SONGS = M.songs;

const wait = ms => new Promise(s => setTimeout(s, ms));
const get = async url => {
  await wait(3100);   // stay under Apple's rate limit
  const res = await fetch(API + url);
  if (!res.ok) throw new Error(res.status + ' from ' + url);
  return res.json();
};

// ---- Muse's whole catalogue on Apple Music: every album, then its songs ----
const catalogue = async () => {
  const hit = (await get('search?entity=song&limit=1&term=' + encodeURIComponent('muse plug in baby'))).results[0];
  const albums = (await get('lookup?id=' + hit.artistId + '&entity=album&limit=200')).results
    .filter(r => r.wrapperType === 'collection');
  const songs = new Map();
  for (const a of albums) {
    const j = await get('lookup?id=' + a.collectionId + '&entity=song&limit=200');
    j.results.filter(r => r.wrapperType === 'track' && r.kind === 'song').forEach(r => songs.set(r.trackId, r));
  }
  console.log(songs.size + ' recordings on ' + albums.length + ' albums');
  return [...songs.values()];
};

// ---- matching ----
const fold = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’‘]/g, "'");
const tidy = s => s.replace(/&/g, ' and ').replace(/\bpt\b\.?/g, 'part').replace(/[^a-z0-9*]+/g, ' ').trim();
// names lose their bracketed parts, unless that's all there is ("[JFK]")
const norm = s => { const f = fold(s), cut = tidy(f.replace(/\(.*?\)|\[.*?\]/g, ' ')); return cut || tidy(f); };
const flat = s => norm(s).replace(/ /g, '');
// Apple censors some names: "We Are F*****g F****d"
const nameOk = (theirs, want) => {
  const c = norm(theirs);
  if (c === want) return true;
  if (!c.includes('*')) return false;
  return new RegExp('^' + c.replace(/\*+/g, '[a-z]*') + '$').test(want);
};
const VERSIONS = ['live', 'remix', 'mix', 'demo', 'acoustic', 'instrumental', 'edit', 'session', 'reprise',
  'orchestral', 'remaster', 'alternate', 'only', 'remixx', 'recording', 'reinterpretation'];
const versionsIn = s => { s = ' ' + fold(s).replace(/[^a-z0-9]+/g, ' ') + ' '; return VERSIONS.filter(v => s.includes(' ' + v + ' ')); };

// the closest Muse recording with the same name: the same kind of version
// (live, remix, demo...) first, then one from the same release
const pick = (r, t, pool) => {
  // a demo can carry an early name for a later song (Balloonatic, Twin); it
  // only takes a recording by its own name
  const names = [norm(t.t)];
  if (t.s && SONGS[t.s] && r.type !== 'demo') names.push(norm(SONGS[t.s].n));
  const want = versionsIn((t.v || '') + ' ' + t.t);
  if (r.type === 'live' && !want.includes('live')) want.push('live');
  let best = null, top = -Infinity;
  for (const x of pool) {
    if (!x.previewUrl || !/^muse($|\s*[,&])/i.test(x.artistName) || !names.some(n => nameOk(x.trackName, n))) continue;
    const col = flat(x.collectionName), mine = flat(r.title);
    const same = col === mine, near = !same && (col.includes(mine) || (r.album && flat(r.album).includes(col)));
    const disc = t.b && flat(t.b).includes(col);
    // an "Intro" or "Interlude" only matches on its own release
    if (/^(intro|interlude|outro)$/.test(names[0]) && !same && !near && !disc) continue;
    const has = versionsIn(x.trackName + ' ' + (/\blive\b/i.test(x.collectionName) ? 'live' : ''));
    let score = 0;
    want.forEach(v => { score += has.includes(v) ? 4 : -2; });
    has.forEach(v => { if (!want.includes(v)) score -= 3; });
    if (same) score += 3; else if (near) score += 1;
    if (disc) score += 3;
    if (/six studio albums/i.test(x.collectionName)) score -= 1;
    if (score > top) { top = score; best = x; }
  }
  return best;
};

// a search catches the odd recording missing from the catalogue
const searched = {};
const search = async q => searched[q] || (searched[q] = (await get('search?entity=song&limit=50&term=' + encodeURIComponent('muse ' + q))).results || []);

// ---- data/muse.js, written back in its one-key-per-line style ----
const serialise = data => {
  const json = JSON.stringify(data);
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i], n = json[i + 1];
    out += c;
    if (inStr) {
      if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false;
      if (inStr) continue;
    } else if (c === '"') { inStr = true; continue; }
    if ('{[,'.includes(c) && n && n !== ']' && n !== '}') out += '\n';
    else if (n && '}]'.includes(n)) out += '\n';
  }
  const head = src.slice(0, src.indexOf('window.MUSE = ') + 'window.MUSE = '.length);
  return head + out + src.slice(src.lastIndexOf('}') + 1);
};

const todo = M.releases.flatMap(r => (r.tracks || []).filter(t => ALL || !t.a).map(t => [r, t]));
if (!todo.length) { console.log('Every track already has an id; pass --all to match them again.'); process.exit(); }
console.log('Matching ' + todo.length + ' tracks...');
const cat = await catalogue();
const miss = [];
let hit = 0;
for (const [r, t] of todo) {
  const x = pick(r, t, cat) || pick(r, t, await search((t.s && SONGS[t.s] ? SONGS[t.s].n : t.t).replace(/\(.*?\)/g, '')));
  delete t.a;
  const name = r.title + ' | ' + t.t + (t.v ? ' ' + t.v : '');
  if (x) { t.a = x.trackId; hit++; } else miss.push(name);
  if (VERBOSE) console.log((x ? 'ok  ' : '--  ') + name + (x ? '  =>  ' + x.trackName + ' [' + x.collectionName + ']' : ''));
}
fs.writeFileSync(DATA, serialise(M));
console.log(hit + ' of ' + todo.length + ' matched' + (miss.length ? '; no recording on Apple Music for:\n  ' + miss.join('\n  ') : ''));
