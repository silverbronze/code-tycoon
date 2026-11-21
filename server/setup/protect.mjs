// code-tycoon protect: put every project the audit flags somewhere safe, with no
// clicking around on GitHub.
//   not in git      -> .gitignore first (shown), git init, commit, private repo, push
//   no remote       -> private repo, push every branch
//   on a remote already -> never pushed to the person's branches (CI may deploy them):
//                      branch tips and uncommitted work go to hidden backup refs
//                      refs/codetycoon/backup/<branch> and refs/codetycoon/wip/<branch>
// Uncommitted work is committed in a temporary index, so the person's index, branches
// and files are untouched. The guard (guardTick) repeats the pushes from the server.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, norm, key } from '../paths.mjs';
import { git as gitRun, fmtBytes, lstat } from './util.mjs';
import { scanProjects } from './projects.mjs';
import { createRepo, gitAuth, githubToken, whoami, installed, installUrl } from './github.mjs';

const STATE = path.join(DATA_DIR, 'protect.json');
export function protectState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { provider: null, projects: {} }; } }
function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); }

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const git = (cwd, args, t) => gitRun(cwd, args, t, ENV);

// ---------------------------------------------------------------- .gitignore

const BASE = ['node_modules/', '.venv/', 'venv/', '__pycache__/', '*.pyc', 'dist/', 'build/', '.next/', '.nuxt/', '.svelte-kit/', '.turbo/', '.cache/',
  'coverage/', 'target/', '.gradle/', '.idea/', '.vs/', '*.log', '.DS_Store', 'Thumbs.db', 'desktop.ini',
  '.env', '.env.*', '!.env.example', '!.env.sample', '!.env.template', '*.pem', '*.key', '*.p12', '*.pfx', '*credentials*.json', '*service-account*.json',
  '.claude/worktrees/', '.claude/settings.local.json'];
const SKIP_DIRS = /^(node_modules|\.venv|venv|__pycache__|dist|build|\.next|\.nuxt|\.svelte-kit|\.turbo|\.cache|coverage|target|\.gradle|\.idea|\.vs|\.git)$/i;
const MEDIA = /\.(mp4|mov|avi|mkv|webm|m4v|wav|mp3|flac|aac|ogg|m4a|psd|psb|ai|blend|fbx|obj|glb|zip|rar|7z|tar|gz|tgz|bz2|xz|iso|dmg|exe|msi|bin|dll|so|dylib|onnx|pt|pth|ckpt|safetensors|gguf|h5|pkl|parquet|sqlite|sqlite3|db|mdb|accdb|session)$/i;
const DATA_DIR_NAME = /^(data|datasets?|raw|outputs?|renders?|runs|archive|archives|backups?|tmp|temp|logs?|downloads|cache|checkpoints|models|weights|recordings|exports?)$/i;
const BIG_FILE = 50 << 20, GITHUB_MAX = 95 << 20, MAX_COMMIT = 1 << 30;

// What a first commit would take and leave out. Nothing is written.
export function ignorePlan(root) {
  const rules = [...BASE], left = [], exts = new Set();
  let files = 0, bytes = 0;
  const dirSize = d => { let n = 0; const st = [d]; while (st.length) { const x = st.pop(); let es; try { es = fs.readdirSync(x, { withFileTypes: true }); } catch { continue; } for (const e of es) { if (e.isSymbolicLink()) continue; const p = path.join(x, e.name); if (e.isDirectory()) st.push(p); else if (e.isFile()) n += lstat(p)?.size || 0; } } return n; };
  const walk = rel => {
    let es; try { es = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.test(e.name)) continue;
        if (DATA_DIR_NAME.test(e.name)) {
          const size = dirSize(path.join(root, r));
          if (size > 20 << 20) { rules.push('/' + r + '/'); left.push({ path: r + '/', size, why: 'data folder' }); continue; }
        }
        walk(r); continue;
      }
      if (!e.isFile() || /^\.env(\.|$)/.test(e.name) && !/\.(example|sample|template)$/.test(e.name)) continue;
      const size = lstat(path.join(root, r))?.size || 0;
      const ext = (/\.[^./]+$/.exec(e.name) || [''])[0].toLowerCase();
      if (MEDIA.test(e.name)) { exts.add(ext); left.push({ path: r, size, why: 'media or binary' }); continue; }
      if (size > BIG_FILE) { rules.push('/' + r); left.push({ path: r, size, why: `over ${fmtBytes(BIG_FILE)}` }); continue; }
      files++; bytes += size;
    }
  };
  walk('');
  for (const x of [...exts].sort()) rules.push('*' + x);
  left.sort((a, b) => b.size - a.size);
  return { rules, files, bytes, left, leftBytes: left.reduce((n, l) => n + l.size, 0) };
}

