// Coaching on how sessions use the model: context size, prompt cache, compactions,
// model choice and tool output, each with what a different habit would have saved.
// One pass over a session's API calls (usage rows) gives its findings; the overview
// rolls them up for the whole machine or one project. Advice only, at API list
// prices (a subscription is not billed per token, but the same tokens count
// against its usage limits).
import { db } from './db.mjs';
import { rates } from './prices.mjs';

const DAY = 86400e3;
const BIG = 150e3, HUGE = 300e3;   // context sizes worth a word
const HANDOFF = 3000;              // tokens a short handoff note adds to a fresh session
const BIG_RESULT = 40e3;
const SETUP = 40e3, HEAVY = 120e3;   // a usual starting context, and one worth flagging           // chars (~10k tokens) of one tool result
const TTL_1H = 3600e3, TTL_5M = 300e3;

const q = {
  rows: db.prepare('SELECT ts, model, tin, tout, tcr, tcw, tcw1h, cost, task_id FROM usage WHERE session_id=? AND agent IS NULL ORDER BY ts'),
  key: db.prepare('SELECT COUNT(*) n, MAX(ts) t, COALESCE(SUM(cost),0) c FROM usage WHERE session_id=?'),
  agents: db.prepare('SELECT COALESCE(SUM(cost),0) c, COUNT(DISTINCT agent) n FROM usage WHERE session_id=? AND agent IS NOT NULL'),
  compacts: db.prepare('SELECT ts, trigger, pre, post FROM compactions WHERE session_id=? ORDER BY ts'),
  paths: db.prepare(`SELECT task_id, lower(path) p FROM events WHERE session_id=? AND agent_id IS NULL AND path IS NOT NULL
    AND kind IN ('read','write','search') AND inferred=0 AND task_id IS NOT NULL`),
  tasks: db.prepare('SELECT id, ts, n_write, n_cmd, title, prompt FROM tasks WHERE session_id=? ORDER BY ts'),
  big: db.prepare(`SELECT ts, tool, path, detail, res_len, task_id FROM events WHERE session_id=? AND agent_id IS NULL AND res_len > ?
    AND kind IN ('read','search','cmd','remote','other') ORDER BY ts`),
  session: db.prepare(`SELECT s.id, s.project_id, s.title, s.last_prompt, s.first_ts, s.last_ts, p.name, p.root FROM sessions s
    LEFT JOIN projects p ON p.id=s.project_id WHERE s.id=?`),
  recent: db.prepare(`SELECT DISTINCT session_id id FROM usage WHERE ts > $since AND ($pid IS NULL OR project_id=$pid)`),
};

const k = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
const money = n => n >= 10 ? `$${Math.round(n)}` : n >= 0.1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
const span = ms => ms >= DAY ? `${Math.round(ms / DAY)}d` : ms >= 3600e3 ? `${Math.floor(ms / 3600e3)}h ${Math.round(ms % 3600e3 / 60e3)}m` : `${Math.round(ms / 60e3)}m`;
const ctxOf = r => r.tin + r.tcr + r.tcw;
// [input, output, cache read] per million tokens
function rate(model) { const r = rates(model); return r ? [r[0], r[1], r[2] ?? r[0] * 0.1] : null; }
const readUsd = (model, n) => (rate(model)?.[2] || 0) * n / 1e6;
const writeUsd = (model, n, long) => (rate(model)?.[0] || 0) * (long ? 2 : 1.25) * n / 1e6;
function costAt(r, R) { // one call re-priced at other rates
  const w5 = Math.max(0, r.tcw - (r.tcw1h || 0));
  return (r.tin * R[0] + r.tout * R[1] + r.tcr * R[2] + w5 * R[0] * 1.25 + (r.tcw1h || 0) * R[0] * 2) / 1e6;
}
const SONNET = rate('claude-sonnet-5-5');
const pricey = m => /opus|fable|mythos/i.test(m || '');

// the folder a path sits in, two levels deep from the project root: a rough "part of the code"
function area(p, root) {
  const r = root ? root.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '') + '/' : '';
  let s = p.replace(/\\/g, '/');
  if (r && s.startsWith(r)) s = s.slice(r.length); else if (r) return null; // outside the project
  const parts = s.split('/'); parts.pop();
  return parts.slice(0, 2).join('/') || '.';
}

