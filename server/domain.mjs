// The project's domain map: the things it is about (entities), how they relate to
// each other and to the real world, the flows through them, and the design
// assumptions underneath, flagged where the code was made for an earlier setup
// and now drags (drift). Built by the project's own model with read-only tools,
// kept per project, updated from the files changed since. A task brief turns one
// "next task" into the slice of the map it touches: entities, files, what exists,
// what is missing, the assumptions to respect and the drift in the way.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { db, kvGet, kvSet } from './db.mjs';
import { projectModel } from './optimize.mjs';
import { runAgent, modelFor, modelLabel, provider, codexBlocked } from './llm.mjs';
import { scanDrift } from './drift.mjs';

// The map is built by a mid-size model, not the sessions' own (often the most expensive one):
// a full build reads the code with tools, an update is one tool-less turn over the diff that
// returns only what changed (a patch), merged here.
const BUILD_USD = process.env.VISUALIZER_DOMAIN_USD || '10';
// How an update runs: 'full' (the model re-reads with tools and returns the whole map) or 'patch'
// (one tool-less turn over the diff, returns only what changed: far cheaper).
const PATCH_MODE = (process.env.VISUALIZER_DOMAIN_UPDATE || 'full') === 'patch';
const UPDATE_USD = process.env.VISUALIZER_DOMAIN_UPDATE_USD || (PATCH_MODE ? '1.5' : BUILD_USD);
const BRIEF_USD = process.env.VISUALIZER_BRIEF_USD || '2';
const FILE_LIST_CHARS = 60e3;
const DOC_CHARS = 8e3;
const DIFF_CHARS = 45e3;     // the whole diff an update sees
const DIFF_FILE_CHARS = 6e3; // one file's share of it

const listeners = [];
export function onDomain(fn) { listeners.push(fn); }
const emit = (pid, msg) => { for (const l of listeners) l({ type: 'domain', pid, ...msg }); };
const jobs = new Map();   // pid -> build job
const procs = new Map();  // job or brief id -> child process
const driftCache = new Map(); // pid -> { at, list }

const saved = pid => kvGet('domain:' + pid) || null;
const briefsOf = pid => kvGet('briefs:' + pid) || [];
const saveBriefs = (pid, list) => kvSet('briefs:' + pid, list.slice(0, 30));
const rid = () => Math.random().toString(36).slice(2, 10);

// Changes that never move the domain map: docs, styles, media, lockfiles, build output.
const NOISE_EXT = /\.(md|mdx|txt|rst|css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|wav|pdf|zip|gz|lock|log|map|snap)$/i;
const NOISE_DIR = /(^|\/)(docs?|dist|build|out|coverage|node_modules|vendor|\.github|\.vscode|\.idea|\.claude)\//i;
const NOISE_FILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|\.gitignore|\.env[^/]*|LICENSE[^/]*)$/i;
const codeChange = p => !NOISE_EXT.test(p) && !NOISE_DIR.test(p) && !NOISE_FILE.test(p);
// every file the map points at
function mapFiles(m) {
  const s = new Set();
  for (const e of m.entities) for (const c of e.code) s.add(c.p);
  for (const f of m.flows) { f.files.forEach(p => s.add(p)); for (const st of f.steps) st.files.forEach(p => s.add(p)); }
  for (const a of m.assumptions) a.files.forEach(p => s.add(p));
  return s;
}

