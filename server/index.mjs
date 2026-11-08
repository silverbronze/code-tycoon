import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { db } from './db.mjs';
import { PORT, PROJECTS_DIR, rel } from './paths.mjs';
import { CODEX_DIR, isCodexFile, codexCwd, codexSlug } from './codex.mjs';
import crypto from 'node:crypto';
import { discover, indexFile, indexProject, listProjects, setTracked, trackedSet, refreshProjectAgg, backfillUsage, backfillResults, backfillCoach } from './indexer.mjs';
import { buildCity, invalidateScan, KIND_INDEX, KINDS } from './citymap.mjs';
import { onHook, onTranscriptItems, onLive, openSessions, trackPlace, syncFromDb, sessions, listAlerts, dismissAlerts, alertOnce, decorateSessions, touchSession } from './live.mjs';
import { sessionHealth, checkSession, review, insights, look, cosmetics, setCosmetic, taskFlags, weekly, fileHistory } from './analytics.mjs';
import { pump, describeModules, onSummaries, summarizerStatus, summarizeDay } from './summarize.mjs';
import { changes, commitDetail, digest, saveDigestSummary } from './insights.mjs';
import { health } from './health.mjs';
import { VIS_DIR } from './paths.mjs';
import { systemLoad, processBreakdown } from './system.mjs';
import { scanIdle, idleSummary, stopIdle } from './idle.mjs';
import { coach, sessionCoach, onPrompt, checkCoach, resetCoach } from './coach.mjs';
import { onOptimize, getJob, projectModel, survey, apply, stop as stopOptimize, undo as undoOptimize } from './optimize.mjs';
import { hooksInstalled, setHooks } from './hooks-install.mjs';
import { onDomain, domainView, build as buildDomain, stop as stopDomain, brief, dropBrief, settleInterrupted, watchCommits, checkCommits, setAuto } from './domain.mjs';
import { autostartSupported, autostartInstalled, setAutostart } from './autostart.mjs';

// Shared secret the hook sends, so no web page can post fake activity to /hook.
const TOKEN_FILE = path.join(VIS_DIR, 'token');
let TOKEN = '';
try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
if (!TOKEN) { TOKEN = crypto.randomBytes(24).toString('hex'); fs.writeFileSync(TOKEN_FILE, TOKEN); }

// Only this machine's own pages may talk to the server: a foreign Host header is
// DNS rebinding, a foreign Origin is another site in the browser.
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
function allowed(req) {
  if (!LOCAL_HOST.test(req.headers.host || '')) return false;
  const o = req.headers.origin;
  return !o || LOCAL_ORIGIN.test(o);
}

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
let discovered = discover();
const cities = new Map(); // pid -> city (with resolveTarget)
const indexing = new Map(); // pid -> progress

function city(pid, fresh = false) {
  if (fresh || !cities.has(pid)) {
    const c = buildCity(pid);
    if (c) {
      cities.set(pid, c);
      describeModules(pid, c.describe);
    }
  }
  return cities.get(pid);
}

// --- websocket fan-out ----------------------------------------------------
const clients = new Set();
function broadcast(msg, pid) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1 && (!pid || !c.pid || c.pid === pid)) c.send(s);
}
// alerts go to every page (desktop notifications work from any view); pages filter by pid
// cards show how the session's current task is going
decorateSessions(s => { try { return sessionHealth(s.id); } catch { return null; } });
const lastState = new Map(); // sid -> state, to see a turn end
onLive(msg => {
  if (msg.type === 'session') {
    const s = msg.session, was = lastState.get(s.id);
    lastState.set(s.id, s.state);
    if (was === 'working' && s.state === 'waiting' && s.pid) setImmediate(() => {
      try { checkSession(s.id, s.pid, alertOnce, true); } catch (e) { console.warn('[analytics]', e.message); }
      try { checkCoach(s.id, s.pid, alertOnce); } catch (e) { console.warn('[coach]', e.message); }
      // backstop for the commit watcher: a turn that ended may have committed
      checkCommits(s.pid);
    });
  }
  if (msg.type === 'alert' || msg.type === 'alert-resolved' || msg.type === 'alerts-dismissed') broadcast({ ...msg, pid: msg.pid ?? msg.alert?.pid ?? null });
  else broadcast(msg, msg.session?.pid);
});
onSummaries(msg => {
  if (msg.type === 'subsys') { cities.delete(msg.pid); broadcast({ type: 'city-changed', pid: msg.pid }, msg.pid); }
  else broadcast(msg, msg.pid);
});
onOptimize(msg => broadcast(msg, msg.pid));
settleInterrupted();
onDomain(msg => broadcast(msg, msg.pid));

