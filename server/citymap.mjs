// Builds the city of a project as a map of its architecture, not of its folder
// tree. Every place is a node in one graph: code modules, data stores (untracked
// data the sessions use), outside systems (servers, sites, MCP services) and
// local areas outside the repo. Edges come from imports, files changed together
// (in one task or one commit), code that names an outside system, and tasks that
// used a system while working on a module. Districts are roles (Storefront,
// Database, Security...; see roles.mjs): a folder that mixes roles becomes one
// block per role. A force layout packs each district's blocks, then lays the
// districts out as zones with avenues between them, tied ones side by side.
// Positions persist so the city does not reshuffle, and every place carries a
// birth time so a replay starts from empty ground.
import path from 'node:path';
import { db, kvGet, kvSet } from './db.mjs';
import { scanProject, countFiles, scanRefs } from './codescan.mjs';
import { key, rel, norm, HOME, isTempPath, CLAUDE_DIR } from './paths.mjs';
import { roleResolver, styleOf } from './roles.mjs';
import { traitsOf, kindOf } from './traits.mjs';

const MAX_MODULES = 90, MAX_EXT = 24, MAX_LOCAL = 6, MAX_STORES = 20;
const PAD = 0.5, GAP = 3.4; // lot border inside a block, street between blocks
const DGAP = 4;             // extra open ground between districts
const DMARGIN = 1.5;        // district ground around its outermost blocks
const LAYOUT_V = 3;         // bump to discard saved positions after a spacing change
const scans = new Map(); // pid -> scan (memory cache)

export function getScan(pid, root, maxAgeMs = 5 * 60e3) {
  let s = scans.get(pid);
  if (!s || Date.now() - s.scannedAt > maxAgeMs) { s = scanProject(root); scans.set(pid, s); }
  return s;
}
export function invalidateScan(pid) { const s = scans.get(pid); if (s) s.scannedAt = 0; }

const dirOf = p => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const trunc = (d, D) => d ? d.split('/').slice(0, D).join('/') : '';
const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };

function pickDepth(files) {
  let best = 1;
  for (let D = 1; D <= 6; D++) {
    const n = new Set(files.map(f => trunc(dirOf(f.p), D))).size;
    if (n <= MAX_MODULES) best = D; else break;
  }
  return best;
}

// Where a local path outside the repo goes: one area per place.
function outskirtOf(abs) {
  const k = key(abs);
  if (k.startsWith(key(CLAUDE_DIR) + '/')) {
    const r = rel(CLAUDE_DIR, abs).split('/');
    return { id: 'claude/' + r[0], label: '~/.claude/' + r[0] };
  }
  if (isTempPath(abs)) return { id: 'scratch', label: 'Scratch & temp' };
  const r = rel(HOME, abs);
  if (r != null) {
    const seg = r.split('/');
    const area = seg.length > 2 ? seg.slice(0, 2).join('/') : seg[0];
    return { id: 'home/' + area.toLowerCase(), label: '~/' + area };
  }
  const seg = norm(abs).split('/');
  return { id: 'disk/' + seg.slice(0, 2).join('/').toLowerCase(), label: seg.slice(0, 2).join('/') };
}

// api.stripe.com -> stripe.com, uk.trustpilot.com -> trustpilot.com, x.co.uk stays
function siteOf(target) {
  const t = target.toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(t) || !t.includes('.')) return t;
  const p = t.replace(/^www\./, '').split('.');
  if (p.length <= 2) return p.join('.');
  const n = p[p.length - 2].length <= 3 && p[p.length - 1].length === 2 ? 3 : 2;
  return p.slice(-n).join('.');
}
const isHost = t => t.includes('.') || /^\d/.test(t);
const REF_STOP = new Set(['claude', 'gmail', 'google', 'plugin', 'chrome', 'github', 'local']);
// named in almost every web file (XML namespaces, schema markup, docs examples): not an integration
const SITE_STOP = new Set(['w3.org', 'schema.org', 'example.com', 'example.org', 'ogp.me', 'purl.org', 'xmlns.com', 'google.com',
  'googleapis.com', 'gstatic.com', 'github.com', 'mozilla.org', 'npmjs.com', 'wikipedia.org', 'youtube.com', 'localhost']);
const BOILERPLATE = new Set(['__init__.py', 'index.ts', 'index.js', 'index.tsx', 'readme.md', '.gitkeep', 'package.json']);
function refToken(site) {
  if (SITE_STOP.has(site)) return null;
  if (isHost(site)) return site.length >= 6 ? site : null;
  const w = site.toLowerCase().split(/[-_ ]/)[0];
  return w.length >= 5 && !REF_STOP.has(w) ? w : null;
}

// Sibling folders with the same shape (logos/<site>, seo/<category>) are one
// module repeated, not separate modules: merge them into "parent/*".
function mergeSiblings(atoms) {
  const byParent = new Map();
  for (const k of atoms.keys()) {
    if (!k.includes('/')) continue;
    const p = dirOf(k);
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(k);
  }
  const merge = new Map();
  for (const [p, kids] of byParent) {
    if (kids.length < 4) continue;
    const shape = (k, f) => {
      const name = k.split('/').pop().toLowerCase(), stem = name.split('.')[0];
      return f.slice(k.length + 1).toLowerCase().split(name).join('*').split(stem).join('*');
    };
    // variants share a skeleton of file names; folders with different roles share almost none
    const sets = kids.map(k => new Set(atoms.get(k).map(f => shape(k, f)).filter(n => !BOILERPLATE.has(n.split('/').pop()))));
    const freq = new Map();
    for (const s of sets) for (const n of s) freq.set(n, (freq.get(n) || 0) + 1);
    const common = new Set([...freq].filter(([, c]) => c >= kids.length * 0.6).map(([n]) => n));
    if (common.size < 3) continue;
    const like = kids.filter((k, i) => [...sets[i]].filter(n => common.has(n)).length >= 3);
    if (like.length >= 4) for (const k of like) merge.set(k, p + '/*');
  }
  return merge;
}