function git(root, args) {
  return execFileSync('git', ['-C', root, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
}
const headOf = root => { try { return git(root, ['rev-parse', 'HEAD']).trim(); } catch { return null; } };
const newer = (root, p, t) => { try { return fs.statSync(path.join(root, p)).mtimeMs > t; } catch { return false; } };

// Files changed since the map was built. In a git project only commits count (the map follows
// HEAD, work in progress waits for its commit); elsewhere files touched after the build.
function changedSince(city, meta) {
  const root = city.project.root;
  if (meta.head && city.project.isGit) {
    try { return git(root, ['diff', '--name-only', meta.head, 'HEAD', '--']).split('\n').filter(Boolean); } catch {}
  }
  return city.files.filter(f => newer(root, f.p, meta.builtAt)).map(f => f.p);
}

function driftOf(pid, city) {
  const c = driftCache.get(pid);
  if (c && Date.now() - c.at < 60e3) return c.list;
  const list = scanDrift(pid, city);
  driftCache.set(pid, { at: Date.now(), list });
  return list;
}

// ------------------------------------------------------------------ auto update
// The map follows commits, not the clock. When HEAD moves (a commit, merge, pull, checkout),
// the diff since the map's commit is read, and the map updates only when that diff can change
// the domain: a code file added, deleted or renamed, or a changed line that declares something
// (a type, class, table, column, schema, route). Edits inside bodies don't start a run; the next
// update sees them with the rest of the diff. A burst of commits settles into one run.
// On by default, switchable per project (kv domain-auto:<pid>).
const SETTLE = Number(process.env.VISUALIZER_DOMAIN_SETTLE_S || 60) * 1e3;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec|e2e|fixtures?|mocks?)\/|\.(test|spec)\.[a-z]+$/i;
const DECL = [
  /^\s*(export\s+)?(default\s+)?(declare\s+)?(abstract\s+|sealed\s+|data\s+|pub(\([^)]*\))?\s+)?(class|interface|enum|struct|trait|protocol|record|union)\s+[A-Za-z_]/,
  /^\s*(export\s+)?type\s+[A-Z]\w*\s*(<[^=]*>)?\s*=/,       // TypeScript type alias
  /^\s*type\s+\w+\s+(struct|interface)\b/,                 // Go
  /^\s*(model|enum|type)\s+\w+\s*\{/,                       // Prisma, GraphQL
  /\b(create|alter|drop)\s+(table|view|type)\b/i,           // SQL
  /\b(add|drop|rename)\s+column\b/i,
  /\b(new\s+Schema|z\.object|mongoose\.model|sequelize\.define|\w+Table|defineModel|defineStore|createSlice)\s*\(/,
  /\b(app|router|server|api|routes?)\.(get|post|put|patch|delete|route|use)\s*\(\s*['"`]/,
  /^\s*@(app|router|bp|api|blueprint)\.(route|get|post|put|patch|delete)\b/i, // Flask, FastAPI
  /^\s*@(Get|Post|Put|Patch|Delete|Controller|Entity|Table|Column|Model|RequestMapping)\b/, // Nest, TypeORM, Spring
];
const codeFile = p => codeChange(p) && !TEST_FILE.test(p);

// Why the commits between two heads may change the map, or null when they can't.
function domainChange(root, from, to) {
  const rows = git(root, ['diff', '--name-status', '-M', from, to, '--']).split('\n').filter(Boolean).map(l => l.split('\t'));
  for (const [s, a, b] of rows) {
    const p = b || a;
    if (!codeFile(p) && !codeFile(a)) continue;
    if (s[0] === 'A') return 'added ' + p;
    if (s[0] === 'D') return 'deleted ' + p;
    if (s[0] === 'R') return `renamed ${a} to ${p}`;
  }
  let file = null;
  for (const l of git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', from, to, '--']).split('\n')) {
    if (l.startsWith('diff --git ')) { file = / b\/(.+)$/.exec(l)?.[1] || null; continue; }
    if (!file || !codeFile(file) || l.startsWith('+++') || l.startsWith('---') || !/^[+-]/.test(l)) continue;
    if (DECL.some(re => re.test(l.slice(1)))) return `${l[0] === '+' ? 'declares' : 'drops'} "${l.slice(1).trim().slice(0, 60)}" in ${file}`;
  }
  return null;
}

let cityOf = () => null;            // set by watchCommits: pid -> city
const watchers = new Map();         // pid -> fs.FSWatcher on the project's git dir
const settle = new Map();           // pid -> timer
const checked = new Map();          // pid -> { head, why }: the last HEAD looked at
const rootOf = pid => db.prepare('SELECT root FROM projects WHERE id=?').get(pid)?.root || null;

export const autoOn = pid => kvGet('domain-auto:' + pid) !== false;
export function setAuto(pid, on) {
  kvSet('domain-auto:' + pid, !!on);
  if (on) { checked.delete(pid); watch(pid); checkCommits(pid); } else clearTimeout(settle.get(pid));
  emit(pid, {});
  return { ok: true, auto: !!on };
}

// Start following the commits of every project with a map; getCity(pid) is the server's city.
export function watchCommits(getCity) {
  cityOf = getCity;
  for (const { k } of db.prepare(`SELECT k FROM kv WHERE k LIKE 'domain:%'`).all()) { const pid = k.slice(7); watch(pid); checkCommits(pid); }
}

function watch(pid) {
  if (watchers.has(pid) || !autoOn(pid)) return;
  const root = rootOf(pid);
  let dir;
  try { dir = git(root, ['rev-parse', '--absolute-git-dir']).trim(); } catch { return; } // not a git project
  try {
    // a commit writes COMMIT_EDITMSG, a checkout HEAD, a pull FETCH_HEAD/ORIG_HEAD; the index changes all the time
    const w = fs.watch(dir, (ev, name) => { if (name && !/^index/.test(name)) later(pid); });
    w.on('error', () => { w.close(); watchers.delete(pid); });
    w.unref?.();
    watchers.set(pid, w);
  } catch {}
}
function later(pid) {
  clearTimeout(settle.get(pid));
  const t = setTimeout(() => { settle.delete(pid); checkCommits(pid); }, SETTLE);
  t.unref?.();
  settle.set(pid, t);
}

// HEAD moved since the map was built: update when the diff can change the domain.
export function checkCommits(pid) {
  const st = saved(pid);
  if (!st || !autoOn(pid) || jobs.get(pid)?.state === 'working') return;
  const root = rootOf(pid), head = root && headOf(root);
  if (!head || head === st.meta.head || checked.get(pid)?.head === head) return; // up to date, or this HEAD was looked at already
  let why;
  if (!st.meta.head) why = 'the map has no commit to compare with';
  else try { why = domainChange(root, st.meta.head, head); } catch { why = 'history was rewritten'; }
  checked.set(pid, { head, why });
  const city = why && cityOf(pid);
  if (city) build(pid, city, { update: true, auto: true, why });
  else emit(pid, {});
}

export function domainView(pid, city) {
  const st = saved(pid);
  const changed = st ? changedSince(city, st.meta) : [];
  const git_ = !!(st?.meta.head && city.project.isGit);
  let behind = 0;
  if (git_ && changed.length) { try { behind = Number(git(city.project.root, ['rev-list', '--count', st.meta.head + '..HEAD'])) || 0; } catch {} }
  const seen = checked.get(pid);
  return {
    model: st?.model || null,
    meta: st ? { ...st.meta, changed: changed.slice(0, 60), changedCount: changed.length, auto: autoOn(pid), git: git_, behind,
      waiting: seen && seen.head !== st.meta.head && !seen.why ? true : false, updateMode: PATCH_MODE || codexBlocked('read') ? 'patch' : 'full' } : null,
    job: jobs.get(pid) || null,
    briefs: briefsOf(pid),
    drift: driftOf(pid, city),
    llm: modelLabel('map'), cli: provider() === 'codex' ? 'Codex' : 'Claude Code',
  };
}

// ------------------------------------------------------------------ context
function readClip(root, rels, max) {
  for (const r of rels) {
    try {
      const t = fs.readFileSync(path.join(root, r), 'utf8');
      return `\n--- ${r}\n${t.length > max ? t.slice(0, max) + '\n…[truncated]' : t}`;
    } catch {}
  }
  return '';
}

function context(pid, city, drift) {
  const root = city.project.root;
  const docs = [['README.md', 'readme.md', 'README', 'README.rst'], ['CLAUDE.md', '.claude/CLAUDE.md'], ['AGENTS.md']]
    .map(r => readClip(root, r, DOC_CHARS)).join('');
  const manifests = [['package.json'], ['pyproject.toml', 'requirements.txt'], ['go.mod'], ['Cargo.toml'], ['composer.json'], ['Gemfile'], ['pom.xml', 'build.gradle']]
    .map(r => readClip(root, r, 3000)).join('');
  const dname = i => city.districts[i]?.name || '';
  const mods = city.modules.map(m => `- ${m.title || m.label}${m.warehouse ? ' (data store)' : ''} [${dname(m.district)}], ${m.files} files${m.desc ? ': ' + m.desc : ''}`).join('\n');
  const ext = city.externals.filter(x => x.type !== 'local').map(x => `- ${x.label} (${x.type}, named in ${x.refCount} files)`).join('\n');
  // file list by folder, most-imported first inside each; sizes in KB, churn in commits
  const deg = new Map();
  for (const [, b] of city.fileEdges) deg.set(b, (deg.get(b) || 0) + 1);
  const byDir = new Map();
  city.files.forEach((f, i) => {
    if (f.kind === 'asset' || f.kind === 'data' || f.kind === 'other') return;
    const d = f.p.includes('/') ? f.p.slice(0, f.p.lastIndexOf('/')) : '.';
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push({ n: f.p.slice(d === '.' ? 0 : d.length + 1), imp: deg.get(i) || 0, kb: Math.max(1, Math.round(f.size / 1024)), c: f.churn });
  });
  let tree = '', cut = 0;
  for (const d of [...byDir.keys()].sort()) {
    const list = byDir.get(d).sort((a, b) => b.imp - a.imp || b.kb - a.kb);
    const line = `${d}/: ${list.map(x => `${x.n}(${x.kb}k${x.imp ? ',imp' + x.imp : ''}${x.c > 2 ? ',c' + x.c : ''})`).join(' ')}\n`;
    if (tree.length + line.length > FILE_LIST_CHARS) { cut += list.length; continue; }
    tree += line;
  }
  const tasks = db.prepare(`SELECT title, ts FROM tasks WHERE project_id=? AND title IS NOT NULL AND title != '—' ORDER BY ts DESC LIMIT 60`).all(pid)
    .map(t => `- ${new Date(t.ts).toISOString().slice(0, 10)} ${t.title}`).join('\n');
  const dr = drift.slice(0, 40).map(d => `- ${d.p} (strain ${d.score}${d.rework ? `, rewritten by ${d.rework} tasks in 30 days` : ''}${d.twin ? ', looks like an old/v1 twin' : ''}${d.lines > 1500 ? `, ${d.lines} lines` : ''}): `
    + [...d.markers.slice(0, 3), ...d.pinned.slice(0, 2)].map(m => `L${m.line} ${m.text}`).join(' | ')).join('\n');
  return `Project "${city.project.name}" at ${root}
${docs ? `\nDocs:${docs}\n` : ''}${manifests ? `\nManifests:${manifests}\n` : ''}
Code map (modules, the role they were sorted into, and an AI description where known):
${mods || '(none)'}
${ext ? `\nOutside systems the code names:\n${ext}\n` : ''}
Files by folder (k = KB, imp = files importing it, c = commits that changed it):
${tree}${cut ? `…and ${cut} more files not listed\n` : ''}
${tasks ? `\nRecent work (task titles, newest first):\n${tasks}\n` : ''}
${dr ? `\nDrift candidates found by a local scan (comments saying legacy/workaround/fallback..., pinned flags, old twins, old files still reworked):\n${dr}\n` : ''}`;
}

// What an update sees instead of reading the code itself: the diff of each changed code file
// since the map was built (a new file in full, clipped), files the map points at first.
function diffOf(city, meta, files, known, to) {
  const root = city.project.root;
  const git_ = meta.head && city.project.isGit && to;
  const order = [...files].sort((a, b) => (known.has(b) ? 1 : 0) - (known.has(a) ? 1 : 0));
  let out = '';
  const skipped = [];
  for (const p of order) {
    if (out.length >= DIFF_CHARS) { skipped.push(p); continue; }
    let d = '';
    if (git_) { try { d = git(root, ['diff', '-U2', '-w', '--no-color', meta.head, to, '--', p]); } catch {} }
    if (!d) {
      let t = null;
      try { t = fs.readFileSync(path.join(root, p), 'utf8'); } catch {}
      d = t == null ? '(deleted)' : `(new or changed file, full text)\n${t}`;
    }
    const room = Math.min(DIFF_FILE_CHARS, DIFF_CHARS - out.length);
    out += `\n=== ${p}${known.has(p) ? ' (on the map)' : ''}\n${d.length > room ? d.slice(0, room) + '\n…[truncated]' : d}\n`;
  }
  return { text: out, skipped };
}

// The parts of the map the changed files touch go to the model in full; the rest as a one-line index.
function mapSlice(m, files) {
  const hit = list => list.some(p => files.has(p));
  const ents = m.entities.filter(e => hit(e.code.map(c => c.p)));
  const flows = m.flows.filter(f => hit(f.files) || f.steps.some(s => hit(s.files)));
  const asm = m.assumptions.filter(a => hit(a.files));
  const eIn = new Set(ents.map(e => e.id)); // entities on a touched flow's path stay in the index
  const touched = { entities: m.entities.filter(e => eIn.has(e.id)), flows, assumptions: asm,
    relations: m.relations.filter(r => eIn.has(r.a) || eIn.has(r.b)) };
  const fIn = new Set(flows.map(f => f.id)), aIn = new Set(asm.map(a => a.id));
  const index = [
    ...m.entities.filter(e => !eIn.has(e.id)).map(e => `entity ${e.id} [${e.group}] ${e.name}: ${e.what} (${e.status}; ${e.code.slice(0, 3).map(c => c.p).join(', ')})`),
    ...m.flows.filter(f => !fIn.has(f.id)).map(f => `flow ${f.id} ${f.name} (${f.status}): ${f.steps.map(s => s.e).join(' > ')}`),
    ...m.assumptions.filter(a => !aIn.has(a.id)).map(a => `assumption ${a.id}${a.holds ? ' (holds)' : ''}: ${a.text}`),
  ].join('\n');
  return { touched, index, count: touched.entities.length + flows.length + asm.length };
}

const PATCH = `{
 "summary": "the new summary, only if it should change; otherwise omit",
 "groups": [new or changed groups, full objects as in the map],
 "world": [new or changed world items, full objects],
 "entities": [new or changed entities, full objects with every field],
 "flows": [new or changed flows, full objects],
 "assumptions": [new or changed assumptions, full objects],
 "relations": {"add": [{"a": "entity id", "verb": "...", "b": "entity id", "card": "1-1|1-n|n-n"}], "remove": [{"a": "entity id", "b": "entity id"}]},
 "remove": {"entities": ["ids gone"], "flows": [], "assumptions": [], "world": [], "groups": []}
}`;

// Lay a patch over the map: items with a known id are merged field by field, new ones added,
// removed ones dropped (with the relations to them), then cleaned like a fresh build.
function applyPatch(m, p, city) {
  const rm = p.remove || {};
  const merge = (list, add, gone) => {
    const out = new Map(list.map(x => [x.id, x]));
    for (const id of arr(gone)) out.delete(slug(id));
    for (const x of arr(add)) { const id = slug(x?.id || x?.name); if (id) out.set(id, { ...(out.get(id) || {}), ...x, id }); }
    return [...out.values()];
  };
  const entities = merge(m.entities, p.entities, rm.entities);
  const key = r => slug(r.a) + '>' + slug(r.b);
  const dropRel = new Set(arr(p.relations?.remove).map(key));
  const rel = new Map(m.relations.filter(r => !dropRel.has(key(r))).map(r => [key(r) + r.verb, r]));
  for (const r of arr(p.relations?.add)) rel.set(key(r) + r.verb, r);
  return clean({
    summary: p.summary || m.summary,
    groups: merge(m.groups, p.groups, rm.groups), world: merge(m.world, p.world, rm.world), entities,
    relations: [...rel.values()], flows: merge(m.flows, p.flows, rm.flows), assumptions: merge(m.assumptions, p.assumptions, rm.assumptions),
  }, city);
}

const SCHEMA = `{
 "summary": "2-3 sentences: what the project is and does, for its builder",
 "groups": [{"id": "g1", "name": "2-3 words", "what": "one line"}],
 "world": [{"id": "w1", "name": "real person, system, device or place outside the code", "kind": "person|system|device|place|thing|money", "what": "one line"}],
 "entities": [{"id": "kebab-id", "name": "Name", "group": "g1", "what": "one line: what it is in this project",
   "real": "its real-world counterpart in plain words", "world": ["w1"], "states": ["lifecycle states, if any"], "facts": ["key properties or rules, 0-5"],
   "code": [{"p": "path/from/root", "does": "defines|stores|changes|shows|uses", "note": "few words"}],
   "status": "solid|shaky|partial|missing|unknown", "statusWhy": "one sentence with evidence"}],
 "relations": [{"a": "entity id", "verb": "verb phrase", "b": "entity id", "card": "1-1|1-n|n-n"}],
 "flows": [{"id": "f1", "name": "user goal in a few words", "why": "who does it and why",
   "start": {"world": "world id of who or what starts it", "by": "the trigger, in a few words"},
   "steps": [{"e": "entity id", "do": "what happens", "files": ["the 1-3 files that do this step"], "risk": "what breaks or drags at this step, if anything"}],
   "end": {"outcome": "what is true when it is done", "world": "world id where the result lands, if any"},
   "files": ["paths on this path"], "status": "works|partial|broken|unknown", "note": "what is missing or fragile, if anything"}],
 "assumptions": [{"id": "a1", "text": "the assumption, as a rule", "holds": false, "was": "the setup it was made for", "now": "the setup today",
   "entities": ["entity ids"], "files": ["paths"], "evidence": "what in the code shows it", "cost": "what it costs today", "fix": "what to do", "severity": "high|medium|low"}]
}`;

const RULES = `Rules
- entities: 8-40 domain things, the nouns the product is about (Order, Customer, Session, Invoice...). Not layers or files: "API", "utils", "frontend" are not entities. Merge synonyms. Include things the code handles implicitly when they matter (a "Collision" when two users edit one record).
- groups: 3-8 archipelagos of related entities.
- real: the entity's counterpart in the real world, in plain words ("a person who pays", "a Claude Code process in a terminal"). world: the real people, systems, devices and places outside the code it stands for or touches; reuse world ids across entities.
- code: the files that implement the entity, does = defines | stores | changes | shows | uses; paths relative to the root, from the file list; at most 10, most important first.
- status: solid (works and fits), shaky (works but strained, patched or inconsistent), partial (half built), missing (needed by a flow or named in docs/tasks, not built), unknown. statusWhy: one sentence of evidence.
- relations: only real ones, verb from a to b ("Session runs Task").
- flows: 4-12 things a user or the system does end to end, as ordered steps through entities, with the files on that path; status works | partial | broken | unknown and a note on what is missing or fragile. Each flow says where it starts (who or what in the real world triggers it, and how) and where it ends (the outcome, and where it lands); each step names the files that do it and, where it applies, the risk at that step.
- assumptions: 5-20 design assumptions the code is built on. Most important are the ones that no longer hold: code made for an earlier setup (an older design, data shape, platform, scale, UI, workflow) that newer code now works around. Say what the old setup was, what it is now, the evidence (files, lines), what it costs today and the fix. holds=true marks a rule still true that any change must respect.
Write for someone who knows the project but cannot hold it all in their head: short, concrete, no filler. Every path must be a real file.`;

// ------------------------------------------------------------------ cleaning
const slug = x => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
const str = (x, n) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const arr = x => Array.isArray(x) ? x : [];
const pick = (x, list, def) => list.includes(x) ? x : def;

function pathFixer(city) {
  const root = city.project.root;
  const byLower = new Map(city.files.map(f => [f.p.toLowerCase(), f.p]));
  return p => {
    let s = String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
    const r = root.toLowerCase() + '/';
    if (s.toLowerCase().startsWith(r)) s = s.slice(r.length);
    s = s.replace(/[:#].*$/, '');
    if (byLower.has(s.toLowerCase())) return byLower.get(s.toLowerCase());
    try { if (s && fs.statSync(path.join(root, s)).isFile()) return s; } catch {}
    return null;
  };
}

function clean(m, city) {
  const fix = pathFixer(city);
  const files = list => [...new Set(arr(list).map(fix).filter(Boolean))];
  const groups = arr(m.groups).map((g, i) => ({ id: slug(g.id) || 'g' + i, name: str(g.name, 40) || 'Group', what: str(g.what, 200) })).slice(0, 10);
  const gIds = new Set(groups.map(g => g.id));
  const world = arr(m.world).map(w => ({ id: slug(w.id), name: str(w.name, 50), kind: pick(w.kind, ['person', 'system', 'device', 'place', 'thing', 'money'], 'thing'), what: str(w.what, 200) }))
    .filter(w => w.id && w.name).slice(0, 30);
  const wIds = new Set(world.map(w => w.id));
  const seen = new Set();
  const entities = arr(m.entities).map(e => ({
    id: slug(e.id || e.name), name: str(e.name, 40), group: gIds.has(slug(e.group)) ? slug(e.group) : (groups[0]?.id || 'g0'),
    what: str(e.what, 260), real: str(e.real, 200), world: arr(e.world).map(slug).filter(w => wIds.has(w)),
    states: arr(e.states).map(s => str(s, 30)).filter(Boolean).slice(0, 8), facts: arr(e.facts).map(s => str(s, 160)).filter(Boolean).slice(0, 6),
    code: (() => { const out = [], got = new Set(); for (const c of arr(e.code)) { const p = fix(c?.p ?? c); if (!p || got.has(p)) continue; got.add(p);
      out.push({ p, does: pick(c?.does, ['defines', 'stores', 'changes', 'shows', 'uses'], 'uses'), note: str(c?.note, 80) }); } return out.slice(0, 12); })(),
    status: pick(e.status, ['solid', 'shaky', 'partial', 'missing', 'unknown'], 'unknown'), statusWhy: str(e.statusWhy, 300),
  })).filter(e => e.id && e.name && !seen.has(e.id) && seen.add(e.id)).slice(0, 48);
  if (!groups.length) groups.push({ id: 'g0', name: 'Project', what: '' });
  const eIds = new Set(entities.map(e => e.id));
  const relations = arr(m.relations).map(r => ({ a: slug(r.a), b: slug(r.b), verb: str(r.verb, 40), card: pick(r.card, ['1-1', '1-n', 'n-n'], '1-n') }))
    .filter(r => eIds.has(r.a) && eIds.has(r.b) && r.a !== r.b).slice(0, 120);
  const wOr = x => wIds.has(slug(x)) ? slug(x) : null;
  const flows = arr(m.flows).map((f, i) => ({ id: slug(f.id) || 'f' + i, name: str(f.name, 60), why: str(f.why, 240),
    start: { world: wOr(f.start?.world), by: str(f.start?.by, 120) }, end: { world: wOr(f.end?.world), outcome: str(f.end?.outcome, 200) },
    steps: arr(f.steps).map(s => ({ e: slug(s.e), do: str(s.do, 140), files: files(s.files).slice(0, 4), risk: str(s.risk, 200) })).filter(s => eIds.has(s.e)).slice(0, 14),
    files: files(f.files).slice(0, 20), status: pick(f.status, ['works', 'partial', 'broken', 'unknown'], 'unknown'), note: str(f.note, 300) }))
    .filter(f => f.name && f.steps.length).slice(0, 16);
  const assumptions = arr(m.assumptions).map((a, i) => ({ id: slug(a.id) || 'a' + i, text: str(a.text, 240), holds: a.holds === true,
    was: str(a.was, 200), now: str(a.now, 200), entities: arr(a.entities).map(slug).filter(e => eIds.has(e)), files: files(a.files).slice(0, 12),
    evidence: str(a.evidence, 400), cost: str(a.cost, 300), fix: str(a.fix, 400), severity: pick(a.severity, ['high', 'medium', 'low'], 'medium') }))
    .filter(a => a.text).slice(0, 24);
  return { summary: str(m.summary, 600), groups, world, entities, relations, flows, assumptions };
}

// ------------------------------------------------------------------ build
export function build(pid, city, { update = false, auto = false, why = null } = {}) {
  const cur = jobs.get(pid);
  if (cur && cur.state === 'working') return { error: 'busy', job: cur };
  const st = saved(pid);
  const root = city.project.root;
  const drift = driftOf(pid, city);
  const changed = st && update ? changedSince(city, st.meta) : [];
  if (update && st && !changed.length) return { error: 'nothing changed since the map was built' };
  const head = headOf(root);
  const job = { id: rid(), kind: update && st ? 'update' : 'build', auto, why, head, state: 'working', started: Date.now(), model: modelFor('map'), cost: 0 };
  jobs.set(pid, job);
  emit(pid, { job });
  let prompt;
  // Codex on Windows cannot read files in its sandbox: updates then work from the diff alone
  const isUpdate = job.kind === 'update', patch = isUpdate && (PATCH_MODE || !!codexBlocked('read'));
  if (isUpdate && !patch) {
    prompt = `You keep a project's DOMAIN MAP up to date. Below is the map as it was built on ${new Date(st.meta.builtAt).toISOString().slice(0, 16)}, and the files that changed since. The working directory is the project root; Read, Glob and Grep what you need, starting with the changed files; about 25 reads is plenty.

Update the map: keep the ids of entities, flows and assumptions that still exist, change code paths, statuses, flows and assumptions where the changes touch them, add what is new, drop what is gone. Return the FULL updated map.

${RULES}

Return ONLY JSON matching:
${SCHEMA}

Changed files (${changed.length}):
${changed.slice(0, 300).join('\n')}

The current map:
${JSON.stringify(st.model)}

${context(pid, city, drift)}`;
  } else if (patch) {
    // one turn, no tools: the diff of the changed code, the touched slice of the map in full, the rest as an index
    const code = changed.filter(codeChange);
    const known = mapFiles(st.model);
    const { text: diff, skipped } = diffOf(city, st.meta, code.length ? code : changed, known, head);
    const slice = mapSlice(st.model, new Set(changed));
    prompt = `You keep a project's DOMAIN MAP up to date. It was built on ${new Date(st.meta.builtAt).toISOString().slice(0, 16)}; below are the code changes since, the parts of the map those files touch (in full), and an index of the rest of the map. You have no tools: work from what is here.

Return a PATCH, not the whole map: only the items the changes add, alter or remove. Keep existing ids. A changed item is sent as a full object with every field (it replaces the old one). Update code paths, statuses, flows and assumptions the changes touch; add entities, flows or assumptions the changes introduce; remove what the changes delete. Leave out everything the changes do not touch. If nothing on the map changes, return {}.

${RULES}

Return ONLY JSON matching:
${PATCH}
where the object shapes are those of the full map:
${SCHEMA}

Groups: ${JSON.stringify(st.model.groups)}
World: ${JSON.stringify(st.model.world)}

Map items the changed files touch (${slice.count}):
${JSON.stringify(slice.touched)}

The rest of the map (index):
${slice.index || '(none)'}

Changed files (${changed.length}${code.length < changed.length ? `, of which ${changed.length - code.length} docs/styles/assets not shown` : ''}):
${changed.slice(0, 200).join('\n')}

Diffs since the map was built${skipped.length ? ` (${skipped.length} more changed files not shown: ${skipped.slice(0, 40).join(', ')})` : ''}:
${diff}`;
  } else prompt = `You map a software project for the person who builds it. It has grown too big to hold in one's head, so they need a DOMAIN MAP: the things the project is about (entities), how those relate to each other and to the real world, the main flows through them, and where code built for an earlier setup now drags (drift). The technical structure (folders, modules) is shown elsewhere; here, translate it into the concepts a product owner talks about, each tied back to the code that implements it.

The working directory is the project root. You may Read, Glob and Grep. Spend reads on what defines the entities (data models, schemas, migrations, types, API routes, state stores, main screens) and on the drift candidates listed below. Do not read everything: after about 40 reads, stop exploring and write the map from what you know.

${RULES}

Return ONLY JSON matching:
${SCHEMA}

${context(pid, city, drift)}`;
  runAgent({ want: 'map', tools: patch ? 'none' : 'read', budgetUsd: isUpdate ? UPDATE_USD : BUILD_USD, cwd: root, prompt, timeoutMs: (patch ? 8 : 25) * 60e3, onSpawn: p => procs.set(job.id, p) })
    .then(({ res, cost, text }) => {
      if (patch && !/\{[\s\S]*\}/.test(text)) throw new Error('the model returned no patch');
      const model = patch ? applyPatch(st.model, res, city) : clean(res, city);
      if (!model.entities.length) throw new Error('the model returned no entities');
      kvSet('domain:' + pid, { model, meta: { builtAt: job.started, head, cost: (isUpdate ? (st?.meta.cost || 0) : 0) + cost, lastCost: cost, model: job.model, kind: job.kind } });
      Object.assign(job, { state: 'done', ended: Date.now(), cost });
    })
    .catch(e => Object.assign(job, { state: 'error', ended: Date.now(), error: e.message }))
    .finally(() => {
      procs.delete(job.id); emit(pid, { job, changed: job.state === 'done' });
      // follow the project's commits from now on; ones that landed during the run get their own look
      if (job.state === 'done') { watch(pid); checkCommits(pid); }
    });
  return { job };
}

export function stop(pid) {
  const job = jobs.get(pid);
  const p = job && procs.get(job.id);
  if (p) { p.stopped = true; p.kill(); }
  for (const b of briefsOf(pid)) { const q = procs.get(b.id); if (q) { q.stopped = true; q.kill(); } }
  return { ok: true };
}

// ------------------------------------------------------------------ brief
const compact = m => ({
  summary: m.summary,
  entities: m.entities.map(e => ({ id: e.id, name: e.name, what: e.what, status: e.status, code: e.code.map(c => `${c.does}:${c.p}`) })),
  relations: m.relations.map(r => `${r.a} ${r.verb} ${r.b}`),
  flows: m.flows.map(f => ({ id: f.id, name: f.name, steps: f.steps.map(s => `${s.e}: ${s.do}`), status: f.status, note: f.note })),
  assumptions: m.assumptions.map(a => ({ id: a.id, text: a.text, holds: a.holds, was: a.was, now: a.now, files: a.files, fix: a.fix })),
});

export function brief(pid, city, task) {
  const st = saved(pid);
  if (!st) return { error: 'build the domain map first' };
  task = str(task, 2000);
  if (!task) return { error: 'describe the task' };
  const root = city.project.root;
  const drift = driftOf(pid, city).slice(0, 25).map(d => `${d.p} (strain ${d.score}): ${d.markers.slice(0, 2).map(m => `L${m.line} ${m.text}`).join(' | ')}`);
  const b = { id: rid(), task, state: 'working', started: Date.now(), model: modelFor(projectModel(pid)), cost: 0, result: null };
  saveBriefs(pid, [b, ...briefsOf(pid)]);
  emit(pid, { brief: b });
  const prompt = `You prepare the next task in a software project for its builder, who cannot hold the whole project in their head. Give them exactly the slice of the project this task touches, so they (and the Claude Code session they will hand it to) can start without re-learning everything.

The working directory is the project root. Read, Glob and Grep the code you need to be sure of what exists; do not edit anything.

The task:
${task}

Return ONLY JSON:
{"goal": "the task restated in one sentence, as you understood it",
 "entities": ["ids of the domain entities involved, most central first"],
 "flows": ["ids of flows the task changes or relies on"],
 "newEntities": [{"name": "Name", "what": "a thing the task introduces"}],
 "done": ["what already exists that the task builds on, naming files"],
 "missing": ["what has to be built or changed"],
 "files": [{"p": "path from the root", "why": "few words", "act": "edit|read|new"}],
 "respect": [{"a": "assumption id or null", "text": "a rule the change must keep"}],
 "drift": [{"a": "assumption id or null", "text": "old-setup code in the way", "how": "work around|fix first|leave", "why": "one sentence"}],
 "steps": ["ordered steps, each small enough for one prompt"],
 "questions": ["decisions only the builder can make; empty when none"],
 "prompt": "a ready-to-paste prompt for a Claude Code session that carries this context: goal, files, rules to respect, drift to handle, steps"}

The project's domain map:
${JSON.stringify(compact(st.model))}

Drift candidates from a local scan:
${drift.join('\n') || '(none)'}`;
  runAgent({ want: projectModel(pid), tools: 'read', budgetUsd: BRIEF_USD, cwd: root, prompt, timeoutMs: 12 * 60e3, onSpawn: p => procs.set(b.id, p) })
    .then(({ res, cost }) => {
      const fix = pathFixer(city), eIds = new Set(st.model.entities.map(e => e.id)), fIds = new Set(st.model.flows.map(f => f.id)), aIds = new Set(st.model.assumptions.map(a => a.id));
      const ref = x => aIds.has(slug(x)) ? slug(x) : null;
      b.result = {
        goal: str(res.goal, 300),
        entities: arr(res.entities).map(slug).filter(e => eIds.has(e)), flows: arr(res.flows).map(slug).filter(f => fIds.has(f)),
        newEntities: arr(res.newEntities).map(n => ({ name: str(n.name, 40), what: str(n.what, 200) })).filter(n => n.name).slice(0, 8),
        done: arr(res.done).map(s => str(s, 300)).filter(Boolean).slice(0, 12), missing: arr(res.missing).map(s => str(s, 300)).filter(Boolean).slice(0, 12),
        files: arr(res.files).map(f => ({ p: f.act === 'new' ? str(f.p, 200) : fix(f.p), why: str(f.why, 160), act: pick(f.act, ['edit', 'read', 'new'], 'read') })).filter(f => f.p).slice(0, 30),
        respect: arr(res.respect).map(r => ({ a: ref(r.a), text: str(r.text, 300) })).filter(r => r.text).slice(0, 10),
        drift: arr(res.drift).map(r => ({ a: ref(r.a), text: str(r.text, 300), how: pick(r.how, ['work around', 'fix first', 'leave'], 'work around'), why: str(r.why, 300) })).filter(r => r.text).slice(0, 10),
        steps: arr(res.steps).map(s => str(s, 400)).filter(Boolean).slice(0, 15), questions: arr(res.questions).map(s => str(s, 300)).filter(Boolean).slice(0, 8),
        prompt: String(res.prompt || '').trim().slice(0, 6000),
      };
      Object.assign(b, { state: 'done', ended: Date.now(), cost });
    })
    .catch(e => Object.assign(b, { state: 'error', ended: Date.now(), error: e.message }))
    .finally(() => {
      procs.delete(b.id);
      saveBriefs(pid, briefsOf(pid).map(x => x.id === b.id ? b : x));
      emit(pid, { brief: b });
    });
  return { brief: b };
}

export function dropBrief(pid, id) {
  const p = procs.get(id); if (p) { p.stopped = true; p.kill(); }
  saveBriefs(pid, briefsOf(pid).filter(b => b.id !== id));
  return { ok: true };
}

// A server restart cuts running jobs short: say so instead of spinning forever.
export function settleInterrupted() {
  for (const r of db.prepare(`SELECT k FROM kv WHERE k LIKE 'briefs:%'`).all()) {
    const list = kvGet(r.k) || [];
    if (list.some(b => b.state === 'working')) kvSet(r.k, list.map(b => b.state === 'working' ? { ...b, state: 'error', error: 'interrupted by a restart' } : b));
  }
}

// for scripts/tests: the pieces an update is made of
export const _internals = { applyPatch, mapSlice, diffOf, mapFiles, domainChange, codeChange, changedSince };
