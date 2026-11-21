// The project pass: every folder Code Tycoon knows a session ran in, and what of it
// exists only on this disk (no remote, unpushed commits, uncommitted changes,
// ignored files such as .env that git will never carry).
import fs from 'node:fs';
import path from 'node:path';
import { norm, key, isTempPath, OWN_DIR_RE, PROJECTS_DIR } from '../paths.mjs';
import { git, pool, treeSize } from './util.mjs';

// Ignored files a fresh clone rebuilds by itself.
const REBUILT = /(^|\/)(node_modules|dist|build|out|target|\.next|\.nuxt|\.svelte-kit|\.turbo|\.cache|\.parcel-cache|coverage|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.gradle|\.idea|\.vs|\.vscode|bin|obj|\.claude\/worktrees|\.tox|vendor|Pods|\.dart_tool|\.expo|\.terraform)(\/|$)|\.(pyc|pyo|class|o|obj|tsbuildinfo|log)$|(^|\/)(\.DS_Store|Thumbs\.db)$/i;
const SECRETISH = /(^|\/)(\.env(\..*)?|\.envrc|.*\.(pem|key|p12|pfx|jks|keystore|ppk)|.*credentials.*|.*secret.*|.*token.*|id_(rsa|ed25519|ecdsa)[^/]*|\.npmrc|\.pypirc|.*service[-_]account.*\.json)$/i;

const EXAMPLE = /\.(example|sample|template|dist|defaults?)$/i;
// cloud-synced folders are backed up already
const SYNCED = /\/(Seafile|OneDrive[^/]*|Dropbox|Google Drive|My Drive|iCloud ?Drive|Nextcloud|ownCloud|pCloud Drive)(\/|$)/i;
export const syncedBy = root => (SYNCED.exec(root) || [])[1] || null;

// Folders from the database plus the cwd of every transcript folder, so the audit
// also works on a machine where the server has never run.
export async function knownRoots(home) {
  const roots = new Map();
  const add = (p, name) => { const n = norm(p); if (n && !roots.has(key(n))) roots.set(key(n), { root: n, name: name || path.basename(n) }); };
  try {
    const { db } = await import('../db.mjs');
    for (const p of db.prepare('SELECT root, name FROM projects ORDER BY last_ts DESC').all()) if (p.root) add(p.root, p.name);
  } catch {}
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch {}
  for (const d of dirs) {
    const cwd = transcriptCwd(path.join(PROJECTS_DIR, d));
    if (cwd) add(cwd);
  }
  const h = key(home);
  const testHome = isTempPath(home); // a scratch home under Temp (tests): its own folders count
  return [...roots.values()].filter(r => {
    const k = key(r.root);
    return k !== h && k.length > 3 && (!isTempPath(r.root) || (testHome && k.startsWith(h + '/'))) && !OWN_DIR_RE.test(r.root + '/') && !/\/\.claude(\/|$)/i.test(r.root) && fs.existsSync(r.root);
  });
}

function transcriptCwd(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t); } catch { return null; }
  for (const { f } of files.slice(0, 3)) {
    try {
      const fd = fs.openSync(path.join(dir, f), 'r'), buf = Buffer.alloc(65536);
      const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
      const m = /"cwd":"((?:[^"\\]|\\.)+)"/.exec(buf.subarray(0, n).toString('utf8'));
      if (m) return JSON.parse('"' + m[1] + '"');
    } catch {}
  }
  return null;
}

// Collapse nested roots: a project inside another tracked project's repo is the same repo.
async function repoTop(root) {
  const r = await git(root, ['rev-parse', '--show-toplevel']);
  if (r.ok) return norm(r.out);
  // git busy or mid-rewrite (another session's index.lock): a .git folder still means a repo
  return fs.existsSync(path.join(root, '.git')) ? norm(root) : null;
}