// retail-shops/books-maps/raw + retail-shops/fine-art/raw + ... -> retail-shops/*/raw
function mergeStores(list) {
  const pat = new Map();
  for (const w of list) {
    const seg = w.key.split('/');
    if (seg.length < 2) continue;
    for (let i = 1; i < seg.length - 1; i++) { // keep a common prefix
      const p = [...seg.slice(0, i), '*', ...seg.slice(i + 1)].join('/');
      if (!pat.has(p)) pat.set(p, []);
      pat.get(p).push(w);
    }
  }
  const into = new Map();
  for (const [p, ws] of [...pat].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    const free = ws.filter(w => !into.has(w.key));
    if (free.length >= 3) for (const w of free) into.set(w.key, p);
  }
  return into;
}

function blockFor(n, store) {
  if (store) { const s = Math.round(2.5 + Math.log10(Math.max(1, n)) * 1.6); return { cols: s, rows: s }; }
  const cap = n + Math.max(1, Math.ceil(n * 0.2));
  const cols = Math.max(1, Math.ceil(Math.sqrt(cap)));
  return { cols, rows: Math.ceil(cap / cols) };
}

// Force layout: springs along edges, districts pull together, footprints never
// overlap and keep a street between them. Known places only settle.
function forceLayout(nodes, edges, comm, saved) {
  const n = nodes.length;
  const X = new Float64Array(n), Z = new Float64Array(n);
  const R = nodes.map(nd => Math.hypot(nd.w, nd.h) / 2);
  const fixed = new Uint8Array(n);
  let known = 0;
  nodes.forEach((nd, i) => { const s = saved[nd.key]; if (s) { X[i] = s[0]; Z[i] = s[1]; fixed[i] = 1; known++; } });
  const fresh = known < n * 0.7;
  const nbrs = Array.from({ length: n }, () => []);
  for (const e of edges) { nbrs[e.a].push([e.b, e.lw]); nbrs[e.b].push([e.a, e.lw]); }
  if (fresh) {
    fixed.fill(0);
    // districts on a sunflower spiral, members scattered around their centre
    const groups = new Map();
    nodes.forEach((nd, i) => { if (!groups.has(comm[i])) groups.set(comm[i], []); groups.get(comm[i]).push(i); });
    const order = [...groups.values()].sort((a, b) => b.length - a.length);
    const spread = Math.sqrt(nodes.reduce((s, nd) => s + (nd.w + GAP) * (nd.h + GAP), 0));
    order.forEach((g, gi) => {
      const a = gi * 2.39996, r = spread * 0.35 * Math.sqrt(gi);
      const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
      const rr = Math.sqrt(g.reduce((s, i) => s + (nodes[i].w + GAP) * (nodes[i].h + GAP), 0)) * 0.5;
      for (const i of g) { const h = hash(nodes[i].key), h2 = hash(nodes[i].key + '#'); X[i] = cx + (h - 0.5) * rr * 2; Z[i] = cz + (h2 - 0.5) * rr * 2; }
    });
  } else {
    for (let i = 0; i < n; i++) {
      if (fixed[i]) continue;
      let sx = 0, sz = 0, sw = 0;
      for (const [j, w] of nbrs[i]) if (fixed[j]) { sx += X[j] * w; sz += Z[j] * w; sw += w; }
      const h = hash(nodes[i].key) * Math.PI * 2;
      X[i] = (sw ? sx / sw : 0) + Math.cos(h) * (R[i] + 3); Z[i] = (sw ? sz / sw : 0) + Math.sin(h) * (R[i] + 3);
    }
  }
  const iters = fresh ? 600 : 160;
  const FX = new Float64Array(n), FZ = new Float64Array(n);
  for (let it = 0; it < iters; it++) {
    const temp = (fresh ? 1.6 : 0.5) * (1 - it / iters) + 0.05;
    FX.fill(0); FZ.fill(0);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      let dx = X[i] - X[j], dz = Z[i] - Z[j];
      let d2 = dx * dx + dz * dz;
      if (d2 < 1e-6) { dx = hash(nodes[i].key + j) - 0.5; dz = hash(nodes[j].key + i) - 0.5; d2 = dx * dx + dz * dz; }
      const min = R[i] + R[j] + GAP + (comm[i] !== comm[j] ? DGAP : 0);
      if (d2 > min * min * 9) continue;
      const d = Math.sqrt(d2), f = 0.6 * min * min / d2;
      FX[i] += dx / d * f; FZ[i] += dz / d * f; FX[j] -= dx / d * f; FZ[j] -= dz / d * f;
    }
    for (const e of edges) {
      const dx = X[e.b] - X[e.a], dz = Z[e.b] - Z[e.a];
      const d = Math.sqrt(dx * dx + dz * dz) + 1e-6;
      const rest = R[e.a] + R[e.b] + GAP + (comm[e.a] !== comm[e.b] ? DGAP : 0);
      const f = 0.05 * e.lw * (d - rest) / d;
      FX[e.a] += dx * f; FZ[e.a] += dz * f; FX[e.b] -= dx * f; FZ[e.b] -= dz * f;
    }
    // district cohesion and a gentle pull to the middle
    const cx = new Map();
    for (let i = 0; i < n; i++) { const c = cx.get(comm[i]) || [0, 0, 0]; c[0] += X[i]; c[1] += Z[i]; c[2]++; cx.set(comm[i], c); }
    for (let i = 0; i < n; i++) {
      const c = cx.get(comm[i]);
      const g = nbrs[i].length ? 0.004 : 0.03; // places with no ties would drift off to the edge
      FX[i] += (c[0] / c[2] - X[i]) * 0.04 - X[i] * g;
      FZ[i] += (c[1] / c[2] - Z[i]) * 0.04 - Z[i] * g;
    }
    for (let i = 0; i < n; i++) {
      const s = fixed[i] ? 0.15 : 1;
      const f = Math.hypot(FX[i], FZ[i]), lim = temp * 3;
      const k = f > lim ? lim / f : 1;
      X[i] += FX[i] * k * s; Z[i] += FZ[i] * k * s;
    }
  }
  // footprints must not overlap: push apart along the shallower axis
  for (let it = 0; it < 400; it++) {
    let moved = false;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const dx = X[j] - X[i], dz = Z[j] - Z[i], gap = GAP + (comm[i] !== comm[j] ? DGAP : 0);
      const ox = (nodes[i].w + nodes[j].w) / 2 + gap - Math.abs(dx), oz = (nodes[i].h + nodes[j].h) / 2 + gap - Math.abs(dz);
      if (ox <= 0 || oz <= 0) continue;
      moved = true;
      const wi = fixed[i] && !fixed[j] ? 0.2 : !fixed[i] && fixed[j] ? 0.8 : 0.5;
      if (ox < oz) { const s = (dx >= 0 ? 1 : -1) * (ox + 0.01); X[i] -= s * wi; X[j] += s * (1 - wi); }
      else { const s = (dz >= 0 ? 1 : -1) * (oz + 0.01); Z[i] -= s * wi; Z[j] += s * (1 - wi); }
    }
    if (!moved) break;
  }
  const pos = {};
  nodes.forEach((nd, i) => { pos[nd.key] = [Math.round(X[i] * 2) / 2, Math.round(Z[i] * 2) / 2]; });
  return pos;
}

