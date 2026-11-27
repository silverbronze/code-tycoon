// A git worktree per board task, so several tasks can work in one project at once.
//
// Each task gets <repo>/.claude/worktrees/task-<id> on its own branch task/<id>, made
// from the branch the main folder is on. Files git ignores (node_modules, .env, data
// folders) are not in a fresh checkout, so they are linked (folders, as junctions) or
// copied (small files) from the main folder. When the task is done the board commits
// what is left, merges the branch into the base branch in the main folder, and removes
// the worktree. paths.mjs folds .claude/worktrees/<name> out of every path, so a session
// in a worktree walks the project's own city.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DIR = path.join('.claude', 'worktrees');
const COPY_MAX = 5 * 1024 * 1024; // ignored files above this are linked, not copied
const LINK_MAX = 300;

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function tryGit(cwd, args) {
  try { return { ok: true, out: git(cwd, args) }; }
  catch (e) { return { ok: false, code: e.status, out: (String(e.stdout || '') + '\n' + String(e.stderr || '')).trim() }; }
}

// the repo a project folder sits in: its top folder, the folder's place in it, and the
// branch checked out there (null: not a repo, no commit yet, or a detached HEAD)
export function repoOf(root) {
  const top = tryGit(root, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return null;
  const branch = tryGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch.ok || !tryGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).ok) return null;
  const t = path.resolve(top.out);
  return { top: t, prefix: path.relative(t, path.resolve(root)), branch: branch.out };
}

// keep the worktrees out of the main folder's git status (and out of a `git add -A`)
function excludeWorktrees(top) {
  const common = path.resolve(top, git(top, ['rev-parse', '--git-common-dir']));
  const f = path.join(common, 'info', 'exclude');
  let s = ''; try { s = fs.readFileSync(f, 'utf8'); } catch {}
  if (/^\/\.claude\/worktrees\/?$/m.test(s)) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, (s && !s.endsWith('\n') ? '\n' : '') + '/.claude/worktrees/\n');
}

// what git ignores in the main folder, linked or copied into the worktree
function bringIgnored(top, dir) {
  const r = tryGit(top, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
  if (!r.ok) return [];
  const links = [];
  for (const e of r.out.split('\0').filter(Boolean).slice(0, 5000)) {
    const rel = e.replace(/\/$/, '');
    if (!rel || /^\.claude\/worktrees(\/|$)/.test(rel) || /(^|\/)\.git(\/|$)/.test(rel)) continue;
    const src = path.join(top, rel), dst = path.join(dir, rel);
    if (fs.existsSync(dst)) continue;
    let st; try { st = fs.statSync(src); } catch { continue; }
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      if (st.isDirectory()) { if (links.length < LINK_MAX) { fs.symlinkSync(src, dst, 'junction'); links.push(rel); } }
      // a hard link: the same file as in the main folder (a results log appended in the
      // worktree is appended there too); a copy where linking fails (another drive)
      else { try { fs.linkSync(src, dst); } catch { if (st.size <= COPY_MAX) fs.copyFileSync(src, dst); } }
    } catch {}
  }
  return links;
}

// Ignored files the session made or rewrote in the worktree (outputs, logs, renders) are
// copied to the main folder before the worktree goes, so nothing it produced is lost.
// Hard-linked files are already the main folder's own; a main-folder file changed since
// the worktree was made is left alone.
export function keepIgnored(w) {
  const r = tryGit(w.dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']);
  if (!r.ok) return [];
  const inLink = rel => (w.links || []).some(l => rel === l || rel.startsWith(l + '/'));
  const kept = [];
  for (const rel of r.out.split('\0').filter(Boolean).slice(0, 20000)) {
    if (inLink(rel) || /(^|\/)node_modules\//.test(rel)) continue;
    const src = path.join(w.dir, rel), dst = path.join(w.top, rel);
    try {
      const s = fs.lstatSync(src);
      if (!s.isFile()) continue;
      let d = null; try { d = fs.statSync(dst); } catch {}
      if (d && (d.ino === s.ino && d.dev === s.dev)) continue; // the same file
      if (d && (s.mtimeMs <= (w.made || 0) || d.mtimeMs > (w.made || 0))) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      kept.push(rel);
    } catch {}
  }
  return kept;
}

const branchFor = id => 'task/' + id;
export const worktreeDir = (top, id) => path.join(top, DIR, 'task-' + id);

// a fresh worktree for a task (the same folder every time, so its session resumes there)
export function makeWorktree(id, root) {
  const r = repoOf(root);
  if (!r) return null;
  excludeWorktrees(r.top);
  const dir = worktreeDir(r.top, id), branch = branchFor(id);
  tryGit(r.top, ['worktree', 'prune']);
  // the branch may be left from an earlier round that was not merged: carry on with it
  const has = tryGit(r.top, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch]).ok;
  const add = tryGit(r.top, has ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, r.branch]);
  if (!add.ok) throw new Error('git worktree add failed: ' + add.out.slice(0, 300));
  const links = bringIgnored(r.top, dir);
  return { dir, cwd: path.join(dir, r.prefix), top: r.top, branch, base: r.branch, links, made: Date.now(), merge: { state: 'working' } };
}

