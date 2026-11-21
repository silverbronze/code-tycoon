// Git sync: keeps a project's checked-out branch level with its upstream, so two machines
// working on one repo (a PC and a cloud work container, two laptops) see each other's commits.
//
// Opt-in per project (kv gitsync:<pid> = { pull, push }); CODETYCOON_GITSYNC=pull|push|both
// sets the default for projects never switched. It never merges, rebases or forces by itself:
// - behind only: fast-forward, unless a session is working in the project, a merge or rebase
//   is in progress, or uncommitted/untracked files touch what is coming in (checked before
//   running git at all: even a merge git refuses rewrites dirty files under core.autocrlf)
// - ahead only: push the branch to its upstream
// - both: "diverged", left to the user; Rebase (rebaseNow) runs git rebase on a clean folder
//   and aborts on a conflict
// Runs every few minutes, right after a session's turn ends and after a board task merges.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { db, kvGet, kvSet } from './db.mjs';
import { trackedSet } from './indexer.mjs';
import { openSessions } from './live.mjs';

const TICK = 3 * 60e3;
// a background job must never wait on a password prompt or a credential window
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' };

function git(cwd, args, { timeout = 30e3, raw = false } = {}) {
  return new Promise(res => execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 32 << 20, env: ENV },
    (e, out, err) => res({ ok: !e, out: raw ? String(out || '') : String(out || '').trim(), err: String(err || '').trim() || String(e?.message || '') })));
}
const firstLine = s => (String(s).split('\n').map(l => l.replace(/^(fatal|error): /, '').trim()).find(Boolean) || 'git failed').slice(0, 200);

const DEFAULT = (() => {
  const v = String(process.env.CODETYCOON_GITSYNC || '').toLowerCase();
  return { pull: v === 'pull' || v === 'both', push: v === 'push' || v === 'both' };
})();
export function syncSettings(pid) { return { ...DEFAULT, ...(kvGet('gitsync:' + pid) || {}) }; }

const state = new Map();   // pid -> last result
const running = new Set(), again = new Set(), timers = new Map();
const listeners = [];
export function onSync(fn) { listeners.push(fn); }
const emit = msg => { for (const l of listeners) try { l(msg); } catch (e) { console.warn('[gitsync]', e.message); } };

export function syncStatus(pid) {
  const s = syncSettings(pid);
  return { pull: s.pull, push: s.push, running: running.has(pid), ...(state.get(pid) || { state: 'unknown' }) };
}
function put(pid, r) {
  const prev = state.get(pid);
  state.set(pid, { ...r, last: r.last || prev?.last || null, at: Date.now() });
  emit({ type: 'sync', pid, sync: syncStatus(pid) });
}

export function setSync(pid, b) {
  const cur = syncSettings(pid);
  const next = { pull: typeof b.pull === 'boolean' ? b.pull : cur.pull, push: typeof b.push === 'boolean' ? b.push : cur.push };
  kvSet('gitsync:' + pid, next);
  if (next.pull || next.push) syncSoon(pid, 0); else emit({ type: 'sync', pid, sync: syncStatus(pid) });
  return syncStatus(pid);
}

export function syncSoon(pid, delay = 5000) {
  if (!pid) return;
  clearTimeout(timers.get(pid));
  timers.set(pid, setTimeout(() => { timers.delete(pid); syncProject(pid); }, delay));
}

export async function syncProject(pid, { force = false } = {}) {
  const set = syncSettings(pid);
  if (!force && !set.pull && !set.push) return syncStatus(pid);
  if (running.has(pid)) { again.add(pid); return syncStatus(pid); }
  running.add(pid);
  emit({ type: 'sync', pid, sync: syncStatus(pid) });
  try { put(pid, await step(pid, set)); }
  catch (e) { put(pid, { state: 'error', msg: firstLine(e.message) }); }
  finally { running.delete(pid); if (again.delete(pid)) syncSoon(pid); }
  return syncStatus(pid);
}

async function repo(pid) {
  const root = db.prepare('SELECT root FROM projects WHERE id=?').get(pid)?.root;
  if (!root || !fs.existsSync(root)) return { error: { state: 'no-repo', msg: 'project folder not found' } };
  const top = await git(root, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { error: { state: 'no-repo', msg: 'not a git repository' } };
  const dir = top.out;
  const br = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!br.ok) return { error: { state: 'detached', msg: 'no branch checked out' } };
  const up = await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!up.ok) return { error: { state: 'no-upstream', branch: br.out, msg: `${br.out} has no upstream branch (push it once with git push -u)` } };
  const remote = (await git(dir, ['config', '--get', `branch.${br.out}.remote`])).out || up.out.split('/')[0];
  const merge = (await git(dir, ['config', '--get', `branch.${br.out}.merge`])).out.replace(/^refs\/heads\//, '') || br.out;
  return { dir, branch: br.out, upstream: up.out, remote, merge };
}