// Two levels: each district's places are laid out on their own, then every
// district becomes one big lot and those lots are laid out, pulled together by
// the ties between districts. No district can reach into another.
function districtLayout(nodes, edges, dOf, dIds, saved) {
  const nD = dIds.length, lots = [], local = [];
  for (let d = 0; d < nD; d++) {
    const idx = [];
    nodes.forEach((_, i) => { if (dOf[i] === d) idx.push(i); });
    const at = new Map(idx.map((i, k) => [i, k]));
    const sub = idx.map(i => nodes[i]);
    const subE = edges.filter(e => dOf[e.a] === d && dOf[e.b] === d).map(e => ({ ...e, a: at.get(e.a), b: at.get(e.b) }));
    const pos = idx.length ? forceLayout(sub, subE, sub.map(() => 0), saved.lpos) : {};
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const nd of sub) { const [x, z] = pos[nd.key]; x0 = Math.min(x0, x - nd.w / 2); x1 = Math.max(x1, x + nd.w / 2); z0 = Math.min(z0, z - nd.h / 2); z1 = Math.max(z1, z + nd.h / 2); }
    // snap the centre to the half grid so places keep their grid alignment
    const cx = Math.round((x0 + x1) / 2 * 2) / 2, cz = Math.round((z0 + z1) / 2 * 2) / 2;
    Object.assign(saved.lpos, pos);
    local.push({ pos, cx, cz });
    lots.push({ key: 'D:' + dIds[d], w: Math.max(...[x1 - cx, cx - x0].map(Math.abs)) * 2 + DMARGIN * 2, h: Math.max(...[z1 - cz, cz - z0].map(Math.abs)) * 2 + DMARGIN * 2 });
  }
  const DE = new Map();
  for (const e of edges) {
    const a = dOf[e.a], b = dOf[e.b];
    if (a === b) continue;
    const k = Math.min(a, b) + ',' + Math.max(a, b);
    const x = DE.get(k) || { a: Math.min(a, b), b: Math.max(a, b), w: 0 };
    x.w += e.w; DE.set(k, x);
  }
  const dEdges = [...DE.values()].map(x => ({ ...x, lw: Math.log2(1 + Math.log2(1 + x.w)) }));
  const dpos = forceLayout(lots, dEdges, lots.map((_, i) => i), saved.dpos);
  Object.assign(saved.dpos, dpos);
  const pos = {};
  nodes.forEach((nd, i) => {
    const L = local[dOf[i]], [dx, dz] = dpos['D:' + dIds[dOf[i]]], [x, z] = L.pos[nd.key];
    pos[nd.key] = [x - L.cx + dx, z - L.cz + dz];
  });
  return pos;
}