function writeIgnore(root, rules) {
  const f = path.join(root, '.gitignore');
  const had = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  const have = new Set(had.split(/\r?\n/).map(s => s.trim()));
  const add = rules.filter(r => !have.has(r));
  if (!add.length) return;
  fs.writeFileSync(f, (had && !had.endsWith('\n') ? had + '\n' : had) + (had ? '\n' : '') + '# added by Code Tycoon (code-tycoon protect)\n' + add.join('\n') + '\n');
}

// ---------------------------------------------------------------- providers

const repoName = s => s.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 90) || 'project';

// provider: { kind: 'github', owner? } or { kind: 'folder', dir }
async function makeRemote(provider, name) {
  if (provider.kind === 'folder') {
    const dir = path.join(provider.dir, repoName(name) + '.git');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      const r = await git(dir, ['init', '--bare', '-b', 'main']);
      if (!r.ok) throw new Error('git init --bare failed: ' + r.err);
    }
    return { url: norm(dir), full: norm(dir) };
  }
  if (provider.kind === 'github') return createRepo(repoName(name), provider.owner || null);
  throw new Error('unknown remote kind ' + provider.kind);
}

export function parseTarget(t) {
  if (!t) return null;
  const m = /^github(?::(.+))?$/i.exec(t);
  if (m) return { kind: 'github', owner: m[1] || null };
  return { kind: 'folder', dir: path.resolve(t) };
}

export async function providerReady(provider) {
  if (!provider) return { ok: false, why: 'no remote chosen' };
  if (provider.kind === 'folder') return { ok: true, label: provider.dir };
  const login = await whoami();
  if (!login) return { ok: false, why: githubToken() ? 'the GitHub token was refused' : 'not signed in to GitHub' };
  if (!await installed()) return { ok: false, why: `install the Code Tycoon app on your account with "All repositories": ${installUrl()}`, install: installUrl() };
  return { ok: true, label: `GitHub ${provider.owner || login}`, login };
}

// ---------------------------------------------------------------- per project

// A commit of the whole working tree (tracked and untracked, minus ignored and secret
// files), on top of HEAD, made in a temporary index. Returns its hash, or null when clean.
async function wipCommit(root) {
  const st = await git(root, ['status', '--porcelain']);
  if (!st.ok || !st.out) return null;
  const tmpIndex = path.join(os.tmpdir(), `ct-index-${process.pid}-${Date.now()}`);
  const env = { ...ENV, GIT_INDEX_FILE: tmpIndex };
  const g = args => gitRun(root, args, 60000, env);
  try {
    const head = await git(root, ['rev-parse', '--verify', 'HEAD']);
    if (head.ok) await g(['read-tree', 'HEAD']);
    await g(['add', '-A']);
    const names = (await g(['diff', '--cached', '--name-only', ...(head.ok ? ['HEAD'] : [])])).out.split('\n').filter(Boolean);
    const secret = names.filter(n => (/(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)[^/]*)$/i.test(n) && !/\.(example|sample|template)$/i.test(n))
      || (lstat(path.join(root, n))?.size || 0) > GITHUB_MAX);
    if (secret.length) await g(['rm', '--cached', '-q', '--', ...secret]);
    const tree = await g(['write-tree']);
    if (!tree.ok) return null;
    const c = await gitRun(root, ['-c', 'user.name=Code Tycoon', '-c', 'user.email=protect@codetycoon.local', 'commit-tree', tree.out, ...(head.ok ? ['-p', head.out] : []), '-m', 'Code Tycoon backup of uncommitted work'], 30000, ENV);
    return c.ok ? c.out : null;
  } finally { fs.rmSync(tmpIndex, { force: true }); }
}

