// Turns Claude Code transcript records into Visualizer items.
// The transcript format is undocumented and changes between versions, so every
// accessor is defensive and unknown record types are ignored rather than fatal.
import fs from 'node:fs';
import path from 'node:path';
import { norm } from './paths.mjs';

// Records that never carry anything we draw. Checked on the raw line prefix so
// multi-MB api-request lines are never JSON.parsed.
const SKIP_PREFIX = /^\{"type":"(api-request|api-request-blob|api-request-shape|atis-latch|queue-operation|file-history-delta|file-history-snapshot|tools-used|mode|cost-state)"/;
// User records whose content is only tool results (the bulk of transcript bytes).
const TOOL_RESULT_HEAD = /"type":"user".{0,400}"content":\[\{"(tool_use_id|type":"tool_result)"/s;

export function quickSkip(line) {
  if (SKIP_PREFIX.test(line.slice(0, 48))) return true;
  return TOOL_RESULT_HEAD.test(line.slice(0, 900));
}

const WRAPPERS = /<(system-reminder|browser_instruction|ide_selection|ide_opened_file|ide_diagnostics|command-name|command-message|command-args|local-command-stdout|local-command-caveat|user-prompt-submit-hook)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g;

// Prompts are shown on screen and sent for titling: mask anything key-shaped.
const SECRET = /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|re_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|pk_(?:live|test)_[A-Za-z0-9]{16,}|rk_(?:live|test)_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g;
const TOKENISH = /\b(?=[A-Za-z0-9_\-]{32,}\b)(?=[^\s]*[a-z])(?=[^\s]*[A-Z])(?=[^\s]*\d)[A-Za-z0-9_\-]{32,}\b/g;
const PASSWORD = /\b(password|passwd|pwd|token|api[_ -]?key|secret)(\s*[:=]\s*|\s+is\s+)(\S{4,})/gi;
export function redact(s) {
  if (!s) return s;
  return s.replace(SECRET, '[secret]').replace(TOKENISH, '[token]').replace(PASSWORD, (_, k, sep) => `${k}${sep}[secret]`);
}

export function cleanPrompt(content) {
  let text;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content.map(b => b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : '').join('\n');
  } else return '';
  // pasted blocks are the user's own material: keep a marker, drop the bulk
  text = text.replace(/<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/g,
    (_, body) => '[pasted: ' + body.replace(/\s+/g, ' ').trim().slice(0, 200) + ']');
  text = text.replace(WRAPPERS, '').replace(/\n{3,}/g, '\n\n').trim();
  return redact(text);
}

function ts(o) { const t = Date.parse(o?.timestamp); return Number.isFinite(t) ? t : null; }

function host(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; }
}

const LOCAL = /^(localhost|127\.|0\.0\.0\.0|::1)/;
const HOSTNAME = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$|^\d{1,3}(?:\.\d{1,3}){3}$/i;

// Paths and remote hosts mentioned in a shell command. Only paths that exist on
// disk are kept, so guessed tokens never invent buildings.
export function scanCommand(cmd, cwd) {
  const out = { paths: [], hosts: [] };
  if (!cmd) return out;
  let base = cwd ? norm(cwd) : null;
  const cd = /^\s*(?:cd|Set-Location|pushd)\s+("[^"]+"|'[^']+'|\S+)/i.exec(cmd);
  if (cd) {
    const d = norm(cd[1]);
    if (d && /^[A-Za-z]:\//.test(d)) base = d;
    else if (d && base) base = norm(path.posix.join(base, d));
  }
  const seen = new Set();
  const tokens = cmd.match(/"[^"\n]{2,300}"|'[^'\n]{2,300}'|[^\s"'|;&<>()=,]+/g) || [];
  for (let t of tokens) {
    t = t.replace(/^["']|["']$/g, '').replace(/[:,]+$/, '');
    if (t.length < 3 || t.startsWith('-') || t.includes('://') || t.includes('*')) continue;
    const abs = /^([A-Za-z]:[\\/]|\/[a-zA-Z]\/)/.test(t);
    const relLike = /[\\/]/.test(t) || /\.[a-zA-Z0-9]{1,5}$/.test(t);
    if (!abs && !relLike) continue;
    let p = abs ? norm(t) : base ? norm(path.posix.join(base, t.replace(/\\/g, '/'))) : null;
    if (!p || seen.has(p)) continue;
    seen.add(p);
    try { if (fs.existsSync(p)) out.paths.push(p); } catch {}
    if (out.paths.length >= 6) break;
  }
  const hs = new Set();
  for (const m of cmd.matchAll(/https?:\/\/[^\s"'<>)]+/g)) { const h = host(m[0]); if (h && !LOCAL.test(h)) hs.add(h); }
  for (const m of cmd.matchAll(/\b(?:ssh|scp|rsync|sftp)\b[^\n;|&]*?\b(?:[\w.-]+@)([\w.-]+)/g)) if (!LOCAL.test(m[1])) hs.add(m[1]);
  out.hosts = [...hs].filter(h => HOSTNAME.test(h)).slice(0, 4);
  return out;
}

// What a shell command checks, if it is a test, build, type check or lint run.
const CHECKS = [
  ['types', /\b(tsc|mypy|pyright|vue-tsc|svelte-check)\b|\bnpm run (typecheck|type-check|types|check:types)\b/],
  ['test', /\b(vitest|jest|mocha|pytest|phpunit|rspec|ava)\b|\bnode --test\b|\b(npm|pnpm|yarn|bun)( run)? test\b|\b(go|cargo|dotnet|mix|deno|bun) test\b|\bplaywright test\b|\bpython3? -m (pytest|unittest)\b/],
  ['lint', /\b(eslint|ruff|flake8|pylint|stylelint|golangci-lint|rubocop)\b|\bbiome (lint|check)\b|\bprettier --check\b|\b(npm|pnpm|yarn) (run )?lint\b|\bcargo clippy\b/],
  ['build', /\b(npm|pnpm|yarn|bun) (run )?build\b|\bvite build\b|\bnext build\b|\b(cargo|go|dotnet) build\b|\bwebpack\b(?! serve)|\bgradlew? (build|assemble)\b|\bmvn (package|install|verify)\b|\bmake( |$)/],
];
export function checkKind(cmd) {
  if (!cmd) return null;
  const c = String(cmd).replace(/\s+/g, ' ');
  if (/--watch\b|\bwatch\b|\bdev\b/.test(c)) return null; // never finishes, so it never passes
  for (const [k, re] of CHECKS) if (re.test(c)) return k;
  return null;
}

// The tool results in one transcript line (cheap: the line is never JSON.parsed).
// Returns null when the line is not a tool-result record. A JSON string cannot
// hold an unescaped quote, so the structural keys found here are the real ones.
export function toolResults(line) {
  if (!line.startsWith('{') || !TOOL_RESULT_HEAD.test(line.slice(0, 900))) return null;
  const out = [];
  const starts = [...line.matchAll(/\{"(?:type":"tool_result"|tool_use_id":")/g)].map(m => m.index);
  for (let i = 0; i < starts.length; i++) {
    const block = line.slice(starts[i], starts[i + 1] ?? line.length);
    const id = /"tool_use_id":"([^"]+)"/.exec(block)?.[1];
    if (id) out.push({ tuid: id, err: /"is_error":true/.test(block), block });
  }
  const t = /"timestamp":"([^"]+)"/.exec(line.slice(-4000))?.[1];
  return { ts: t ? Date.parse(t) : null, results: out };
}

// The text of one tool-result block: its head, or its tail (where test runners print the summary).
export function resultText(block, tail = false, n = 300) {
  const m = /"(?:content|text)":"((?:[^"\\]|\\.)*)"/.exec(block);
  if (!m) return null;
  let s; try { s = JSON.parse('"' + m[1] + '"'); } catch { return null; }
  s = s.replace(/\x1b\[[0-9;]*m/g, '').trim();
  return redact(tail ? s.slice(-n) : s.slice(0, n));
}

// Short, human description of a tool call for logs and tooltips.
function brief(s, n = 160) { return s ? String(s).replace(/\s+/g, ' ').slice(0, n) : null; }

// One tool_use block -> zero or more items.
export function toolItems(b, cwd) {
  const name = b.name || '';
  const inp = b.input || {};
  const base = { tool: name, tuid: b.id };
  const fp = inp.file_path || inp.notebook_path;
  switch (name) {
    case 'Read': return [{ ...base, kind: 'read', path: norm(fp) }];
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit':
      return [{ ...base, kind: 'write', path: norm(fp) }];
    case 'Grep': case 'Glob':
      return [{ ...base, kind: 'search', path: norm(inp.path || cwd), detail: brief(inp.pattern) }];
    case 'Bash': case 'PowerShell': {
      const c = inp.command || '';
      const s = scanCommand(c, cwd);
      const items = [{ ...base, kind: 'cmd', detail: brief(inp.description || c), chk: checkKind(c) }];
      for (const p of s.paths) items.push({ ...base, kind: 'touch', path: p, inferred: 1 });
      for (const h of s.hosts) items.push({ ...base, kind: 'remote', target: h, inferred: 1 });
      return items;
    }
    case 'WebFetch': return [{ ...base, kind: 'remote', target: host(inp.url) || 'web', detail: brief(inp.url) }];
    case 'WebSearch': return [{ ...base, kind: 'remote', target: 'web search', detail: brief(inp.query) }];
    case 'Agent': case 'Task':
      return [{ ...base, kind: 'spawn', detail: brief(inp.description || inp.prompt, 120), target: inp.subagent_type || 'agent' }];
    case 'Skill': return [{ ...base, kind: 'skill', target: inp.skill, detail: brief(inp.args) }];
    case 'AskUserQuestion': return [{ ...base, kind: 'ask', detail: brief(inp.questions?.[0]?.question) }];
    case 'ToolSearch': case 'TodoWrite': case 'TaskStop': case 'TaskOutput': return [];
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) {
    let server = mcp[1].replace(/^claude_ai_/, '').replace(/^plugin_[^_]+_/, '');
    // a browser call is really work on whatever site it is pointed at
    const u = inp.url && host(inp.url);
    const target = u && /chrome|browser|playwright/i.test(server) ? u : server;
    return [{ ...base, kind: 'remote', target, detail: brief(mcp[2] + (inp.url ? ' ' + inp.url : '')) }];
  }
  return [{ ...base, kind: 'other', detail: brief(name) }];
}

// Parse one transcript record. Returns { meta, items } where items are
// prompts / tool calls / stops in order.
export function parseRecord(o) {
  const t = ts(o);
  const meta = {};
  const items = [];
  if (o.cwd) meta.cwd = o.cwd;
  if (o.gitBranch) meta.branch = o.gitBranch;
  if (o.version) meta.version = o.version;
  if (o.entrypoint) meta.entrypoint = o.entrypoint;
  if (o.sessionId) meta.sessionId = o.sessionId;
  if (o.agentId) meta.agentId = o.agentId;
  if (t) meta.ts = t;

  switch (o.type) {
    case 'ai-title': meta.title = o.aiTitle; break;
    case 'last-prompt': break;
    case 'user': {
      const c = o.message?.content;
      if (o.isSidechain || o.isMeta) break;
      if (Array.isArray(c) && c.length && c.every(b => b?.type === 'tool_result')) break;
      const human = o.origin?.kind === 'human' || (!o.origin && o.turnOrigin === 'human');
      if (!human) break;
      const text = cleanPrompt(c);
      if (/^This session is being continued from a previous conversation/.test(text)) break;
      items.push({ kind: 'prompt', ts: t, text: text || '(no text)', uuid: o.uuid });
      break;
    }
    case 'attachment': {
      const a = o.attachment;
      if (a?.type === 'queued_command' && a.commandMode === 'prompt' && a.origin?.kind === 'human') {
        items.push({ kind: 'prompt', ts: t, text: cleanPrompt(a.prompt) || '(no text)', uuid: a.source_uuid || o.uuid, queued: true });
      }
      break;
    }
    case 'assistant': {
      const m = o.message || {};
      if (m.model && m.model !== '<synthetic>') meta.model = m.model;
      if (m.stop_reason) meta.stop = m.stop_reason;
      if (m.id && m.usage && m.model !== '<synthetic>') meta.usage = { id: m.id, model: m.model, u: m.usage };
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type === 'tool_use') for (const it of toolItems(b, o.cwd)) items.push({ ...it, ts: t });
      }
      break;
    }
  }
  for (const it of items) if (!it.ts) it.ts = t;
  return { meta, items };
}