export async function scanProjects(home) {
  const roots = await knownRoots(home);
  const seen = new Map();
  const out = await pool(roots, 6, async r => {
    const top = await repoTop(r.root);
    if (top && seen.has(key(top))) return null;
    if (top) seen.set(key(top), true);
    return top ? gitProject({ ...r, root: top, name: path.basename(top) }) : plainFolder(r);
  });
  // a folder inside another known folder is part of it
  const list = out.filter(Boolean);
  const inside = (a, b) => key(a.root).startsWith(key(b.root) + '/');
  return list.filter(p => !list.some(q => q !== p && inside(p, q)))
    .map(p => ({ ...p, synced: syncedBy(p.root) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function gitProject(p) {
  const cwd = p.root;
  const [remotes, branch, head, status, ahead, refs, ignored, count] = await Promise.all([
    git(cwd, ['remote', '-v']),
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['rev-parse', 'HEAD']),
    git(cwd, ['status', '--porcelain', '-uall']),
    // commits on local branches that no remote has
    git(cwd, ['rev-list', '--count', '--branches', '--not', '--remotes']),
    git(cwd, ['for-each-ref', '--format=%(refname:short)\t%(upstream:short)\t%(upstream:track)', 'refs/heads']),
    git(cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory']),
    git(cwd, ['rev-list', '--count', '--all']),
  ]);
  const remoteList = [...new Set(remotes.out.split('\n').filter(Boolean).map(l => l.split(/\s+/).slice(0, 2).join(' ')))]
    .map(l => { const [name, url] = l.split(' '); return { name, url }; });
  const origin = remoteList.find(r => r.name === 'origin') || remoteList[0] || null;
  const dirty = status.out ? status.out.split('\n').filter(Boolean) : [];
  const commits = Number(count.out) || 0;
  const unpushedBranches = refs.out.split('\n').filter(Boolean).map(l => l.split('\t'))
    .filter(([, up, track]) => !up || /ahead/.test(track)).map(([name, up, track]) => ({ name, upstream: up || null, ahead: Number((/ahead (\d+)/.exec(track) || [])[1]) || null }));
  const localOnly = ignoredFiles(cwd, ignored.out);
  return {
    name: p.name, root: cwd, git: true,
    remote: origin?.url || null, remotes: remoteList,
    branch: branch.ok ? branch.out : null, head: head.ok ? head.out : null, commits,
    unpushed: remoteList.length ? Number(ahead.out) || 0 : commits,
    unpushedBranches: remoteList.length ? unpushedBranches.filter(b => b.ahead || !b.upstream) : [],
    dirty: dirty.length, untracked: dirty.filter(l => l.startsWith('??')).length,
    localOnly,
  };
}

// What `git ls-files --ignored --directory` lists, minus what a build makes again.
function ignoredFiles(cwd, out) {
  const secrets = [], data = [];
  for (const rel of out.split('\n').map(s => s.trim()).filter(Boolean)) {
    const r = rel.replace(/\/$/, '');
    if (REBUILT.test(r)) continue;
    const abs = path.join(cwd, r);
    const st = (() => { try { return fs.statSync(abs); } catch { return null; } })();
    if (!st) continue;
    const size = st.isDirectory() ? treeSize(abs, 20000).size : st.size;
    (SECRETISH.test(r) && !EXAMPLE.test(r) && !st.isDirectory() ? secrets : data).push({ path: r, size, dir: st.isDirectory() });
  }
  data.sort((a, b) => b.size - a.size);
  return { secrets, data: data.slice(0, 30), dataBytes: data.reduce((s, d) => s + d.size, 0), dataCount: data.length };
}

function plainFolder(p) {
  const t = treeSize(p.root, 50000);
  return { name: p.name, root: p.root, git: false, remote: null, remotes: [], commits: 0, unpushed: 0, unpushedBranches: [], dirty: 0, untracked: 0, size: t.size, files: t.files,
    localOnly: { secrets: [], data: [], dataBytes: 0, dataCount: 0 } };
}
