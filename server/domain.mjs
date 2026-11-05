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
import { runCli, projectModel } from './optimize.mjs';
import { scanDrift } from './drift.mjs';

const BUILD_USD = process.env.VISUALIZER_DOMAIN_USD || '10';
const BRIEF_USD = process.env.VISUALIZER_BRIEF_USD || '2';
const FILE_LIST_CHARS = 60e3;
const DOC_CHARS = 8e3;

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
const modelArgs = pid => { const m = projectModel(pid); return m ? ['--model', m] : []; };
const READ_ONLY = ['--no-session-persistence', '--setting-sources', 'project', '--strict-mcp-config', '--tools', 'Read,Glob,Grep'];

function git(root, args) {
  return execFileSync('git', ['-C', root, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
}
const headOf = root => { try { return git(root, ['rev-parse', 'HEAD']).trim(); } catch { return null; } };
const newer = (root, p, t) => { try { return fs.statSync(path.join(root, p)).mtimeMs > t; } catch { return false; } };

// Files changed since the map was built: commits since then, plus uncommitted and new
// files touched after it (an uncommitted file the map already read does not count again).
function changedSince(city, meta) {
  const root = city.project.root;
  if (meta.head && city.project.isGit) {
    try {
      const lines = args => git(root, args).split('\n').filter(Boolean);
      const committed = lines(['diff', '--name-only', meta.head, 'HEAD', '--']);
      const dirty = [...lines(['diff', '--name-only', 'HEAD', '--']), ...lines(['ls-files', '--others', '--exclude-standard'])]
        .filter(p => newer(root, p, meta.builtAt));
      return [...new Set([...committed, ...dirty])];
    } catch {}
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

export function domainView(pid, city) {
  const st = saved(pid);
  const changed = st ? changedSince(city, st.meta) : [];
  return {
    model: st?.model || null,
    meta: st ? { ...st.meta, changed: changed.slice(0, 60), changedCount: changed.length } : null,
    job: jobs.get(pid) || null,
    briefs: briefsOf(pid),
    drift: driftOf(pid, city),
    llm: projectModel(pid),
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
export function build(pid, city, { update = false } = {}) {
  const cur = jobs.get(pid);
  if (cur && cur.state === 'working') return { error: 'busy', job: cur };
  const st = saved(pid);
  const root = city.project.root;
  const drift = driftOf(pid, city);
  const changed = st && update ? changedSince(city, st.meta) : [];
  if (update && st && !changed.length) return { error: 'nothing changed since the map was built' };
  const job = { id: rid(), kind: update && st ? 'update' : 'build', state: 'working', started: Date.now(), model: projectModel(pid), cost: 0 };
  jobs.set(pid, job);
  emit(pid, { job });
  const head = headOf(root);
  const prompt = job.kind === 'update'
    ? `You keep a project's DOMAIN MAP up to date. Below is the map as it was built on ${new Date(st.meta.builtAt).toISOString().slice(0, 16)}, and the files that changed since. The working directory is the project root; Read, Glob and Grep what you need, starting with the changed files; about 25 reads is plenty.

Update the map: keep the ids of entities, flows and assumptions that still exist, change code paths, statuses, flows and assumptions where the changes touch them, add what is new, drop what is gone. Return the FULL updated map.

${RULES}

Return ONLY JSON matching:
${SCHEMA}

Changed files (${changed.length}):
${changed.slice(0, 300).join('\n')}

The current map:
${JSON.stringify(st.model)}

${context(pid, city, drift)}`
    : `You map a software project for the person who builds it. It has grown too big to hold in one's head, so they need a DOMAIN MAP: the things the project is about (entities), how those relate to each other and to the real world, the main flows through them, and where code built for an earlier setup now drags (drift). The technical structure (folders, modules) is shown elsewhere; here, translate it into the concepts a product owner talks about, each tied back to the code that implements it.

The working directory is the project root. You may Read, Glob and Grep. Spend reads on what defines the entities (data models, schemas, migrations, types, API routes, state stores, main screens) and on the drift candidates listed below. Do not read everything: after about 40 reads, stop exploring and write the map from what you know.

${RULES}

Return ONLY JSON matching:
${SCHEMA}

${context(pid, city, drift)}`;
  runCli([...modelArgs(pid), ...READ_ONLY, '--max-budget-usd', BUILD_USD],
    { cwd: root, env: { VISUALIZER_INTERNAL: '1' }, prompt, timeoutMs: 25 * 60e3, onSpawn: p => procs.set(job.id, p) })
    .then(({ res, cost }) => {
      const model = clean(res, city);
      if (!model.entities.length) throw new Error('the model returned no entities');
      kvSet('domain:' + pid, { model, meta: { builtAt: job.started, head, cost: (job.kind === 'update' ? (st?.meta.cost || 0) : 0) + cost, model: job.model, kind: job.kind } });
      Object.assign(job, { state: 'done', ended: Date.now(), cost });
    })
    .catch(e => Object.assign(job, { state: 'error', ended: Date.now(), error: e.message }))
    .finally(() => { procs.delete(job.id); emit(pid, { job, changed: job.state === 'done' }); });
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
  const b = { id: rid(), task, state: 'working', started: Date.now(), model: projectModel(pid), cost: 0, result: null };
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
  runCli([...modelArgs(pid), ...READ_ONLY, '--max-budget-usd', BRIEF_USD],
    { cwd: root, env: { VISUALIZER_INTERNAL: '1' }, prompt, timeoutMs: 12 * 60e3, onSpawn: p => procs.set(b.id, p) })
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
