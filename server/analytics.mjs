// Practical analytics over what the sessions did and how it turned out:
// - live health of a session (checks passing, edit loops, cost against the usual)
//   and the warnings it raises,
// - a review list of uncommitted files, riskiest first, with the reasons,
// - weekly insights (what lands, rework, waiting on you, hotspots, CLAUDE.md lines),
// - what the city's look and cosmetics follow (the health score's inputs).
// Coaching numbers here are advice only; none of them feed the health score.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { db, kvGet, kvSet } from './db.mjs';
import { getScan } from './citymap.mjs';
import { changes } from './insights.mjs';
import { redact } from './transcript.mjs';

const DAY = 86400e3, WEEK = 7 * DAY;
const CHECK_LABEL = { test: 'Tests', build: 'Build', types: 'Type check', lint: 'Lint' };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const money = n => n >= 10 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
const median = xs => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function git(root, args, max = 32 * 1024 * 1024) {
  return execFileSync('git', ['-C', root, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8', maxBuffer: max, windowsHide: true, timeout: 15e3 });
}
const relOf = (root, p) => {
  const r = root.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '') + '/', q = String(p || '').replace(/\\/g, '/');
  return q.toLowerCase().startsWith(r) ? q.slice(r.length) : null;
};

// ---------------------------------------------------------------- live session health
const q = {
  curTask: db.prepare('SELECT id, ts, end_ts, project_id FROM tasks WHERE session_id=? ORDER BY ts DESC LIMIT 1'),
  checks: db.prepare('SELECT chk, ok, res, ts FROM events WHERE task_id=? AND chk IS NOT NULL AND ok IS NOT NULL ORDER BY ts'),
  loop: db.prepare(`SELECT lower(path) p, path, COUNT(*) n, MIN(ts) t0, MAX(ts) t1 FROM events WHERE task_id=? AND kind='write' AND path IS NOT NULL
    GROUP BY lower(path) ORDER BY n DESC LIMIT 1`),
  taskCost: db.prepare('SELECT COALESCE(SUM(cost),0) c FROM usage WHERE task_id=?'),
  taskCosts: db.prepare('SELECT SUM(cost) c FROM usage WHERE project_id=? AND ts>? AND task_id IS NOT NULL GROUP BY task_id HAVING c > 0'),
  title: db.prepare('SELECT title FROM sessions WHERE id=?'),
};

const medianCache = new Map(); // pid -> { at, v }
function medianTaskCost(pid) {
  const hit = medianCache.get(pid);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.v;
  const v = median(q.taskCosts.all(pid, Date.now() - 30 * DAY).map(r => r.c));
  medianCache.set(pid, { at: Date.now(), v });
  return v;
}

const healthCache = new Map(); // sid -> { at, v }
// The current task of a session: last result of each check, the failure streak,
// the file it keeps rewriting, and its cost against the project's usual task.
export function sessionHealth(sid, maxAge = 3000) {
  const hit = healthCache.get(sid);
  if (hit && Date.now() - hit.at < maxAge) return hit.v;
  const t = q.curTask.get(sid);
  let v = null;
  if (t) {
    const checks = {}, runs = q.checks.all(t.id);
    for (const r of runs) {
      const c = checks[r.chk] || (checks[r.chk] = { ok: true, ts: 0, res: null, fails: 0, runs: 0 });
      c.ok = !!r.ok; c.ts = r.ts; c.res = r.ok ? null : r.res; c.runs++;
      c.fails = r.ok ? 0 : c.fails + 1;
    }
    const lp = q.loop.get(t.id);
    const cost = q.taskCost.get(t.id).c, med = medianTaskCost(t.project_id);
    v = { task: t.id, since: t.ts, checks, last: runs.length ? runs[runs.length - 1].chk : null,
      loop: lp && lp.n >= 6 ? { path: lp.path, n: lp.n, mins: Math.max(1, Math.round((lp.t1 - lp.t0) / 60e3)) } : null,
      cost, median: med, ratio: med > 0 ? cost / med : 0 };
  }
  healthCache.set(sid, { at: Date.now(), v });
  return v;
}

// Warnings from a session's latest outcomes. `raise(key, ttl, alert)` raises once per key.
export function checkSession(sid, pid, raise, turnEnded = false) {
  const h = sessionHealth(sid, 0);
  if (!h) return;
  const title = q.title.get(sid)?.title || 'A session';
  const base = { pid, sessions: [sid] };
  const label = p => p ? p.replace(/\\/g, '/').split('/').slice(-2).join('/') : '';
  if (h.loop && h.loop.n >= 8) {
    const failing = Object.entries(h.checks).filter(([, c]) => !c.ok).map(([k]) => CHECK_LABEL[k].toLowerCase());
    raise(`loop|${h.task}|${h.loop.path.toLowerCase()}`, DAY, { ...base, kind: 'loop', path: h.loop.path,
      text: `${title} has edited ${label(h.loop.path)} ${h.loop.n}× in ${h.loop.mins} min` + (failing.length ? ` and ${failing.join(' and ')} still fail` : '') });
  }
  for (const [k, c] of Object.entries(h.checks)) if (c.fails >= 3)
    raise(`failing|${h.task}|${k}|${Math.floor(c.fails / 3)}`, DAY, { ...base, kind: 'failing',
      text: `${CHECK_LABEL[k]} failed ${c.fails} times in a row in ${title}` + (c.res ? `: ${c.res.split('\n').filter(Boolean).pop()?.slice(0, 120)}` : '') });
  if (h.median > 0 && h.cost >= Math.max(1, 4 * h.median))
    raise(`cost|${h.task}|${Math.floor(Math.log2(h.ratio))}`, DAY, { ...base, kind: 'cost',
      text: `This task in ${title} has cost ${money(h.cost)}, ${Math.round(h.ratio)}× your usual task (${money(h.median)})` });
  if (turnEnded && h.last && h.checks[h.last] && !h.checks[h.last].ok)
    raise(`red-stop|${h.task}`, DAY, { ...base, kind: 'red-stop',
      text: `${title} finished its turn with ${CHECK_LABEL[h.last].toLowerCase()} failing` });
}

// ---------------------------------------------------------------- review
const RISK = { payments: 3, security: 3, database: 3, infra: 2, api: 1.5, pipeline: 1.3, storefront: 1, marketing: 0.8, workspace: 0.8, qa: 0.5, docs: 0.3, brand: 0.3 };
const DEPS = /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|Cargo\.toml|go\.mod|Gemfile|composer\.json)$/i;
const DEBUG = /\bconsole\.(log|debug)\(|\bdebugger\b|^\s*print\(|\bvar_dump\(|\bdd\(|\bdbg!\(|\bTODO\b|\bFIXME\b|\bXXX\b/;
const writersQ = db.prepare(`SELECT task_id, session_id, MAX(ts) ts FROM events WHERE project_id=? AND kind='write' AND lower(path)=lower(?) AND ts > ?
  GROUP BY task_id`);
const taskWritesQ = db.prepare("SELECT DISTINCT lower(path) p FROM events WHERE task_id=? AND kind='write' AND path IS NOT NULL");
// the last check the writing session ran after its edit: another session's green run proves nothing about this edit
const lastCheckQ = db.prepare(`SELECT ok, ts, chk FROM events WHERE project_id=? AND session_id=? AND chk IN ('test','types','build') AND ok IS NOT NULL AND ts > ?
  ORDER BY ts DESC LIMIT 1`);
const taskInfoQ = db.prepare('SELECT title, prompt FROM tasks WHERE id=?');

// Added lines per file in the working tree against HEAD (untracked files count whole).
function diffInfo(root, files) {
  const out = new Map();
  const get = p => { let x = out.get(p); if (!x) out.set(p, x = { add: 0, del: 0, debug: 0, secret: 0, deps: 0 }); return x; };
  let text = '';
  try { text = git(root, ['diff', 'HEAD', '-U0', '--no-color', '--no-ext-diff']); } catch {}
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) { const m = / b\/(.+)$/.exec(line); cur = m ? get(m[1]) : null; continue; }
    if (!cur || line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) { cur.add++; scanAdded(cur, line.slice(1)); } else if (line.startsWith('-')) cur.del++;
  }
  for (const f of files) if (f.st === '??') {
    const x = get(f.p);
    let src = ''; try { const full = path.join(root, f.p); if (fs.statSync(full).size < 400 * 1024) src = fs.readFileSync(full, 'utf8'); } catch {}
    for (const l of src.split('\n')) { x.add++; scanAdded(x, l); }
  }
  return out;
}
function scanAdded(x, l) {
  if (DEBUG.test(l)) x.debug++;
  if (redact(l) !== l) x.secret++;
  if (/^\s*"[@\w./-]+"\s*:\s*"[\^~>=<*\d]/.test(l) || /^[A-Za-z][\w.-]*\s*[=<>~!]=/.test(l)) x.deps++;
}

const reviewCache = new Map();
export function review(pid, root, city) {
  const hit = reviewCache.get(pid);
  if (hit && Date.now() - hit.at < 5000) return hit.out;
  const ch = changes(pid, root);
  if (!ch.isGit) return { isGit: false, files: [] };
  const scan = getScan(pid, root);
  const lastCommit = new Map(); for (const c of scan.commits) for (const f of c.files) if (!lastCommit.has(f.toLowerCase())) lastCommit.set(f.toLowerCase(), c.ts);
  const fileIdx = new Map(city.files.map((f, i) => [f.p.toLowerCase(), i]));
  const importedBy = new Map(); for (const [, b] of city.fileEdges) importedBy.set(b, (importedBy.get(b) || 0) + 1);
  const districtOf = p => { const i = fileIdx.get(p.toLowerCase()); return i == null ? null : city.modules[city.files[i].m].district; };
  const diff = diffInfo(root, ch.files);
  const taskDistricts = new Map();
  const mainArea = tid => {
    if (taskDistricts.has(tid)) return taskDistricts.get(tid);
    const n = new Map();
    for (const r of taskWritesQ.all(tid)) { const rp = relOf(root, r.p); const d = rp == null ? null : districtOf(rp); if (d != null) n.set(d, (n.get(d) || 0) + 1); }
    const top = [...n].sort((a, b) => b[1] - a[1]);
    const v = { main: top[0]?.[0] ?? null, count: n.size };
    taskDistricts.set(tid, v);
    return v;
  };
  const now = Date.now();
  const files = ch.files.map(f => {
    const di = districtOf(f.p), D = di != null ? city.districts[di] : null;
    const fi = fileIdx.get(f.p.toLowerCase()), cf = fi != null ? city.files[fi] : null;
    const kind = cf?.kind || null;
    const d = diff.get(f.p) || { add: 0, del: 0, debug: 0, secret: 0, deps: 0 };
    const since = lastCommit.get(f.p.toLowerCase()) ?? 0;
    const tasks = writersQ.all(pid, root + '/' + f.p, since);
    const lastWrite = Math.max(0, ...tasks.map(t => t.ts));
    const sessions = new Set(tasks.map(t => t.session_id));
    const reasons = [];
    const role = D?.id || 'workspace';
    let w = RISK[role] ?? RISK[D?.kind] ?? 1;
    if (D && w >= 2) reasons.push({ t: D.name, k: 'role' });
    const lines = d.add + d.del;
    if (lines >= 40) reasons.push({ t: `+${d.add} −${d.del}`, k: 'size' });
    let score = w * (1 + Math.log2(1 + lines / 25));
    if (/(^|\/)\.env(\.|$)/i.test(f.p)) { score += 4; reasons.push({ t: 'env file', k: 'secret' }); }
    else if (d.secret) { score += 4; reasons.push({ t: 'looks like a secret', k: 'secret' }); }
    if (kind === 'code' && lastWrite) {
      const chk = lastCheckQ.get(pid, tasks.find(t => t.ts === lastWrite).session_id, lastWrite);
      if (!chk) { score += 2; reasons.push({ t: 'no test since edit', k: 'untested' }); }
      else if (!chk.ok) { score += 2.5; reasons.push({ t: `${CHECK_LABEL[chk.chk].toLowerCase()} failing`, k: 'failing' }); }
      else reasons.push({ t: `${CHECK_LABEL[chk.chk].toLowerCase()} passed`, k: 'ok' });
    }
    if (sessions.size > 1) { score += 1.5; reasons.push({ t: `${sessions.size} sessions`, k: 'multi' }); }
    if (di != null && tasks.some(t => { const a = t.task_id && mainArea(t.task_id); return a && a.count >= 3 && a.main !== di; })) {
      score += 1.5; reasons.push({ t: 'outside the task\'s main area', k: 'scope' });
    }
    if (d.debug) { score += 1; reasons.push({ t: plural(d.debug, 'debug/TODO line'), k: 'leftover' }); }
    if (DEPS.test(f.p) && d.deps) { score += 1.5; reasons.push({ t: 'dependencies changed', k: 'deps' }); }
    if ((f.st === '??' || f.st === 'A') && kind === 'code' && fi != null && !importedBy.get(fi) && !/(^|\/)(index|main|app|server|cli)\.|\.(test|spec)\./i.test(f.p)) {
      score += 0.8; reasons.push({ t: 'new, nothing imports it', k: 'orphan' });
    }
    const t = tasks.sort((a, b) => b.ts - a.ts)[0];
    const ti = t?.task_id ? taskInfoQ.get(t.task_id) : null;
    return { p: f.p, st: f.st, ti: fi ?? null, district: D?.name || null, add: d.add, del: d.del, score: Math.round(score * 10) / 10,
      level: score >= 6 ? 'high' : score >= 3 ? 'medium' : 'low', reasons, sessions: [...sessions], lastWrite: lastWrite || null,
      task: t?.task_id ? { id: t.task_id, title: ti?.title && ti.title !== '—' ? ti.title : (ti?.prompt || '').slice(0, 100) } : null,
      age: lastWrite ? now - lastWrite : null };
  }).sort((a, b) => b.score - a.score);
  const out = { isGit: true, files, high: files.filter(f => f.level === 'high').length, medium: files.filter(f => f.level === 'medium').length };
  reviewCache.set(pid, { at: Date.now(), out });
  return out;
}

// ---------------------------------------------------------------- insights
const tasksQ = db.prepare('SELECT id, session_id, ts, end_ts, n_read, n_write, prompt FROM tasks WHERE project_id=? AND ts > ? ORDER BY session_id, ts');
const writesSinceQ = db.prepare(`SELECT task_id, session_id, lower(path) p, MIN(ts) ts, MAX(ts) t1 FROM events WHERE project_id=? AND kind='write' AND ts > ? AND task_id IS NOT NULL
  AND path IS NOT NULL GROUP BY task_id, lower(path)`);
const costSinceQ = db.prepare('SELECT COALESCE(SUM(cost),0) c FROM usage WHERE project_id=? AND ts BETWEEN ? AND ?');
const checksSinceQ = db.prepare('SELECT chk, ok, ts, task_id, session_id FROM events WHERE project_id=? AND chk IS NOT NULL AND ok IS NOT NULL AND ts > ?');

// One window's numbers: what landed, what was reworked, what waited on you.
function windowStats(pid, root, scan, from, to) {
  const lastByFile = new Map();
  for (const c of scan.commits) for (const f of c.files) { const k = f.toLowerCase(); (lastByFile.get(k) || lastByFile.set(k, []).get(k)).push(c.ts); }
  const tasks = tasksQ.all(pid, from - DAY).filter(t => t.ts <= to);
  const inWin = tasks.filter(t => t.ts >= from);
  const writes = writesSinceQ.all(pid, from).filter(w => w.ts <= to + 3 * DAY);
  const byTask = new Map(), byFile = new Map();
  for (const w of writes) {
    const rp = relOf(root, w.p); if (rp == null) continue;
    (byTask.get(w.task_id) || byTask.set(w.task_id, []).get(w.task_id)).push({ p: rp.toLowerCase(), ts: w.ts });
    (byFile.get(rp.toLowerCase()) || byFile.set(rp.toLowerCase(), []).get(rp.toLowerCase())).push({ task: w.task_id, ts: w.ts });
  }
  let writing = 0, landed = 0, abandoned = 0, reworked = 0, pairs = 0, blind = 0;
  const now = Date.now();
  for (const t of inWin) {
    const ws = byTask.get(t.id); if (!ws) continue;
    writing++;
    const isLanded = ws.some(w => (lastByFile.get(w.p) || []).some(ts => ts >= w.ts));
    if (isLanded) landed++; else if (now - (t.end_ts || t.ts) > 6 * 3600e3) abandoned++;
    if (t.n_read < Math.max(1, t.n_write / 3)) blind++;
    for (const w of ws) {
      if (w.ts > to) continue;
      pairs++;
      if ((byFile.get(w.p) || []).some(o => o.task !== t.id && o.ts > w.ts && o.ts - w.ts < 3 * DAY)) reworked++;
    }
  }
  // time a finished turn waited for your next prompt, while you were around (< 4h)
  let waited = 0; const waits = [];
  for (let i = 1; i < tasks.length; i++) {
    const a = tasks[i - 1], b = tasks[i];
    if (a.session_id !== b.session_id || b.ts < from || b.ts > to) continue;
    const gap = b.ts - (a.end_ts || a.ts);
    if (gap > 0 && gap < 4 * 3600e3) { waited += gap; waits.push(gap); }
  }
  const cost = costSinceQ.get(pid, from, to).c;
  const checks = checksSinceQ.all(pid, from).filter(c => c.ts <= to);
  return { tasks: inWin.length, writing, landed, abandoned, cost, perLanded: landed ? cost / landed : null,
    rework: pairs ? reworked / pairs : null, waited, waitMedian: median(waits), blind: writing ? blind / writing : null,
    checks: checks.length, checkPass: checks.length ? checks.filter(c => c.ok).length / checks.length : null };
}

// Lines in the prompts that correct the assistant, repeated across tasks: CLAUDE.md material.
const LEAD = /^(?:(?:no|ok|okay|so|and|but|also|again|please|btw|by the way|as a rule|from now on|in the future|important)\b[\s,:;.!-]*)+/i;
const CORRECTION = /^(?:don'?t|do not|never|always|stop|avoid|make sure|remember|no more|use\b.+\binstead\b|you (?:should|must|need to|keep))\b/i;
const RULE = /\b(as a rule|from now on|in the future|every time|always|never)\b/i; // one statement of a standing rule is enough
const STOP = new Set('the a an to of in on for and or it is be this that with you your please dont do not never always stop make sure remember use instead again should must need just any all from as at by'.split(' '));
const words = s => new Set(s.toLowerCase().replace(/[^a-z0-9_\s.-]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));
const jacc = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n || 1); };
function suggestions(pid, root, since) {
  const groups = [];
  for (const t of tasksQ.all(pid, since)) {
    for (const raw of (t.prompt || '').split(/(?<=[.!?])\s+|\n+/)) {
      const s = raw.replace(/\[pasted:[^\]]*\]/g, '').trim();
      if (s.length < 12 || s.length > 220 || !CORRECTION.test(s.replace(LEAD, ''))) continue;
      const w = words(s); if (w.size < 2) continue;
      const g = groups.find(g => jacc(g.w, w) >= 0.45);
      if (g) { g.tasks.add(t.id); g.n++; g.rule ||= RULE.test(s); if (s.length < g.text.length) g.text = s; for (const x of w) g.w.add(x); }
      else groups.push({ w, text: s, n: 1, tasks: new Set([t.id]), rule: RULE.test(s) });
    }
  }
  let claudeMd = '';
  for (const f of ['CLAUDE.md', '.claude/CLAUDE.md']) try { claudeMd += fs.readFileSync(path.join(root, f), 'utf8').toLowerCase(); } catch {}
  const have = words(claudeMd);
  return groups.filter(g => g.tasks.size >= 2 || g.rule)
    .map(g => ({ text: g.text, n: g.tasks.size, rule: g.rule, covered: [...g.w].filter(x => have.has(x)).length / g.w.size >= 0.8 }))
    .filter(g => !g.covered).sort((a, b) => b.n - a.n || +b.rule - +a.rule).slice(0, 8).map(({ covered, ...g }) => g);
}

// Lines added minus removed per file over the last 30 days of commits.
function growth(root) {
  const out = new Map();
  let text = '';
  try { text = git(root, ['log', '--since=30.days.ago', '--numstat', '--format=', '--no-renames']); } catch { return out; }
  for (const l of text.split('\n')) {
    const m = /^(\d+)\t(\d+)\t(.+)$/.exec(l); if (!m) continue;
    const k = m[3].toLowerCase(); out.set(k, (out.get(k) || 0) + Number(m[1]) - Number(m[2]));
  }
  return out;
}

const SOURCE = new Set(['code', 'style', 'markup']); // files whose churn and growth mean design trouble, not notes or data
const insightCache = new Map();
export function insights(pid, root, city) {
  const hit = insightCache.get(pid);
  if (hit && Date.now() - hit.at < 60e3) return hit.out;
  const now = Date.now(), scan = getScan(pid, root);
  const week = windowStats(pid, root, scan, now - WEEK, now), prev = windowStats(pid, root, scan, now - 2 * WEEK, now - WEEK);

  // per file over 30 days: tasks that wrote it, sessions, net growth, whether a check passed after its last write
  const fileIdx = new Map(city.files.map((f, i) => [f.p.toLowerCase(), i]));
  const per = new Map();
  for (const w of writesSinceQ.all(pid, now - 30 * DAY)) {
    const rp = relOf(root, w.p); if (rp == null) continue;
    const i = fileIdx.get(rp.toLowerCase()); if (i == null) continue;
    const x = per.get(i) || { tasks: 0, last: 0, sid: null }; x.tasks++;
    if (w.t1 > x.last) { x.last = w.t1; x.sid = w.session_id; }
    per.set(i, x);
  }
  // tested: the session that last wrote the file ran a passing test, type check or build after that write
  const checks = checksSinceQ.all(pid, now - 30 * DAY).filter(c => c.chk === 'test' || c.chk === 'types' || c.chk === 'build').sort((a, b) => a.ts - b.ts);
  const passedAfter = (ts, sid) => { for (let k = checks.length - 1; k >= 0 && checks[k].ts > ts; k--) if (checks[k].ok && checks[k].session_id === sid) return true; return false; };
  const grow = scan.isGit ? growth(root) : new Map();
  const files = city.files.map((f, i) => {
    const x = per.get(i);
    return { churn: x?.tasks || 0, growth: grow.get(f.p.toLowerCase()) || 0, tested: f.kind !== 'code' || !x ? null : passedAfter(x.last, x.sid) ? 1 : 0 };
  });
  const hot = [...per].filter(([i, x]) => SOURCE.has(city.files[i].kind) && x.tasks >= 3).sort((a, b) => b[1].tasks - a[1].tasks).slice(0, 8)
    .map(([i, x]) => ({ i, p: city.files[i].p, tasks: x.tasks }));
  const growing = files.map((f, i) => ({ i, p: city.files[i].p, g: f.growth, size: city.files[i].size })).filter(f => f.g >= 150 && SOURCE.has(city.files[f.i].kind))
    .sort((a, b) => b.g - a.g).slice(0, 6);
  const untested = files.filter(f => f.tested === 0).length, testedN = files.filter(f => f.tested === 1).length;
  const out = { at: now, week, prev, files, hot, growing, untested, tested: testedN,
    suggestions: suggestions(pid, root, now - 30 * DAY),
    prompts: promptOutcomes(pid, root, scan, city, taskFlags(pid, root, city)), deps: scan.isGit ? dependencies(pid, root) : { weeks: [] } };
  insightCache.set(pid, { at: now, out });
  return out;
}

// ---------------------------------------------------------------- task flags, prompts, dependencies, file history
const taskWritesAllQ = db.prepare(`SELECT task_id, session_id, lower(path) p, MAX(ts) ts FROM events WHERE project_id=? AND kind='write' AND ts > ?
  AND task_id IS NOT NULL AND path IS NOT NULL GROUP BY task_id, lower(path)`);
const taskChecksQ = db.prepare(`SELECT task_id, chk, ok, ts FROM events WHERE project_id=? AND ts > ? AND chk IN ('test','types','build') AND ok IS NOT NULL`);

// Per task (30 days): districts it wrote into, whether code it wrote went untested
// within the task, and how many of its files another task rewrote within 3 days.
const flagCache = new Map();
export function taskFlags(pid, root, city) {
  const hit = flagCache.get(pid);
  if (hit && Date.now() - hit.at < 30e3) return hit.out;
  const since = Date.now() - 30 * DAY;
  const fileIdx = new Map(city.files.map((f, i) => [f.p.toLowerCase(), i]));
  const byTask = new Map(), byFile = new Map();
  for (const w of taskWritesAllQ.all(pid, since)) {
    const rp = relOf(root, w.p); if (rp == null) continue;
    const i = fileIdx.get(rp.toLowerCase());
    (byTask.get(w.task_id) || byTask.set(w.task_id, []).get(w.task_id)).push({ i, p: rp.toLowerCase(), ts: w.ts });
    (byFile.get(rp.toLowerCase()) || byFile.set(rp.toLowerCase(), []).get(rp.toLowerCase())).push({ task: w.task_id, ts: w.ts });
  }
  const checks = new Map();
  for (const c of taskChecksQ.all(pid, since)) (checks.get(c.task_id) || checks.set(c.task_id, []).get(c.task_id)).push(c);
  const out = {};
  for (const [id, ws] of byTask) {
    const districts = new Set(ws.filter(w => w.i != null).map(w => city.modules[city.files[w.i].m].district));
    const code = ws.filter(w => w.i != null && city.files[w.i].kind === 'code');
    const last = Math.max(0, ...code.map(w => w.ts));
    const untested = code.length > 0 && !(checks.get(id) || []).some(c => c.ok && c.ts > last);
    const reworked = ws.filter(w => w.i != null && SOURCE.has(city.files[w.i].kind) && (byFile.get(w.p) || []).some(o => o.task !== id && o.ts > w.ts && o.ts - w.ts < 3 * DAY)).length;
    out[id] = { d: districts.size, u: untested ? 1 : 0, r: reworked, f: ws.length };
  }
  flagCache.set(pid, { at: Date.now(), out });
  return out;
}

// Prompts behind tasks that landed cheaply, against prompts behind tasks that were
// abandoned or reworked, with what tells them apart (length, naming files).
const taskCostQ = db.prepare('SELECT task_id, SUM(cost) c FROM usage WHERE project_id=? AND ts > ? AND task_id IS NOT NULL GROUP BY task_id');
const NAMES_FILE = /[\w-]+\.(?:m?[jt]sx?|py|css|html|sql|json|md|php|go|rs|vue|svelte)\b|\/[\w-]+\//;
function promptOutcomes(pid, root, scan, city, flags) {
  const since = Date.now() - 30 * DAY;
  const lastByFile = new Map();
  for (const c of scan.commits) for (const f of c.files) { const k = f.toLowerCase(); (lastByFile.get(k) || lastByFile.set(k, []).get(k)).push(c.ts); }
  const cost = new Map(taskCostQ.all(pid, since).map(r => [r.task_id, r.c]));
  const writes = new Map();
  for (const w of taskWritesAllQ.all(pid, since)) { const rp = relOf(root, w.p); if (rp != null) (writes.get(w.task_id) || writes.set(w.task_id, []).get(w.task_id)).push({ p: rp.toLowerCase(), ts: w.ts }); }
  const good = [], bad = [];
  for (const t of tasksQ.all(pid, since)) {
    const ws = writes.get(t.id); if (!ws || !t.prompt || t.prompt.length < 15) continue;
    if (Date.now() - (t.end_ts || t.ts) < 6 * 3600e3) continue;
    const landed = ws.some(w => (lastByFile.get(w.p) || []).some(ts => ts >= w.ts));
    const fl = flags[t.id], c = cost.get(t.id) || 0;
    const x = { id: t.id, prompt: t.prompt.replace(/\s+/g, ' ').slice(0, 220), cost: c, words: t.prompt.split(/\s+/).length, names: NAMES_FILE.test(t.prompt) };
    if (landed && !(fl?.r)) good.push(x); else if (!landed || (fl && fl.r >= Math.max(2, fl.f / 2))) bad.push({ ...x, why: landed ? 'reworked soon after' : 'never committed' });
  }
  if (good.length < 3 || bad.length < 3) return null;
  good.sort((a, b) => a.cost - b.cost);
  const cheap = good.slice(0, Math.max(3, Math.floor(good.length / 4)));
  const avg = (xs, f) => xs.reduce((s, x) => s + f(x), 0) / xs.length;
  return {
    good: cheap.slice(0, 3), bad: bad.sort((a, b) => b.cost - a.cost).slice(0, 3),
    stats: { goodWords: Math.round(median(cheap.map(x => x.words))), badWords: Math.round(median(bad.map(x => x.words))),
      goodNames: avg(cheap, x => +x.names), badNames: avg(bad, x => +x.names), goodN: cheap.length, badN: bad.length },
  };
}

// Dependencies added and removed per week (8 weeks), from the manifests' history,
// with the task that last wrote the manifest before the commit.
const MANIFESTS = ['package.json', 'requirements.txt', 'requirements-dev.txt', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Gemfile', 'composer.json'];
const manifestTaskQ = db.prepare(`SELECT e.task_id, t.title, t.prompt FROM events e LEFT JOIN tasks t ON t.id=e.task_id WHERE e.project_id=? AND e.kind='write'
  AND lower(e.path)=lower(?) AND e.ts BETWEEN ? AND ? ORDER BY e.ts DESC LIMIT 1`);
const depName = (file, l) => {
  if (/package\.json$|composer\.json$/i.test(file)) return /^\s*"([@\w./-]+)"\s*:\s*"[\^~>=<*\dvlatesxworkspace:file:git+.-]/.exec(l)?.[1];
  if (/\.txt$/i.test(file)) return /^([A-Za-z][\w.-]*)\s*(?:[=<>~!]=|>|<|$)/.exec(l.trim())?.[1];
  if (/pyproject|Cargo/i.test(file)) return /^\s*"?([A-Za-z][\w.-]*)"?\s*=\s*["{]/.exec(l)?.[1] || /^\s*"([A-Za-z][\w.-]*)[=<>~ ]/.exec(l)?.[1];
  if (/go\.mod$/i.test(file)) return /^\s*(?:require\s+)?([\w.-]+\.[\w.-]+\/[\w./-]+)\s+v/.exec(l)?.[1];
  if (/Gemfile$/i.test(file)) return /^\s*gem\s+['"]([\w-]+)/.exec(l)?.[1];
  return null;
};
const depCache = new Map();
export function dependencies(pid, root) {
  const hit = depCache.get(pid);
  if (hit && Date.now() - hit.at < 5 * 60e3) return hit.out;
  let text = '';
  try { text = git(root, ['log', '--since=8.weeks.ago', '-p', '-U0', '--no-color', '--format=%x00%H%x09%ct%x09%s', '--', ...MANIFESTS.flatMap(m => [m, `:(glob)**/${m}`])]); } catch {}
  const weeks = new Map(), skip = /^(name|version|description|main|type|license|private|author|scripts|engines)$/;
  for (const chunk of text.split('\0').slice(1)) {
    const [head, ...lines] = chunk.split('\n');
    const [h, ct, ...subj] = head.split('\t'); const ts = Number(ct) * 1000;
    let file = null; const add = new Map(), del = new Map();
    for (const l of lines) {
      if (l.startsWith('diff --git ')) { file = / b\/(.+)$/.exec(l)?.[1] || null; continue; }
      if (!file || l.startsWith('+++') || l.startsWith('---')) continue;
      const name = (l[0] === '+' || l[0] === '-') ? depName(file, l.slice(1)) : null;
      if (!name || skip.test(name)) continue;
      (l[0] === '+' ? add : del).set(name, file);
    }
    // a version bump shows as removed + added: that is not a new dependency
    const added = [...add].filter(([n]) => !del.has(n)), removed = [...del].filter(([n]) => !add.has(n));
    if (!added.length && !removed.length) continue;
    const wk = Math.floor((Date.now() - ts) / WEEK);
    const w = weeks.get(wk) || { week: wk, added: [], removed: [] };
    for (const [n, f] of added) {
      const t = manifestTaskQ.get(pid, root + '/' + f, ts - 2 * DAY, ts);
      w.added.push({ name: n, file: f, ts, commit: h.slice(0, 8), task: t?.task_id ? { id: t.task_id, title: t.title && t.title !== '—' ? t.title : (t.prompt || '').slice(0, 80) } : null });
    }
    for (const [n, f] of removed) w.removed.push({ name: n, file: f, ts, commit: h.slice(0, 8) });
    weeks.set(wk, w);
  }
  const out = { weeks: [...weeks.values()].sort((a, b) => a.week - b.week) };
  depCache.set(pid, { at: Date.now(), out });
  return out;
}

// One file over the last 12 weeks: lines at the end of each week (from its commits),
// commits and AI writes per week, for the Inspect sparklines.
const fileWritesQ = db.prepare("SELECT ts FROM events WHERE project_id=? AND kind='write' AND lower(path)=lower(?) AND ts > ?");
export function fileHistory(pid, root, rel) {
  const N = 12, now = Date.now(), weeks = Array.from({ length: N }, (_, k) => ({ week: N - 1 - k, lines: 0, commits: 0, writes: 0 }));
  let lines = 0;
  try { const src = fs.readFileSync(path.join(root, rel), 'utf8'); lines = src ? src.split('\n').length - (src.endsWith('\n') ? 1 : 0) : 0; } catch {}
  let text = '';
  try { text = git(root, ['log', '--since=12.weeks.ago', '--follow', '--numstat', '--format=%x00%ct', '--', rel], 8 * 1024 * 1024); } catch {}
  const commits = [];
  for (const chunk of text.split('\0').slice(1)) {
    const [ct, ...rest] = chunk.split('\n');
    const m = rest.map(l => /^(\d+)\t(\d+)\t/.exec(l)).find(Boolean);
    commits.push({ ts: Number(ct) * 1000, net: m ? Number(m[1]) - Number(m[2]) : 0 });
  }
  // walk back from today's size: a week ends with the lines before the later commits
  let cur = lines, ci = 0;
  commits.sort((a, b) => b.ts - a.ts);
  for (let k = 0; k < N; k++) {
    const end = now - k * WEEK, start = end - WEEK, w = weeks[N - 1 - k];
    while (ci < commits.length && commits[ci].ts > end) { cur -= commits[ci].net; ci++; }
    w.lines = Math.max(0, cur);
    for (const c of commits) if (c.ts > start && c.ts <= end) w.commits++;
  }
  for (const r of fileWritesQ.all(pid, root + '/' + rel, now - N * WEEK)) {
    const k = Math.floor((now - r.ts) / WEEK); if (k < N) weeks[N - 1 - k].writes++;
  }
  return { p: rel, lines, weeks };
}

// The overview's four numbers per project: this week and last.
const weekCache = new Map();
export function weekly(pid, root) {
  const hit = weekCache.get(pid);
  if (hit && Date.now() - hit.at < 5 * 60e3) return hit.out;
  const now = Date.now(), scan = getScan(pid, root);
  // without git nothing can land, so the landing numbers are unknown rather than zero
  const pick = s => ({ perLanded: scan.isGit ? s.perLanded : null, landed: s.landed, writing: scan.isGit ? s.writing : 0, rework: s.rework, waitMedian: s.waitMedian });
  const out = { week: pick(windowStats(pid, root, scan, now - WEEK, now)), prev: pick(windowStats(pid, root, scan, now - 2 * WEEK, now - WEEK)) };
  weekCache.set(pid, { at: now, out });
  return out;
}

// ---------------------------------------------------------------- city look and cosmetics
const churnQ = db.prepare(`SELECT lower(path) p, COUNT(DISTINCT session_id) n FROM events WHERE project_id=? AND kind='write' AND ts > ? AND path IS NOT NULL
  GROUP BY lower(path) HAVING n >= 3`);
const collidedQ = db.prepare("SELECT DISTINCT path FROM alerts WHERE project_id=? AND kind='collision' AND ts > ? AND path IS NOT NULL");

// What the city looks like for its health: smog for spend, lit streets for shipping,
// litter by stale uncommitted files, run-down buildings for churn, cones where sessions collided.
export function look(pid, root, h, city) {
  const f = Object.fromEntries((h.factors || []).map(x => [x.key, x.score]));
  const now = Date.now();
  const kinds = new Map(city.files.map(x => [x.p.toLowerCase(), x.kind]));
  const rel = p => { const r = relOf(root, p); return r && SOURCE.has(kinds.get(r.toLowerCase())) ? r : null; };
  const ch = changes(pid, root);
  const litter = ch.isGit ? ch.files.filter(c => { const ts = Math.max(0, ...c.writers.map(w => w.ts)); return ts && now - ts > DAY; }).map(c => c.p).slice(0, 200) : [];
  return {
    smog: f.efficiency == null ? 0 : Math.max(0, Math.min(1, (70 - f.efficiency) / 60)),
    light: f.shipping == null ? 0.5 : f.shipping / 100,
    rundown: churnQ.all(pid, now - WEEK).map(r => rel(r.p)).filter(Boolean).slice(0, 200),
    litter,
    cones: collidedQ.all(pid, now - WEEK).map(r => r.path).filter(Boolean).slice(0, 100),
  };
}

// Cosmetics are earned by milestones and never touch the score.
const COSMETICS = [
  { key: 'sign', label: 'City name sign', by: 'first-commit' },
  { key: 'landmark', label: 'Landmark spire', by: 'commits-100' },
  { key: 'fireworks', label: 'Fireworks on commits', by: 'streak-7' },
  { key: 'snow', label: 'Snowfall', by: 'week-80' },
  { key: 'aurora', label: 'Aurora sky', by: 'streak-30' },
  { key: 'gold', label: 'Golden spire', by: 'commits-1000' },
];
export function cosmetics(pid, h) {
  const got = new Set((h.milestones || []).filter(m => m.got).map(m => m.key));
  const lab = Object.fromEntries((h.milestones || []).map(m => [m.key, m.label]));
  const set = kvGet('cosmetics:' + pid) || {};
  return COSMETICS.map(c => ({ key: c.key, label: c.label, unlock: lab[c.by] || c.by, unlocked: got.has(c.by), on: got.has(c.by) && set[c.key] !== false }));
}
export function setCosmetic(pid, key, on) {
  const set = kvGet('cosmetics:' + pid) || {};
  set[key] = !!on; kvSet('cosmetics:' + pid, set);
}