async function counts(dir) {
  const c = await git(dir, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
  const [ahead, behind] = c.out.split(/\s+/).map(Number);
  return { ahead: ahead || 0, behind: behind || 0 };
}

// why a fast-forward has to wait (null: go ahead)
async function blockers(pid, dir) {
  if (openSessions(pid).some(s => s.state === 'working')) return 'a session is working in this project';
  const gd = path.resolve(dir, (await git(dir, ['rev-parse', '--git-dir'])).out);
  for (const f of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD']) if (fs.existsSync(path.join(gd, f))) return 'a merge or rebase is in progress';
  const incoming = new Set((await git(dir, ['diff', '--name-only', 'HEAD', '@{u}'])).out.split('\n').filter(Boolean));
  const st = await git(dir, ['status', '--porcelain', '-z', '--untracked-files=all'], { raw: true });
  // "XY path" entries, not trimmed (X may be a space)
  const dirty = st.out.split('\0').filter(Boolean).map(s => /^.. /.test(s) ? s.slice(3) : s).filter(f => incoming.has(f));
  if (dirty.length) return `uncommitted changes in ${dirty.length} incoming file${dirty.length > 1 ? 's' : ''}: ${dirty.slice(0, 3).join(', ')}`;
  return null;
}

async function step(pid, set) {
  const r = await repo(pid);
  if (r.error) return r.error;
  const base = { branch: r.branch, upstream: r.upstream };
  const f = await git(r.dir, ['fetch', '--quiet', r.remote], { timeout: 90e3 });
  if (!f.ok) return { ...base, state: 'error', msg: 'fetch failed: ' + firstLine(f.err) };
  const { ahead, behind } = await counts(r.dir);
  Object.assign(base, { ahead, behind });
  if (ahead && behind) return { ...base, state: 'diverged', msg: `${ahead} local and ${behind} remote commit${behind > 1 ? 's' : ''} differ: rebase, or merge by hand` };
  if (behind) {
    if (!set.pull) return { ...base, state: 'behind' };
    const why = await blockers(pid, r.dir);
    if (why) return { ...base, state: 'waiting', msg: why };
    const m = await git(r.dir, ['merge', '--ff-only', '--quiet', '@{u}']);
    if (!m.ok) return { ...base, state: 'error', msg: 'fast-forward failed: ' + firstLine(m.err) };
    emit({ type: 'pulled', pid, n: behind });
    return { ...base, behind: 0, state: 'synced', last: { kind: 'pulled', n: behind, at: Date.now() } };
  }
  if (ahead) {
    if (!set.push) return { ...base, state: 'ahead' };
    const p = await git(r.dir, ['push', '--quiet', r.remote, `HEAD:refs/heads/${r.merge}`], { timeout: 90e3 });
    if (!p.ok) return { ...base, state: 'error', msg: 'push failed: ' + firstLine(p.err) };
    return { ...base, ahead: 0, state: 'synced', last: { kind: 'pushed', n: ahead, at: Date.now() } };
  }
  return { ...base, state: 'synced' };
}

// diverged: replay the local commits on the upstream (clean folder only; a conflict is aborted)
export async function rebaseNow(pid) {
  if (running.has(pid)) return { error: 'busy' };
  running.add(pid);
  try {
    const r = await repo(pid);
    if (r.error) return { error: r.error.msg };
    if (openSessions(pid).some(s => s.state === 'working')) return { error: 'a session is working in this project' };
    const st = await git(r.dir, ['status', '--porcelain', '--untracked-files=no'], { raw: true });
    if (st.out.trim()) return { error: 'commit or stash the uncommitted changes first' };
    const f = await git(r.dir, ['fetch', '--quiet', r.remote], { timeout: 90e3 });
    if (!f.ok) return { error: 'fetch failed: ' + firstLine(f.err) };
    const b =await git(r.dir, ['rebase', '@{u}'], { timeout: 120e3 });
    if (!b.ok) {
      await git(r.dir, ['rebase', '--abort']);
      return { error: 'the rebase hit conflicts and was undone: merge by hand' };
    }
    emit({ type: 'pulled', pid, n: 0 });
  } finally { running.delete(pid); }
  return { ok: true, sync: await syncProject(pid, { force: true }) };
}

function tick() {
  for (const pid of trackedSet()) { const s = syncSettings(pid); if (s.pull || s.push) syncProject(pid); }
}
setInterval(tick, TICK).unref();
setTimeout(tick, 60e3).unref();
