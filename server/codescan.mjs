// Inventory of a project's source: files, kinds, import edges and git history.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { norm } from './paths.mjs';

const KIND = {
  code: 'js mjs cjs ts tsx jsx mts cts py php go rs java kt rb cs swift c h cpp hpp vue svelte astro sh ps1 psm1 bat sql lua dart scala ex exs',
  style: 'css scss sass less styl',
  markup: 'html htm njk hbs ejs twig liquid xml svg',
  doc: 'md mdx txt rst adoc',
  config: 'json jsonc yaml yml toml ini env lock conf cfg properties gitignore gitattributes dockerignore editorconfig npmrc',
  asset: 'png jpg jpeg gif webp avif ico bmp tif tiff mp4 webm mov mp3 wav ogg woff woff2 ttf otf eot pdf zip gz tar 7z img bin',
  data: 'csv tsv parquet ndjson jsonl sqlite db xlsx xls',
};
const EXT_KIND = {};
for (const [k, v] of Object.entries(KIND)) for (const e of v.split(' ')) EXT_KIND[e] = k;
export function fileKind(p) {
  const b = p.split('/').pop().toLowerCase();
  if (b === 'dockerfile' || b === 'makefile') return 'config';
  const e = b.includes('.') ? b.split('.').pop() : '';
  return EXT_KIND[e] || 'other';
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.svelte-kit', 'out', 'coverage',
  '__pycache__', '.venv', 'venv', 'env', '.cache', '.turbo', 'target', 'vendor', '.idea', '.vscode']);

function git(root, args, max = 256 * 1024 * 1024) {
  return execFileSync('git', ['-C', root, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8', maxBuffer: max, windowsHide: true });
}

function walk(root, limit = 20000) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < limit) {
    const d = stack.pop();
    let ents; try { ents = fs.readdirSync(path.join(root, d), { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const r = d ? d + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(r); }
      else if (e.isFile()) out.push(r);
    }
  }
  return out;
}

// Count files under a directory, giving up past `cap` entries or `ms` milliseconds.
export function countFiles(dir, cap = 200000, ms = 1500) {
  const t0 = Date.now(); let n = 0; const stack = [dir];
  while (stack.length) {
    if (n >= cap || Date.now() - t0 > ms) return { n, partial: true };
    const d = stack.pop();
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) { if (e.isDirectory()) stack.push(path.join(d, e.name)); else n++; }
  }
  return { n, partial: false };
}

