// City health: one 0-100 score per project from what Visualizer already records,
// plus commit streaks and milestones. It rewards work that lands (committed,
// cheap per landed task, few collisions), never raw activity.
import fs from 'node:fs';
import path from 'node:path';
import { db, kvGet, kvSet } from './db.mjs';
import { getScan } from './citymap.mjs';
import { changes } from './insights.mjs';

const DAY = 86400e3, WEEK = 7 * DAY;
const GRACE = 2 * 3600e3; // a task this fresh may still be committed; it only counts once it lands

const FACTORS = [
  { key: 'shipping', label: 'Shipping', weight: 0.3 },
  { key: 'tidiness', label: 'Tidiness', weight: 0.25 },
  { key: 'efficiency', label: 'Efficiency', weight: 0.2 },
  { key: 'harmony', label: 'Harmony', weight: 0.15 },
  { key: 'stability', label: 'Stability', weight: 0.1 },
];
const GRADES = [[85, 'thriving'], [70, 'healthy'], [50, 'fair'], [30, 'struggling'], [0, 'run-down']];

const clamp = x => Math.max(0, Math.min(100, Math.round(x)));
const dayKey = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const money = n => n >= 10 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;

// path -> time of the last commit that touched it, lower-cased, rebuilt when the scan is
const lastCommits = new WeakMap();
function lastCommitOf(scan) {
  let m = lastCommits.get(scan);
  if (!m) { m = new Map(); for (const c of scan.commits) for (const f of c.files) m.set(f.toLowerCase(), c.ts); lastCommits.set(scan, m); }
  return m;
}

const writesQ = db.prepare(`SELECT task_id, session_id, MIN(ts) ts, lower(path) p FROM events
  WHERE project_id=? AND kind='write' AND ts > ? AND task_id IS NOT NULL AND path IS NOT NULL GROUP BY task_id, lower(path)`);
const endQ = db.prepare('SELECT id, COALESCE(end_ts, ts) e FROM tasks WHERE project_id=? AND ts > ?');
const costQ = db.prepare('SELECT COALESCE(SUM(cost),0) c FROM usage WHERE project_id=? AND ts > ?');
const alertsQ = db.prepare("SELECT kind, COUNT(*) n FROM alerts WHERE project_id=? AND ts > ? AND kind IN ('collision','overlap') GROUP BY kind");

// Tasks that wrote committable files since `since`, and which of them landed in a later commit.
function landing(pid, root, scan, since, now) {
  const last = lastCommitOf(scan);
  const inv = new Set(scan.files.map(f => f.p.toLowerCase()));
  const prefix = root.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '') + '/';
  const ends = new Map(endQ.all(pid, since - DAY).map(r => [r.id, r.e]));
  const tasks = new Map(), fileSessions = new Map();
  for (const r of writesQ.all(pid, since)) {
    const p = r.p.replace(/\\/g, '/');
    if (!p.startsWith(prefix)) continue;
    const rel = p.slice(prefix.length);
    if (!inv.has(rel) && !last.has(rel)) continue; // ignored or scratch files are never committed
    const t = tasks.get(r.task_id) || { landed: false, files: 0 };
    t.files++;
    if ((last.get(rel) ?? 0) >= r.ts) t.landed = true;
    tasks.set(r.task_id, t);
    const s = fileSessions.get(rel) || new Set(); s.add(r.session_id); fileSessions.set(rel, s);
  }
  let landed = 0, counted = 0;
  for (const [id, t] of tasks) {
    if (t.landed) { landed++; counted++; }
    else if (now - (ends.get(id) ?? now) > GRACE) counted++;
  }
  return { landed, counted, fileSessions };
}

