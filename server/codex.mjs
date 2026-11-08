// OpenAI Codex CLI sessions. Codex writes one JSONL "rollout" per session to
// ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl; this turns its records
// into the same items the Claude Code parser produces, so everything downstream
// (city, drones, tasks, alerts) treats both alike. Like Claude's transcripts the
// format is undocumented, so unknown records are ignored rather than fatal.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, norm, key, slugFor } from './paths.mjs';
import { cleanPrompt, toolItems } from './transcript.mjs';

export const CODEX_DIR = path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'sessions');
const codexKey = key(CODEX_DIR) + '/';

export const isCodexFile = f => !!key(f)?.startsWith(codexKey);
// transcripts.slug for a Codex project: one per cwd, never equal to a ~/.claude/projects folder name
export const codexSlug = cwd => 'codex:' + slugFor(cwd);
export const codexSessionId = f => /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(f)?.[1] || path.basename(f, '.jsonl');

// Every rollout file, oldest day first.
export function codexFiles() {
  const out = [];
  const walk = (dir, depth) => {
    let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory() && depth < 3) walk(path.join(dir, e.name), depth + 1);
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(path.join(dir, e.name));
    }
  };
  walk(CODEX_DIR, 0);
  return out;
}

// The session's cwd, from session_meta on the first line. A rollout never moves, so it is cached.
const cwdCache = new Map();
export function codexCwd(f) {
  if (cwdCache.has(f)) return cwdCache.get(f);
  let cwd = null, fd;
  try {
    fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const m = /"cwd":"((?:[^"\\]|\\.)+)"/.exec(buf.toString('utf8', 0, n));
    if (m) cwd = norm(JSON.parse('"' + m[1] + '"'));
  } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
  if (cwd) cwdCache.set(f, cwd);
  return cwd;
}

// Records that never carry anything we draw (the big ones are the tool list and system prompt).
const SKIP = /^\{"timestamp":"[^"]*","ordinal":\d+,"type":"(response_item|world_state)"/;
export const codexQuickSkip = line => SKIP.test(line.slice(0, 120));

function toPath(p, cwd) {
  if (!p || typeof p !== 'string') return null;
  if (p.startsWith('file://')) try { p = fileURLToPath(p); } catch { return null; }
  const n = norm(p);
  return /^([A-Za-z]:\/|\/)/.test(n) || !cwd ? n : norm(path.posix.join(cwd, n));
}

// ["powershell.exe", "-Command", "x"] / ["bash", "-lc", "x"] -> "x"
function commandText(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  if (c.length >= 3 && /^(-c|-lc|-Command|\/c)$/i.test(c[1])) return c.slice(2).join(' ');
  return c.map(a => /\s/.test(a) ? JSON.stringify(a) : a).join(' ');
}

function commandItems(id, command, cwd, parsed) {
  const cmd = commandText(command);
  const items = toolItems({ name: 'Bash', input: { command: cmd }, id }, cwd).map(it => ({ ...it, tool: 'shell' }));
  // Codex classifies simple commands itself; a read or search names its file
  for (const p of Array.isArray(parsed) ? parsed : []) {
    if (p?.type === 'read' && (p.path || p.name)) items.push({ tool: 'shell', tuid: id, kind: 'read', path: toPath(p.path || p.name, cwd) });
    else if (p?.type === 'search' || p?.type === 'list_files') items.push({ tool: 'shell', tuid: id, kind: 'search', path: toPath(p.path, cwd) || cwd, detail: p.query || null });
  }
  return items;
}

function patchItems(id, changes, cwd) {
  const items = [];
  for (const [p, ch] of Object.entries(changes || {})) {
    items.push({ tool: 'apply_patch', tuid: id, kind: 'write', path: toPath(p, cwd) });
    if (ch?.move_path) items.push({ tool: 'apply_patch', tuid: id, kind: 'write', path: toPath(ch.move_path, cwd) });
  }
  return items;
}

const brief = (s, n = 160) => s ? String(s).replace(/\s+/g, ' ').slice(0, n) : null;

// One rollout record -> { meta, items, results }. ctx carries cwd and model
// between records (model comes from turn_context, usage arrives later).
// results are tool outcomes; Codex logs them on the same record as the call.
export function parseCodexRecord(o, ctx) {
  const t = o.timestamp ? Date.parse(o.timestamp) : null;
  const p = o.payload || {};
  const meta = {}, items = [], results = [];
  if (t) meta.ts = t;
  switch (o.type) {
    case 'session_meta':
      if (p.cwd) { ctx.cwd = norm(p.cwd); meta.cwd = ctx.cwd; }
      if (p.git?.branch) meta.branch = p.git.branch;
      if (p.cli_version) meta.version = p.cli_version;
      meta.entrypoint = 'codex';
      break;
    case 'turn_context':
      if (p.cwd) ctx.cwd = norm(p.cwd);
      if (p.model) { ctx.model = p.model; meta.model = p.model; }
      break;
    case 'token_usage_record': {
      const u = p.usage; if (!u) break;
      // OpenAI counts cached tokens inside input_tokens; split them out like Claude's usage
      const cached = u.cached_input_tokens || 0, wrote = u.cache_write_input_tokens || 0;
      meta.usage = { id: p.response_id || (ctx.sid + ':' + t), model: ctx.model || null,
        u: { input_tokens: Math.max(0, (u.input_tokens || 0) - cached - wrote), output_tokens: u.output_tokens || 0,
          cache_read_input_tokens: cached, cache_creation_input_tokens: wrote } };
      break;
    }
    case 'event_msg':
      switch (p.type) {
        case 'task_started': meta.stop = 'running'; meta.kind = 'user'; break;
        case 'task_complete': case 'turn_aborted': meta.stop = 'end_turn'; meta.kind = 'assistant'; break;
        case 'item_completed': itemCompleted(p.item || {}, ctx, t, meta, items, results); break;
      }
      break;
  }
  for (const it of items) it.ts ??= t;
  return { meta, items, results };
}

function itemCompleted(it, ctx, t, meta, items, results) {
  const id = it.id;
  switch (it.type) {
    case 'UserMessage': {
      const text = cleanPrompt((it.content || []).filter(c => c?.type === 'text').map(c => ({ type: 'text', text: c.text })));
      items.push({ kind: 'prompt', ts: t, text: text || '(no text)', uuid: id });
      meta.kind = 'user';
      break;
    }
    case 'AgentMessage': meta.kind = 'assistant'; break;
    case 'CommandExecution': {
      const cwd = toPath(it.cwd) || ctx.cwd;
      items.push(...commandItems(id, it.command, cwd, it.parsed_cmd));
      if (it.status === 'completed' || it.status === 'failed')
        results.push({ tuid: id, err: it.status === 'failed' || (it.exit_code != null && it.exit_code !== 0), text: it.aggregated_output || '' });
      break;
    }
    case 'FileChange':
      items.push(...patchItems(id, it.changes, ctx.cwd));
      if (it.status === 'failed') results.push({ tuid: id, err: true, text: it.stderr || it.stdout || '' });
      break;
    case 'McpToolCall': {
      const server = it.server || it.server_name || 'mcp';
      items.push({ tool: 'mcp', tuid: id, kind: 'remote', target: server, detail: brief(it.tool || it.tool_name) });
      break;
    }
    case 'WebSearch':
      items.push({ tool: 'web_search', tuid: id, kind: 'remote', target: 'web search', detail: brief(it.query) });
      break;
  }
}
