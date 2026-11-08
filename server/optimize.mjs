// Optimize one block or district with the project's own model, in two steps:
// a read-only survey (the busiest files of the place, inlined, plus read tools to
// follow calls) returns a ranked list of concrete optimizations; the items the
// user picks are then applied by a real, visible Claude Code session in the
// project folder, so it walks the city and collision alerts cover it. Files are
// snapshotted before the edit, so one click puts them back.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { db, kvGet, kvSet } from './db.mjs';
import { findClaudeCli, rel } from './paths.mjs';
import { openSessions } from './live.mjs';

const KINDS = new Set(['code', 'style', 'markup']);
const INLINE_CHARS = 90e3; // file text put straight into the survey prompt
const PER_FILE = 20e3;
const MAX_SIZE = 400e3;    // bigger files are bundles or generated, not worth a survey
const SURVEY_BUDGET = process.env.VISUALIZER_OPTIMIZE_SURVEY_USD || '2';
const APPLY_BUDGET = process.env.VISUALIZER_OPTIMIZE_APPLY_USD || '8';

const listeners = [];
export function onOptimize(fn) { listeners.push(fn); }
const jobs = new Map();      // pid|key -> job
const procs = new Map();     // job id -> child process
const snapshots = new Map(); // job id -> { before: Map<p, Buffer|null>, after: Map<p, Buffer|null> }
const applying = new Set();  // pid: one edit run per project at a time

const jobKey = (pid, key) => pid + '|' + key;
const saved = pid => kvGet('optimize:' + pid) || {};
function publish(job) {
  jobs.set(jobKey(job.pid, job.key), job);
  const all = saved(job.pid); all[job.key] = job;
  kvSet('optimize:' + job.pid, all);
  for (const l of listeners) l({ type: 'optimize', pid: job.pid, key: job.key, job: view(job) });
}
const view = job => job && { ...job, undo: job.state === 'applied' && snapshots.has(job.id) };

// The model the project's sessions use now; the user's default if none is known.
export function projectModel(pid) {
  return process.env.VISUALIZER_OPTIMIZE_MODEL
    || db.prepare('SELECT model FROM sessions WHERE project_id=? AND model IS NOT NULL ORDER BY last_ts DESC LIMIT 1').get(pid)?.model || null;
}

// key: "m:<module key>" or "d:<district id>"
function scope(c, key) {
  const deg = new Map();
  for (const [, b] of c.fileEdges) deg.set(b, (deg.get(b) || 0) + 1);
  let label, kind, desc, idx;
  if (key.startsWith('m:')) {
    const mi = c.modules.findIndex(m => m.key === key.slice(2));
    const m = c.modules[mi];
    if (!m || m.warehouse) return null;
    label = m.title || m.label; kind = 'block'; desc = m.desc;
    idx = c.files.map((f, i) => f.m === mi ? i : -1).filter(i => i >= 0);
  } else if (key.startsWith('d:')) {
    const di = c.districts.findIndex(d => d.id === key.slice(2));
    const d = c.districts[di];
    if (!d) return null;
    label = d.name; kind = 'district'; desc = d.desc;
    idx = c.files.map((f, i) => c.modules[f.m].district === di ? i : -1).filter(i => i >= 0);
  } else return null;
  // where optimizing pays: code that is run a lot (imported by many), changed a lot, or big
  const files = idx.map(i => ({ ...c.files[i], by: deg.get(i) || 0 })).filter(f => KINDS.has(f.kind) && f.size <= MAX_SIZE)
    .map(f => ({ ...f, score: f.by * 2 + f.churn * 1.5 + f.w * 3 + f.r * 0.5 + Math.log2(f.size / 1024 + 1) * 2 }))
    .sort((a, b) => b.score - a.score);
  return { label, kind, desc, files };
}

export function runCli(args, { cwd, env, prompt, timeoutMs, onSpawn }) {
  return new Promise((resolve, reject) => {
    const p = spawn(findClaudeCli(), ['-p', '--output-format', 'json', ...args], { cwd, windowsHide: true, env: { ...process.env, ...env } });
    onSpawn?.(p);
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('timed out')); }, timeoutMs);
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      if (p.stopped) return reject(new Error('stopped'));
      let j;
      try { j = JSON.parse(out); } catch { return reject(new Error(`claude exited ${code}: ${(err || out).slice(0, 300)}`)); }
      if (j.is_error) return reject(new Error(String(j.result || j.subtype || 'failed').slice(0, 300)));
      const m = String(j.result || '').match(/\{[\s\S]*\}/);
      let res = {};
      try { res = m ? JSON.parse(m[0]) : {}; } catch {}
      resolve({ res, cost: j.total_cost_usd || 0, sid: j.session_id || null, text: String(j.result || '') });
    });
    p.stdin.end(prompt);
  });
}
const modelArgs = pid => { const m = projectModel(pid); return m ? ['--model', m] : []; };