// Live items -> city places -> clients
function fanOut(pid, items) {
  const c = cities.get(pid);
  const out = [];
  let unknownWrite = false;
  for (const it of items) {
    let tt = -1, ti = -1;
    if (c && it.kind !== 'prompt') {
      [tt, ti] = c.resolveTarget({ kind: it.kind, path: it.path, target: it.target });
      if (it.kind === 'write' && tt !== 0 && it.path && rel(c.project.root, it.path) != null) unknownWrite = true;
      const modKey = tt === 0 ? c.modules[c.files[ti].m].id : tt === 1 ? c.modules[ti].id : null;
      trackPlace(pid, it.sessionId, it.kind, tt === 0 ? c.files[ti].p : null, modKey, tt === 0 ? c.files[ti].p : modKey);
    }
    out.push({ ts: it.ts, s: it.sessionId, a: it.agentId || null, k: KIND_INDEX[it.kind] ?? KIND_INDEX.other, tt, ti,
      task: it.taskId || null, tuid: it.tuid || null, d: it.detail || it.text?.slice(0, 200) || null, tool: it.tool || null, via: it.live });
  }
  if (out.length) broadcast({ type: 'events', pid, events: out }, pid);
  if (unknownWrite) scheduleRebuild(pid);
}

const rebuildTimers = new Map();
function scheduleRebuild(pid) {
  clearTimeout(rebuildTimers.get(pid));
  rebuildTimers.set(pid, setTimeout(() => {
    invalidateScan(pid);
    city(pid, true);
    broadcast({ type: 'city-changed', pid }, pid);
  }, 4000));
}

// --- transcript watching ---------------------------------------------------
const pending = new Map();
function onTranscriptChange(file) {
  clearTimeout(pending.get(file));
  pending.set(file, setTimeout(() => {
    pending.delete(file);
    const codex = isCodexFile(file);
    const slug = codex ? codexCwd(file) && codexSlug(codexCwd(file)) : path.relative(PROJECTS_DIR, file).split(path.sep)[0];
    if (!slug) return;
    let pid = db.prepare('SELECT project_id FROM transcripts WHERE slug=? LIMIT 1').get(slug)?.project_id;
    if (!pid) { discovered = discover(); pid = [...discovered].find(([, p]) => p.slugs.has(slug))?.[0]; }
    if (!pid || !trackedSet().has(pid) || indexing.has(pid)) return;
    const all = indexFile(pid, file, slug);
    if (!all.length) return;
    refreshProjectAgg(pid);
    // outcomes of tool calls update the session's health, not the city
    const items = all.filter(i => i.kind !== 'result');
    const recent = new Set(all.filter(i => Date.now() - i.ts < 10 * 60e3 && (i.kind === 'result' || i.kind === 'write')).map(i => i.sessionId));
    for (const sid of recent) {
      try { checkSession(sid, pid, alertOnce); } catch (e) { console.warn('[analytics]', e.message); }
      touchSession(sid);
    }
    if (!items.length) return;
    const live = onTranscriptItems(pid, items);
    const sids = new Set(items.map(i => i.sessionId));
    for (const sid of sids) syncFromDb(sid);
    for (const it of items.filter(i => i.kind === 'prompt')) {
      const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(it.taskId);
      if (t) broadcast({ type: 'task', pid, task: taskOut(t) }, pid);
    }
    fanOut(pid, live);
    schedulePump();
    // the domain maps follow their projects' commits
    watchCommits(pid => city(pid));
  }, 250));
}
try {
  fs.watch(PROJECTS_DIR, { recursive: true }, (_, f) => { if (f && f.endsWith('.jsonl')) onTranscriptChange(path.join(PROJECTS_DIR, f)); });
} catch (e) { console.warn('fs.watch unavailable, polling only:', e.message); }
// Codex sessions; if the folder appears later, the periodic rescan below finds its files
try {
  if (fs.existsSync(CODEX_DIR)) fs.watch(CODEX_DIR, { recursive: true }, (_, f) => { if (f && f.endsWith('.jsonl')) onTranscriptChange(path.join(CODEX_DIR, f)); });
} catch (e) { console.warn('fs.watch on Codex sessions unavailable, polling only:', e.message); }
// fs.watch on Windows can miss appends to files held open by another process
let polls = 0;
setInterval(() => {
  for (const pid of trackedSet()) {
    for (const r of db.prepare('SELECT file, offset FROM transcripts WHERE project_id=?').all(pid)) {
      try { if (fs.statSync(r.file).size > r.offset) onTranscriptChange(r.file); } catch {}
    }
  }
  // new transcript files (a full rescan of ~/.claude/projects, so less often)
  if (polls++ % 6) return;
  const before = new Set(db.prepare('SELECT file FROM transcripts').all().map(r => r.file));
  discovered = discover();
  for (const pid of trackedSet()) for (const f of discovered.get(pid)?.files || []) if (!before.has(f.file)) onTranscriptChange(f.file);
}, 5000).unref();

