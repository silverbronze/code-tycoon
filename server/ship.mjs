// Shipping: what "done" means for a task on the board. A task whose result is only merged on
// this PC is not done for a user who can't see the output; it is done when it is live and
// checked. Each project has a ship recipe (kv ship:<pid>):
//   check:  commands that must pass before anything goes out (type-check, tests, a build)
//   ship:   commands that put it live (a push, wrangler deploy, hostinger up, a restart)
//   verify: where to see that it is live ({ url, expect: 'ok' | 'sha' | '<text>', within })
//   live:   the address the user opens (shown on the card), screenshot: take one there
// A step may carry `when`, a regex on the changed files: it runs only when one matches.
// "@restart" is a step of Code Tycoon's own recipe: rebuild, then restart this very server.
//
// The recipe is detected once (scripts, deploy configs, CLAUDE.md, CI files, read by a small
// model) and the user confirms it once per project: that is the standing permission to ship.
// The board (board.mjs) runs it after a task is merged; this file only knows how.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { kvGet, kvSet } from './db.mjs';
import { runAgent } from './llm.mjs';
import { DATA_DIR, PORT, isWin } from './paths.mjs';

export const SELF_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SHOTS = path.join(DATA_DIR, 'ship');
const STEP_MS = Number(process.env.CODETYCOON_SHIP_MINUTES || 15) * 60e3;
// a background job must never wait on a password prompt or a credential window
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', CI: '1',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' };