async function push(root, url, refspecs, log) {
  if (!refspecs.length) return true;
  const r = await git(root, [...gitAuth(url), 'push', '--force', url, ...refspecs], 600000);
  if (!r.ok) log(`    ! push failed: ${r.err.split('\n').filter(Boolean).pop()}`);
  return r.ok;
}

async function identityArgs(root) {
  const n = await git(root, ['config', 'user.name']), e = await git(root, ['config', 'user.email']);
  if (n.out && e.out) return [];
  const u = os.userInfo().username;
  return ['-c', `user.name=${n.out || u}`, '-c', `user.email=${e.out || u + '@' + os.hostname()}`];
}

// What protect would do for one scanned project.
export function stepsFor(p, state) {
  const mine = state.projects[key(p.root)];
  if (p.synced && !mine) return null;
  if (!p.git) return { kind: 'init', p };
  if (!p.remotes.length) return { kind: 'remote', p };
  const own = mine?.own && p.remotes.some(r => r.url === mine.remote);
  if (own && (p.unpushed || p.dirty)) return { kind: 'own', p };
  if (p.unpushedBranches.length || p.dirty) return { kind: 'backup', p };
  return null;
}

async function protectOne(step, provider, state, log) {
  const p = step.p, root = p.root;
  const rec = state.projects[key(root)] || {};
  if (step.kind === 'init') {
    const plan = ignorePlan(root);
    if (plan.bytes > MAX_COMMIT) throw new Error(`a first commit would be ${fmtBytes(plan.bytes)}; review the .gitignore first`);
    writeIgnore(root, plan.rules);
    let r = await git(root, ['init', '-b', 'main']);
    if (!r.ok) throw new Error('git init failed: ' + r.err);
    await git(root, ['add', '-A'], 300000);
    // GitHub refuses files over 100 MB; anything that slipped through comes out again
    const staged = (await git(root, ['ls-files', '-s', '--', '.'])).out.split('\n').filter(Boolean).map(l => l.split('\t')[1]);
    const huge = staged.filter(f => (lstat(path.join(root, f))?.size || 0) > GITHUB_MAX);
    if (huge.length) { writeIgnore(root, huge.map(f => '/' + f)); await git(root, ['rm', '--cached', '-q', '--', ...huge]); await git(root, ['add', '.gitignore']); }
    r = await git(root, [...await identityArgs(root), 'commit', '-q', '-m', 'First commit (by Code Tycoon: data, media and secrets left out, see .gitignore)'], 300000);
    if (!r.ok) throw new Error('git commit failed: ' + r.err);
    log(`    committed ${plan.files} files (${fmtBytes(plan.bytes)}); left out ${plan.left.length} (${fmtBytes(plan.leftBytes)})`);
  }
  if (step.kind === 'init' || step.kind === 'remote') {
    const remote = await makeRemote(provider, p.name);
    const has = await git(root, ['remote', 'get-url', 'origin']);
    await git(root, has.ok ? ['remote', 'add', 'codetycoon', remote.url] : ['remote', 'add', 'origin', remote.url]);
    const name = has.ok ? 'codetycoon' : 'origin';
    const ok = await push(root, remote.url, ['refs/heads/*:refs/heads/*', 'refs/tags/*:refs/tags/*'], log);
    if (!ok) throw new Error('push failed');
    // the person's branches track the new remote, as if they had pushed with -u
    for (const b of (await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).out.split('\n').filter(Boolean)) {
      await git(root, ['config', `branch.${b}.remote`, name]); await git(root, ['config', `branch.${b}.merge`, `refs/heads/${b}`]);
    }
    await git(root, ['fetch', '-q', ...gitAuth(remote.url), name]);
    Object.assign(rec, { remote: remote.url, full: remote.full, own: true, provider: provider.kind });
    log(`    pushed to ${remote.full}`);
  }
  const url = rec.own ? rec.remote : p.remote;
  if (step.kind === 'own') {
    await push(root, url, ['refs/heads/*:refs/heads/*'], log);
  }
  if (step.kind === 'backup' || step.kind === 'own') {
    const specs = rec.own ? [] : p.unpushedBranches.map(b => `refs/heads/${b.name}:refs/codetycoon/backup/${b.name}`);
    if (await push(root, url, specs, log) && specs.length) log(`    backed up ${specs.length} branch${specs.length > 1 ? 'es' : ''} to refs/codetycoon/backup/ (your branches untouched)`);
    Object.assign(rec, { remote: rec.remote || url, own: !!rec.own });
  }
  // uncommitted work, every kind
  const wip = await wipCommit(root);
  if (wip) {
    const br = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).out || 'HEAD';
    if (await push(root, url, [`${wip}:refs/codetycoon/wip/${br}`], log)) { rec.wip = wip; log(`    saved uncommitted work to refs/codetycoon/wip/${br}`); }
  }
  rec.at = Date.now();
  state.projects[key(root)] = { root: norm(root), name: p.name, ...rec };
  saveState(state);
}