let pumpTimer = null;
function schedulePump() { clearTimeout(pumpTimer); pumpTimer = setTimeout(() => pump([...trackedSet()]), 5000); }

// --- API -------------------------------------------------------------------
function taskOut(t, cost = 0) {
  return { id: t.id, s: t.session_id, ts: t.ts, end: t.end_ts, title: t.title && t.title !== '—' ? t.title : null,
    prompt: t.prompt.slice(0, 400), n: [t.n_read, t.n_write, t.n_cmd, t.n_remote, t.n_agent], cost: +cost.toFixed(4) };
}
const costBy = (col, pid) => new Map(db.prepare(`SELECT ${col} k, SUM(cost) c FROM usage WHERE project_id=? GROUP BY ${col}`).all(pid).map(r => [r.k, r.c]));

// Full session/task lists, and the events from `since` on (older ones load on demand).
function timeline(pid, since = 0) {
  const c = city(pid);
  const ss = db.prepare('SELECT * FROM sessions WHERE project_id=? AND first_ts IS NOT NULL ORDER BY first_ts').all(pid);
  const sIdx = new Map(ss.map((s, i) => [s.id, i]));
  const ags = db.prepare('SELECT a.* FROM agents a JOIN sessions s ON s.id=a.session_id WHERE s.project_id=? ORDER BY a.first_ts').all(pid);
  const aIdx = new Map(ags.map((a, i) => [a.id, i]));
  const ts = db.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY ts').all(pid);
  const tIdx = new Map(ts.map((t, i) => [t.id, i]));
  const ev = { ts: [], s: [], a: [], k: [], tt: [], ti: [], task: [] };
  const taskCost = costBy('task_id', pid), sessCost = costBy('session_id', pid);
  const older = since ? db.prepare('SELECT COUNT(*) n FROM events WHERE project_id=? AND ts < ?').get(pid, since).n : 0;
  for (const e of db.prepare('SELECT session_id, agent_id, task_id, ts, kind, path, target FROM events WHERE project_id=? AND ts >= ? ORDER BY ts').iterate(pid, since)) {
    const si = sIdx.get(e.session_id); if (si == null) continue;
    const [tt, ti] = c.resolveTarget(e);
    ev.ts.push(e.ts); ev.s.push(si); ev.a.push(e.agent_id ? aIdx.get(e.agent_id) ?? -1 : -1);
    ev.k.push(KIND_INDEX[e.kind] ?? KIND_INDEX.other); ev.tt.push(tt); ev.ti.push(ti); ev.task.push(e.task_id ? tIdx.get(e.task_id) ?? -1 : -1);
  }
  return {
    kinds: KINDS,
    sessions: ss.map(s => ({ id: s.id, title: s.title || s.last_prompt?.slice(0, 60) || s.id.slice(0, 8), first: s.first_ts, last: s.last_ts,
      prompts: s.prompts, branch: s.branch, entry: s.entrypoint, model: s.model, cost: +(sessCost.get(s.id) || 0).toFixed(4) })),
    agents: ags.map(a => ({ id: a.id, s: sIdx.get(a.session_id) ?? -1, desc: a.description, type: a.type, first: a.first_ts, last: a.last_ts })),
    tasks: ts.map(t => taskOut(t, taskCost.get(t.id))),
    events: ev, since, older,
  };
}