function compute(pid, root, now) {
  const scan = getScan(pid, root);
  const week = landing(pid, root, scan, now - WEEK, now);
  const month = landing(pid, root, scan, now - 30 * DAY, now);
  const f = {};

  // Shipping: share of writing tasks that ended in a commit
  f.shipping = !scan.isGit ? { score: null, value: 'Not a git repository' } : week.counted
    ? { score: clamp(100 * week.landed / week.counted), value: `${week.landed} of ${week.counted} tasks landed in a commit`,
      tip: 'Commit finished work; tasks whose edits never reach a commit pull this down.' }
    : { score: null, value: 'No writing tasks in the last 7 days' };

  // Tidiness: uncommitted files, weighted by how long they have sat
  const ch = scan.isGit ? changes(pid, root) : { isGit: false, files: [] };
  if (ch.isGit) {
    let penalty = 0, stale = 0;
    for (const c of ch.files) {
      let ts = Math.max(0, ...c.writers.map(w => w.ts));
      if (!ts) try { ts = fs.statSync(path.join(root, c.p)).mtimeMs; } catch { ts = now; }
      const hours = (now - ts) / 3600e3;
      if (hours > 24) stale++;
      penalty += 1 + 4 * Math.min(1, hours / 72);
    }
    f.tidiness = { score: clamp(100 / (1 + penalty / 25)),
      value: ch.files.length ? `${plural(ch.files.length, 'uncommitted file')}, ${stale} older than a day` : 'Working tree clean',
      tip: stale ? `${stale} files have sat uncommitted for over a day. Commit or discard them.` : 'Commit or discard the open changes.' };
  } else f.tidiness = { score: null, value: 'Not a git repository' };

  // Efficiency: cost per landed task this week against the project's own 30-day rate
  const costW = costQ.get(pid, now - WEEK).c, costM = costQ.get(pid, now - 30 * DAY).c;
  if (week.landed && month.landed && costW > 0) {
    const cur = costW / week.landed, base = costM / month.landed;
    f.efficiency = { score: clamp(75 + 25 * Math.log2(base / cur)), value: `${money(cur)} per landed task (30-day: ${money(base)})`,
      tip: 'Spend per landed task is above your usual. Smaller, well-scoped tasks land cheaper.' };
  } else f.efficiency = { score: null, value: week.landed ? 'No cost recorded this week' : 'Nothing landed this week to price' };

  // Harmony: sessions colliding on one file or crowding one area
  const al = Object.fromEntries(alertsQ.all(pid, now - WEEK).map(r => [r.kind, r.n]));
  const col = al.collision || 0, ov = al.overlap || 0;
  f.harmony = week.counted || col || ov
    ? { score: clamp(100 / (1 + 0.25 * col + 0.1 * ov)), value: col || ov ? `${plural(col, 'collision')}, ${plural(ov, 'overlap')} this week` : 'No collisions this week',
      tip: 'Sessions keep editing the same files. Split work by area before starting parallel sessions.' }
    : { score: null, value: 'No sessions this week' };

  // Stability: files rewritten by three or more sessions in a week
  const written = week.fileSessions.size;
  const churned = [...week.fileSessions.values()].filter(s => s.size >= 3).length;
  f.stability = written
    ? { score: clamp(100 * (1 - Math.min(1, 3 * churned / written))), value: `${churned} of ${written} written files reworked by 3+ sessions`,
      tip: 'A few files are rewritten again and again. Settle their design once.' }
    : { score: null, value: 'No files written this week' };

  const factors = FACTORS.map(d => ({ ...d, ...f[d.key] }));
  const live = factors.filter(x => x.score != null);
  const wsum = live.reduce((a, x) => a + x.weight, 0);
  const score = wsum ? clamp(live.reduce((a, x) => a + x.score * x.weight, 0) / wsum) : null;
  const weakest = live.filter(x => x.score < 80 && x.tip).sort((a, b) => a.score * a.weight - b.score * b.weight || a.score - b.score)[0];

  return { score, grade: score == null ? null : GRADES.find(([min]) => score >= min)[1], factors: factors.map(({ tip, ...x }) => x),
    tip: weakest?.tip || null, ...streaks(scan.commits, now), commits: scan.commits.length };
}

// consecutive local days with a commit; a streak is still alive until a whole day passes without one
function streaks(commits, now) {
  const days = new Set(commits.map(c => dayKey(c.ts)));
  const back = (d, n) => { const x = new Date(d); x.setDate(x.getDate() - n); return x.getTime(); };
  const today = days.has(dayKey(now));
  let current = 0;
  for (let i = today ? 0 : 1; days.has(dayKey(back(now, i))); i++) current++;
  let best = 0, run = 0, prev = null;
  for (const k of [...days].sort()) {
    const d = new Date(k + 'T12:00:00');
    run = prev && (d - prev) / DAY < 1.5 ? run + 1 : 1;
    best = Math.max(best, run); prev = d;
  }
  return { streak: { current, best, today } };
}

// a daily score per project, kept for the trend and the week-at-80 milestone
function remember(pid, score, now) {
  const k = `health:${pid}`;
  const h = kvGet(k) || {};
  if (score != null && h[dayKey(now)] !== score) {
    h[dayKey(now)] = score;
    for (const d of Object.keys(h).sort().slice(0, -90)) delete h[d];
    kvSet(k, h);
  }
  return Object.entries(h).sort(([a], [b]) => a.localeCompare(b)).map(([day, s]) => ({ day, score: s }));
}

function milestones(r, history) {
  let run = 0, week80 = false;
  for (const x of history) { run = x.score >= 80 ? run + 1 : 0; if (run >= 7) week80 = true; }
  const m = (key, label, have, need) => ({ key, label, got: have >= need, progress: Math.min(1, have / need), have, need });
  return [
    m('first-commit', 'First commit', r.commits, 1),
    m('commits-100', '100 commits', r.commits, 100),
    m('commits-1000', '1,000 commits', r.commits, 1000),
    m('streak-7', '7-day commit streak', r.streak.best, 7),
    m('streak-30', '30-day commit streak', r.streak.best, 30),
    m('healthy-80', 'Health 80 or more', r.score ?? 0, 80),
    m('week-80', 'A week at 80+', week80 ? 7 : run, 7),
  ];
}

const cache = new Map(); // pid -> { at, out }
export function health(pid, root) {
  const hit = cache.get(pid), now = Date.now();
  if (hit && now - hit.at < 10e3) return hit.out;
  const r = compute(pid, root, now);
  const history = remember(pid, r.score, now);
  const out = { ...r, history: history.slice(-30), milestones: milestones(r, history), at: now };
  cache.set(pid, { at: now, out });
  return out;
}
