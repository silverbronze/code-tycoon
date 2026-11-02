// Incremental transcript indexer: every transcript file is read from its saved
// byte offset, so the first run parses everything and later runs only new lines.
import fs from 'node:fs';
import path from 'node:path';
import { db, tx, kvGet, kvSet } from './db.mjs';
import { PROJECTS_DIR, SUMMARIZER_CWD, slugFor, norm, projectId, baseName, isTempPath } from './paths.mjs';
import { quickSkip, parseRecord, redact, toolResults, resultText, checkKind } from './transcript.mjs';
import { costOf } from './prices.mjs';

const SUMMARIZER_SLUG = slugFor(SUMMARIZER_CWD).toLowerCase();

// one-off: mask secrets in prompts indexed before redaction existed
if (!kvGet('redacted-v1')) {
  tx(() => {
    const up = db.prepare('UPDATE tasks SET prompt=? WHERE id=?');
    for (const r of db.prepare('SELECT id, prompt FROM tasks').all()) { const p = redact(r.prompt); if (p !== r.prompt) up.run(p, r.id); }
    const us = db.prepare('UPDATE sessions SET last_prompt=? WHERE id=?');
    for (const r of db.prepare('SELECT id, last_prompt FROM sessions WHERE last_prompt IS NOT NULL').all()) { const p = redact(r.last_prompt); if (p !== r.last_prompt) us.run(p, r.id); }
  });
  kvSet('redacted-v1', true);
}
const CHUNK = 8 * 1024 * 1024;

// Read the cwd a transcript folder belongs to from the head of its first file.
function folderCwd(dir, files) {
  for (const f of files.slice(0, 5)) {
    let fd;
    try {
      fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const m = /"cwd":"((?:[^"\\]|\\.)+)"/.exec(buf.toString('utf8', 0, n));
      if (m) return norm(JSON.parse('"' + m[1] + '"'));
    } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return null;
}

// Map every transcript folder to a project and refresh project byte totals.
export function discover() {
  const known = new Map(db.prepare('SELECT slug, project_id FROM transcripts GROUP BY slug').all().map(r => [r.slug, r.project_id]));
  const out = new Map(); // projectId -> {root, files:[]}
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return out; }
  for (const d of dirs) {
    if (d.name.toLowerCase() === SUMMARIZER_SLUG) continue;
    const dir = path.join(PROJECTS_DIR, d.name);
    const files = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.jsonl')) files.push(path.join(dir, e.name));
      else if (e.isDirectory()) {
        const sub = path.join(dir, e.name, 'subagents');
        try { for (const s of fs.readdirSync(sub)) if (s.endsWith('.jsonl')) files.push(path.join(sub, s)); } catch {}
      }
    }
    if (!files.length) continue;
    let pid = known.get(d.name), root = null;
    if (!pid) { root = folderCwd(dir, files.filter(f => path.dirname(f) === dir)); if (!root) continue; pid = projectId(root); }
    if (!out.has(pid)) out.set(pid, { root: root || db.prepare('SELECT root FROM projects WHERE id=?').get(pid)?.root, slugs: new Set(), files: [] });
    const p = out.get(pid);
    p.slugs.add(d.name);
    for (const f of files) p.files.push({ file: f, slug: d.name });
  }
  const up = db.prepare(`INSERT INTO projects(id, root, name, bytes) VALUES(?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET bytes=excluded.bytes, root=COALESCE(projects.root, excluded.root)`);
  tx(() => {
    for (const [pid, p] of out) {
      let bytes = 0;
      for (const f of p.files) { try { f.size = fs.statSync(f.file).size; bytes += f.size; } catch { f.size = 0; } }
      up.run(pid, p.root, baseName(p.root || pid), bytes);
    }
  });
  return out;
}