// What each kind of finding asks of the user, as a habit.
export const HABITS = {
  'cold-resume': 'Coming back after the cache expired writes the whole context again. For a new task, open a fresh session; for the same task, run /compact before you step away so there is less to rewrite.',
  'big-context': 'Every turn re-reads the whole context. Keep sessions under ~150k tokens: /compact at a natural break, or start a new session for the next task.',
  'topic-switch': 'One session per topic. A task in another part of the code does not need the old context, but pays to re-read it on every turn.',
  'compacted': 'Automatic compaction means the session ran to the limit. Split long work into tasks with a fresh session each, or /compact yourself and say what to keep.',
  'model-switch': 'Pick the model when the session starts: switching mid-session writes the whole cache again under the new model.',
  'cache-reset': 'The cached prefix changed mid-session (tools, MCP servers or settings changed), so the whole context was written again. Change setup between sessions, not during one.',
  'model-fit': 'Read-only work (lookups, explanations, reviews) runs fine on Sonnet. Keep Opus or Fable for tasks that change code.',
  'big-results': 'Large tool output stays in context for every later turn. Read files with offset/limit, pipe long logs through tail, or let a subagent explore and report back.',
  'heavy-start': 'Every turn starts with this many tokens before your first word: system prompt, tool definitions, MCP servers, CLAUDE.md and memory. Turn off servers this project does not use.',
};
// Concrete steps that keep each one from happening again.
export const STEPS = {
  'cold-resume': ['Before a break longer than the cache lasts, run /compact so less is written again on return.',
    'Coming back to something new? Start a fresh session and paste a two-line handoff instead of resuming.',
    'For long, interrupted work, a 1-hour cache (where available) outlives short breaks.'],
  'big-context': ['Watch the context meter: at ~150k, /compact with a note on what to keep.',
    'End a session when its task is done; the next task starts lean.',
    'Send exploration (searching, reading many files) to a subagent so only its summary lands in context.'],
  'topic-switch': ['When the next prompt is about another part of the code, open a new session.',
    'Keep a short handoff note (CLAUDE.md or a scratch file) so a fresh session needs no history.'],
  'compacted': ['Run /compact yourself at a natural break and say what to keep, before the limit forces it.',
    'Plan long work as a list of tasks and give each its own session.'],
  'model-switch': ['Choose the model with /model at the start of a session, not halfway.',
    'Need a second opinion from another model? Ask it in a new session with a short summary.'],
  'cache-reset': ['Add or remove MCP servers, tools and settings between sessions, not during one.',
    'Edits to CLAUDE.md or memory mid-session change the cached prefix too; batch them for later.'],
  'model-fit': ['Use Sonnet for questions, lookups, reviews and explanations; switch to Opus or Fable in a new session for the change.',
    'Set a cheaper default model and pick the big one on purpose.'],
  'big-results': ['Read files with offset/limit, and grep before reading whole files.',
    'Pipe long command output through tail or head, or filter it to the lines that matter.',
    'Let a subagent explore and report a summary back.'],
  'heavy-start': ['Disable MCP servers this project does not use (/mcp).',
    'Trim CLAUDE.md and memory to what every session needs; move the rest into files read on demand.'],
};
export const LABEL = { 'cold-resume': 'Cold resume', 'big-context': 'Large context', 'topic-switch': 'New topic, old session', 'compacted': 'Auto-compacted',
  'model-switch': 'Model switched', 'cache-reset': 'Cache rebuilt', 'model-fit': 'Pricier model than needed', 'big-results': 'Bulky tool output', 'heavy-start': 'Heavy start' };

const cache = new Map(); // sid -> { key, v }
// after a backfill: compactions and result sizes changed without new API calls
export function resetCoach() { cache.clear(); rollCache.clear(); }

// Everything about one session's use of context and cache. null when it made no API calls.
export function analyzeSession(sid) {
  const key = q.key.get(sid);
  if (!key.n) return null;
  const kstr = key.n + ':' + key.t;
  const hit = cache.get(sid);
  if (hit && hit.key === kstr) return hit.v;
  const v = analyze(sid, key.c);
  cache.set(sid, { key: kstr, v });
  return v;
}