const JS_IMPORT = /(?:^|[^\w$.])(?:import\s+(?:[\w*{}\s,$]+\s+from\s+)?|export\s+[\w*{}\s,$]+\s+from\s+|import\s*\(\s*|require\s*\(\s*)["'`]([^"'`\n]+)["'`]/g;
const PY_IMPORT = /^\s*(?:from\s+(\.*[\w.]*)\s+import|import\s+([\w.]+))/gm;
const JS_EXT = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.mts', '.vue', '.svelte', '/index.ts', '/index.tsx', '/index.js', '/index.mjs', '/index.jsx'];

function resolver(files) {
  const lower = new Map(files.map(f => [f.toLowerCase(), f]));
  const has = p => lower.get(path.posix.normalize(p).toLowerCase());
  const pkgRoots = files.filter(f => f.endsWith('package.json')).map(f => path.posix.dirname(f)).sort((a, b) => b.length - a.length);
  const pkgOf = f => pkgRoots.find(r => r === '.' || f.startsWith(r + '/')) ?? '.';
  return {
    js(from, spec) {
      let bases;
      if (spec.startsWith('.')) bases = [path.posix.join(path.posix.dirname(from), spec)];
      else if (/^[@~#]\//.test(spec)) { const r = pkgOf(from); const rest = spec.slice(2); bases = [path.posix.join(r, 'src', rest), path.posix.join(r, rest)]; }
      else if (spec.startsWith('/')) bases = [spec.slice(1)];
      else return null;
      for (const b of bases) {
        const clean = b.replace(/\?.*$/, '');
        for (const e of JS_EXT) { const hit = has(clean + e); if (hit) return hit; }
        // TS sources imported with a .js suffix
        const swapped = clean.replace(/\.js$/, '.ts'); if (swapped !== clean && has(swapped)) return has(swapped);
      }
      return null;
    },
    py(from, mod) {
      const dir = path.posix.dirname(from);
      let base;
      if (mod.startsWith('.')) {
        const dots = mod.match(/^\.+/)[0].length;
        let d = dir; for (let i = 1; i < dots; i++) d = path.posix.dirname(d);
        base = [path.posix.join(d, mod.slice(dots).replace(/\./g, '/'))];
      } else {
        const m = mod.replace(/\./g, '/');
        base = [path.posix.join(dir, m), m];
        const top = from.split('/')[0]; if (top !== from) base.push(path.posix.join(top, m));
      }
      for (const b of base) for (const e of ['.py', '/__init__.py']) { const hit = has(b + e); if (hit) return hit; }
      return null;
    },
  };
}

export function scanProject(rootIn) {
  const root = norm(rootIn);
  const isGit = fs.existsSync(path.join(root, '.git'));
  let files;
  if (isGit) {
    try {
      files = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
      files = [...new Set(files)].filter(f => !f.split('/').some(s => SKIP_DIRS.has(s)));
    } catch { files = walk(root); }
  } else files = walk(root);

  const inv = [];
  for (const f of files) {
    let st;
    try { st = fs.statSync(path.join(root, f)); } catch { continue; } // deleted but still in index
    // ctime: when the file appeared on this disk (creation, or mtime if earlier)
    inv.push({ p: f, kind: fileKind(f), size: st.size, ctime: Math.round(Math.min(st.birthtimeMs || Infinity, st.mtimeMs)) });
  }

  // import graph
  const R = resolver(inv.map(f => f.p));
  const edges = [];
  for (const f of inv) {
    if (f.kind !== 'code' || f.size > 400 * 1024) continue;
    let src; try { src = fs.readFileSync(path.join(root, f.p), 'utf8'); } catch { continue; }
    const seen = new Set();
    if (/\.py$/.test(f.p)) {
      for (const m of src.matchAll(PY_IMPORT)) { const t = R.py(f.p, m[1] || m[2]); if (t && t !== f.p) seen.add(t); }
    } else {
      for (const m of src.matchAll(JS_IMPORT)) { const t = R.js(f.p, m[1]); if (t && t !== f.p) seen.add(t); }
    }
    for (const t of seen) edges.push([f.p, t]);
  }

  // git history: commits, file birth and churn
  const commits = [], born = {}, churn = {};
  if (isGit) {
    try {
      const log = git(root, ['log', '--reverse', '--no-renames', '--name-status', '--format=%x01%H%x09%at%x09%s']);
      for (const block of log.split('\x01').slice(1)) {
        const [head, ...lines] = block.split('\n');
        const [h, at, ...subj] = head.split('\t');
        const ts = Number(at) * 1000;
        const touched = [];
        for (const l of lines) {
          const m = /^([AMD])\t(.+)$/.exec(l); if (!m) continue;
          const p = m[2];
          touched.push(p);
          if (m[1] === 'A' && !(p in born)) born[p] = ts;
          churn[p] = (churn[p] || 0) + 1;
        }
        commits.push({ h: h.slice(0, 9), ts, s: subj.join('\t').slice(0, 160), n: touched.length, files: touched });
      }
    } catch {}
  }
  for (const f of inv) { f.born = born[f.p] || null; f.churn = churn[f.p] || 0; }
  return { root, isGit, files: inv, edges, commits, scannedAt: Date.now() };
}

// Which files mention which outside systems. Hosts are matched against the
// domains and IPs found in each file (mapped through `siteOf`); service names
// (no dot) by substring. Per-file results are cached by size, so a rebuild only
// rereads files that changed.
const refCache = new Map(); // root|path|size -> { sites:Set, txt }
const HOSTISH = /\b(?:\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,})\b/g;
export function scanRefs(root, files, tokens, siteOf) {
  const out = new Map(); // token -> [file]
  if (!tokens.length) return out;
  const hostTokens = new Set(tokens.filter(t => t.includes('.'))), words = tokens.filter(t => !t.includes('.'));
  for (const f of files) {
    if (!(f.kind === 'code' || f.kind === 'config' || f.kind === 'markup') || f.size > 300 * 1024 || f.p.endsWith('.svg')) continue;
    const ck = root + '|' + f.p + '|' + f.size;
    let c = refCache.get(ck);
    if (!c) {
      let txt = '';
      try { txt = fs.readFileSync(path.join(root, f.p), 'utf8').toLowerCase(); } catch {}
      c = { sites: new Set((txt.match(HOSTISH) || []).map(siteOf)), txt };
      if (refCache.size > 30000) refCache.clear();
      refCache.set(ck, c);
    }
    const hit = t => { const a = out.get(t); if (a) a.push(f.p); else out.set(t, [f.p]); };
    for (const s of c.sites) if (hostTokens.has(s)) hit(s);
    for (const w of words) if (c.txt.includes(w)) hit(w);
  }
  return out;
}