// links and junctions go first: a recursive delete must never follow one into the main folder
function unlinkAll(w) {
  for (const rel of w.links || []) {
    const p = path.join(w.dir, rel);
    try { const st = fs.lstatSync(p); if (st.isSymbolicLink()) { try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); } } } catch {}
  }
  // anything else that links out (made by the session itself)
  const walk = (d, depth) => {
    if (depth > 6) return;
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) { try { fs.unlinkSync(p); } catch { try { fs.rmdirSync(p); } catch {} } }
      else if (e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules') walk(p, depth + 1);
    }
  };
  walk(w.dir, 0);
}

// remove the worktree folder; the branch stays unless it is merged
export function dropWorktree(w, { deleteBranch = false } = {}) {
  if (!w) return;
  if (fs.existsSync(w.dir)) keepIgnored(w);
  unlinkAll(w);
  for (const rel of w.links || []) { try { if (fs.lstatSync(path.join(w.dir, rel)).isSymbolicLink()) return; } catch {} } // a link survived: leave it all
  tryGit(w.top, ['worktree', 'remove', '--force', w.dir]);
  if (fs.existsSync(w.dir)) { unlinkAll(w); try { fs.rmSync(w.dir, { recursive: true, force: true }); } catch {} tryGit(w.top, ['worktree', 'prune']); }
  if (deleteBranch) tryGit(w.top, ['branch', '-d', w.branch]);
}

// commit whatever the session left in the worktree (links excluded)
export function commitAll(w, message) {
  if (!fs.existsSync(w.dir)) return false;
  tryGit(w.dir, ['add', '-A', '--', '.', ...(w.links || []).map(l => ':(exclude)' + l)]);
  if (tryGit(w.dir, ['diff', '--cached', '--quiet']).ok) return false;
  const c = tryGit(w.dir, ['commit', '--no-verify', '-m', message]);
  if (!c.ok) throw new Error('commit failed: ' + c.out.slice(0, 300));
  return true;
}

export const ahead = w => Number(tryGit(w.top, ['rev-list', '--count', `${w.base}..${w.branch}`]).out) || 0;

// The main folder moved to another branch while the task ran (the user started a feature
// branch): the task merges into the branch the user is on now, not the one it began from,
// or it waits forever for a branch nobody comes back to. Returns the old base, or null.
export function followBase(w) {
  const cur = tryGit(w.top, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!cur.ok || !cur.out || cur.out === w.base || cur.out === w.branch) return null;
  const from = w.base;
  w.from = w.from || from;
  w.base = cur.out;
  return from;
}
// the branch's work is already in its base (someone merged it by hand): its own commits,
// counted from the base it was made from, are all reachable from the current base
export const mergedAlready = w => !!w.from && !ahead(w) && (Number(tryGit(w.top, ['rev-list', '--count', `${w.from}..${w.branch}`]).out) || 0) > 0;
export const changedFiles = w => tryGit(w.top, ['diff', '--name-only', `${w.base}...${w.branch}`]).out.split('\n').filter(Boolean);

// would the branch merge into its base cleanly? (nothing is touched)
export function predict(w) {
  const r = tryGit(w.top, ['merge-tree', '--write-tree', '--name-only', '--no-messages', w.base, w.branch]);
  if (r.ok) return { clean: true, files: [] };
  if (r.code === 1) return { clean: false, files: r.out.split('\n').slice(1).map(s => s.trim()).filter(Boolean) };
  throw new Error('git merge-tree failed: ' + r.out.slice(0, 300));
}