function analyze(sid, totalCost) {
  const s = q.session.get(sid);
  const rows = q.rows.all(sid);
  if (!s || !rows.length) return null;
  const tasks = q.tasks.all(sid), compacts = q.compacts.all(sid), agents = q.agents.get(sid);
  const findings = [], marks = [];
  const long = rows.some(r => r.tcw1h > 0), ttl = long ? TTL_1H : TTL_5M;
  const ctxs = rows.map(ctxOf);
  const byTask = new Map();
  for (const r of rows) if (r.task_id) (byTask.get(r.task_id) || byTask.set(r.task_id, []).get(r.task_id)).push(r);
  const base = Math.min(...ctxs.slice(0, 3));
  const model = rows[rows.length - 1].model;
  let sumCtx = 0, sumRead = 0;
  for (const r of rows) { sumCtx += ctxOf(r); sumRead += r.tcr; }
  const promptIn = (a, b) => tasks.some(t => t.ts > a && t.ts <= b);
  const compactIn = (a, b) => compacts.some(c => c.ts > a && c.ts <= b);
  // the prompts a finding happened in, by title
  const taskName = new Map(tasks.map(t => [t.id, clip(t.title || t.prompt, 90)]));
  const taskAt = ts => { let id = null; for (const t of tasks) { if (t.ts > ts) break; id = t.id; } return id; };
  const names = ids => [...new Set(ids.filter(Boolean))].map(id => taskName.get(id)).filter(Boolean);

  // 2, 6: the cache written again from scratch
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i], p = rows[i - 1], ctx = ctxs[i], gap = r.ts - p.ts;
    if (ctx < 30e3 || r.tcw < ctx * 0.5 || compactIn(p.ts, r.ts)) continue;
    const rewrite = writeUsd(r.model, r.tcw, r.tcw1h > r.tcw / 2), asRead = readUsd(r.model, r.tcw);
    if (gap > ttl && promptIn(p.ts, r.ts)) {
      const fresh = writeUsd(r.model, base + HANDOFF, long);
      if (rewrite - fresh < 0.1) continue; // a fresh session would start almost as big: the lesson is the heavy start
      findings.push({ kind: 'cold-resume', ts: r.ts, lost: rewrite - asRead, save: Math.max(0, rewrite - fresh),
        text: `Back after ${span(gap)}: the cache had expired, so ${k(ctx)} tokens of context were written again for ${money(rewrite)}.`,
        fix: `A fresh session with a short handoff would have started at about ${k(base + HANDOFF)} tokens (${money(fresh)}).` });
    } else if (gap <= ttl && r.model !== p.model) {
      findings.push({ kind: 'model-switch', ts: r.ts, lost: rewrite - asRead, save: rewrite - asRead,
        text: `Switched from ${p.model} to ${r.model} with ${k(ctx)} tokens in context: the cache started over (${money(rewrite)}).`,
        fix: 'Start a new session for the other model, or pick it before the context grows.' });
    } else if (gap <= ttl && r.tcr < ctxs[i - 1] * 0.3) {
      findings.push({ kind: 'cache-reset', ts: r.ts, lost: rewrite - asRead, save: rewrite - asRead,
        text: `The cache was rebuilt mid-session without a break: ${k(r.tcw)} tokens written again (${money(rewrite)}).`,
        fix: 'Something in the prompt prefix changed (tools, MCP servers, settings). Change those between sessions.' });
    }
  }

  // 3: a large context, re-read on every turn
  const heavy = rows.filter((r, i) => ctxs[i] > BIG);
  if (heavy.length >= 3) {
    const maxCtx = Math.max(...ctxs);
    const extra = heavy.reduce((a, r) => a + readUsd(r.model, ctxOf(r) - BIG), 0);
    const lastBig = heavy[heavy.length - 1];
    findings.push({ kind: 'big-context', ts: heavy[0].ts, lost: extra, save: extra, tasks: names(heavy.map(r => r.task_id || taskAt(r.ts))),
      text: `${heavy.length} turns ran with more than ${k(BIG)} tokens in context (peak ${k(maxCtx)}); at that size each turn costs about ${money(readUsd(lastBig.model, ctxOf(lastBig)))} just to re-read it.`,
      fix: `Keeping it under ${k(BIG)} with /compact or a fresh session would have saved about ${money(extra)}.` });
  }

  // 5: automatic compactions
  const auto = compacts.filter(c => c.trigger === 'auto');
  for (const c of compacts) marks.push({ ts: c.ts, kind: 'compact', pre: c.pre, post: c.post });
  if (auto.length) {
    const before = rows.filter(r => auto.some(c => r.ts <= c.ts && c.ts - r.ts < 30 * 60e3) && ctxOf(r) > BIG);
    const extra = before.reduce((a, r) => a + readUsd(r.model, ctxOf(r) - BIG), 0);
    findings.push({ kind: 'compacted', ts: auto[0].ts, lost: 0, save: 0, tasks: names(auto.map(c => taskAt(c.ts))),
      text: `Compacted automatically ${auto.length}× at about ${k(Math.max(...auto.map(c => c.pre)))} tokens, dropping ${k(auto.reduce((a, c) => a + c.pre - c.post, 0))} tokens of history it had paid to carry.`,
      fix: extra > 0.01 ? `The half hour before each compaction spent ${money(extra)} re-reading context above ${k(BIG)}.` : 'Splitting the work keeps what matters instead of an automatic summary.' });
  }

  // 4: a new part of the code in a session full of another
  const areas = new Map();
  for (const e of q.paths.all(sid)) { const a = area(e.p, s.root); if (!a) continue; (areas.get(e.task_id) || areas.set(e.task_id, new Set()).get(e.task_id)).add(a); }
  const seen = [];
  for (const t of tasks) {
    const mine = areas.get(t.id);
    if (!mine?.size) continue;
    const prev = new Set(seen.slice(-4).flatMap(x => [...x]));
    seen.push(mine);
    if (seen.length < 2) continue;
    const known = [...mine].filter(a => prev.has(a)).length / mine.size;
    const calls = byTask.get(t.id) || [];
    if (!calls.length || known >= 0.2) continue;
    const start = ctxOf(calls[0]);
    if (start < 60e3) continue;
    const carry = start - base - HANDOFF;
    const save = calls.reduce((a, r) => a + readUsd(r.model, carry), 0) - writeUsd(calls[0].model, base + HANDOFF, long);
    if (save <= 0) continue;
    findings.push({ kind: 'topic-switch', ts: t.ts, task: t.id, lost: save, save,
      text: `“${clip(t.title || t.prompt, 70)}” worked in ${[...mine].slice(0, 3).join(', ')}, which the session had not touched, yet carried ${k(start)} tokens of earlier work through ${calls.length} calls.`,
      fix: `In a fresh session this task would have cost about ${money(save)} less.` });
  }

  // 8: read-only tasks on the priciest models
  let fitSave = 0, fitN = 0;
  const fitIds = [];
  for (const t of tasks) {
    if (t.n_write > 0 || t.n_cmd > 3) continue;
    const calls = (byTask.get(t.id) || []).filter(r => pricey(r.model));
    if (!calls.length) continue;
    const now = calls.reduce((a, r) => a + r.cost, 0), alt = calls.reduce((a, r) => a + costAt(r, SONNET), 0);
    if (now - alt > 0.05) { fitSave += now - alt; fitN++; fitIds.push(t.id); }
  }
  if (fitSave > 0.25) findings.push({ kind: 'model-fit', ts: rows[0].ts, lost: fitSave, save: fitSave, tasks: names(fitIds),
    text: `${fitN} task${fitN === 1 ? '' : 's'} only read and answered, on ${model}.`,
    fix: `On Sonnet they would have cost about ${money(fitSave)} less.` });

  // 10: tool output that stays in context
  const big = q.big.all(sid, BIG_RESULT);
  if (big.length) {
    let tokens = 0, usd = 0;
    const by = new Map();
    for (const e of big) {
      const tk = Math.round(e.res_len / 4), nextC = compacts.find(c => c.ts > e.ts)?.ts ?? Infinity;
      const later = rows.filter(r => r.ts > e.ts && r.ts < nextC);
      const c = later.reduce((a, r) => a + readUsd(r.model, tk), 0);
      tokens += tk; usd += c;
      const what = e.tool === 'Read' && e.path ? 'Read ' + e.path.split('/').slice(-2).join('/') : (e.detail || e.tool || 'tool').slice(0, 60);
      const g = by.get(what) || { what, n: 0, tk: 0 }; g.n++; g.tk += tk; by.set(what, g);
    }
    const top = [...by.values()].sort((a, b) => b.tk - a.tk).slice(0, 3);
    if (usd > 0.05) findings.push({ kind: 'big-results', ts: big[0].ts, lost: usd, save: usd * 0.7, top, tasks: names(big.map(e => e.task_id || taskAt(e.ts))),
      text: `${big.length} tool result${big.length === 1 ? '' : 's'} added about ${k(tokens)} tokens, re-read on every later turn for ${money(usd)}. Largest: ${top.map(x => `${x.what} (${k(x.tk)}${x.n > 1 ? `, ${x.n}×` : ''})`).join('; ')}.`,
      fix: 'Ask for the part you need: line ranges, a tail of the log, a grep, or a subagent summary.' });
  }

  // 7: what every turn pays before the user types
  if (base > HEAVY && rows.length >= 5) {
    const usd = rows.reduce((a, r) => a + readUsd(r.model, base - SETUP), 0);
    findings.push({ kind: 'heavy-start', ts: rows[0].ts, lost: usd, save: usd, tasks: [],
      text: `The first turn already held ${k(base)} tokens; each of ${rows.length} turns re-read it.`,
      fix: `Each 10k tokens of setup trimmed would save about ${money(rows.reduce((a, r) => a + readUsd(r.model, 10e3), 0))} in a session like this.` });
  }

  for (const f of findings) f.tasks ??= names([f.task || taskAt(f.ts)]);
  for (const f of findings) if (!['big-context', 'heavy-start', 'model-fit', 'compacted'].includes(f.kind)) marks.push({ ts: f.ts, kind: f.kind });
  return {
    id: sid, pid: s.project_id, project: s.name, title: s.title || clip(s.last_prompt, 60) || sid.slice(0, 8),
    first: rows[0].ts, last: rows[rows.length - 1].ts, model, cost: totalCost, agentCost: agents.c, agents: agents.n,
    calls: rows.length, tasks: tasks.length, per10k: rows.reduce((a, r) => a + readUsd(r.model, 10e3), 0), hit: sumCtx ? sumRead / sumCtx : 0, base, peak: Math.max(...ctxs), ttl,
    compactions: compacts.length, findings: findings.sort((a, b) => b.save - a.save), marks, curve: curve(rows, ctxs),
    lost: findings.reduce((a, f) => a + f.lost, 0), save: findings.reduce((a, f) => a + f.save, 0),
  };
}

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// context size over the session, at most 160 points (the largest in each slot)
function curve(rows, ctxs) {
  const n = rows.length, step = Math.max(1, Math.ceil(n / 160)), out = [];
  for (let i = 0; i < n; i += step) {
    let m = i; for (let j = i; j < Math.min(n, i + step); j++) if (ctxs[j] > ctxs[m]) m = j;
    out.push([rows[m].ts, ctxs[m]]);
  }
  return out;
}

