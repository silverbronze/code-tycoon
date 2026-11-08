// Live session state and multi-session alerts. Fed by hooks (instant) and by
// transcript tailing (a few hundred ms later, and the only source when hooks are
// not installed). Hook events are matched to transcript items by tool_use_id so
// each action is broadcast once.
import { db } from './db.mjs';
import { projectId, key } from './paths.mjs';
import { toolItems } from './transcript.mjs';

const OPEN_WINDOW = 2 * 3600e3;      // a session counts as open this long after its last sign of life
const COLLISION_WINDOW = 30 * 60e3;  // two writes to one file within this window collide
const OVERLAP_WINDOW = 10 * 60e3;

export const sessions = new Map(); // id -> live record
const recentWrites = new Map();    // pid|path -> [{sid, ts}]
const recentArea = new Map();      // pid|module -> Map(sid -> {ts, wrote})
const alertSeen = new Map();       // dedupe key -> ts
const hookTuids = new Map();       // tuid -> ts (seen via hook)
let listeners = [];
export function onLive(fn) { listeners.push(fn); }
let decorate = null; // extra per-session facts for the cards (analytics.mjs)
export function decorateSessions(fn) { decorate = fn; }
function emit(msg) { for (const l of listeners) l(msg); }

const slugToProject = () => new Map(db.prepare('SELECT slug, project_id FROM transcripts GROUP BY slug').all().map(r => [r.slug.toLowerCase(), r.project_id]));
let slugCache = null, slugCacheAt = 0;
function projectFor(transcriptPath, cwd) {
  if (transcriptPath) {
    if (Date.now() - slugCacheAt > 30e3) { slugCache = slugToProject(); slugCacheAt = Date.now(); }
    const parts = String(transcriptPath).replace(/\\/g, '/').split('/');
    const i = parts.findIndex(p => p.toLowerCase() === 'projects');
    const pid = i >= 0 && slugCache.get((parts[i + 1] || '').toLowerCase());
    if (pid) return pid;
  }
  return cwd ? projectId(cwd) : null;
}

function rec(sid, pid) {
  let s = sessions.get(sid);
  if (!s) {
    const row = db.prepare('SELECT title, project_id, last_prompt, last_ts, last_stop, last_kind, hook_ts FROM sessions WHERE id=?').get(sid);
    // a session that reported through hooks before a server restart still has them
    s = { id: sid, pid: pid || row?.project_id || null, title: row?.title || null, state: 'working', since: Date.now(),
      lastSeen: row?.last_ts || Date.now(), prompt: row?.last_prompt || null, action: null, needs: null,
      hooks: !!row?.hook_ts && Date.now() - row.hook_ts < OPEN_WINDOW, agents: {} };
    sessions.set(sid, s);
  }
  if (pid && !s.pid) s.pid = pid;
  return s;
}

function setState(s, state, extra = {}) {
  const changed = s.state !== state;
  Object.assign(s, extra);
  if (changed && s.state === 'needs-you') resolveNeeds(s.id);
  if (changed) { s.state = state; s.since = Date.now(); }
  s.lastSeen = Date.now();
  emit({ type: 'session', session: publicSession(s) });
}

export function publicSession(s) {
  return { id: s.id, pid: s.pid, title: s.title, state: s.state, since: s.since, lastSeen: s.lastSeen, prompt: s.prompt,
    action: s.action, needs: s.needs, hooks: s.hooks, agents: Object.values(s.agents).filter(a => Date.now() - a.ts < 15 * 60e3),
    health: decorate ? decorate(s) : null };
}

export function openSessions(pid) {
  const now = Date.now();
  // sessions with recent transcript activity that we have not heard from this run
  const rows = db.prepare('SELECT id, project_id, title, last_ts, last_stop, last_kind, last_prompt FROM sessions WHERE last_ts > $since AND ($pid IS NULL OR project_id = $pid)')
    .all({ since: now - OPEN_WINDOW, pid: pid ?? null });
  for (const r of rows) if (!sessions.has(r.id) && r.last_stop !== 'ended') {
    const s = rec(r.id, r.project_id);
    s.lastSeen = r.last_ts;
    s.state = r.last_kind === 'assistant' && r.last_stop === 'end_turn' ? 'waiting' : now - r.last_ts < 3 * 60e3 ? 'working' : 'idle';
    s.since = r.last_ts;
  }
  return [...sessions.values()]
    .filter(s => (!pid || s.pid === pid) && s.state !== 'ended' && now - s.lastSeen < OPEN_WINDOW)
    .map(publicSession);
}