// The CLI command. opts: { to, yes, only: [names], log }
export async function protect(opts = {}, log = console.log) {
  const state = protectState();
  const provider = parseTarget(opts.to) || state.provider;
  const projects = await scanProjects(os.homedir());
  const only = opts.only?.length ? new Set(opts.only.map(s => s.toLowerCase())) : null;
  const steps = projects.map(p => stepsFor(p, state)).filter(s => s && (!only || only.has(s.p.name.toLowerCase())));
  if (!steps.length) { log('Every project is already pushed or protected.'); return { done: [] }; }

  const needsRemote = steps.some(s => s.kind === 'init' || s.kind === 'remote');
  const ready = needsRemote ? await providerReady(provider) : { ok: true };
  log(needsRemote ? `New private repos go to: ${ready.ok ? ready.label : '(none: ' + ready.why + ')'}` : 'Backing up to the remotes the projects already have.');
  for (const s of steps) {
    const p = s.p;
    if (s.kind === 'init') {
      const plan = ignorePlan(p.root);
      log(`  ${p.name}: start git, commit ${plan.files} files (${fmtBytes(plan.bytes)}), new private repo`);
      if (plan.left.length) log(`      leaves out ${plan.left.length} (${fmtBytes(plan.leftBytes)}): ${plan.left.slice(0, 6).map(l => l.path).join(', ')}${plan.left.length > 6 ? ', …' : ''}`);
    } else if (s.kind === 'remote') log(`  ${p.name}: new private repo, push ${p.commits} commits`);
    else if (s.kind === 'own') log(`  ${p.name}: push to its Code Tycoon repo`);
    else log(`  ${p.name}: back up ${p.unpushedBranches.length ? p.unpushedBranches.map(b => b.name).join(', ') : ''}${p.unpushedBranches.length && p.dirty ? ' and ' : ''}${p.dirty ? 'uncommitted work' : ''} to hidden refs on ${p.remote}`);
  }
  if (needsRemote && !ready.ok) {
    log('');
    log('Pick where new repos go:  --to github  |  --to github:<org>  |  --to <folder of bare repos, e.g. a NAS>');
    log('For GitHub, sign in with `code-tycoon protect --login`, or set CODETYCOON_GITHUB_TOKEN.');
    return { done: [], needs: 'remote' };
  }
  if (!opts.yes) {
    if (!process.stdin.isTTY) { log('\nNothing done. Run again with --yes.'); return { done: [] }; }
    const a = await new Promise(r => { process.stdout.write('\nProtect these projects? [y/N] '); process.stdin.resume(); process.stdin.setEncoding('utf8'); process.stdin.once('data', d => { process.stdin.pause(); r(String(d)); }); });
    if (!/^y(es)?$/i.test(a.trim())) { log('Nothing done.'); return { done: [] }; }
  }
  if (provider) { state.provider = provider; saveState(state); }
  const done = [], failed = [];
  for (const s of steps) {
    log(`${s.p.name}…`);
    try { await protectOne(s, provider, state, log); done.push(s.p.name); }
    catch (e) { failed.push(s.p.name); log(`    ! ${e.message}`); }
  }
  log(`\n${done.length} protected${failed.length ? `, ${failed.length} failed (${failed.join(', ')})` : ''}. Code Tycoon keeps them pushed while it runs.`);
  if (steps.some(s => s.kind === 'init')) log('Their .env files are left out of git; `code-tycoon snapshot` keeps them in the encrypted vault.');
  return { done, failed };
}