const rollCache = new Map(); // pid|days -> { at, v }
// Sessions active in the last `days`, across the machine or one project.
export function coach({ pid = null, days = 7 } = {}) {
  const ck = (pid || '*') + '|' + days, hit = rollCache.get(ck);
  if (hit && Date.now() - hit.at < 60e3) return hit.v;
  const since = Date.now() - days * DAY;
  const all = q.recent.all({ since, pid }).map(r => analyzeSession(r.id)).filter(Boolean);
  const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
  const roll = list => {
    const by = {};
    for (const s of list) for (const f of s.findings) { const b = by[f.kind] || (by[f.kind] = { kind: f.kind, n: 0, sessions: 0, lost: 0, save: 0 }); b.n++; b.lost += f.lost; b.save += f.save; }
    for (const b of Object.values(by)) b.sessions = list.filter(s => s.findings.some(f => f.kind === b.kind)).length;
    const calls = sum(list, s => s.calls);
    return { sessions: list.length, cost: sum(list, s => s.cost), calls,
      hit: calls ? sum(list, s => s.hit * s.calls) / calls : 0, save: sum(list, s => s.save), lost: sum(list, s => s.lost),
      compactions: sum(list, s => s.compactions), coldResumes: by['cold-resume']?.n || 0, coldLost: by['cold-resume']?.lost || 0,
      fitSave: by['model-fit']?.save || 0, bigShare: calls ? sum(list, s => s.findings.find(f => f.kind === 'big-context') ? s.calls : 0) / calls : 0,
      base: median(list.map(s => s.base)), per10k: sum(list, s => s.per10k), peak: Math.max(0, ...list.map(s => s.peak)),
      habits: Object.values(by).sort((a, b) => b.save - a.save).map(b => ({ ...b, label: LABEL[b.kind], habit: HABITS[b.kind], steps: STEPS[b.kind] || [] })) };
  };
  const byP = new Map();
  for (const s of all) (byP.get(s.pid) || byP.set(s.pid, []).get(s.pid)).push(s);
  const projects = [...byP].map(([id, list]) => ({ id, name: list[0].project || id, ...roll(list) }))
    .sort((a, b) => b.cost - a.cost);
  const totals = roll(all);
  const sessions = all.filter(s => s.findings.length || s.cost > 0.5).sort((a, b) => b.save - a.save || b.cost - a.cost)
    .slice(0, pid ? 80 : 40).map(({ curve, marks, ...s }) => s);
  const v = { days, pid, since, totals, projects, sessions, at: Date.now() };
  rollCache.set(ck, { at: Date.now(), v });
  return v;
}
const median = xs => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// --------------------------------------------------------------- live nudges
const lastMain = db.prepare('SELECT ts, model, tin, tcr, tcw, tcw1h FROM usage WHERE session_id=? AND agent IS NULL ORDER BY ts DESC LIMIT 1');
const firstMain = db.prepare('SELECT tin, tcr, tcw FROM usage WHERE session_id=? AND agent IS NULL ORDER BY ts LIMIT 3');
const hasLong = db.prepare('SELECT 1 FROM usage WHERE session_id=? AND tcw1h > 0 LIMIT 1');
const titleQ = db.prepare('SELECT title, last_prompt FROM sessions WHERE id=?');
const titleOf = sid => { const t = titleQ.get(sid); return t?.title || clip(t?.last_prompt, 50) || 'A session'; };

