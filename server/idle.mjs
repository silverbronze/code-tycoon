// Claude Code processes still running long after anyone used them. The VS Code
// extension keeps one CLI per panel it ever opened, each with its own MCP
// servers and shells, until the window closes; a day of work leaves dozens.
// Processes carry no session id, so each CLI is matched to the session whose
// first transcript line came right after it started.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { db } from './db.mjs';
import { PROJECTS_DIR, slugFor } from './paths.mjs';
import { sessions as live } from './live.mjs';
import { snapshot, forgetSnapshot, nodeLabel } from './system.mjs';

export const IDLE_AFTER = 2 * 3600e3;  // same as a session counting as open
const BUSY_CPU = 0.5;                  // % of the whole machine over the sampled second
const HELPER_AGE = 10 * 60e3;          // an orphaned node helper this young may still be starting up

// VS Code extension binary, npm package, or the native installer's ~/.local/{bin,share}/claude
const isCli = r => (r.name === 'claude' && /native-binary|claude-code|[\\/]\.local[\\/](bin|share)[\\/]claude/i.test(r.cmd) && !/--type=/.test(r.cmd))
  || (r.name === 'node' && /@anthropic-ai[\\/]claude-code[\\/]cli/i.test(r.cmd));
const sessionsQ = db.prepare(`SELECT s.id, s.title, s.last_prompt, s.first_ts, s.last_ts, s.last_stop, p.name project FROM sessions s
  LEFT JOIN projects p ON p.id = s.project_id WHERE s.last_ts > ? AND s.first_ts IS NOT NULL ORDER BY s.first_ts`);

// Only tracked projects are indexed; for the rest a transcript's creation and last
// write stand in for the session's first and last activity, its first prompt for a title.
function transcriptSessions(since, known) {
  const names = new Map(db.prepare('SELECT name, root FROM projects WHERE root IS NOT NULL').all().map(r => [slugFor(r.root).toLowerCase(), r.name]));
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()); } catch {}
  for (const d of dirs) {
    const dir = path.join(PROJECTS_DIR, d.name);
    try { if (fs.statSync(dir).mtimeMs < since) continue; } catch { continue; }
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl') || known.has(f.slice(0, -6))) continue;
      let st; try { st = fs.statSync(path.join(dir, f)); } catch { continue; }
      const born = st.birthtimeMs || st.ctimeMs;
      if (st.mtimeMs < since || born < since) continue;
      out.push({ id: f.slice(0, -6), file: path.join(dir, f), first_ts: born, last_ts: st.mtimeMs, last_stop: null, title: null, last_prompt: null,
        project: names.get(d.name.toLowerCase()) || d.name.split('-').filter(Boolean).at(-1) });
    }
  }
  return out;
}
function firstPrompt(file) {
  try {
    const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(64 << 10);
    const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      if (!line.includes('"type":"user"')) continue;
      try {
        const c = JSON.parse(line).message?.content;
        // injected context comes first as <tag>…</tag> blocks; the prompt is the first plain one
        const t = (typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text) : []).find(x => x && !x.trimStart().startsWith('<'));
        if (t) return t.replace(/\s+/g, ' ').trim().slice(0, 80);
      } catch {}
    }
  } catch {}
  return null;
}

// pid -> the session it runs now. First each process takes the earliest session that
// started within minutes of it; then later sessions (a /clear, a new chat in the same
// panel) go to the process whose session had gone quiet just before.
function matchSessions(clis) {
  if (!clis.length) return new Map();
  const since = Math.min(...clis.map(p => p.born)) - 60e3;
  const rows = sessionsQ.all(since);
  rows.push(...transcriptSessions(since, new Set(rows.map(r => r.id))));
  rows.sort((a, b) => a.first_ts - b.first_ts);
  const procs = [...clis].sort((a, b) => a.born - b.born);
  const cur = new Map(), used = new Set();
  for (const p of procs) {
    const s = rows.find(s => !used.has(s.id) && s.first_ts >= p.born - 10e3 && s.first_ts - p.born < 10 * 60e3);
    if (s) { cur.set(p.pid, s); used.add(s.id); }
  }
  for (const s of rows) {
    if (used.has(s.id) || s.last_stop === 'ended') continue;
    let best = null;
    for (const p of procs) {
      const c = cur.get(p.pid);
      if (!c || c.first_ts > s.first_ts || c.last_ts > s.first_ts + 60e3) continue;
      if (!best || c.last_ts > cur.get(best.pid).last_ts) best = p;
    }
    if (best) { cur.set(best.pid, s); used.add(s.id); }
  }
  return cur;
}