// Events before `before`, keyed by ids (the client's indexes may differ from ours).
function olderEvents(pid, before) {
  const c = city(pid);
  const ids = { s: [], a: [], task: [] }, idx = { s: new Map(), a: new Map(), task: new Map() };
  const at = (k, id) => { if (id == null) return -1; let i = idx[k].get(id); if (i == null) { i = ids[k].length; ids[k].push(id); idx[k].set(id, i); } return i; };
  const ev = { ts: [], s: [], a: [], k: [], tt: [], ti: [], task: [] };
  for (const e of db.prepare('SELECT session_id, agent_id, task_id, ts, kind, path, target FROM events WHERE project_id=? AND ts < ? ORDER BY ts').iterate(pid, before)) {
    const [tt, ti] = c.resolveTarget(e);
    ev.ts.push(e.ts); ev.s.push(at('s', e.session_id)); ev.a.push(at('a', e.agent_id)); ev.k.push(KIND_INDEX[e.kind] ?? KIND_INDEX.other);
    ev.tt.push(tt); ev.ti.push(ti); ev.task.push(at('task', e.task_id));
  }
  return { ids, events: ev };
}

const titlesOf = pid => Object.fromEntries(db.prepare('SELECT id, title, last_prompt FROM sessions WHERE project_id=?').all(pid).map(r => [r.id, r.title || (r.last_prompt || '').slice(0, 50)]));
const summarizing = new Set();

function taskDetail(id) {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  if (!t) return null;
  const evs = db.prepare('SELECT ts, kind, tool, path, target, detail, agent_id, inferred FROM events WHERE task_id=? ORDER BY ts LIMIT 2000').all(id);
  const cost = db.prepare('SELECT COALESCE(SUM(cost),0) c, COALESCE(SUM(tout),0) o, COALESCE(SUM(tin+tcr+tcw),0) i FROM usage WHERE task_id=?').get(id);
  return { ...taskOut(t, cost.c), prompt: t.prompt, events: evs, tokens: { in: cost.i, out: cost.o } };
}

function send(res, code, body, req) {
  const json = typeof body === 'string' ? body : JSON.stringify(body);
  const gz = json.length > 4096 && /gzip/.test(req.headers['accept-encoding'] || '');
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(gz ? { 'content-encoding': 'gzip' } : {}) });
  res.end(gz ? zlib.gzipSync(json, { level: 4 }) : json);
}