// --- alerts -------------------------------------------------------------
export function alertOnce(k, ttl, alert) {
  const t = alertSeen.get(k);
  if (t && Date.now() - t < ttl) return;
  alertSeen.set(k, Date.now());
  raise(alert);
}
// Every alert is kept until dismissed, so one missed while away is still there.
function raise(alert) {
  const ts = Date.now();
  const id = Number(db.prepare('INSERT INTO alerts(project_id, kind, ts, text, sessions, path, module) VALUES(?,?,?,?,?,?,?)')
    .run(alert.pid || null, alert.kind, ts, alert.text, JSON.stringify(alert.sessions), alert.path || null, alert.module ?? null).lastInsertRowid);
  emit({ type: 'alert', alert: { ...alert, id, ts } });
}
// "Needs you" is over once the session moves on.
function resolveNeeds(sid) {
  const rows = db.prepare("SELECT id, project_id FROM alerts WHERE kind='needs-you' AND resolved=0 AND sessions=?").all(JSON.stringify([sid]));
  if (!rows.length) return;
  db.prepare("UPDATE alerts SET resolved=1 WHERE kind='needs-you' AND resolved=0 AND sessions=?").run(JSON.stringify([sid]));
  for (const r of rows) emit({ type: 'alert-resolved', id: r.id, pid: r.project_id });
}

export function alertRow(r) {
  return { id: r.id, kind: r.kind, pid: r.project_id, ts: r.ts, text: r.text, sessions: JSON.parse(r.sessions || '[]'),
    path: r.path, module: r.module, dismissed: !!r.dismissed, resolved: !!r.resolved };
}
// a session's card changed for reasons other than its state (new outcomes)
export function touchSession(sid) { const s = sessions.get(sid); if (s && s.state !== 'ended') emit({ type: 'session', session: publicSession(s) }); }
export function listAlerts(pid, limit = 100) {
  return db.prepare('SELECT * FROM alerts WHERE ($pid IS NULL OR project_id=$pid) AND dismissed=0 ORDER BY ts DESC LIMIT $limit')
    .all({ pid: pid ?? null, limit }).map(alertRow);
}
export function dismissAlerts(ids, pid) {
  if (ids) for (const id of ids) db.prepare('UPDATE alerts SET dismissed=1 WHERE id=?').run(id);
  else db.prepare('UPDATE alerts SET dismissed=1 WHERE ($pid IS NULL OR project_id=$pid)').run({ pid: pid ?? null });
  emit({ type: 'alerts-dismissed', ids: ids || null, pid: pid ?? null });
}

// Called for every live action that has been mapped to a place in a city.
export function trackPlace(pid, sid, kind, pathKey, moduleKey, label) {
  const now = Date.now();
  if (kind === 'write' && pathKey) {
    const k = pid + '|' + pathKey;
    const list = (recentWrites.get(k) || []).filter(w => now - w.ts < COLLISION_WINDOW && w.sid !== sid);
    const others = [...new Set(list.map(w => w.sid))].filter(o => isOpen(o));
    if (others.length) alertOnce('col|' + k + '|' + [sid, ...others].sort().join(','), COLLISION_WINDOW,
      { kind: 'collision', pid, sessions: [sid, ...others], path: pathKey, label, text: `${others.length + 1} sessions edited ${label}` });
    list.push({ sid, ts: now });
    recentWrites.set(k, list);
  }
  if (moduleKey != null && (kind === 'write' || kind === 'read' || kind === 'touch' || kind === 'search')) {
    const k = pid + '|' + moduleKey;
    const m = recentArea.get(k) || new Map();
    const prev = m.get(sid);
    m.set(sid, { ts: now, wrote: kind === 'write' || !!(prev && prev.wrote && now - prev.ts < OVERLAP_WINDOW) });
    for (const [o, v] of m) if (now - v.ts > OVERLAP_WINDOW || !isOpen(o)) m.delete(o);
    recentArea.set(k, m);
    const writers = [...m].filter(([, v]) => v.wrote);
    if (m.size >= 2 && writers.length >= 1) {
      const ids = [...m.keys()].sort();
      alertOnce('ovl|' + k + '|' + ids.join(','), OVERLAP_WINDOW,
        { kind: 'overlap', pid, sessions: ids, module: moduleKey, text: `${ids.length} sessions working in ${moduleKey || '(root)'}` });
    }
  }
}
function isOpen(sid) { const s = sessions.get(sid); return !s || (s.state !== 'ended' && Date.now() - s.lastSeen < OPEN_WINDOW); }