let last = null, scanning = null;
// { at, items: [...], n, mem } where items are the idle trees that can be stopped
export function scanIdle() {
  return scanning ||= (async () => {
    try {
      const rows = await snapshot(), now = Date.now();
      const by = new Map(rows.map(r => [r.pid, r]));
      // a pid can be reused: a "parent" born after its child is someone else
      const parentOf = r => { const p = by.get(r.ppid); return p && p.pid !== r.pid && (!p.born || !r.born || p.born <= r.born + 1000) ? p : null; };
      const kids = new Map();
      for (const r of rows) { const p = parentOf(r); if (p) { const k = kids.get(p.pid) || []; k.push(r); kids.set(p.pid, k); } }
      const tree = r => { const out = [r]; for (let i = 0; i < out.length && out.length < 500; i++) out.push(...(kids.get(out[i].pid) || [])); return out; };
      // whatever this server runs under (a Claude session's shell, a terminal) is never stopped
      const mine = new Set();
      for (let r = by.get(process.pid); r && !mine.has(r.pid); r = parentOf(r)) mine.add(r.pid);
      for (const r of tree(by.get(process.pid) || { pid: process.pid })) mine.add(r.pid);

      const clis = rows.filter(isCli);
      const match = matchSessions(clis);
      const items = [];
      for (const p of clis) {
        const t = tree(p), s = match.get(p.pid);
        if (t.some(r => mine.has(r.pid))) continue;
        const cpu = t.reduce((a, r) => a + r.cpu, 0);
        const seen = Math.max(p.born, s?.last_ts || 0, (s && live.get(s.id)?.lastSeen) || 0);
        if (cpu >= BUSY_CPU || now - seen < IDLE_AFTER) continue;
        const ver = p.cmd.match(/anthropic\.claude-code-([\d.]+)/)?.[1] || null;
        const title = (s?.title || s?.last_prompt || (s?.file && firstPrompt(s.file)) || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
        const helpers = t.slice(1).filter(r => r.name !== 'conhost'); // every console app gets one; not worth naming
        items.push({ pid: p.pid, kind: 'session', reason: !s ? 'unseen' : s.last_stop === 'ended' ? 'ended' : 'idle',
          session: s ? { id: s.id, title: title || null, project: s.project } : null,
          ver, born: p.born, seen, tree: t.map(r => r.pid), mem: t.reduce((a, r) => a + r.mem, 0), priv: t.reduce((a, r) => a + r.priv, 0), helpers: helpers.length,
          helperNames: [...new Set(helpers.map(r => r.name === 'node' ? nodeLabel(r, by) : r.name))].slice(0, 6) });
      }
      // packaged node helpers (MCP servers started through npx) whose session died without
      // taking them along. A plain script with no parent is more often a daemon someone
      // started on purpose (a watcher, a gateway), so those are left alone.
      const inTree = new Set(items.flatMap(i => i.tree));
      for (const r of rows) {
        if (r.name !== 'node' || isCli(r) || mine.has(r.pid) || inTree.has(r.pid) || parentOf(r) || now - r.born < HELPER_AGE || r.cpu >= BUSY_CPU) continue;
        if (!/[\\/]node_modules[\\/]|npx-cli|[\\/]_npx[\\/]/i.test(r.cmd)) continue;
        const t = tree(r);
        items.push({ pid: r.pid, kind: 'orphan', reason: 'orphan', session: null, label: nodeLabel(r, by), born: r.born, seen: r.born, tree: t.map(x => x.pid),
          mem: t.reduce((a, x) => a + x.mem, 0), priv: t.reduce((a, x) => a + x.priv, 0), helpers: t.length - 1, helperNames: [] });
      }
      items.sort((a, b) => a.seen - b.seen);
      return last = { at: now, items, n: items.length, mem: items.reduce((a, i) => a + i.mem, 0) };
    } finally { scanning = null; }
  })();
}

// For the pulse: the last count, refreshed in the background at most once a minute.
export function idleSummary() {
  if (!scanning && (!last || Date.now() - last.at > 60e3)) scanIdle().catch(() => {});
  return last ? { n: last.n, mem: last.mem, at: last.at } : null;
}

function kill(items) {
  const pids = items.map(i => i.pid);
  if (!pids.length) return Promise.resolve();
  return new Promise(resolve => {
    if (process.platform === 'win32') {
      // /T takes the MCP servers and shells along; /F because a console app has no window to close
      execFile('taskkill', ['/F', '/T', ...pids.flatMap(p => ['/PID', String(p)])], { windowsHide: true }, () => resolve());
    } else {
      for (const p of items.flatMap(i => i.tree).reverse()) try { process.kill(p, 'SIGTERM'); } catch {}
      resolve();
    }
  });
}

// Stops only pids that a fresh scan still calls idle; anything else is reported back as skipped.
export async function stopIdle(pids) {
  forgetSnapshot();
  const before = await scanIdle();
  const want = new Set(pids.map(Number));
  const go = before.items.filter(i => want.has(i.pid));
  await kill(go);
  await new Promise(r => setTimeout(r, 800));
  forgetSnapshot();
  const after = await scanIdle();
  const alive = new Set((await snapshot()).map(r => r.pid));
  const stopped = go.filter(i => !alive.has(i.pid));
  return { stopped: stopped.map(i => i.pid), failed: go.filter(i => alive.has(i.pid)).map(i => i.pid),
    skipped: [...want].filter(p => !go.some(i => i.pid === p)), freed: stopped.reduce((a, i) => a + i.mem, 0), idle: after };
}