function readBody(req) {
  return new Promise(r => { let b = ''; req.on('data', d => { b += d; if (b.length > 5e6) req.destroy(); }); req.on('end', () => r(b)); });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  if (!allowed(req)) { res.writeHead(403).end(); return; }
  const u = new URL(req.url, 'http://x');
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (req.method === 'POST' && u.pathname === '/hook') {
      if (req.headers['x-visualizer-token'] !== TOKEN) { res.writeHead(403).end(); return; }
      const body = await readBody(req);
      res.writeHead(204).end();
      let h; try { h = JSON.parse(body); } catch { return; }
      if (h.cwd && /[\\/]\.visualizer[\\/]summarizer/i.test(h.cwd)) return;
      const items = onHook(h);
      const pid = sessions.get(h.session_id)?.pid;
      // a prompt on a big context whose cache has expired: say so while it is being written again
      if (pid && h.hook_event_name === 'UserPromptSubmit') try { onPrompt(h.session_id, pid, alertOnce); } catch (e) { console.warn('[coach]', e.message); }
      if (pid && items.length && trackedSet().has(pid)) { city(pid); fanOut(pid, items); }
      return;
    }
    if (parts[0] === 'api') {
      if (parts[1] === 'projects' && parts.length === 2) {
        const all = u.searchParams.get('all') === '1';
        const open = openSessions();
        const day0 = Date.now() - 14 * 86400e3;
        const sparkQ = db.prepare('SELECT CAST((ts - ?) / 86400000 AS INTEGER) d, COUNT(*) n FROM tasks WHERE project_id=? AND ts > ? GROUP BY d');
        const rows = listProjects(all).map(p => {
          let spark = null;
          if (p.tracked) { spark = new Array(14).fill(0); for (const r of sparkQ.all(day0, p.id, day0)) if (r.d >= 0 && r.d < 14) spark[r.d] = r.n; }
          return { ...p, spark, open: open.filter(s => s.pid === p.id).length,
            needs: open.filter(s => s.pid === p.id && s.state === 'needs-you').length, indexing: indexing.get(p.id) || null,
            cost14: p.tracked ? db.prepare('SELECT COALESCE(SUM(cost),0) c FROM usage WHERE project_id=? AND ts > ?').get(p.id, day0).c : null };
        });
        const names = new Map(db.prepare('SELECT id, name FROM projects').all().map(r => [r.id, r.name]));
        return send(res, 200, { projects: rows, summarizer: summarizerStatus(),
          sessions: open.map(s => ({ ...s, project: names.get(s.pid) || null, tracked: trackedSet().has(s.pid) })) }, req);
      }
      // the same top-line numbers on every page, plus how hard the machine is working
      // what one of those numbers is made of
      if (parts[1] === 'pulse' && parts[2]) {
        const k = parts[2];
        if (k === 'sessions' || k === 'needs') {
          const names = new Map(db.prepare('SELECT id, name FROM projects').all().map(r => [r.id, r.name]));
          const open = openSessions().filter(s => k === 'sessions' || s.state === 'needs-you');
          return send(res, 200, { kind: k, sessions: open.map(s => ({ ...s, project: names.get(s.pid) || null, tracked: trackedSet().has(s.pid) })) }, req);
        }
        if (k === 'tracked') {
          const open = openSessions(), t = trackedSet();
          return send(res, 200, { kind: k, projects: listProjects(true).filter(p => t.has(p.id)).map(p => ({ id: p.id, name: p.name, root: p.root,
            sessions: p.sessions, prompts: p.prompts, last_ts: p.last_ts, open: open.filter(s => s.pid === p.id).length })) }, req);
        }
        if (k === 'node' || k === 'claude') {
          const [d, idle] = await Promise.all([processBreakdown(k), scanIdle()]);
          return send(res, 200, { ...d, idle }, req);
        }
        if (k === 'cpu' || k === 'ram') return send(res, 200, await processBreakdown(k), req);
        return send(res, 404, { error: 'unknown' }, req);
      }
      if (parts[1] === 'pulse') {
        const open = openSessions();
        return send(res, 200, { open: open.length, needs: open.filter(s => s.state === 'needs-you').length,
          tracked: trackedSet().size, summarizer: summarizerStatus(), system: systemLoad(), idle: idleSummary() }, req);
      }
      // stop idle Claude Code processes; JSON only, so a plain form from another page cannot reach it
      if (parts[1] === 'procs' && parts[2] === 'stop' && req.method === 'POST') {
        if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'json only' }, req);
        const b = JSON.parse(await readBody(req) || '{}');
        if (!Array.isArray(b.pids) || !b.pids.length) return send(res, 400, { error: 'pids' }, req);
        return send(res, 200, await stopIdle(b.pids), req);
      }
      // first-run setup: Claude Code hooks for live updates, start at login. JSON only, like procs/stop
      if (parts[1] === 'setup') {
        if (req.method === 'POST') {
          if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'json only' }, req);
          const b = JSON.parse(await readBody(req) || '{}');
          try {
            if (typeof b.hooks === 'boolean') setHooks(b.hooks ? 'install' : 'uninstall');
            if (typeof b.autostart === 'boolean') setAutostart(b.autostart ? 'install' : 'uninstall');
          } catch (e) { return send(res, 500, { error: e.message }, req); }
        }
        return send(res, 200, { hooks: hooksInstalled(), autostart: autostartSupported() ? autostartInstalled() : null }, req);
      }
      // how sessions use context and cache, machine-wide or for one project (?pid=)
      if (parts[1] === 'coach') {
        if (parts[2] === 'session' && parts[3]) return send(res, 200, sessionCoach(parts[3]) || { error: 'not found' }, req);
        const days = Math.min(90, Math.max(1, Number(u.searchParams.get('days')) || 7));
        return send(res, 200, coach({ pid: u.searchParams.get('pid') || null, days }), req);
      }
      if (parts[1] === 'alerts') {
        if (req.method === 'POST' && parts[2] === 'dismiss') {
          const b = JSON.parse(await readBody(req) || '{}');
          dismissAlerts(Array.isArray(b.ids) ? b.ids.map(Number) : null, b.pid ?? null);
          return send(res, 200, { ok: true }, req);
        }
        return send(res, 200, { alerts: listAlerts(u.searchParams.get('pid')) }, req);
      }
      const pid = parts[2];
      if (parts[1] === 'projects' && pid) {
        const proj = db.prepare('SELECT * FROM projects WHERE id=?').get(pid);
        if (!proj) return send(res, 404, { error: 'unknown project' }, req);
        if (parts[3] === 'track' && req.method === 'POST') {
          setTracked(pid, true);
          if (!indexing.has(pid)) {
            indexing.set(pid, { done: 0, total: 1 });
            setImmediate(() => {
              try { indexProject(pid, discover(), (d, n) => indexing.set(pid, { done: d, total: n })); backfillUsage(pid); backfillResults(pid).then(() => backfillCoach(pid)).then(resetCoach).catch(e => console.warn('[results]', e.message)); }
              finally { indexing.delete(pid); cities.delete(pid); broadcast({ type: 'indexed', pid }); schedulePump(); }
            });
          }
          return send(res, 202, { ok: true }, req);
        }
        if (parts[3] === 'untrack' && req.method === 'POST') {
          setTracked(pid, false); cities.delete(pid);
          return send(res, 200, { ok: true }, req);
        }
        if (indexing.has(pid)) return send(res, 409, { indexing: indexing.get(pid) }, req);
        if (!proj.tracked) return send(res, 409, { untracked: true }, req);
        if (parts[3] === 'city') {
          const c = city(pid, u.searchParams.get('fresh') === '1');
          const { resolveTarget, describe, ...rest } = c;
          return send(res, 200, rest, req);
        }
        if (parts[3] === 'timeline') {
          const before = Number(u.searchParams.get('before'));
          if (before) return send(res, 200, olderEvents(pid, before), req);
          return send(res, 200, timeline(pid, Number(u.searchParams.get('since')) || 0), req);
        }
        if (parts[3] === 'changes') return send(res, 200, changes(pid, proj.root), req);
        if (parts[3] === 'health') {
          const hl = health(pid, proj.root);
          return send(res, 200, { ...hl, look: look(pid, proj.root, hl, city(pid)), cosmetics: cosmetics(pid, hl) }, req);
        }
        if (parts[3] === 'cosmetics' && req.method === 'POST') {
          const b = JSON.parse(await readBody(req) || '{}');
          setCosmetic(pid, String(b.key), !!b.on);
          return send(res, 200, { ok: true }, req);
        }
        if (parts[3] === 'review') return send(res, 200, review(pid, proj.root, city(pid)), req);
        if (parts[3] === 'insights') return send(res, 200, insights(pid, proj.root, city(pid)), req);
        if (parts[3] === 'taskflags') return send(res, 200, taskFlags(pid, proj.root, city(pid)), req);
        if (parts[3] === 'week') return send(res, 200, weekly(pid, proj.root), req);
        if (parts[3] === 'filehist') return send(res, 200, fileHistory(pid, proj.root, String(u.searchParams.get('p') || '')), req);
        if (parts[3] === 'commit') return send(res, 200, commitDetail(pid, proj.root, parts[4]) || { error: 'not found' }, req);
        if (parts[3] === 'digest') {
          const from = Number(u.searchParams.get('from')), to = Number(u.searchParams.get('to'));
          if (!from || !to) return send(res, 400, { error: 'from and to are required' }, req);
          const d = digest(pid, city(pid), from, to);
          // the written recap arrives later over the websocket
          const k = pid + ':' + from + ':' + d.tasks.length;
          if (!d.summary && d.tasks.length && u.searchParams.get('summarize') === '1') {
            d.summarizing = true;
            if (!summarizing.has(k)) {
              summarizing.add(k);
              summarizeDay(d, titlesOf(pid)).then(text => { saveDigestSummary(pid, d, text); broadcast({ type: 'digest', pid, from, text }, pid); })
                .catch(e => broadcast({ type: 'digest', pid, from, error: e.message }, pid)).finally(() => summarizing.delete(k));
            }
          }
          return send(res, 200, d, req);
        }
        // optimize a block (key m:<module key>) or district (d:<id>) with the project's model
        if (parts[3] === 'optimize') {
          if (req.method !== 'POST') { const key = String(u.searchParams.get('key') || ''); return send(res, 200, { model: projectModel(pid), job: getJob(pid, key) }, req); }
          if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'json only' }, req);
          const b = JSON.parse(await readBody(req) || '{}'), key = String(b.key || '');
          getJob(pid, key); // loads a saved plan, so it can be applied after a restart
          const r = parts[4] === 'survey' ? survey(pid, city(pid), key)
            : parts[4] === 'apply' ? apply(pid, city(pid), key, Array.isArray(b.items) ? b.items.map(String) : [], !!b.force)
            : parts[4] === 'stop' ? stopOptimize(pid, key)
            : parts[4] === 'undo' ? undoOptimize(pid, city(pid), key) : { error: 'unknown step' };
          return send(res, r.busy ? 409 : r.error ? 400 : 200, r, req);
        }
        // the domain map (server/domain.mjs): GET the map, POST build|update|stop, POST brief {task}, POST brief/drop {id}
        if (parts[3] === 'domain' || parts[3] === 'brief') {
          if (req.method !== 'POST') return send(res, 200, domainView(pid, city(pid)), req);
          if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'json only' }, req);
          const b = JSON.parse(await readBody(req) || '{}');
          const r = parts[3] === 'brief' ? (parts[4] === 'drop' ? dropBrief(pid, String(b.id || '')) : brief(pid, city(pid), b.task))
            : parts[4] === 'stop' ? stopDomain(pid) : parts[4] === 'auto' ? setAuto(pid, b.on !== false)
            : buildDomain(pid, city(pid), { update: parts[4] === 'update' });
          return send(res, r.error === 'busy' ? 409 : r.error ? 400 : 200, r, req);
        }
        if (parts[3] === 'live') return send(res, 200, { sessions: openSessions(pid) }, req);
        if (parts[3] === 'task') return send(res, 200, taskDetail(parts[4]) || { error: 'not found' }, req);
        if (parts[3] === 'file') {
          const p = u.searchParams.get('p');
          const root = proj.root;
          const full = (root + '/' + p);
          const rows = db.prepare(`SELECT e.task_id, e.session_id, MIN(e.ts) ts, GROUP_CONCAT(DISTINCT e.kind) kinds, t.title, t.prompt
            FROM events e LEFT JOIN tasks t ON t.id=e.task_id WHERE e.project_id=? AND lower(e.path)=lower(?)
            GROUP BY e.task_id ORDER BY ts DESC LIMIT 200`).all(pid, full);
          return send(res, 200, { path: p, tasks: rows.map(r => ({ id: r.task_id, s: r.session_id, ts: r.ts, kinds: r.kinds,
            title: r.title && r.title !== '—' ? r.title : null, prompt: (r.prompt || '').slice(0, 200) })) }, req);
        }
      }
      return send(res, 404, { error: 'not found' }, req);
    }
    // static (production build)
    let f = path.join(DIST, u.pathname === '/' ? 'index.html' : u.pathname);
    if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
    if (!fs.existsSync(f)) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('Run `npm run build` first, or use `npm run dev`.'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: e.message }, req);
  }
});

