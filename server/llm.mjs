// One way to run a model for Code Tycoon's own work (task titles, district names, recaps,
// the domain map, briefs, Optimize): the user's Claude Code CLI, or the OpenAI Codex CLI
// when Claude Code is missing or VISUALIZER_LLM=codex.
//
// runAgent({ want, tools, cwd, prompt, budgetUsd, timeoutMs, persist, name, onSpawn })
//   want:  'small' (titles, recaps), 'map' (the domain map), or a model id (the project's own)
//   tools: 'none' | 'read' | 'edit'
//   persist: false = no transcript, no hooks (never drawn); true = a real, visible session
// resolves { res (first JSON object in the reply), text, cost, sid, model }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { findClaudeCli, isWin } from './paths.mjs';
import { costOf } from './prices.mjs';

const isClaudeModel = m => /claude|opus|sonnet|haiku|fable|mythos/i.test(m || '');
const isCodexModel = m => /^(gpt-|o\d|codex)/i.test(m || '');

// ------------------------------------------------------------------ which CLI
function which(name) {
  try { return execFileSync(isWin ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).filter(Boolean); }
  catch { return []; }
}
function claudeFound() {
  const c = findClaudeCli();
  return c !== 'claude' ? fs.existsSync(c) : which('claude').length > 0;
}

// Codex ships as an npm package; on Windows its launcher is a .cmd that Node will not spawn
// without a shell, so run its codex.js with this Node instead. [command, ...leading args] or null.
export function findCodexCli() {
  const env = process.env.VISUALIZER_CODEX;
  const viaNode = p => /\.[cm]?js$/i.test(p) ? [process.execPath, p] : [p];
  if (env) return viaNode(env);
  const pkg = dir => path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const tries = process.env.APPDATA ? [pkg(path.join(process.env.APPDATA, 'npm'))] : [];
  for (const p of which('codex')) {
    if (!isWin) return [p];
    if (/\.exe$/i.test(p)) return [p];
    tries.push(pkg(path.dirname(p)));
  }
  for (const t of tries) if (fs.existsSync(t)) return [process.execPath, t];
  return null;
}

let chosen = null; // { at, v }
export function provider() {
  const want = (process.env.VISUALIZER_LLM || 'auto').toLowerCase();
  if (want === 'claude' || want === 'codex') return want;
  if (chosen && Date.now() - chosen.at < 60e3) return chosen.v;
  const v = claudeFound() ? 'claude' : findCodexCli() ? 'codex' : 'claude';
  chosen = { at: Date.now(), v };
  return v;
}

// ------------------------------------------------------------------ models
const CODEX = {
  small: process.env.VISUALIZER_CODEX_SMALL_MODEL || 'gpt-6-luna',
  map: process.env.VISUALIZER_CODEX_MAP_MODEL || 'gpt-6.1-terra',
  def: process.env.VISUALIZER_CODEX_MODEL || 'gpt-6.1-sol',
};
const CLAUDE = { small: 'haiku', map: process.env.VISUALIZER_DOMAIN_MODEL || 'sonnet', def: null };

// The model for a job on this provider. A model id that belongs to the other provider
// (the project's latest session ran on Codex, the CLI is Claude Code) falls back to the default.
export function modelFor(want, prov = provider()) {
  const t = prov === 'codex' ? CODEX : CLAUDE;
  if (want === 'small' || want === 'map') return t[want];
  if (prov === 'codex') return isCodexModel(want) ? want : t.def;
  return isClaudeModel(want) ? want : t.def;
}
// A name for the UI: "Sonnet", "gpt-6.1-terra"
export function modelLabel(want) {
  const m = modelFor(want);
  if (!m) return 'your default model';
  return /^(haiku|sonnet|opus|fable)$/.test(m) ? m[0].toUpperCase() + m.slice(1) : m.replace(/^claude-/, '');
}

// ------------------------------------------------------------------ run
const firstJson = text => { const m = String(text || '').match(/\{[\s\S]*\}/); try { return m ? JSON.parse(m[0]) : {}; } catch { return {}; } };

export function runAgent(o) {
  return provider() === 'codex' ? runCodex(o) : runClaude(o);
}

function runClaude({ want, tools = 'none', cwd, prompt, budgetUsd, timeoutMs = 120e3, persist = false, name, onSpawn, env }) {
  const model = modelFor(want, 'claude');
  const args = ['-p', '--output-format', 'json', ...(model ? ['--model', model] : []), '--strict-mcp-config',
    ...(persist ? (name ? ['-n', name] : []) : ['--no-session-persistence', '--setting-sources', 'project']),
    ...(tools === 'edit' ? ['--permission-mode', 'acceptEdits', '--tools', 'Read,Edit,Write,Glob,Grep'] : ['--tools', tools === 'read' ? 'Read,Glob,Grep' : '']),
    ...(budgetUsd ? ['--max-budget-usd', String(budgetUsd)] : [])];
  return new Promise((resolve, reject) => {
    const p = spawn(findClaudeCli(), args, { cwd, windowsHide: true, env: { ...process.env, VISUALIZER_INTERNAL: persist ? '' : '1', ...env } });
    onSpawn?.(p);
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('timed out')); }, timeoutMs);
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    // Windows reports a missing cwd as ENOENT too
    p.on('error', e => { clearTimeout(timer); reject(e.code !== 'ENOENT' ? e : !fs.existsSync(cwd) ? new Error('folder not found: ' + cwd) : new Error('Claude Code CLI not found (set VISUALIZER_CLAUDE, or install Codex)')); });
    p.on('close', code => {
      clearTimeout(timer);
      if (p.stopped) return reject(new Error('stopped'));
      let j;
      try { j = JSON.parse(out); } catch { return reject(new Error(`claude exited ${code}: ${(err || out).slice(0, 300)}`)); }
      if (j.is_error) return reject(new Error(String(j.result || j.subtype || 'failed').slice(0, 300)));
      const text = String(j.result || '');
      resolve({ res: firstJson(text), text, cost: j.total_cost_usd || 0, sid: j.session_id || null, model });
    });
    p.stdin.end(prompt);
  });
}

