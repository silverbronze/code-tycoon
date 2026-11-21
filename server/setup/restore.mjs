// code-tycoon restore <folder | git url> [--yes] [--projects <dir>] [--recovery-key]
// Rebuilds a setup snapshot on this machine: clones the projects, places every file
// with paths rewritten for this OS and user, puts the secrets back from the vault,
// installs missing tools and packages, re-registers Code Tycoon's hooks and autostart,
// and lists what needs a fresh sign-in. Existing files that differ are backed up first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DATA_DIR, norm, findClaudeCli } from '../paths.mjs';
import { mergeClaudeJson } from './adapters/claude.mjs';
import { fillSecrets } from './secrets.mjs';
import { fillPaths, fillSlug } from './pathmap.mjs';
import { unlock, readSecrets, askSecret } from './vault.mjs';
import { git, sha256 } from './util.mjs';
import { FORMAT, VERSION, isGitUrl } from './snapshot.mjs';

const WIN_ONLY = /\.(vbs|bat|cmd|ps1|lnk|exe)$/i;
const inContainer = () => !!process.env.CODETYCOON_CONTAINER || fs.existsSync('/.dockerenv');

function mapJson(v, fn) {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map(x => mapJson(x, fn));
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[fn(k)] = mapJson(x, fn); return o; }
  return v;
}

function has(bin) {
  if (bin === 'claude' && findClaudeCli() !== 'claude') return true;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore', windowsHide: true });
  return r.status === 0;
}
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
  return r.status === 0;
}

async function source(src) {
  if (!isGitUrl(src)) return path.resolve(src);
  const dir = path.join(DATA_DIR, 'restore-src', crypto.createHash('sha256').update(src).digest('hex').slice(0, 12));
  if (fs.existsSync(path.join(dir, '.git'))) { const r = await git(dir, ['pull', '--ff-only'], 120000); if (!r.ok) throw new Error('git pull failed: ' + r.err); }
  else { fs.mkdirSync(path.dirname(dir), { recursive: true }); const r = await git(path.dirname(dir), ['clone', src, dir], 300000); if (!r.ok) throw new Error('git clone failed: ' + r.err); }
  return dir;
}

// Everything restore would do, without doing it.
export function planRestore(manifest, secrets, opts = {}) {
  const home = norm(opts.home || os.homedir());
  const win = (opts.platform || process.platform) === 'win32';
  const where = { home, projects: {} };
  const projects = manifest.projects.map(p => {
    const name = p.name.replace(/[<>:"|?*]/g, '_');
    const dest = opts.projectsDir ? norm(path.resolve(opts.projectsDir, name))
      : p.rel ? `${home}/${p.rel}`
      : (manifest.source.platform === (opts.platform || process.platform) && p.original) ? p.original
      : `${home}/projects/${name}`;
    where.projects[p.n] = dest;
    const exists = fs.existsSync(dest);
    const action = exists ? 'exists' : p.remote ? 'clone' : 'lost';
    return { ...p, dest, action };
  });

  const files = [], skipped = [], missing = new Set();
  for (const f of manifest.files) {
    let tpl = f.path;
    if (tpl.includes('@@ct-slug@@')) {
      const slug = fillSlug(f.slug || '', where);
      if (!slug) { skipped.push({ ...f, why: 'project folder unknown' }); continue; }
      tpl = tpl.replace('@@ct-slug@@', slug);
    }
    const dest = fillPaths(tpl, where, win);
    if (/@@ct-/.test(dest)) { skipped.push({ ...f, why: 'path has an unknown placeholder' }); continue; }
    if (!win && (f.cls === 'autostart' || WIN_ONLY.test(dest))) { skipped.push({ ...f, dest, why: 'Windows only' }); continue; }
    if (f.cls === 'autostart' && f.platform && f.platform !== (opts.platform || process.platform)) { skipped.push({ ...f, dest, why: `${f.platform} only` }); continue; }
    if (f.cls === 'repo') { files.push({ ...f, dest, action: fs.existsSync(dest) ? 'exists' : 'clone' }); continue; }
    files.push({ ...f, dest });
  }
  return { where, win, projects, files, skipped, missing };
}

// The bytes a file entry restores to.
export function contentOf(f, dir, secrets, plan, missing) {
  if (f.cls === 'secret') {
    const b64 = secrets[f.vault];
    if (b64 == null) { missing.add(f.vault); return null; }
    return Buffer.from(b64, 'base64');
  }
  const buf = fs.readFileSync(path.join(dir, 'files', f.hash.slice(0, 2), f.hash));
  if (sha256(buf) !== f.hash) throw new Error(`snapshot file damaged: ${f.path}`);
  if (!f.text) return buf;
  let text = buf.toString('utf8');
  if (f.json) {
    let j = mapJson(JSON.parse(text), s => fillSecrets(fillPaths(s, plan.where, plan.win), secrets, missing));
    if (f.merge === 'claude-json') {
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(f.dest, 'utf8')); } catch {}
      j = mergeClaudeJson(cur, j);
    }
    return Buffer.from(JSON.stringify(j, null, 2) + '\n');
  }
  text = fillSecrets(fillPaths(text, plan.where, plan.win), secrets, missing);
  // a Windows git config elsewhere: CRLF checkouts break shell scripts, the credential manager isn't there
  if (!plan.win && /(^|\/)\.gitconfig$/.test(f.dest)) {
    text = text.replace(/^(\s*autocrlf\s*=\s*)true\s*$/gmi, '$1input').replace(/^\s*helper\s*=\s*(manager[\w-]*|wincred)\s*$/gmi, '')
      .replace(/^(\s*sshCommand\s*=\s*).*\.exe.*$/gmi, '');
  }
  return Buffer.from(text, 'utf8');
}