const st = {
  getT: db.prepare('SELECT * FROM transcripts WHERE file=?'),
  putT: db.prepare(`INSERT INTO transcripts(file, slug, project_id, session_id, agent_id, offset, size, state) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(file) DO UPDATE SET offset=excluded.offset, size=excluded.size, state=excluded.state`),
  sess: db.prepare('SELECT * FROM sessions WHERE id=?'),
  insSess: db.prepare('INSERT OR IGNORE INTO sessions(id, project_id, first_ts, last_ts) VALUES(?,?,?,?)'),
  updSess: db.prepare(`UPDATE sessions SET title=COALESCE(?,title), cwd=COALESCE(cwd,?), branch=COALESCE(?,branch),
    entrypoint=COALESCE(entrypoint,?), version=COALESCE(?,version), model=COALESCE(?,model),
    first_ts=COALESCE(MIN(COALESCE(first_ts,?),?), first_ts), last_ts=MAX(COALESCE(last_ts,0),COALESCE(?,0)), prompts=prompts+?,
    last_kind=COALESCE(?,last_kind), last_stop=COALESCE(?,last_stop), last_prompt=COALESCE(?,last_prompt) WHERE id=?`),
  lastTask: db.prepare('SELECT id, prompt, ts FROM tasks WHERE session_id=? ORDER BY ts DESC LIMIT 1'),
  taskAt: db.prepare('SELECT id FROM tasks WHERE session_id=? AND ts<=? ORDER BY ts DESC LIMIT 1'),
  insTask: db.prepare('INSERT OR IGNORE INTO tasks(id, session_id, project_id, ts, end_ts, prompt) VALUES(?,?,?,?,?,?)'),
  updTask: db.prepare(`UPDATE tasks SET end_ts=MAX(COALESCE(end_ts,0),?), n_read=n_read+?, n_write=n_write+?,
    n_cmd=n_cmd+?, n_remote=n_remote+?, n_agent=n_agent+? WHERE id=?`),
  insEv: db.prepare(`INSERT INTO events(project_id, session_id, agent_id, task_id, ts, kind, tool, path, target, detail, inferred, tuid, chk)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  chkOf: db.prepare("SELECT chk FROM events WHERE tuid=? AND kind='cmd' LIMIT 1"),
  setOk: db.prepare('UPDATE events SET ok=?, res=? WHERE tuid=? RETURNING session_id, task_id, kind, chk, path, ts'),
  setChk: db.prepare("UPDATE events SET chk=? WHERE tuid=? AND kind='cmd'"),
  upAgent: db.prepare(`INSERT INTO agents(id, session_id, description, type, tool_use_id, first_ts, last_ts) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET last_ts=MAX(COALESCE(agents.last_ts,0),excluded.last_ts),
    first_ts=MIN(COALESCE(agents.first_ts,excluded.first_ts),excluded.first_ts)`),
  // the same message arrives on several records; keep the largest counts
  upUsage: db.prepare(`INSERT INTO usage(msg_id, project_id, session_id, task_id, ts, model, tin, tout, tcr, tcw, cost) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(msg_id) DO UPDATE SET tin=MAX(tin,excluded.tin), tout=MAX(tout,excluded.tout), tcr=MAX(tcr,excluded.tcr),
    tcw=MAX(tcw,excluded.tcw), cost=MAX(cost,excluded.cost), task_id=COALESCE(task_id,excluded.task_id)`),
  projAgg: db.prepare(`UPDATE projects SET sessions=(SELECT COUNT(*) FROM sessions WHERE project_id=$pid),
    prompts=(SELECT COALESCE(SUM(prompts),0) FROM sessions WHERE project_id=$pid),
    first_ts=(SELECT MIN(first_ts) FROM sessions WHERE project_id=$pid),
    last_ts=(SELECT MAX(last_ts) FROM sessions WHERE project_id=$pid),
    indexed_bytes=(SELECT COALESCE(SUM(offset),0) FROM transcripts WHERE project_id=$pid) WHERE id=$pid`),
};

function putUsage(pid, sid, taskId, ts, { id, model, u }) {
  st.upUsage.run(id, pid, sid, taskId || null, ts, model, u.input_tokens || 0, u.output_tokens || 0,
    u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0, costOf(model, u));
}

// Token usage for transcripts indexed before usage was recorded: one extra pass
// over assistant records only, once per project.
export function backfillUsage(pid, discovered) {
  if (kvGet('usage-v1:' + pid)) return;
  const p = (discovered || discover()).get(pid);
  for (const f of p?.files || []) {
    const isSub = path.basename(path.dirname(f.file)) === 'subagents';
    const sid = isSub ? path.basename(path.dirname(path.dirname(f.file))) : path.basename(f.file, '.jsonl');
    let text; try { text = fs.readFileSync(f.file, 'utf8'); } catch { continue; }
    tx(() => {
      for (const line of text.split('\n')) {
        if (!line.startsWith('{"type":"assistant"') && !(line.includes('"type":"assistant"') && line.includes('"usage"'))) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        const r = parseRecord(o);
        if (r.meta.usage && r.meta.ts) putUsage(pid, sid, st.taskAt.get(sid, r.meta.ts)?.id, r.meta.ts, r.meta.usage);
      }
    });
  }
  kvSet('usage-v1:' + pid, true);
}

// A tool's outcome onto the event(s) of its call. Checks keep the tail of their
// output (where runners print the summary), failures the head (the error).
function putResult(r) {
  const chk = st.chkOf.get(r.tuid)?.chk || null;
  const res = r.err ? resultText(r.block, !!chk) : chk ? resultText(r.block, true, 200) : null;
  const rows = st.setOk.all(r.err ? 0 : 1, res, r.tuid);
  const head = rows.find(x => x.kind === 'cmd') || rows[0];
  if (!head) return null;
  return { kind: 'result', ts: head.ts, sessionId: head.session_id, taskId: head.task_id, tuid: r.tuid, ok: !r.err, chk: head.chk, of: head.kind, path: head.path, res };
}

// Outcomes and check kinds for transcripts indexed before they were recorded:
// one pass over tool calls and results only, once per project, in slices so the
// server stays responsive.
export async function backfillResults(pid, discovered) {
  if (kvGet('results-v1:' + pid)) return;
  const p = (discovered || discover()).get(pid);
  for (const f of p?.files || []) {
    let text; try { text = fs.readFileSync(f.file, 'utf8'); } catch { continue; }
    tx(() => {
      for (const line of text.split('\n')) {
        if (line.includes('"name":"Bash"') || line.includes('"name":"PowerShell"')) {
          if (!line.startsWith('{"type":"assistant"') && !line.includes('"type":"assistant"')) continue;
          let o; try { o = JSON.parse(line); } catch { continue; }
          for (const b of o.message?.content || []) if (b?.type === 'tool_use' && (b.name === 'Bash' || b.name === 'PowerShell')) {
            const k = checkKind(b.input?.command); if (k) st.setChk.run(k, b.id);
          }
          continue;
        }
        const tr = line.includes('tool_use_id') ? toolResults(line) : null;
        if (tr) for (const r of tr.results) putResult(r);
      }
    });
    await new Promise(r => setImmediate(r));
  }
  kvSet('results-v1:' + pid, true);
}

const COUNT_COL ={ read: 0, search: 0, write: 1, cmd: 2, touch: -1, remote: 3, spawn: 4 };

// Index new bytes of one transcript. Returns the new items (for live fan-out).
export function indexFile(pid, f, slug) {
  const isSub = path.basename(path.dirname(f)) === 'subagents';
  const sessionId = isSub ? path.basename(path.dirname(path.dirname(f))) : path.basename(f, '.jsonl');
  const agentId = isSub ? path.basename(f, '.jsonl').replace(/^agent-/, '') : null;
  const row = st.getT.get(f);
  let offset = row?.offset || 0;
  let size;
  try { size = fs.statSync(f).size; } catch { return []; }
  if (size < offset) offset = 0; // file rewritten
  if (size === offset && row) return [];

  const fresh = [];
  const fd = fs.openSync(f, 'r');
  try {
    let pos = offset, carry = Buffer.alloc(0);
    let cur = st.lastTask.get(sessionId) || null;
    let agentMeta = null;
    if (isSub) {
      try { agentMeta = JSON.parse(fs.readFileSync(f.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch { agentMeta = {}; }
    }
    st.insSess.run(sessionId, pid, null, null);
    while (pos < size) {
      const len = Math.min(CHUNK, size - pos);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      pos += len;
      const all = carry.length ? Buffer.concat([carry, buf]) : buf;
      const lastNl = all.lastIndexOf(10);
      if (lastNl < 0) { carry = all; continue; }
      carry = all.subarray(lastNl + 1);
      const consumedTo = pos - carry.length;
      const meta = {}; const taskDelta = new Map();
      let firstTs = null, lastTs = null, prompts = 0, lastKind = null, lastPrompt = null;
      tx(() => {
        let s = 0;
        while (s <= lastNl) {
          let e = all.indexOf(10, s); if (e < 0 || e > lastNl) e = lastNl;
          const line = all.toString('utf8', s, e); s = e + 1;
          if (line.length < 2) continue;
          const tr = toolResults(line);
          if (tr) { for (const r of tr.results) { const ev = putResult(r); if (ev) fresh.push(ev); } continue; }
          if (quickSkip(line)) continue;
          let o; try { o = JSON.parse(line); } catch { continue; }
          const r = parseRecord(o);
          if (r.meta.ts) { firstTs ??= r.meta.ts; lastTs = r.meta.ts; }
          for (const k of ['title', 'cwd', 'branch', 'entrypoint', 'version', 'model', 'stop']) if (r.meta[k]) meta[k] = r.meta[k];
          if (o.type === 'assistant' || o.type === 'user') lastKind = isSub ? lastKind : o.type;
          if (r.meta.usage && r.meta.ts) putUsage(pid, sessionId, isSub ? st.taskAt.get(sessionId, r.meta.ts)?.id : cur?.id, r.meta.ts, r.meta.usage);
          for (const it of r.items) {
            if (!it.ts) continue;
            if (it.kind === 'prompt') {
              if (isSub) continue;
              if (cur && cur.prompt === it.text && it.ts - cur.ts < 30 * 60e3) continue; // queued + delivered copy
              const id = sessionId + ':' + (it.uuid || it.ts);
              st.insTask.run(id, sessionId, pid, it.ts, it.ts, it.text.slice(0, 4000));
              cur = { id, prompt: it.text, ts: it.ts };
              prompts++; lastPrompt = it.text.slice(0, 300);
              fresh.push({ ...it, sessionId, taskId: id });
              continue;
            }
            const taskId = isSub ? st.taskAt.get(sessionId, it.ts)?.id || null : cur?.id || null;
            st.insEv.run(pid, sessionId, agentId, taskId, it.ts, it.kind, it.tool || null, it.path || null,
              it.target || null, it.detail || null, it.inferred || 0, it.tuid || null, it.chk || null);
            fresh.push({ ...it, sessionId, agentId, taskId });
            if (taskId) {
              const d = taskDelta.get(taskId) || { end: 0, c: [0, 0, 0, 0, 0] };
              d.end = Math.max(d.end, it.ts);
              const col = COUNT_COL[it.kind];
              if (col >= 0) d.c[col]++;
              taskDelta.set(taskId, d);
            }
          }
        }
        for (const [id, d] of taskDelta) st.updTask.run(d.end, ...d.c, id);
        if (isSub) {
          if (firstTs) st.upAgent.run(agentId, sessionId, agentMeta.description || null, agentMeta.agentType || null,
            agentMeta.toolUseId || null, firstTs, lastTs);
          if (lastTs) st.updSess.run(null, null, null, null, null, null, firstTs, firstTs, lastTs, 0, null, null, null, sessionId);
        } else if (firstTs || meta.title) {
          st.updSess.run(meta.title || null, meta.cwd ? norm(meta.cwd) : null, meta.branch || null, meta.entrypoint || null,
            meta.version || null, meta.model || null, firstTs, firstTs, lastTs || 0, prompts, lastKind, meta.stop || null, lastPrompt, sessionId);
        }
        st.putT.run(f, slug, pid, sessionId, agentId, consumedTo, size, null);
      });
    }
  } finally { fs.closeSync(fd); }
  return fresh;
}

export function trackedSet() { return new Set(kvGet('tracked') || []); }
export function setTracked(pid, on) {
  const s = trackedSet(); on ? s.add(pid) : s.delete(pid);
  kvSet('tracked', [...s]);
  db.prepare('UPDATE projects SET tracked=? WHERE id=?').run(on ? 1 : 0, pid);
}

// Index every transcript of one project. Main session files go first so that
// subagent events can find their parent's task.
export function indexProject(pid, discovered, onProgress) {
  const p = (discovered || discover()).get(pid);
  if (!p) return { files: 0, fresh: [] };
  const files = [...p.files].sort((a, b) => (a.file.includes('subagents') ? 1 : 0) - (b.file.includes('subagents') ? 1 : 0));
  const fresh = [];
  let done = 0;
  for (const f of files) {
    const items = indexFile(pid, f.file, f.slug);
    if (items.length) fresh.push(...items);
    done++;
    if (onProgress && done % 10 === 0) onProgress(done, files.length);
  }
  st.projAgg.run({ pid });
  return { files: files.length, fresh };
}

export function refreshProjectAgg(pid) { st.projAgg.run({ pid }); }

// Projects worth showing on the overview: real human prompts, not temp dirs.
export function listProjects(showAll = false) {
  const rows = db.prepare('SELECT * FROM projects ORDER BY last_ts DESC NULLS LAST, bytes DESC').all();
  return showAll ? rows : rows.filter(r => !isTempPath(r.root) && (r.tracked || r.prompts > 0 || !r.indexed_bytes));
}