// Codex's sandbox on Windows blocks every command, reads included, even in workspace-write,
// so jobs that read or edit the project can only run there without it, and only when the
// user says so. A read job then runs in a throwaway copy of the project.
const UNSANDBOXED = process.env.VISUALIZER_CODEX_UNSANDBOXED === '1';
export function codexBlocked(tools) {
  if (!isWin || tools === 'none' || UNSANDBOXED || provider() !== 'codex') return null;
  return 'Codex cannot read or edit files in its sandbox on Windows yet. Set VISUALIZER_CODEX_UNSANDBOXED=1 to let it run without one (reads go to a throwaway copy of the project), or install Claude Code.';
}

async function runCodex({ want, tools = 'none', cwd, prompt, timeoutMs = 120e3, persist = false, onSpawn, env }) {
  const blocked = codexBlocked(tools);
  if (blocked) throw new Error(blocked);
  const cli = findCodexCli();
  if (!cli) throw new Error('Codex CLI not found (set VISUALIZER_CODEX, or install Claude Code)');
  const model = modelFor(want, 'codex');
  const loose = isWin && tools !== 'none';
  const dir = loose && tools === 'read' ? snapshot(cwd) : cwd;
  const sandbox = loose ? ['--dangerously-bypass-approvals-and-sandbox'] : ['-s', tools === 'edit' ? 'workspace-write' : 'read-only'];
  // a hidden job ignores the user's config (MCP servers, hooks, profiles), like Claude's
  // --setting-sources project --strict-mcp-config; a visible session runs as the user's own
  const args = [...cli.slice(1), 'exec', '--json', '--skip-git-repo-check', '-C', dir, '-m', model, ...sandbox,
    ...(persist ? [] : ['--ephemeral', '--ignore-user-config']), '-'];
  try {
    return await new Promise((resolve, reject) => {
      const p = spawn(cli[0], args, { cwd: dir, windowsHide: true, env: { ...process.env, VISUALIZER_INTERNAL: persist ? '' : '1', ...env } });
      onSpawn?.(p);
      let buf = '', err = '', text = '', sid = null, failed = null;
      const use = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 };
      const timer = setTimeout(() => { p.kill(); reject(new Error('timed out')); }, timeoutMs);
      const line = l => {
        let j; try { j = JSON.parse(l); } catch { return; }
        if (j.type === 'thread.started') sid = j.thread_id || null;
        else if (j.type === 'item.completed' && j.item?.type === 'agent_message') text = String(j.item.text || '');
        else if (j.type === 'turn.completed' && j.usage) for (const k of Object.keys(use)) use[k] += j.usage[k] || 0;
        else if (j.type === 'turn.failed' || j.type === 'error') failed = j.error?.message || j.message || 'failed';
      };
      p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); } });
      p.stderr.on('data', d => { err += d; if (err.length > 20e3) err = err.slice(-10e3); });
      p.on('error', e => { clearTimeout(timer); reject(e); });
      p.on('close', code => {
        clearTimeout(timer);
        if (buf.trim()) line(buf);
        if (p.stopped) return reject(new Error('stopped'));
        // OpenAI counts cached tokens inside input_tokens; split them out like Claude's usage
        const cost = costOf(model, { input_tokens: Math.max(0, use.input_tokens - use.cached_input_tokens - use.cache_write_input_tokens),
          output_tokens: use.output_tokens, cache_read_input_tokens: use.cached_input_tokens, cache_creation_input_tokens: use.cache_write_input_tokens }, { perRequest: false });
        if (failed || (!text && code !== 0)) return reject(new Error(String(failed || `codex exited ${code}: ${err.split('\n').filter(Boolean).slice(-2).join(' ')}`).slice(0, 300)));
        resolve({ res: firstJson(text), text, cost, sid, model });
      });
      p.stdin.end(prompt);
    });
  } finally {
    if (dir !== cwd) fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

// ------------------------------------------------------------------ throwaway copy
const SKIP = /(^|\/)(\.git|node_modules|dist|build|out|coverage|\.next|\.venv|venv|__pycache__|target)(\/|$)/;
const MAX_FILES = 20000, MAX_BYTES = 300 * 1024 * 1024;
// The project's files (git's view when it is a repo: tracked plus untracked, not ignored)
// copied to a temp folder, so a job without a sandbox can read but never change the project.
export function snapshot(root) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'code-tycoon-'));
  let files;
  try {
    files = execFileSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0').filter(Boolean);
  } catch {
    files = [];
    const walk = d => {
      for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
        const r = d ? d + '/' + e.name : e.name;
        if (SKIP.test(r) || files.length >= MAX_FILES) continue;
        if (e.isDirectory()) walk(r); else if (e.isFile()) files.push(r);
      }
    };
    walk('');
  }
  let bytes = 0;
  for (const f of files.slice(0, MAX_FILES)) {
    const src = path.join(root, f);
    let st; try { st = fs.statSync(src); } catch { continue; }
    if (!st.isFile() || (bytes += st.size) > MAX_BYTES) continue;
    fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
    try { fs.copyFileSync(src, path.join(dest, f)); } catch {}
  }
  return dest;
}