export async function restore(src, opts = {}, log = console.log) {
  const dir = await source(src);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (manifest.format !== FORMAT) throw new Error('not a Code Tycoon setup snapshot');
  if (manifest.version > VERSION) throw new Error(`snapshot format ${manifest.version} is newer than this code-tycoon understands (${VERSION}); update it`);

  const vault = JSON.parse(fs.readFileSync(path.join(dir, 'vault.json'), 'utf8'));
  const secret = opts.recovery ? await askSecret('Recovery key: ', 'CODETYCOON_RECOVERY_KEY') : await askSecret('Vault passphrase: ');
  const secrets = readSecrets(vault, unlock(vault, secret, opts.recovery ? 'recovery' : 'passphrase'));

  const plan = planRestore(manifest, secrets, opts);
  const missing = new Set();
  // decide per file before touching anything: new, same or changed
  for (const f of plan.files) {
    if (f.cls === 'repo') continue;
    f.content = contentOf(f, dir, secrets, plan, missing);
    if (!f.content) { f.action = 'missing'; continue; }
    let cur = null; try { cur = fs.readFileSync(f.dest); } catch {}
    f.action = !cur ? 'new' : cur.equals(f.content) ? 'same' : 'replace';
  }

  const count = a => plan.files.filter(f => f.action === a).length;
  const tools = manifest.tools.map(t => ({ ...t, present: t.id === 'codetycoon' || has(t.id === 'claude' ? 'claude' : t.id) }));
  log(`Snapshot from ${manifest.source.host} (${manifest.source.platform}), ${manifest.created}`);
  log(`Restoring into ${plan.where.home} on ${process.platform}:`);
  log(`  files: ${count('new')} new, ${count('replace')} replaced (old copies backed up), ${count('same')} already the same${plan.skipped.length ? `, ${plan.skipped.length} skipped` : ''}`);
  for (const p of plan.projects) log(`  project ${p.name}: ${p.action === 'clone' ? `clone ${p.remote} -> ${p.dest}` : p.action === 'exists' ? `${p.dest} already there` : `never pushed, cannot restore${p.synced ? ` (synced by ${p.synced})` : ''}`}`);
  for (const t of tools.filter(t => !t.present)) log(`  install ${t.name}: ${t.install}`);
  if (manifest.installs.length) log(`  reinstall packages in ${manifest.installs.length} folder${manifest.installs.length > 1 ? 's' : ''}`);
  for (const r of manifest.register) log(`  register ${r.kind}`);

  if (!opts.yes) {
    if (!process.stdin.isTTY) { log('\nNothing written. Run again with --yes to restore.'); return { plan, written: false }; }
    const a = await askLine('\nRestore now? [y/N] ');
    if (!/^y(es)?$/i.test(a.trim())) { log('Nothing written.'); return { plan, written: false }; }
  }

  // tools first: hooks and MCP servers need them
  if (opts.install !== false) for (const t of tools.filter(t => !t.present && t.install)) { log(`Installing ${t.name}…`); run(t.install.split(' ')[0] === 'npm' ? npmBin : t.install.split(' ')[0], t.install.split(' ').slice(1)); }

  // Order: setup files first (the SSH key and git config clone the private repos), then
  // the clones, then the files that go inside projects (.env).
  const backup = path.join(DATA_DIR, `restore-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  let backedUp = 0;
  const writeOne = f => {
    if (f.action !== 'new' && f.action !== 'replace') return;
    // a project's .env goes back only into a project that is there
    if (f.tool === 'project') {
      const p = plan.projects.find(p => norm(f.dest).toLowerCase().startsWith(p.dest.toLowerCase() + '/'));
      if (!p || !fs.existsSync(p.dest)) { f.action = 'no-project'; return; }
    }
    if (f.action === 'replace') {
      const b = path.join(backup, norm(f.dest).replace(/^([A-Za-z]):/, '$1').replace(/^\/+/, ''));
      fs.mkdirSync(path.dirname(b), { recursive: true });
      fs.copyFileSync(f.dest, b); backedUp++;
    }
    fs.mkdirSync(path.dirname(f.dest), { recursive: true });
    fs.writeFileSync(f.dest, f.content);
    if (process.platform !== 'win32') {
      if (f.cls === 'secret' || /\/\.ssh\//.test(f.dest)) { fs.chmodSync(f.dest, f.cls === 'secret' ? 0o600 : 0o644); fs.chmodSync(path.dirname(f.dest), 0o700); }
      else if (f.mode && f.mode & 0o111 && manifest.source.platform !== 'win32') fs.chmodSync(f.dest, f.mode);
    }
  };
  for (const f of plan.files) if (f.cls !== 'repo' && f.tool !== 'project') writeOne(f);

  // a private GitHub repo over https needs a token; with the restored SSH key, try SSH
  const clone = async (url, dest) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let r = await git(path.dirname(dest), ['clone', url, dest], 600000);
    const ssh = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(\.git)?\/?$/i.exec(url);
    if (!r.ok && ssh && !fs.existsSync(path.join(dest, '.git'))) {
      fs.rmSync(dest, { recursive: true, force: true });
      r = await git(path.dirname(dest), ['-c', 'core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new', 'clone', `git@github.com:${ssh[1]}.git`, dest], 600000);
      if (r.ok) await git(dest, ['remote', 'set-url', 'origin', url]); // keep the remote as it was; pushes may use pushInsteadOf
    }
    return r;
  };
  if (opts.clone !== false) {
    for (const p of plan.projects.filter(p => p.action === 'clone')) {
      log(`Cloning ${p.name}…`);
      const r = await clone(p.remote, p.dest);
      p.result = r.ok ? 'cloned' : 'failed: ' + r.err.split('\n').filter(Boolean).pop();
      if (r.ok && p.branch && p.branch !== 'HEAD') await git(p.dest, ['checkout', p.branch]);
      // work that `code-tycoon protect` backed up (unpushed branches, uncommitted changes)
      if (r.ok) {
        await git(p.dest, ['fetch', '-q', 'origin', '+refs/codetycoon/*:refs/codetycoon/*'], 600000);
        p.backups = (await git(p.dest, ['for-each-ref', '--format=%(refname)', 'refs/codetycoon'])).out.split('\n').filter(Boolean);
      }
    }
    for (const f of plan.files.filter(f => f.cls === 'repo' && f.action === 'clone')) f.result = (await clone(f.remote, f.dest)).ok ? 'cloned' : 'failed';
  }
  for (const f of plan.files) if (f.tool === 'project') writeOne(f);

  if (opts.install !== false) for (const i of manifest.installs) {
    const d = fillPaths(i.path, plan.where, plan.win);
    if (!fs.existsSync(path.join(d, i.kind === 'npm' ? 'package.json' : 'requirements.txt'))) continue;
    log(`Installing packages in ${d}…`);
    i.ok = i.kind === 'npm' ? run(npmBin, ['install', '--no-audit', '--no-fund'], d) : run('python3', ['-m', 'pip', 'install', '-r', 'requirements.txt'], d);
  }

  for (const r of manifest.register) {
    try {
      if (r.kind === 'codetycoon-hooks') { const { setHooks } = await import('../hooks-install.mjs'); setHooks('install'); r.ok = true; }
      // in a container the entrypoint starts the server; a systemd unit there would do nothing
      if (r.kind === 'codetycoon-autostart') {
        if (inContainer()) { r.ok = true; r.err = 'skipped in a container'; continue; }
        const a = await import('../autostart.mjs'); if (a.autostartSupported()) { a.setAutostart('install'); r.ok = true; } else r.ok = false;
      }
    } catch (e) { r.ok = false; r.err = e.message; }
  }

  // the report
  log('\nDone.');
  log(`  ${count('new') + count('replace')} files written${backedUp ? `, ${backedUp} old copies in ${backup}` : ''}`);
  const cloned = plan.projects.filter(p => p.result === 'cloned').length, failed = plan.projects.filter(p => p.result?.startsWith('failed'));
  if (cloned) log(`  ${cloned} projects cloned`);
  for (const p of failed) log(`  ! ${p.name}: clone ${p.result}`);
  for (const p of plan.projects.filter(p => p.action === 'lost')) log(`  ! ${p.name} was never pushed; its code is not in the snapshot`);
  for (const p of plan.projects.filter(p => p.backups?.length)) {
    log(`  ${p.name}: backed-up work came back as ${p.backups.map(b => b.replace('refs/codetycoon/', '')).join(', ')}`);
    log(`      e.g. git -C "${p.dest}" switch -c recovered ${p.backups[0]}`);
  }
  for (const p of plan.projects.filter(p => (p.unpushed || p.dirty) && !p.backups?.length)) if (p.action !== 'lost') log(`  ~ ${p.name} had ${p.unpushed ? p.unpushed + ' unpushed commits' : ''}${p.unpushed && p.dirty ? ' and ' : ''}${p.dirty ? p.dirty + ' uncommitted changes' : ''} when the snapshot was made`);
  for (const r of manifest.register) log(`  ${r.ok ? (r.err ? 'skipped' : 'registered') : '! could not register'} ${r.kind}${r.err ? ': ' + r.err : ''}`);
  const winOnly = plan.skipped.filter(s => /only$/.test(s.why));
  if (winOnly.length) log(`  skipped ${winOnly.length} Windows-only launcher${winOnly.length > 1 ? 's' : ''}: ${winOnly.map(s => s.path.split('/').pop()).join(', ')}`);
  if (missing.size) log(`  ! ${missing.size} secrets were not in the vault; those files still hold @@ct-secret references`);
  const logins = manifest.tools.flatMap(t => t.logins || []);
  if (logins.length) { log('\nSign in again (sign-ins are never copied):'); for (const l of logins) log('  - ' + l); }
  return { plan, written: true, backup: backedUp ? backup : null, missing: [...missing] };
}

function askLine(q) {
  process.stdout.write(q);
  return new Promise(r => { process.stdin.resume(); process.stdin.setEncoding('utf8'); process.stdin.once('data', d => { process.stdin.pause(); r(String(d)); }); });
}