// The last run for a place; one cut short by a server restart reads as an error.
export function getJob(pid, key) {
  const live = jobs.get(jobKey(pid, key));
  if (live) return view(live);
  const old = saved(pid)[key];
  if (!old) return null;
  const job = /ing$/.test(old.state) ? { ...old, state: 'error', error: 'interrupted by a restart' } : old;
  jobs.set(jobKey(pid, key), job);
  return view(job);
}

export function survey(pid, c, key) {
  const cur = jobs.get(jobKey(pid, key));
  if (cur && (cur.state === 'surveying' || cur.state === 'applying')) return { error: 'busy', job: view(cur) };
  const sc = scope(c, key);
  if (!sc) return { error: 'unknown place' };
  if (!sc.files.length) return { error: 'no source files here' };
  const root = c.project.root;
  const inline = [];
  let used = 0;
  for (const f of sc.files) {
    if (used >= INLINE_CHARS || inline.length >= 25) break;
    let text; try { text = fs.readFileSync(path.join(root, f.p), 'utf8'); } catch { continue; }
    if (text.length > PER_FILE) text = text.slice(0, PER_FILE) + '\n…[truncated; Read the file for the rest]';
    inline.push({ f, text }); used += text.length;
  }
  const rest = sc.files.slice(inline.length, inline.length + 150);
  const job = { id: Math.random().toString(36).slice(2, 10), pid, key, label: sc.label, kind: sc.kind, model: projectModel(pid),
    state: 'surveying', started: Date.now(), files: sc.files.length, read: inline.length, plan: null, cost: 0 };
  publish(job);
  const sig = f => `${f.p} (${f.by} importers, ${f.churn} commits, ${f.w} AI edits, ${(f.size / 1024).toFixed(1)} KB)`;
  const prompt = `You review one part of a software project for optimizations. The part is the ${sc.kind} "${sc.label}"${sc.desc ? ` (${sc.desc})` : ''}. The working directory is the project root; you may Read, Glob and Grep to follow calls into and out of this part, but report only on this part.

Look for optimizations worth doing: work repeated in hot paths or loops, N+1 queries, sync I/O or blocking calls on request/render paths, needless re-renders, allocations or copies, caches that are missing or never invalidated, oversized payloads or bundles, extra network or model calls, and duplicated or dead code that can go. Behavior and public interfaces must stay the same. Skip style nits, renames, comments, formatting, and speculative rewrites. A few high-value items beat many small ones; an empty list is a fine answer when the code is already lean.

Return ONLY JSON:
{"summary": "two sentences on how lean this part is and where the cost is",
 "items": [{"id": "o1", "title": "at most 8 words", "gain": "speed|memory|size|io|cost|simpler", "impact": "high|medium|low", "risk": "low|medium|high",
   "files": ["path relative to the root"], "why": "what the code does now, naming functions and lines", "change": "exactly what to change"}]}
At most 8 items, best impact-for-risk first.

Files, busiest first (importers = files that import it):
${inline.map(({ f, text }) => `\n=== ${sig(f)}\n${text}`).join('\n')}
${rest.length ? `\nOther files in this ${sc.kind} (not shown; Read them if a finding leads there):\n${rest.map(sig).join('\n')}` : ''}${sc.files.length > inline.length + rest.length ? `\n…and ${sc.files.length - inline.length - rest.length} more` : ''}`;
  runCli([...modelArgs(pid), '--no-session-persistence', '--setting-sources', 'project', '--strict-mcp-config', '--tools', 'Read,Glob,Grep',
    '--max-budget-usd', SURVEY_BUDGET], { cwd: root, env: { VISUALIZER_INTERNAL: '1' }, prompt, timeoutMs: 8 * 60e3, onSpawn: p => procs.set(job.id, p) })
    .then(({ res, cost }) => {
      const files = new Set(sc.files.map(f => f.p.toLowerCase()));
      const items = (Array.isArray(res.items) ? res.items : []).filter(x => x && x.title).slice(0, 8).map((x, i) => ({
        id: 'o' + (i + 1), title: String(x.title).slice(0, 80), gain: String(x.gain || ''), impact: ['high', 'medium', 'low'].includes(x.impact) ? x.impact : 'medium',
        risk: ['high', 'medium', 'low'].includes(x.risk) ? x.risk : 'medium', why: String(x.why || '').slice(0, 600), change: String(x.change || '').slice(0, 800),
        files: (Array.isArray(x.files) ? x.files : []).map(p => String(p).replace(/\\/g, '/').replace(/^\.\//, '')).filter(p => files.has(p.toLowerCase()) || fs.existsSync(path.join(root, p))).slice(0, 8) }));
      Object.assign(job, { state: 'planned', ended: Date.now(), cost, plan: { summary: String(res.summary || '').slice(0, 400), items } });
    })
    .catch(e => Object.assign(job, { state: 'error', ended: Date.now(), error: e.message }))
    .finally(() => { procs.delete(job.id); publish(job); });
  return { job: view(job) };
}

const gitNew = root => { try { return new Set(execFileSync('git', ['-C', root, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean)); } catch { return null; } };
const readOr = p => { try { return fs.readFileSync(p); } catch { return null; } };

export function apply(pid, c, key, ids, force) {
  const job = jobs.get(jobKey(pid, key));
  if (!job?.plan || job.state === 'surveying' || job.state === 'applying') return { error: 'survey first' };
  if (applying.has(pid)) return { error: 'another optimization is editing this project; wait for it to finish' };
  const items = job.plan.items.filter(x => ids.includes(x.id));
  if (!items.length) return { error: 'pick at least one item' };
  const sc = scope(c, key);
  const root = c.project.root;
  const inScope = new Map([...(sc?.files || []).map(f => f.p), ...items.flatMap(x => x.files)].map(p => [p.toLowerCase(), p]));
  if (!force) {
    const busy = openSessions(pid).filter(s => s.state === 'working' && s.action?.path && inScope.has(String(rel(root, s.action.path) || '').toLowerCase()));
    if (busy.length) return { busy: busy.map(s => ({ id: s.id, title: s.title })) };
  }
  // what the run may touch, as it is now
  const before = new Map();
  for (const p of inScope.values()) before.set(p, readOr(path.join(root, p)));
  const untracked = gitNew(root);
  Object.assign(job, { state: 'applying', applyStarted: Date.now(), picked: items.map(x => x.id), result: null, error: undefined });
  applying.add(pid);
  publish(job);
  const prompt = `Apply these optimizations to the ${job.kind} "${job.label}" of this project. They come from a review of its code:
${JSON.stringify(items.map(({ id, title, files, why, change }) => ({ id, title, files, why, change })), null, 1)}

Rules: keep behavior and public interfaces exactly the same. Edit only the files named in the items, unless a change needs a caller updated; then keep that edit minimal. No new dependencies. Smallest diff that does the job, in the style of the surrounding code. Read the code before you change it; if an item turns out wrong or unsafe, skip it and say why. Do not run commands.
When done, reply with ONLY JSON: {"done": [{"id": "o1", "note": "what changed, one sentence"}], "skipped": [{"id": "o2", "why": "..."}]}`;
  runCli([...modelArgs(pid), '-n', `Optimize ${job.label}`, '--permission-mode', 'acceptEdits', '--strict-mcp-config', '--tools', 'Read,Edit,Write,Glob,Grep',
    '--max-budget-usd', APPLY_BUDGET], { cwd: root, prompt, timeoutMs: 25 * 60e3, onSpawn: p => procs.set(job.id, p) })
    .then(({ res, cost, sid, text }) => {
      Object.assign(job, { state: 'applied', cost: job.cost + cost, session: sid,
        result: { done: Array.isArray(res.done) ? res.done.slice(0, 8) : [], skipped: Array.isArray(res.skipped) ? res.skipped.slice(0, 8) : [], note: res.done ? null : text.slice(0, 400) } });
    })
    .catch(e => Object.assign(job, { state: 'error', error: e.message }))
    .finally(() => {
      // what really changed, whatever the model says
      const after = new Map(), changed = [], created = [];
      for (const [p, buf] of before) { const now = readOr(path.join(root, p)); if (!(buf && now && buf.equals(now)) && (buf || now)) { changed.push(p); after.set(p, now); } }
      const nowNew = gitNew(root);
      if (untracked && nowNew) for (const p of nowNew) if (!untracked.has(p) && !inScope.has(p.toLowerCase())) { created.push(p); after.set(p, readOr(path.join(root, p))); }
      if (after.size) snapshots.set(job.id, { before, after });
      Object.assign(job, { ended: Date.now(), changed, created });
      if (job.state === 'error' && after.size) job.state = 'applied'; // stopped half way: still offer undo
      procs.delete(job.id); applying.delete(pid); publish(job);
    });
  return { job: view(job) };
}

export function stop(pid, key) {
  const job = jobs.get(jobKey(pid, key));
  const p = job && procs.get(job.id);
  if (!p) return { ok: false };
  p.stopped = true; p.kill();
  return { ok: true };
}

// Put the files back as they were before the run, but never over a later edit.
export function undo(pid, c, key) {
  const job = jobs.get(jobKey(pid, key));
  const snap = job && snapshots.get(job.id);
  if (!snap) return { error: 'nothing to undo' };
  const root = c.project.root, restored = [], kept = [];
  for (const [p, after] of snap.after) {
    const full = path.join(root, p), now = readOr(full);
    if (!(now === after || (now && after && now.equals(after)))) { kept.push(p); continue; }
    const was = snap.before.get(p) ?? null;
    if (was) fs.writeFileSync(full, was); else if (now) fs.rmSync(full);
    restored.push(p);
  }
  snapshots.delete(job.id);
  Object.assign(job, { state: 'undone', undoneAt: Date.now(), kept });
  publish(job);
  return { restored, kept };
}