const KINDS = ['prompt', 'read', 'write', 'search', 'cmd', 'touch', 'remote', 'spawn', 'skill', 'ask', 'other'];
export const KIND_INDEX = Object.fromEntries(KINDS.map((k, i) => [k, i]));
const HUES = [205, 160, 32, 280, 340, 50, 190, 120, 255, 15, 300, 90, 230, 175, 0, 140];
const STRENGTH = { write: 1, remote: 0.8, skill: 0.6, read: 0.4, search: 0.3, touch: 0.3 };

export function buildCity(pid) {
  const proj = db.prepare('SELECT * FROM projects WHERE id=?').get(pid);
  if (!proj) return null;
  const root = proj.root;
  const scan = getScan(pid, root);
  const inv = scan.files;
  const invByKey = new Map(inv.map(f => [f.p.toLowerCase(), f]));
  const trackedDirs = new Set();
  for (const f of inv) { let d = dirOf(f.p); while (d) { trackedDirs.add(d.toLowerCase()); d = dirOf(d); } }
  const D = pickDepth(inv);
  const firstEv = db.prepare('SELECT MIN(ts) t FROM events WHERE project_id=?').get(pid)?.t ?? Date.now();
  const T0 = Math.min(firstEv, scan.commits[0]?.ts ?? Infinity);

  // ---- code modules: folder atoms, repeated siblings merged
  const atoms = new Map();
  for (const f of inv) { const a = trunc(dirOf(f.p), D); if (!atoms.has(a)) atoms.set(a, []); atoms.get(a).push(f.p); }
  const merged = mergeSiblings(atoms);
  const modOfDir = d => { const a = trunc(d, D); return merged.get(a) ?? a; };

  // ---- classify every event path once
  const pathRows = db.prepare(`SELECT path, COUNT(*) n, SUM(kind='write') w, SUM(kind IN ('read','search','touch')) r, MIN(ts) first, MAX(ts) last,
    MIN(CASE WHEN kind='write' THEN ts END) fw FROM events WHERE project_id=? AND path IS NOT NULL GROUP BY path`).all(pid);
  const pathTarget = new Map(); // event path -> {type, id}
  const storeRaw = new Map();   // relKey -> {key, n, paths, first}
  const outskirts = new Map();
  const fileStats = new Map();
  for (const r of pathRows) {
    const rp = rel(root, r.path);
    if (rp === null) {
      const o = outskirtOf(r.path);
      const cur = outskirts.get(o.id) || { ...o, n: 0, first: Infinity, last: 0 };
      cur.n += r.n; cur.first = Math.min(cur.first, r.first); cur.last = Math.max(cur.last, r.last); outskirts.set(o.id, cur);
      pathTarget.set(r.path, { type: 'x', id: 'local:' + o.id });
      continue;
    }
    const lk = rp.toLowerCase();
    const f = invByKey.get(lk);
    if (f) {
      const s = fileStats.get(f.p) || { w: 0, r: 0, last: 0, fw: Infinity };
      s.w += r.w; s.r += r.r; s.last = Math.max(s.last, r.last); if (r.fw != null) s.fw = Math.min(s.fw, r.fw); fileStats.set(f.p, s);
      pathTarget.set(r.path, { type: 'f', id: f.p });
      continue;
    }
    if (lk === '') { pathTarget.set(r.path, { type: 'dir', id: '' }); continue; }
    if (trackedDirs.has(lk)) { pathTarget.set(r.path, { type: 'dir', id: rp }); continue; }
    const seg = rp.split('/');
    const dep = seg.findIndex(s => s === 'node_modules' || s === '.git' || s === '__pycache__' || s === '.venv');
    if (dep >= 0) { pathTarget.set(r.path, { type: 'dir', id: seg.slice(0, dep).join('/') }); continue; }
    // untracked: the first path prefix that is not a tracked directory is the store
    let i = 0; while (i < seg.length - 1 && trackedDirs.has(seg.slice(0, i + 1).join('/').toLowerCase())) i++;
    const wk = seg.slice(0, i + 1).join('/');
    const isFileLeaf = i === seg.length - 1 && /\.[^/]+$/.test(wk);
    const whKey = isFileLeaf ? (dirOf(wk) || '(root)') + '/*' : wk;
    const cur = storeRaw.get(whKey.toLowerCase()) || { key: whKey, n: 0, paths: new Set(), first: Infinity };
    cur.n += r.n; cur.paths.add(lk); cur.first = Math.min(cur.first, r.first); storeRaw.set(whKey.toLowerCase(), cur);
    pathTarget.set(r.path, { type: 'm', id: '#wh:' + whKey });
  }

  // file births: first commit, first AI write or creation on disk, never before the city starts
  const fileBorn = new Map();
  for (const f of inv) {
    const s = fileStats.get(f.p);
    fileBorn.set(f.p, Math.max(T0, Math.min(f.born ?? Infinity, s?.fw ?? Infinity, f.ctime ?? Infinity, Date.now())));
  }

  // ---- nodes
  const nodes = [], nIdx = new Map();
  const addNode = nd => { nIdx.set(nd.key, nodes.length); nodes.push(nd); return nd; };
  const modFiles = new Map();
  for (const f of inv) { const mk = modOfDir(dirOf(f.p)); if (!modFiles.has(mk)) modFiles.set(mk, []); modFiles.get(mk).push(f.p); }
  // one block per role a module plays
  const R = roleResolver(kvGet('roles:' + pid));
  const blockOf = new Map(), mainBlock = new Map(); // file -> node, module -> its biggest block
  for (const [mk, files] of [...modFiles].sort((a, b) => a[0].localeCompare(b[0]))) {
    files.sort();
    const variants = mk.endsWith('/*') ? [...atoms.keys()].filter(a => merged.get(a) === mk).length : 0;
    const label = mk ? (variants ? `${mk} (${variants})` : mk) : '(root)';
    const byRole = new Map();
    for (const p of files) { const r = R.file(mk, p, files); if (!byRole.has(r)) byRole.set(r, []); byRole.get(r).push(p); }
    let big = -1;
    for (const [role, part] of byRole) {
      const b = blockFor(part.length, false);
      addNode({ key: 'm:' + mk + '@' + role, kind: 'module', id: mk, role, split: byRole.size > 1, files: part, ...b, w: b.cols + PAD * 2, h: b.rows + PAD * 2,
        born: Math.min(...part.map(p => fileBorn.get(p))), label });
      const ni = nodes.length - 1;
      for (const p of part) blockOf.set(p, ni);
      if (big < 0 || part.length > nodes[big].files.length) big = ni;
    }
    mainBlock.set(mk, big);
  }
  // data stores with real traffic, look-alike folders merged
  const storeList = [...storeRaw.values()].filter(w => w.n >= 3).sort((a, b) => b.n - a.n);
  const into = mergeStores(storeList);
  const stores = new Map();
  for (const w of storeList) {
    const k = into.get(w.key) || w.key;
    const s = stores.get(k) || { key: k, n: 0, members: [], first: Infinity };
    s.n += w.n; s.members.push(w.key); s.first = Math.min(s.first, w.first); stores.set(k, s);
  }
  const storeKeep = [...stores.values()].sort((a, b) => b.n - a.n).slice(0, MAX_STORES);
  const whCounts = kvGet('whcount:' + pid) || {};
  const storeOf = new Map(); // raw store key -> kept store key
  for (const s of storeKeep) {
    let onDisk = 0, partial = false;
    for (const mkey of s.members) {
      if (mkey.endsWith('/*')) { onDisk += storeRaw.get(mkey.toLowerCase())?.paths.size || 0; continue; }
      if (whCounts[mkey] == null) { const c = countFiles(path.join(root, mkey)); whCounts[mkey] = c.n + (c.partial ? '+' : ''); }
      onDisk += parseInt(whCounts[mkey], 10) || 0; if (String(whCounts[mkey]).endsWith('+')) partial = true;
      storeOf.set(mkey, s.key);
    }
    for (const mkey of s.members) storeOf.set(mkey, s.key);
    const b = blockFor(onDisk || s.n, true);
    const label = s.key.endsWith('/*') ? dirOf(s.key).replace('(root)', 'root') + ' (loose files)' : s.key;
    addNode({ key: 'm:#wh:' + s.key, kind: 'store', id: '#wh:' + s.key, files: [], n: onDisk || s.n, onDisk: onDisk ? onDisk + (partial ? '+' : '') : null,
      role: R.place('m:#wh:' + s.key, label), ...b, w: b.cols + PAD, h: b.rows + PAD, born: Math.max(T0, s.first), label });
  }
  kvSet('whcount:' + pid, whCounts);

  // outside systems, grouped by site; the ones the code names or the work leans on get their own building
  const remoteRows = db.prepare(`SELECT target, COUNT(*) n, MIN(ts) first, MAX(ts) last, COUNT(DISTINCT task_id) tasks FROM events
    WHERE project_id=? AND kind IN ('remote','skill') AND target IS NOT NULL GROUP BY target`).all(pid);
  const sites = new Map();
  for (const r of remoteRows) {
    const s = siteOf(r.target);
    const cur = sites.get(s) || { site: s, n: 0, first: Infinity, last: 0, tasks: 0, targets: [] };
    cur.n += r.n; cur.first = Math.min(cur.first, r.first); cur.last = Math.max(cur.last, r.last); cur.tasks += r.tasks; cur.targets.push(r.target);
    sites.set(s, cur);
  }
  const tokens = [...new Set([...sites.keys()].map(refToken).filter(Boolean))];
  const refs = scanRefs(scan.root, inv, tokens, siteOf);
  for (const s of sites.values()) {
    const t = refToken(s.site);
    s.refFiles = t ? refs.get(t) || [] : [];
    s.score = s.refFiles.length * 4 + s.tasks + Math.log2(1 + s.n);
  }
  const extKeep = [...sites.values()].filter(s => s.site !== 'web search' && ((s.refFiles.length > 0 && s.n >= 2) || (s.tasks >= 3 && s.n >= 8)))
    .sort((a, b) => b.score - a.score).slice(0, MAX_EXT);
  const keptSite = new Set(extKeep.map(s => s.site));
  for (const s of extKeep) {
    const refBorn = Math.min(...s.refFiles.map(p => fileBorn.get(p) ?? Infinity));
    const host = isHost(s.site);
    addNode({ key: 'remote:' + s.site, kind: 'ext', type: host ? 'host' : 'service', label: s.site, n: s.n, first: s.first, last: s.last,
      role: R.place('remote:' + s.site, s.site), refs: s.refFiles, w: host ? 2.6 : 2.8, h: host ? 2.6 : 2.8, born: Math.max(T0, Math.min(s.first, refBorn)) });
  }
  const rest = [...sites.values()].filter(s => !keptSite.has(s.site));
  if (rest.length) {
    const n = rest.reduce((a, s) => a + s.n, 0), first = Math.min(...rest.map(s => s.first)), last = Math.max(...rest.map(s => s.last));
    addNode({ key: 'remote:*', kind: 'ext', type: 'web', label: `The web · ${rest.length} sites`, n, first, last, refs: [], w: 3.4, h: 3.4, born: Math.max(T0, first),
      top: rest.sort((a, b) => b.n - a.n).slice(0, 12).map(s => [s.site, s.n]) });
  }
  const localKeep = [...outskirts.values()].filter(o => o.n >= 10).sort((a, b) => b.n - a.n).slice(0, MAX_LOCAL);
  for (const o of localKeep) addNode({ key: 'local:' + o.id, kind: 'local', type: 'local', label: o.label, role: R.place('local:' + o.id, o.label) || 'workspace', n: o.n, first: o.first, last: o.last, refs: [], w: 3, h: 3, born: Math.max(T0, o.first) });

  // ---- where an event lands, as a node
  const modKeys = new Set([...modFiles.keys()]);
  const nearCache = new Map();
  const nearestModule = d => {
    if (nearCache.has(d)) return nearCache.get(d);
    let k = modOfDir(d);
    if (!modKeys.has(k)) {
      const below = [...modKeys].filter(m => d === '' ? false : m.toLowerCase().startsWith(d.toLowerCase() + '/'));
      if (below.length) k = below.sort((a, b) => modFiles.get(b).length - modFiles.get(a).length)[0];
      else { let p = d; while (p && !modKeys.has(modOfDir(p))) p = dirOf(p); k = p ? modOfDir(p) : (modKeys.has('') ? '' : null); }
    }
    nearCache.set(d, k);
    return k;
  };
  const siteNode = target => { const s = siteOf(target); return nIdx.get('remote:' + s) ?? (s === 'web search' || sites.has(s) ? nIdx.get('remote:*') : undefined); };
  const classify = p => {
    let t = pathTarget.get(p);
    if (!t) {
      const rp = rel(root, p);
      if (rp === null) t = { type: 'x', id: 'local:' + outskirtOf(p).id };
      else { const f = invByKey.get(rp.toLowerCase()); if (f) t = { type: 'f', id: f.p }; else { let d = rp; while (d && !trackedDirs.has(d.toLowerCase())) d = dirOf(d); t = { type: 'dir', id: d }; } }
      pathTarget.set(p, t);
    }
    return t;
  };
  const nodeOfPath = p => {
    const t = classify(p);
    if (t.type === 'f') return blockOf.get(t.id);
    if (t.type === 'm') { const s = storeOf.get(t.id.slice(4)); if (s != null) return nIdx.get('m:#wh:' + s); const k = nearestModule(dirOf(t.id.slice(4))); return k == null ? undefined : mainBlock.get(k); }
    if (t.type === 'x') return nIdx.get(t.id);
    if (t.type === 'dir') { const k = nearestModule(t.id); return k == null ? undefined : mainBlock.get(k); }
  };

  // ---- connections
  const E = new Map();
  const edge = (i, j) => {
    if (i == null || j == null || i === j) return null;
    const k = i < j ? i + ',' + j : j + ',' + i;
    let e = E.get(k);
    if (!e) { e = { a: Math.min(i, j), b: Math.max(i, j), imp: 0, task: 0, commit: 0, ref: 0, ev: Infinity }; E.set(k, e); }
    return e;
  };
  const fileNode = p => blockOf.get(p);
  for (const [a, b] of scan.edges) {
    const e = edge(fileNode(a), fileNode(b)); if (!e) continue;
    e.imp++; e.ev = Math.min(e.ev, Math.max(fileBorn.get(a) ?? T0, fileBorn.get(b) ?? T0));
  }
  for (const c of scan.commits) {
    const ms = [...new Set(c.files.map(p => invByKey.has(p.toLowerCase()) ? fileNode(p) : undefined).filter(x => x != null))];
    if (ms.length < 2 || ms.length > 15) continue;
    for (let x = 0; x < ms.length; x++) for (let y = x + 1; y < ms.length; y++) { const e = edge(ms[x], ms[y]); e.commit += 1 / (ms.length - 1); e.ev = Math.min(e.ev, c.ts); }
  }
  for (const nd of nodes) if (nd.kind === 'ext') for (const p of nd.refs) {
    const e = edge(fileNode(p), nIdx.get(nd.key)); if (!e) continue;
    e.ref++; e.ev = Math.min(e.ev, fileBorn.get(p) ?? T0);
  }
  // tasks: places used in the same piece of work are connected
  let curTask = null, used = new Map();
  const flush = () => {
    const list = [...used];
    if (list.length >= 2) {
      const norm = 1 / (list.length - 1) * (list.length > 16 ? 16 / list.length : 1);
      for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
        const [i, a] = list[x], [j, b] = list[y];
        const e = edge(i, j); e.task += Math.min(a.s, b.s) * norm; e.ev = Math.min(e.ev, Math.max(a.t, b.t));
      }
    }
    used = new Map();
  };
  for (const r of db.prepare(`SELECT task_id, kind, path, target, MIN(ts) t FROM events WHERE project_id=? AND task_id IS NOT NULL
      AND kind IN ('write','read','search','touch','remote','skill') AND (path IS NOT NULL OR target IS NOT NULL)
      GROUP BY task_id, kind, path, target ORDER BY task_id`).iterate(pid)) {
    if (r.task_id !== curTask) { flush(); curTask = r.task_id; }
    const i = (r.kind === 'remote' || r.kind === 'skill') ? (r.target ? siteNode(r.target) : undefined) : r.path ? nodeOfPath(r.path) : undefined;
    if (i == null) continue;
    const s = STRENGTH[r.kind] || 0.3, u = used.get(i);
    if (u) { u.s = Math.max(u.s, s); u.t = Math.min(u.t, r.t); } else used.set(i, { s, t: r.t });
  }
  flush();
  const edges = [];
  for (const e of E.values()) {
    e.w = 1.5 * Math.log2(1 + e.imp) + 1.2 * Math.log2(1 + e.task) + Math.log2(1 + e.commit) + 2 * Math.log2(1 + e.ref);
    if (e.w < 0.35) continue;
    e.lw = Math.log2(1 + e.w);
    e.born = Math.max(nodes[e.a].born, nodes[e.b].born, Math.max(T0, e.ev === Infinity ? T0 : e.ev));
    edges.push(e);
  }
  edges.sort((x, y) => y.w - x.w);

  // ---- districts: one per role; a place with no role of its own joins the one it is most tied to
  const saved = kvGet('graph:' + pid) || {};
  if (saved.v !== LAYOUT_V) Object.assign(saved, { v: LAYOUT_V, lpos: {}, dpos: {}, lots: {} });
  saved.hue ||= {};
  const role = nodes.map(nd => nd.role || null);
  for (let pass = 0; pass < 3; pass++) {
    const pull = nodes.map(() => new Map());
    for (const e of edges) for (const [x, y] of [[e.a, e.b], [e.b, e.a]]) if (!role[x] && role[y]) pull[x].set(role[y], (pull[x].get(role[y]) || 0) + e.w);
    let any = false;
    pull.forEach((m, i) => { const best = [...m].sort((p, q) => q[1] - p[1])[0]; if (best) { role[i] = best[0]; any = true; } });
    if (!any) break;
  }
  const order = new Map(R.list.map((d, i) => [d.id, i]));
  const dIds = [...new Set(role.map(r => r || 'workspace'))].sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
  const dOf = Int32Array.from(role, r => dIds.indexOf(r || 'workspace'));
  const usedHue = new Set(dIds.map(d => saved.hue[d]).filter(h => h != null));
  for (const d of dIds) {
    if (saved.hue[d] == null) { const free = HUES.find(h => !usedHue.has(h)) ?? HUES[hash(d) * HUES.length | 0]; saved.hue[d] = free; usedHue.add(free); }
  }

  // ---- layout
  const pos = districtLayout(nodes, edges, dOf, dIds, saved);
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  nodes.forEach(nd => { const [x, z] = pos[nd.key]; minX = Math.min(minX, x - nd.w / 2); maxX = Math.max(maxX, x + nd.w / 2); minZ = Math.min(minZ, z - nd.h / 2); maxZ = Math.max(maxZ, z + nd.h / 2); });
  const ox = Math.round((minX + maxX) / 2 * 2) / 2, oz = Math.round((minZ + maxZ) / 2 * 2) / 2;
  for (const k in pos) { pos[k][0] -= ox; pos[k][1] -= oz; }

  // ---- output
  const subsys = kvGet('subsys:' + pid) || {};
  const modulesOut = [], files = [], fIdx = new Map();
  const localMods = new Set(inv.flatMap(f => f.p.toLowerCase().replace(/\.[^./]+$/, '').split('/')));
  const externals = [];
  const ref = new Array(nodes.length); // node -> [tt, ti]
  nodes.forEach((nd, i) => {
    const [cx, cz] = pos[nd.key];
    if (nd.kind === 'module' || nd.kind === 'store') {
      const mi = modulesOut.length; ref[i] = [1, mi];
      const x = cx - nd.w / 2, z = cz - nd.h / 2;
      let lots = saved.lots[nd.key];
      if (nd.kind === 'module') {
        if (!lots || lots.cols !== nd.cols) lots = { cols: nd.cols, at: {} };
        const want = new Set(nd.files);
        for (const f of Object.keys(lots.at)) if (!want.has(f) || lots.at[f] >= nd.cols * nd.rows) delete lots.at[f];
        const taken = new Set(Object.values(lots.at)); let free = 0;
        for (const f of nd.files) if (!(f in lots.at)) { while (taken.has(free)) free++; lots.at[f] = free; taken.add(free); }
        saved.lots[nd.key] = lots;
        for (const p of nd.files) {
          const f = invByKey.get(p.toLowerCase()), lot = lots.at[p];
          const s = fileStats.get(p) || { w: 0, r: 0, last: 0 };
          fIdx.set(p, files.length);
          files.push({ p, m: mi, lot, x: x + PAD + (lot % nd.cols) + 0.5, z: z + PAD + Math.floor(lot / nd.cols) + 0.5,
            kind: f.kind, size: f.size, born: fileBorn.get(p), churn: f.churn, w: s.w, r: s.r, last: s.last || null });
        }
      }
      const title = subsys[nd.id]?.name || null, rname = R.list.find(d => d.id === nd.role)?.name;
      const kind = kindOf(dIds[dOf[i]], R.list.find(d => d.id === dIds[dOf[i]])?.name);
      const traits = nd.kind === 'module' ? traitsOf(scan.root, nd.files.map(p => invByKey.get(p.toLowerCase())).filter(Boolean), kind, localMods) : null;
      modulesOut.push({ id: nd.id, key: nd.key, district: dOf[i], x, z, w: nd.w, h: nd.h, cols: nd.cols, rows: nd.rows, warehouse: nd.kind === 'store',
        label: nd.label, files: nd.kind === 'store' ? nd.n : nd.files.length, onDisk: nd.onDisk ?? null, born: nd.born,
        desc: subsys[nd.id]?.desc || null, title: nd.split && rname ? `${title || nd.label} · ${rname}` : title,
        kind: traits?.kind || null, props: traits?.props || [] });
    } else {
      const xi = externals.length; ref[i] = [3, xi];
      externals.push({ id: nd.key, label: nd.label, type: nd.type, n: nd.n, first: nd.first, last: nd.last, x: cx, z: cz, w: nd.w, h: nd.h,
        district: dOf[i], born: nd.born, refs: nd.refs.slice(0, 40), refCount: nd.refs.length, top: nd.top || null });
    }
  });
  kvSet('graph:' + pid, saved);
  const districts = dIds.map((id, di) => {
    const members = []; nodes.forEach((_, i) => { if (dOf[i] === di) members.push(i); });
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const i of members) { const [cx, cz] = pos[nodes[i].key]; x0 = Math.min(x0, cx - nodes[i].w / 2); x1 = Math.max(x1, cx + nodes[i].w / 2); z0 = Math.min(z0, cz - nodes[i].h / 2); z1 = Math.max(z1, cz + nodes[i].h / 2); }
    const r = R.list.find(d => d.id === id) || { name: id, desc: '' };
    // its properties over every block it holds, plus the places that serve it
    const own = members.flatMap(i => nodes[i].kind === 'module' ? nodes[i].files : []).map(p => invByKey.get(p.toLowerCase())).filter(Boolean);
    const traits = traitsOf(scan.root, own, kindOf(id, r.name), localMods);
    const placeProp = (k, list) => list.length ? [{ k, v: list.map(nd => ({ t: nd.label, n: nd.n || 0, f: [] })) }] : [];
    const stores = members.map(i => nodes[i]).filter(nd => nd.kind === 'store'), ext = members.map(i => nodes[i]).filter(nd => nd.kind === 'ext' || nd.kind === 'local');
    const props = traits.props.filter(p => !p.basic).concat(placeProp('Data stores', stores), placeProp('Outside systems', ext), traits.props.filter(p => p.basic));
    return { id, name: r.name, desc: r.desc || null, hue: saved.hue[id], x: x0, z: z0, w: x1 - x0, h: z1 - z0,
      born: Math.min(...members.map(i => nodes[i].born)), members: members.map(i => ref[i]), kind: traits.kind, style: styleOf({ ...r, id, style: r.style }), props };
  });
  const roads = new Set();
  // roads: every place keeps its three strongest ties, plus a spanning tree so nothing is cut off
  const per = new Map();
  for (const e of edges) for (const x of [e.a, e.b]) { const c = per.get(x) || 0; if (c < 3) { roads.add(e); per.set(x, c + 1); } }
  const parent = nodes.map((_, i) => i);
  const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  for (const e of edges) { const ra = find(e.a), rb = find(e.b); if (ra !== rb) { parent[ra] = rb; roads.add(e); } }
  const links = edges.slice(0, 1500).map(e => ({ a: ref[e.a], b: ref[e.b], w: +e.w.toFixed(2), born: e.born, road: roads.has(e),
    imp: e.imp, task: +e.task.toFixed(1), commit: +e.commit.toFixed(1), ref: e.ref }));
  const fileEdges = [];
  for (const [a, b] of scan.edges) { const i = fIdx.get(a), j = fIdx.get(b); if (i != null && j != null) fileEdges.push([i, j]); }

  const resolveTarget = (row) => {
    // returns [type, index]: 0 file, 1 module, 3 outside system, -1 none
    if (row.kind === 'remote' || row.kind === 'skill') {
      const i = row.target ? siteNode(row.target) : undefined;
      return i == null ? [-1, -1] : ref[i];
    }
    if (!row.path) return [-1, -1];
    const t = classify(row.path);
    if (t.type === 'f') return fIdx.has(t.id) ? [0, fIdx.get(t.id)] : [-1, -1];
    const i = nodeOfPath(row.path);
    return i == null ? [-1, -1] : ref[i];
  };

  return {
    project: { id: pid, name: proj.name, root, isGit: scan.isGit, depth: D, w: maxX - minX, h: maxZ - minZ, t0: T0 },
    districts, modules: modulesOut, files, externals, links, fileEdges,
    commits: scan.commits.map(({ files, ...c }) => c), resolveTarget,
    describe: { modules: [...modFiles].map(([id, files]) => ({ id, label: nodes[mainBlock.get(id)].label, files: files.length, sample: files.slice(0, 8).map(p => p.split('/').pop()), all: files })),
      places: nodes.filter(nd => nd.kind !== 'module').map(nd => ({ id: nd.key, label: nd.label, kind: nd.kind === 'store' ? 'data store' : nd.kind === 'local' ? 'local folder' : 'outside system',
        refs: (nd.refs || []).slice(0, 4) })) },
  };
}

export { KINDS };