// --- inputs -------------------------------------------------------------
// Hook payloads (see hooks/visualizer-hook.mjs). Returns live items to animate.
export function onHook(h) {
  const sid = h.session_id; if (!sid) return [];
  const pid = projectFor(h.transcript_path, h.cwd);
  const s = rec(sid, pid);
  if (!s.hooks || Date.now() - (s.hookSaved || 0) > 10 * 60e3) {
    s.hookSaved = Date.now();
    db.prepare('UPDATE sessions SET hook_ts=? WHERE id=?').run(s.hookSaved, sid);
  }
  s.hooks = true;
  const ev = h.hook_event_name;
  const agentId = h.agent_id || null;
  switch (ev) {
    case 'SessionStart': setState(s, 'waiting', { needs: null }); return [];
    case 'UserPromptSubmit': {
      const p = String(h.prompt || '').slice(0, 300);
      setState(s, 'working', { prompt: p, needs: null, action: null });
      return [{ kind: 'prompt', ts: Date.now(), text: p, sessionId: sid, pid, live: 'hook' }];
    }
    case 'PreToolUse': {
      const items = toolItems({ name: h.tool_name, input: h.tool_input || {}, id: h.tool_use_id }, h.cwd);
      if (h.tool_use_id) hookTuids.set(h.tool_use_id, Date.now());
      const head = items[0];
      if (agentId) s.agents[agentId] = { id: agentId, type: h.agent_type || null, ts: Date.now() };
      setState(s, 'working', { needs: null, action: head ? { kind: head.kind, tool: h.tool_name, path: head.path || null, target: head.target || null, detail: head.detail || null, agentId } : null });
      return items.map(it => ({ ...it, ts: Date.now(), sessionId: sid, agentId, pid, live: 'hook' }));
    }
    case 'PostToolUse': case 'PostToolUseFailure': setState(s, 'working', { needs: null }); return [];
    case 'Notification': {
      const msg = String(h.message || '');
      const type = h.notification_type || (/permission/i.test(msg) ? 'permission_prompt' : /waiting for your input|idle/i.test(msg) ? 'idle_prompt' : 'other');
      if (type === 'permission_prompt' || type === 'elicitation_dialog') {
        const was = s.state;
        setState(s, 'needs-you', { needs: { type, msg } });
        if (was !== 'needs-you') raise({ kind: 'needs-you', pid, sessions: [sid], text: msg || 'Session needs your answer' });
      } else if (type === 'idle_prompt') setState(s, 'waiting', { needs: null });
      return [];
    }
    case 'Stop': setState(s, 'waiting', { action: null }); return [];
    case 'SubagentStop': if (agentId) delete s.agents[agentId]; emit({ type: 'session', session: publicSession(s) }); return [];
    case 'SessionEnd':
      // persisted so a server restart does not resurrect closed sessions; a resumed session overwrites last_stop
      db.prepare("UPDATE sessions SET last_stop='ended' WHERE id=?").run(sid);
      setState(s, 'ended', { action: null, needs: null }); return [];
  }
  return [];
}

// Items freshly parsed from a transcript. Drops the ones a hook already announced.
export function onTranscriptItems(pid, items) {
  const out = [];
  const now = Date.now();
  for (const [t, at] of hookTuids) if (now - at > 15 * 60e3) hookTuids.delete(t);
  for (const it of items) {
    if (now - it.ts > 10 * 60e3) continue; // backfill, not live
    const s = rec(it.sessionId, pid);
    if (!s.hooks) {
      // no hooks: approximate state from the transcript
      if (it.kind === 'prompt') setState(s, 'working', { prompt: it.text.slice(0, 300) });
      else setState(s, 'working', { action: { kind: it.kind, tool: it.tool, path: it.path || null, target: it.target || null, detail: it.detail || null, agentId: it.agentId } });
    }
    if (it.agentId) s.agents[it.agentId] = { id: it.agentId, ts: it.ts };
    if (it.tuid && hookTuids.has(it.tuid)) continue;
    if (it.kind === 'prompt' && s.hooks) continue;
    out.push({ ...it, pid, live: 'transcript' });
  }
  return out;
}

// Called after a transcript batch: refresh titles / end-of-turn for hookless sessions.
export function syncFromDb(sid) {
  const s = sessions.get(sid); if (!s) return;
  const r = db.prepare('SELECT title, last_stop, last_kind FROM sessions WHERE id=?').get(sid);
  if (!r) return;
  const titleChanged = r.title && r.title !== s.title;
  if (titleChanged) s.title = r.title;
  if (!s.hooks && r.last_kind === 'assistant' && r.last_stop === 'end_turn' && s.state === 'working') setState(s, 'waiting', { action: null });
  else if (titleChanged) emit({ type: 'session', session: publicSession(s) });
}

// Sessions go quiet without a SessionEnd when a window is closed.
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.state === 'working' && !s.hooks && now - s.lastSeen > 3 * 60e3) setState(s, 'idle');
    if (s.state !== 'ended' && now - s.lastSeen > OPEN_WINDOW) { s.state = 'ended'; emit({ type: 'session', session: publicSession(s) }); }
  }
}, 30e3).unref();

export { key };