const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const gitTop = root => { try { return execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
export const isSelf = root => !!root && fs.existsSync(path.join(SELF_ROOT, '.git')) && same(gitTop(root) || root, SELF_ROOT);
export function headSha(root) {
  try { return execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}

// ------------------------------------------------------------------ recipes
const detecting = new Set();
const listeners = [];
export function onShip(fn) { listeners.push(fn); }
const emit = pid => { for (const l of listeners) try { l(pid, shipInfo(pid)); } catch (e) { console.warn('[ship]', e.message); } };

// { recipe, confirmed, off, source, at, why, detecting }
export function shipInfo(pid) {
  const s = kvGet('ship:' + pid);
  return { recipe: null, confirmed: false, off: false, source: null, at: null, why: null, ...(s || {}), detecting: detecting.has(pid) };
}

const str = (v, n) => typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null;
function stepsOf(a) {
  return (Array.isArray(a) ? a : []).map(s => typeof s === 'string' ? { run: s } : s).filter(s => s && str(s.run, 600))
    .map(s => ({ run: str(s.run, 600), when: validRe(s.when) ? str(s.when, 200) : null })).slice(0, 8);
}
function validRe(s) { if (!str(s, 200)) return false; try { new RegExp(s); return true; } catch { return false; } }
export function cleanRecipe(r) {
  if (!r || typeof r !== 'object') return null;
  const v = r.verify && typeof r.verify === 'object' ? r.verify : null;
  const url = v && /^https?:\/\//i.test(String(v.url || '')) ? str(v.url, 400) : null;
  return {
    check: stepsOf(r.check), ship: stepsOf(r.ship),
    verify: v?.self ? { self: true } : url ? { url, expect: str(v.expect, 200) || 'ok', within: Math.min(1800, Math.max(10, Number(v.within) || 120)) } : null,
    live: /^https?:\/\//i.test(String(r.live || '')) ? str(r.live, 400) : url,
    screenshot: !!r.screenshot,
    notes: str(r.notes, 600),
  };
}

// b: { recipe?, confirmed?, off? }
export function setShip(pid, b = {}) {
  const cur = shipInfo(pid);
  const recipe = b.recipe !== undefined ? cleanRecipe(b.recipe) : cur.recipe;
  const next = { recipe, confirmed: typeof b.confirmed === 'boolean' ? b.confirmed && !!recipe : cur.confirmed && !!recipe, off: typeof b.off === 'boolean' ? b.off : cur.off,
    source: b.recipe !== undefined ? 'you' : cur.source, at: Date.now(), why: b.recipe !== undefined ? 'Edited by you' : cur.why };
  kvSet('ship:' + pid, next);
  emit(pid);
  return shipInfo(pid);
}

// Code Tycoon itself: type-check, build the UI, restart the server when server code changed
// (static files are read per request, so a UI change needs no restart), re-copy the hook
const SELF_RECIPE = {
  check: [{ run: 'npx tsc --noEmit -p .', when: null }],
  ship: [{ run: 'npm run build', when: '^(web/|vite\\.config|index\\.html|package)' },
    { run: 'npm run hooks:install', when: '^server/(hook|hooks-install)\\.mjs$' },
    { run: '@restart', when: '^server/' }],
  verify: { self: true }, live: `http://127.0.0.1:${PORT}/`, screenshot: false,
  notes: 'Code Tycoon itself: the app you are looking at is rebuilt, and restarted when its server changed.',
};

// What the repo says about building and deploying, for the model to read.
const CONFIGS = ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc', 'vercel.json', 'netlify.toml', 'fly.toml', 'render.yaml', 'railway.json', 'Procfile', 'app.yaml',
  'firebase.json', 'Dockerfile', 'docker-compose.yml', 'compose.yaml', 'Makefile', 'deploy.sh', 'deploy.ps1', '.hostinger.json', 'ecosystem.config.js', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'composer.json', 'style.css', 'functions.php'];
const HINT = /deploy|publish|release|ship|build|restart|live|prod|hostinger|vercel|netlify|wrangler|cloudflare|ssh|scp|rsync|pm2|systemctl|docker|url|https?:\/\/|test|tsc|lint|push/i;
function readSome(f, n) { try { return fs.readFileSync(f, 'utf8').slice(0, n); } catch { return null; } }
export function hints(root) {
  const out = [];
  const pj = readSome(path.join(root, 'package.json'), 20000);
  if (pj) { try { const j = JSON.parse(pj); out.push('package.json scripts: ' + JSON.stringify(j.scripts || {}).slice(0, 2500)); if (j.homepage) out.push('package.json homepage: ' + j.homepage); } catch {} }
  for (const c of CONFIGS) { const s = readSome(path.join(root, c), 1500); if (s != null) out.push(`--- ${c}\n${s}`); }
  const wf = path.join(root, '.github', 'workflows');
  try { for (const f of fs.readdirSync(wf).slice(0, 6)) { const s = readSome(path.join(wf, f), 1500); if (s) out.push(`--- .github/workflows/${f}\n${s}`); } } catch {}
  for (const f of ['CLAUDE.md', 'AGENTS.md', 'README.md', 'DEPLOY.md', 'docs/deploy.md']) {
    const s = readSome(path.join(root, f), 60000);
    if (!s) continue;
    const lines = s.split('\n').filter(l => HINT.test(l)).slice(0, 60).map(l => l.slice(0, 300));
    if (lines.length) out.push(`--- ${f} (lines about building and deploying)\n${lines.join('\n')}`);
  }
  try {
    const remote = execFileSync('git', ['-C', root, 'remote', '-v'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(l => /\(push\)/.test(l)).map(l => l.replace(/\/\/[^@/\s]+@/, '//')).join('\n');
    if (remote) out.push('git remotes:\n' + remote);
    const up = execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', '@{u}'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (up) out.push('the checked-out branch tracks ' + up);
  } catch {}
  try { out.push('top-level files: ' + fs.readdirSync(root).filter(f => !f.startsWith('.') || /^\.(github|env\.example)$/.test(f)).slice(0, 60).join(', ')); } catch {}
  return out.join('\n\n').slice(0, 24000);
}

// Work out a recipe once (a confirmed one is never replaced unless `force`).
export async function detect(pid, root, { force = false } = {}) {
  const cur = shipInfo(pid);
  if (detecting.has(pid) || (!force && cur.recipe)) return cur;
  if (isSelf(root)) {
    kvSet('ship:' + pid, { recipe: cleanRecipe(SELF_RECIPE), confirmed: false, off: false, source: 'detected', at: Date.now(), why: 'This is Code Tycoon itself' });
    emit(pid);
    return shipInfo(pid);
  }
  detecting.add(pid); emit(pid);
  try {
    const prompt = `Work out how this software project is checked and put live, from what its files say. Reply with JSON only.

Project folder: ${root}

${hints(root)}

Reply with:
{"check": ["commands that must pass before shipping: a type-check, tests, a build; only ones these files show exist"],
 "ship": ["commands, in order, that put the current commit live: a deploy command, a git push that triggers a deploy (CI, Vercel, Netlify, Cloudflare Pages), an upload, a service restart; [] when nothing here deploys anything"],
 "verify": {"url": "the live address to check, only one written in these files", "expect": "ok", "within": 180} or null,
 "live": "the address the user opens to see it, or null",
 "screenshot": true when it is a website or app with pages to look at, else false,
 "why": "one sentence: what you based this on, and what is missing or unsure"}
Rules: commands run from the project folder in ${isWin ? 'cmd.exe on Windows' : 'sh'}, one per entry, with no prompts (non-interactive flags). Never invent a URL, host, or command that the files don't support. A push deploys only when a CI workflow or host integration in these files deploys on push; then add "within": 300 to verify. A library or CLI with nothing to deploy gets "ship": [] (check only).`;
    const { res } = await runAgent({ want: 'small', tools: 'none', cwd: root, prompt, timeoutMs: 120e3 });
    const recipe = cleanRecipe(res);
    if (!recipe) throw new Error('no recipe in the reply');
    kvSet('ship:' + pid, { recipe, confirmed: false, off: false, source: 'detected', at: Date.now(), why: str(res?.why, 400) || null });
  } catch (e) {
    console.warn('[ship] detect:', e.message);
    kvSet('ship:' + pid, { ...cur, recipe: cur.recipe || cleanRecipe({ check: [], ship: [] }), at: Date.now(), why: 'Could not work it out (' + e.message.slice(0, 120) + '): fill it in yourself' });
  } finally { detecting.delete(pid); emit(pid); }
  return shipInfo(pid);
}

// ------------------------------------------------------------------ running
// steps whose `when` matches a changed file (changed = null: unknown, all of them run)
export function stepsFor(steps, changed) {
  return steps.filter(s => !s.when || !changed || changed.some(f => new RegExp(s.when).test(f.replace(/\\/g, '/'))));
}

// one shell command; resolves { ok, code, out } (the tail of stdout + stderr)
export function runCmd(cmd, cwd, { timeoutMs = STEP_MS, onSpawn } = {}) {
  return new Promise(res => {
    let out = '';
    const p = spawn(cmd, { cwd, shell: true, windowsHide: true, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    onSpawn?.(p);
    const add = d => { out += d; if (out.length > 40e3) out = out.slice(-20e3); };
    p.stdout.on('data', add); p.stderr.on('data', add);
    const timer = setTimeout(() => { add(`\n(stopped after ${Math.round(timeoutMs / 60e3)} minutes)`); killTree(p); }, timeoutMs);
    p.on('error', e => { clearTimeout(timer); res({ ok: false, code: -1, out: out + '\n' + e.message }); });
    p.on('close', code => { clearTimeout(timer); res({ ok: code === 0 && !p.stopped, code, out: out.replace(/\x1b\[[0-9;]*m/g, '').slice(-6000) }); });
  });
}
export function killTree(p) {
  p.stopped = true;
  if (isWin && p.pid) { try { execFileSync('taskkill', ['/pid', String(p.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); return; } catch {} }
  try { p.kill(); } catch {}
}

// Is it live? resolves { ok, why, status }
export async function verifyLive(v, { sha, since, restarted } = {}) {
  if (!v) return { ok: true, why: 'nothing to check: no live address in the recipe', status: null };
  if (v.self) return verifySelf({ sha, since, restarted });
  const until = Date.now() + (v.within || 120) * 1000;
  let last = { ok: false, why: 'not checked', status: null };
  for (;;) {
    try {
      const r = await fetch(v.url, { redirect: 'follow', signal: AbortSignal.timeout(20e3), headers: { 'cache-control': 'no-cache' } });
      const body = await r.text().catch(() => '');
      if (!r.ok) last = { ok: false, status: r.status, why: `${v.url} answered ${r.status}` };
      else if (v.expect === 'sha' && sha && !body.includes(sha)) last = { ok: false, status: r.status, why: `${v.url} does not show commit ${sha} yet` };
      else if (v.expect && !['ok', 'sha'].includes(v.expect) && !body.includes(v.expect)) last = { ok: false, status: r.status, why: `${v.url} does not contain "${v.expect.slice(0, 60)}"` };
      else return { ok: true, status: r.status, why: v.expect === 'sha' && sha ? `${v.url} shows commit ${sha}` : `${v.url} answered ${r.status}` };
    } catch (e) { last = { ok: false, status: null, why: `${v.url}: ${e.cause?.code || e.message}` }; }
    if (Date.now() > until) return last;
    await new Promise(r => setTimeout(r, 10e3));
  }
}

// Code Tycoon itself: the running server is the new commit (when it was restarted) and the
// built UI is newer than the merge (when it was rebuilt)
async function verifySelf({ sha, since, restarted }) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/version`, { signal: AbortSignal.timeout(10e3) });
    const j = await r.json();
    if (restarted && sha && j.sha !== sha) return { ok: false, status: r.status, why: `the server runs ${j.sha || 'an unknown commit'}, not ${sha}` };
    const built = fs.statSync(path.join(SELF_ROOT, 'dist', 'index.html')).mtimeMs;
    if (since && built < since - 1000 && !restarted) return { ok: true, status: r.status, why: 'no UI or server change to ship; the app answers' };
    const page = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(10e3) });
    if (!page.ok) return { ok: false, status: page.status, why: 'the app page answered ' + page.status };
    return { ok: true, status: page.status, why: restarted ? `the server restarted on ${j.sha} and the app answers` : `rebuilt; the app on :${PORT} answers` };
  } catch (e) { return { ok: false, status: null, why: 'the app does not answer: ' + e.message }; }
}

// a picture of the live page, for the card (the user can't look at the output themselves)
export async function screenshot(url, id) {
  let browser;
  try {
    const { chromium } = await import(new URL('../node_modules/playwright/index.mjs', import.meta.url).href);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url, { waitUntil: 'load', timeout: 45e3 });
    await page.waitForTimeout(2500);
    fs.mkdirSync(SHOTS, { recursive: true });
    const file = path.join(SHOTS, id + '.png');
    await page.screenshot({ path: file });
    return file;
  } catch (e) { console.warn('[ship] screenshot:', e.message); return null; }
  finally { try { await browser?.close(); } catch {} }
}
export const shotFile = id => { const f = path.join(SHOTS, String(id).replace(/[^\w-]/g, '') + '.png'); return fs.existsSync(f) ? f : null; };

// ------------------------------------------------------------------ restarting this server
// In `npm run dev` the server already restarts itself when its files change.
export const devWatch = () => process.execArgv.some(a => a.startsWith('--watch'));
// A detached helper waits for this process to exit, then starts it again with the same command
// line, folder and environment (so CODETYCOON_PORT, _DB and the rest carry over), hidden,
// writing to server.log like the login launcher does.
export function restartSelf() {
  const launch = [process.execPath, [...process.execArgv, ...process.argv.slice(1)]];
  const log = path.join(DATA_DIR, 'server.log');
  const helper = `
const { spawn } = require('node:child_process'); const fs = require('node:fs');
const [pid, cmd, args, cwd, log] = [Number(process.argv[1]), process.argv[2], JSON.parse(process.argv[3]), process.argv[4], process.argv[5]];
const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
const t0 = Date.now();
(function wait() {
  if (alive() && Date.now() - t0 < 30000) return setTimeout(wait, 200);
  const fd = fs.openSync(log, 'a');
  spawn(cmd, args, { cwd, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] }).unref();
  setTimeout(() => process.exit(0), 500);
})();`;
  const fd = fs.openSync(log, 'a');
  spawn(process.execPath, ['-e', helper, String(process.pid), launch[0], JSON.stringify(launch[1]), process.cwd(), log],
    { cwd: process.cwd(), detached: true, windowsHide: true, stdio: ['ignore', fd, fd] }).unref();
  console.log('[ship] restarting the server on the new code');
  setTimeout(() => process.exit(0), 800);
}