// A prompt just went in: if the cache has expired on a big context, it will all be written again.
export function onPrompt(sid, pid, raise) {
  const last = lastMain.get(sid);
  if (!last) return;
  const ctx = ctxOf(last), gap = Date.now() - last.ts;
  const long = !!hasLong.get(sid), ttl = long ? TTL_1H : TTL_5M;
  if (gap <= ttl || ctx < 50e3) return;
  const base = Math.min(...firstMain.all(sid).map(ctxOf));
  const rewrite = writeUsd(last.model, ctx, long), fresh = writeUsd(last.model, base + HANDOFF, long);
  raise(`cold|${sid}|${last.ts}`, DAY, { kind: 'cold-resume', pid, sessions: [sid],
    text: `${titleOf(sid)}: back after ${span(gap)}, the cache expired, so ${k(ctx)} tokens of context are being written again (~${money(rewrite)}).` +
      (rewrite - fresh >= 0.1 ? ` For a new task, a fresh session starts at ~${money(fresh)}.` : '') });
}

const alertedCompact = new Map(); // sid -> ts of the last compaction alerted
// After a turn: a large context, a session that moved to a new topic, an automatic compaction.
export function checkCoach(sid, pid, raise) {
  const a = analyzeSession(sid);
  if (!a) return;
  const level = a.peak >= HUGE ? 2 : a.peak >= BIG ? 1 : 0;
  const last = lastMain.get(sid), now = last ? ctxOf(last) : 0;
  if (level && now >= BIG) raise(`ctx|${sid}|${level}`, DAY, { kind: 'context-big', pid, sessions: [sid],
    text: `${a.title} is carrying ${k(now)} tokens; each turn costs ~${money(readUsd(last.model, now))} just to re-read it. /compact, or start a fresh session for the next task.` });
  const recent = Date.now() - 30 * 60e3;
  const t = a.findings.find(f => f.kind === 'topic-switch' && f.ts > recent);
  if (t) raise(`topic|${t.task}`, DAY, { kind: 'topic-switch', pid, sessions: [sid], text: `${a.title}: ${t.text} ${t.fix}` });
  const c = q.compacts.all(sid).filter(x => x.trigger === 'auto').pop();
  if (c && c.ts > recent && alertedCompact.get(sid) !== c.ts) {
    alertedCompact.set(sid, c.ts);
    raise(`compact|${sid}|${c.ts}`, DAY, { kind: 'compacted', pid, sessions: [sid],
      text: `${a.title} hit the context limit and compacted itself (${k(c.pre)} → ${k(c.post)} tokens). A fresh session for the next task keeps what you choose.` });
  }
}

// One session with its context curve, for the detail view.
export function sessionCoach(sid) { return analyzeSession(sid); }