const wss = new WebSocketServer({ server, path: '/ws', verifyClient: ({ req }) => allowed(req) });
wss.on('error', () => {}); // ws re-emits the http server's errors; handled on `server` below
wss.on('connection', ws => {
  clients.add(ws);
  ws.on('message', m => { try { const j = JSON.parse(m); if (j.type === 'subscribe') ws.pid = j.pid || null; } catch {} });
  ws.on('close', () => clients.delete(ws));
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') { console.log(`Code Tycoon is already running on port ${PORT}`); process.exit(0); }
  throw e;
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Code Tycoon on http://127.0.0.1:${PORT}`);
  // catch up tracked projects that changed while we were down
  setImmediate(() => {
    for (const pid of trackedSet()) {
      indexing.set(pid, { done: 0, total: 1 });
      try { indexProject(pid, discovered, (d, n) => indexing.set(pid, { done: d, total: n })); } finally { indexing.delete(pid); }
    }
    schedulePump();
    for (const pid of trackedSet()) setImmediate(() => { try { backfillUsage(pid, discovered); } catch (e) { console.warn('[usage]', e.message); } });
    (async () => {
      for (const pid of trackedSet()) await backfillResults(pid, discovered).catch(e => console.warn('[results]', e.message));
      for (const pid of trackedSet()) await backfillCoach(pid, discovered).catch(e => console.warn('[coach]', e.message));
      resetCoach();
    })();
  });
});