// merge the task branch into its base in the main folder
// -> { ok, sha } | { ok: false, why, files? }
export function mergeIntoBase(w, message) {
  const cur = tryGit(w.top, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!cur.ok || cur.out !== w.base) return { ok: false, why: `the main folder is on ${cur.ok ? 'branch ' + cur.out : 'a detached HEAD'}, not ${w.base}` };
  const mergeHead = path.join(path.resolve(w.top, git(w.top, ['rev-parse', '--git-dir'])), 'MERGE_HEAD');
  if (fs.existsSync(mergeHead)) return { ok: false, why: 'the main folder is in the middle of a merge' };
  // uncommitted changes in files the branch touches: wait, without running git merge at all
  // (even a merge git refuses rewrites those files' line endings under core.autocrlf)
  const touched = new Set(changedFiles(w));
  let st = '';
  try { st = execFileSync('git', ['-C', w.top, 'status', '--porcelain', '-z', '--untracked-files=all'], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch {}
  // "XY path" entries (not trimmed: X may be a space); a rename's old path is its own entry
  const dirty = st.split('\0').filter(Boolean).map(s => /^.. /.test(s) ? s.slice(3) : s).filter(f => touched.has(f));
  if (dirty.length) return { ok: false, why: 'uncommitted changes in the main folder touch the same files', files: dirty.slice(0, 20) };
  const m = tryGit(w.top, ['merge', '--no-ff', '--no-edit', '-m', message, w.branch]);
  if (m.ok) return { ok: true, sha: git(w.top, ['rev-parse', '--short', 'HEAD']) };
  // only a merge git started is undone; one it refused up front left nothing to undo
  if (fs.existsSync(mergeHead)) tryGit(w.top, ['merge', '--abort']);
  const files = [...m.out.matchAll(/^\t(.+)$/gm)].map(x => x[1].trim());
  const why = /would be overwritten|untracked working tree files/.test(m.out)
    ? 'uncommitted changes in the main folder touch the same files' : m.out.split('\n').find(l => l.trim())?.slice(0, 200) || 'git merge failed';
  return { ok: false, why, files };
}

// bring the base into the task branch inside the worktree, leaving conflicts to resolve
export function mergeBaseIn(w) {
  const r = tryGit(w.dir, ['merge', '--no-ff', '--no-edit', w.base]);
  if (r.ok) return { clean: true, files: [] };
  const files = tryGit(w.dir, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean);
  if (!files.length) { tryGit(w.dir, ['merge', '--abort']); throw new Error('git merge failed: ' + r.out.slice(0, 300)); }
  return { clean: false, files };
}
export function unresolved(w, files) {
  return files.filter(f => { try { return /^(<{7}|>{7})( |$)/m.test(fs.readFileSync(path.join(w.dir, f), 'utf8')); } catch { return false; } });
}
export function finishMerge(w) {
  tryGit(w.dir, ['add', '-A', '--', '.', ...(w.links || []).map(l => ':(exclude)' + l)]);
  const c = tryGit(w.dir, ['commit', '--no-verify', '--no-edit']);
  if (!c.ok && !/nothing to commit/.test(c.out)) throw new Error('commit failed: ' + c.out.slice(0, 300));
}
export function abortMerge(w) { tryGit(w.dir, ['merge', '--abort']); }

// Undo a task's merges on the main folder's branch (newest first), as new revert commits.
// Like mergeIntoBase, it does not run git at all when uncommitted changes touch the same files.
// -> { ok, sha } | { ok: false, why }
export function revertMerges(top, shas) {
  const files = new Set();
  for (const s of shas) for (const f of tryGit(top, ['diff', '--name-only', `${s}^1`, s]).out.split('\n').filter(Boolean)) files.add(f);
  let st = '';
  try { st = execFileSync('git', ['-C', top, 'status', '--porcelain', '-z', '--untracked-files=all'], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch {}
  const dirty = st.split('\0').filter(Boolean).map(s => /^.. /.test(s) ? s.slice(3) : s).filter(f => files.has(f));
  if (dirty.length) return { ok: false, why: 'uncommitted changes in the main folder touch the same files: ' + dirty.slice(0, 3).join(', ') };
  for (const s of [...shas].reverse()) {
    const parents = tryGit(top, ['rev-list', '--parents', '-n', '1', s]).out.split(/\s+/).length - 1;
    const r = tryGit(top, ['revert', '--no-edit', ...(parents > 1 ? ['-m', '1'] : []), s]);
    if (!r.ok) { tryGit(top, ['revert', '--abort']); return { ok: false, why: 'git revert failed: ' + r.out.split('\n').find(l => l.trim())?.slice(0, 200) }; }
  }
  return { ok: true, sha: tryGit(top, ['rev-parse', '--short', 'HEAD']).out };
}
