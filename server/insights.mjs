// Questions asked of one project's working tree and history: which uncommitted
// files each session wrote, which tasks produced a commit, and what a day held.
import { execFileSync } from 'node:child_process';
import { db, kvGet, kvSet } from './db.mjs';
import { getScan } from './citymap.mjs';

function git(root, args) {
  return execFileSync('git', ['-C', root, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 15e3 });
}

// path -> time of the last commit that touched it
const lastCommitCache = new Map(); // pid -> { n, map }
function lastCommitOf(pid, root) {
  const scan = getScan(pid, root);
  let c = lastCommitCache.get(pid);
  if (!c || c.n !== scan.commits.length || c.scan !== scan) {
    const map = new Map();
    for (const cm of scan.commits) for (const f of cm.files) map.set(f.toLowerCase(), cm.ts);
    c = { n: scan.commits.length, scan, map };
    lastCommitCache.set(pid, c);
  }
  return c.map;
}

const writersQ = db.prepare(`SELECT session_id s, MAX(ts) ts, COUNT(*) n FROM events
  WHERE project_id=? AND kind='write' AND lower(path)=lower(?) AND ts > ? GROUP BY session_id ORDER BY ts DESC`);

// Uncommitted files and the sessions that wrote them since the file was last committed.
const changesCache = new Map(); // pid -> { at, out }
export function changes(pid, root) {
  const hit = changesCache.get(pid);
  if (hit && Date.now() - hit.at < 3000) return hit.out;
  let out = { isGit: false, files: [] };
  try {
    const raw = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const parts = raw.split('\0');
    const last = lastCommitOf(pid, root);
    const files = [];
    for (let i = 0; i < parts.length && files.length < 400; i++) {
      const e = parts[i]; if (e.length < 4) continue;
      const st = e.slice(0, 2), p = e.slice(3);
      if (st[0] === 'R' || st[0] === 'C') i++; // the next field is the old name
      const since = last.get(p.toLowerCase()) ?? 0;
      const writers = writersQ.all(pid, root + '/' + p, since).map(r => ({ s: r.s, ts: r.ts, n: r.n }));
      files.push({ p, st: st.trim() || st, writers });
    }
    out = { isGit: true, files };
  } catch {}
  changesCache.set(pid, { at: Date.now(), out });
  return out;
}

// The tasks behind a commit: the session that ran `git commit` near its time, and
// tasks that wrote its files in the two days before it.
export function commitDetail(pid, root, h) {
  const scan = getScan(pid, root);
  const c = scan.commits.find(x => x.h.startsWith(h) || h.startsWith(x.h));
  if (!c) return null;
  const committers = db.prepare(`SELECT DISTINCT session_id s FROM events WHERE project_id=? AND kind='cmd'
    AND ts BETWEEN ? AND ? AND detail LIKE '%git%commit%'`).all(pid, c.ts - 5 * 60e3, c.ts + 2 * 60e3).map(r => r.s);
  const byTask = new Map();
  const q = db.prepare(`SELECT task_id, COUNT(*) n FROM events WHERE project_id=? AND kind='write' AND lower(path)=lower(?)
    AND ts BETWEEN ? AND ? AND task_id IS NOT NULL GROUP BY task_id`);
  for (const f of c.files.slice(0, 200)) for (const r of q.all(pid, root + '/' + f, c.ts - 48 * 3600e3, c.ts + 60e3)) {
    const t = byTask.get(r.task_id) || { files: 0, n: 0 }; t.files++; t.n += r.n; byTask.set(r.task_id, t);
  }
  const tq = db.prepare('SELECT id, session_id s, ts, title, prompt FROM tasks WHERE id=?');
  const tasks = [...byTask].sort((a, b) => b[1].files - a[1].files || b[1].n - a[1].n).slice(0, 20).map(([id, v]) => {
    const t = tq.get(id); return t && { id, s: t.s, ts: t.ts, title: t.title && t.title !== '—' ? t.title : null, prompt: (t.prompt || '').slice(0, 200), files: v.files };
  }).filter(Boolean);
  return { h: c.h, ts: c.ts, s: c.s, files: c.files, tasks, committers };
}

// Facts for one stretch of time (normally a local day). `city` resolves places.
export function digest(pid, city, from, to) {
  const tasks = db.prepare('SELECT id, session_id, ts, title, prompt, n_write FROM tasks WHERE project_id=? AND ts BETWEEN ? AND ? ORDER BY ts').all(pid, from, to);
  const sessions = new Set(tasks.map(t => t.session_id));
  const modW = new Map(), fileBy = new Map();
  for (const e of db.prepare("SELECT session_id, kind, path, target FROM events WHERE project_id=? AND kind='write' AND ts BETWEEN ? AND ?").iterate(pid, from, to)) {
    sessions.add(e.session_id);
    const [tt, ti] = city.resolveTarget(e);
    const mi = tt === 0 ? city.files[ti].m : tt === 1 ? ti : -1;
    if (mi >= 0) modW.set(mi, (modW.get(mi) || 0) + 1);
    if (tt === 0) { const s = fileBy.get(ti) || new Set(); s.add(e.session_id); fileBy.set(ti, s); }
  }
  const name = r => r[0] === 1 ? (city.modules[r[1]].title || city.modules[r[1]].label) : city.externals[r[1]].label;
  const why = l => l.imp ? 'imports' : l.ref ? 'named in code' : l.commit >= 0.5 ? 'committed together' : 'worked on together';
  const ties = since => city.links.filter(l => l.born >= since && l.born <= to && (l.imp || l.ref || l.w >= 1.5))
    .sort((a, b) => b.w - a.w).slice(0, 15).map(l => ({ a: l.a, b: l.b, an: name(l.a), bn: name(l.b), why: why(l), born: l.born }));
  const cost = db.prepare('SELECT COALESCE(SUM(cost),0) c, COALESCE(SUM(tout),0) o FROM usage WHERE project_id=? AND ts BETWEEN ? AND ?').get(pid, from, to);
  return {
    from, to,
    tasks: tasks.map(t => ({ id: t.id, s: t.session_id, ts: t.ts, title: t.title && t.title !== '—' ? t.title : null, prompt: t.prompt.slice(0, 160), w: t.n_write })),
    sessions: [...sessions],
    modules: [...modW].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([i, n]) => ({ i, name: city.modules[i].title || city.modules[i].label, n })),
    shared: [...fileBy].filter(([, s]) => s.size > 1).map(([i, s]) => ({ i, p: city.files[i].p, sessions: [...s] })).slice(0, 20),
    commits: city.commits.filter(c => c.ts >= from && c.ts <= to).map(c => ({ h: c.h, ts: c.ts, s: c.s, n: c.n })),
    ties: ties(from), tiesWeek: ties(to - 7 * 86400e3),
    cost: cost.c, outTokens: cost.o,
    summary: kvGet(`digest:${pid}:${from}:${tasks.length}`)?.text || null,
  };
}
export function saveDigestSummary(pid, d, text) { kvSet(`digest:${pid}:${d.from}:${d.tasks.length}`, { text }); }