// ---------------------------------------------------------------- guard

// Called by the server every few minutes: keep protected projects pushed.
let guarding = false;
export async function guardTick(log = () => {}) {
  if (guarding) return; guarding = true;
  try {
    const state = protectState();
    for (const rec of Object.values(state.projects)) {
      const root = rec.root;
      if (!fs.existsSync(path.join(root, '.git'))) continue;
      const url = rec.remote; if (!url) continue;
      if (rec.own) {
        const ahead = await git(root, ['rev-list', '--count', '--branches', '--not', '--remotes']);
        if (Number(ahead.out) > 0 && await push(root, url, ['refs/heads/*:refs/heads/*'], log)) await git(root, ['fetch', '-q', ...gitAuth(url), (await git(root, ['remote'])).out.split('\n').includes('codetycoon') ? 'codetycoon' : 'origin']);
      } else {
        const refs = (await git(root, ['for-each-ref', '--format=%(refname:short)\t%(upstream:short)\t%(upstream:track)', 'refs/heads'])).out.split('\n').filter(Boolean).map(l => l.split('\t'));
        const specs = refs.filter(([, up, tr]) => !up || /ahead/.test(tr)).map(([b]) => `refs/heads/${b}:refs/codetycoon/backup/${b}`);
        if (specs.length && JSON.stringify(specs) + (await git(root, ['rev-parse', ...specs.map(s => s.split(':')[0])])).out !== rec.lastBackup) {
          if (await push(root, url, specs, log)) rec.lastBackup = JSON.stringify(specs) + (await git(root, ['rev-parse', ...specs.map(s => s.split(':')[0])])).out;
        }
      }
      const wip = await wipCommit(root);
      const tree = wip ? (await git(root, ['rev-parse', wip + '^{tree}'])).out : null;
      if (wip && tree !== rec.wipTree) {
        const br = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).out || 'HEAD';
        if (await push(root, url, [`${wip}:refs/codetycoon/wip/${br}`], log)) { rec.wipTree = tree; rec.wip = wip; }
      }
      rec.checked = Date.now();
    }
    // re-read before saving: a protect run may have added projects meanwhile
    const fresh = protectState();
    for (const [k, v] of Object.entries(state.projects)) if (fresh.projects[k]) Object.assign(fresh.projects[k], { lastBackup: v.lastBackup, wip: v.wip, wipTree: v.wipTree, checked: v.checked });
    saveState(fresh);
  } finally { guarding = false; }
}
