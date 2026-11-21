// code-tycoon snapshot <folder | git url>
// Writes manifest.json (what goes where, with placeholders for every absolute path),
// files/<sha256> (content-addressed copies, secrets cut out) and vault.json (the
// secrets, encrypted with your passphrase). Format: docs/setup-snapshot.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { DATA_DIR, norm } from '../paths.mjs';
import { isOurs, hooksInstalled } from '../hooks-install.mjs';
import { autostartInstalled } from '../autostart.mjs';
import { scan, machine } from './scan.mjs';
import { COPIED } from './adapters/common.mjs';
import { pickClaudeJson } from './adapters/claude.mjs';
import { cutJson, cutText, cutFile } from './secrets.mjs';
import { makeMapper } from './pathmap.mjs';
import { createVault, unlock, readSecrets, writeSecrets, askSecret } from './vault.mjs';
import { sha256, isText, git, fmtBytes } from './util.mjs';
import { LAST_FILE } from './audit.mjs';

export const FORMAT = 'code-tycoon-setup';
export const VERSION = 1;
const pkg = createRequire(import.meta.url)('../../package.json');

export const isGitUrl = s => /^(git@|ssh:\/\/|git:\/\/)|^https?:\/\/.+\.git\/?$|^https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\//i.test(s);

// Strings and keys of a JSON value through fn.
function mapJson(v, fn) {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map(x => mapJson(x, fn));
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[fn(k)] = mapJson(x, fn); return o; }
  return v;
}

// Claude Code settings without Code Tycoon's own hooks (restore installs fresh ones,
// with a new token and this machine's port).
function stripOwnHooks(settings) {
  if (!settings.hooks) return settings;
  const hooks = {};
  for (const [ev, groups] of Object.entries(settings.hooks)) {
    const g = (groups || []).map(x => ({ ...x, hooks: (x.hooks || []).filter(h => !isOurs(h)) })).filter(x => x.hooks.length);
    if (g.length) hooks[ev] = g;
  }
  const out = { ...settings, hooks };
  if (!Object.keys(hooks).length) delete out.hooks;
  return out;
}

export async function buildSnapshot(env = machine(), log = () => {}) {
  log('Scanning…');
  const s = await scan(env);
  const home = norm(env.home);
  const projects = s.projects.map((p, n) => ({
    n, name: p.name, path: p.root, git: p.git, remote: p.remote, remotes: p.remotes, branch: p.branch, head: p.head,
    unpushed: p.unpushed, dirty: p.dirty, synced: p.synced || null,
    rel: p.root.toLowerCase().startsWith(home.toLowerCase() + '/') ? p.root.slice(home.length + 1) : null,
  }));
  const mapper = makeMapper([{ path: home, token: '@@ct-home@@' }, ...projects.map(p => ({ path: p.path, token: `@@ct-project:${p.n}@@` }))], env.platform === 'win32');

  const blobs = new Map();   // hash -> Buffer
  const secrets = {};        // id -> value; whole files as f:<hash> -> base64
  const files = [], skipped = {}, register = [], installs = [], pending = [];
  const put = buf => { const h = sha256(buf); blobs.set(h, buf); return h; };
  const tplPath = abs => mapper.text(norm(abs));

  for (const e of s.entries) {
    let p = tplPath(e.abs), slug = null;
    // project memory: the folder name under ~/.claude/projects is the project path, slugged
    const pm = /^(.*\/\.claude\/projects\/)([^/]+)(\/.*)$/i.exec(p);
    if (pm && e.tool === 'claude') { slug = mapper.slug(pm[2]) || pm[2]; p = pm[1] + '@@ct-slug@@' + pm[3]; }

    if (e.cls === 'repo') { files.push({ tool: e.tool, cls: 'repo', path: p, remote: e.remote }); continue; }
    if (e.cls === 'deps') {
      const dir = path.dirname(e.abs);
      if (path.basename(e.abs) === 'node_modules' && fs.existsSync(path.join(dir, 'package.json'))) installs.push({ kind: 'npm', path: tplPath(dir) });
      if (/venv$/.test(e.abs) && fs.existsSync(path.join(dir, 'requirements.txt'))) installs.push({ kind: 'pip', path: tplPath(dir) });
      continue;
    }
    if (e.cls === 'secret') {
      let buf; try { buf = fs.readFileSync(e.abs); } catch { continue; }
      const h = sha256(buf);
      secrets['f:' + h] = buf.toString('base64');
      files.push({ tool: e.tool, cls: 'secret', path: p, ...(slug ? { slug } : {}), vault: 'f:' + h, size: buf.length, mode: modeOf(e.abs) });
      continue;
    }
    if (!COPIED.has(e.cls)) { const k = `${e.tool}/${e.cls}`; skipped[k] ||= { files: 0, bytes: 0 }; skipped[k].files += e.files || 1; skipped[k].bytes += e.size || 0; continue; }

    let buf; try { buf = fs.readFileSync(e.abs); } catch { continue; }
    const entry = { tool: e.tool, cls: e.cls, path: p, ...(slug ? { slug } : {}), size: buf.length, mode: modeOf(e.abs) };
    if (e.cls === 'autostart') entry.platform = env.platform;
    if (isText(buf)) {
      const found = new Map();
      let text = buf.toString('utf8'), json = false;
      if (/\.json$/i.test(e.abs)) {
        try {
          let j = JSON.parse(text);
          if (e.opts?.pick === 'claude-json') { j = pickClaudeJson(j); entry.merge = 'claude-json'; }
          if (e.opts?.transform === 'claude-settings') j = stripOwnHooks(j);
          const out = mapJson(cutJson(j, found), x => mapper.text(x));
          const changed = entry.merge || e.opts?.transform || found.size || JSON.stringify(out) !== JSON.stringify(JSON.parse(text));
          if (changed) text = JSON.stringify(out, null, 2) + '\n';
          json = true;
        } catch {}
      }
      if (!json) text = mapper.text(cutText(text, found, e.abs));
      for (const [id, v] of found) secrets[id] = v;
      Object.assign(entry, { text: true, ...(json ? { json: true } : {}), ...(found.size ? { secrets: [...found.keys()] } : {}) });
      pending.push({ entry, text });
    } else {
      entry.hash = put(buf);
    }
    files.push(entry);
  }

  // secret files in projects that git ignores (.env and friends) go into the vault too
  for (const p of s.projects) for (const f of p.localOnly.secrets) {
    const abs = path.join(p.root, f.path);
    let buf; try { buf = fs.readFileSync(abs); } catch { continue; }
    if (buf.length > 1 << 20) continue;
    const h = sha256(buf);
    secrets['f:' + h] = buf.toString('base64');
    files.push({ tool: 'project', cls: 'secret', path: tplPath(abs), vault: 'f:' + h, size: buf.length, mode: modeOf(abs) });
  }

  // A value found as a secret anywhere is cut everywhere: the same key often sits
  // undetected in a script or a note (const KEY = '...' with a name no rule knows).
  // Values inside whole secret files (.env, service-account JSON) count too.
  const known = new Map();
  for (const [id, v] of Object.entries(secrets)) {
    if (!id.startsWith('f:')) { if (v.length >= 12) known.set(v, id); continue; }
    const t = Buffer.from(v, 'base64');
    if (!isText(t)) continue;
    const found = cutFile(t.toString('utf8'), files.find(f => f.vault === id)?.path || '.env').found;
    for (const [fid, fv] of found) if (fv.length >= 12) { secrets[fid] = fv; known.set(fv, fid); }
  }
  const byLength = [...known].sort((a, b) => b[0].length - a[0].length);
  for (const { entry, text: t0 } of pending) {
    let text = t0;
    for (const [v, id] of byLength) {
      const form = entry.json ? JSON.stringify(v).slice(1, -1) : v;
      if (!text.includes(form)) continue;
      text = text.split(form).join(`@@ct-secret:${id}@@`);
      entry.secrets = [...new Set([...(entry.secrets || []), id])];
    }
    entry.hash = put(Buffer.from(text, 'utf8'));
  }

  if (hooksInstalled()) register.push({ kind: 'codetycoon-hooks' });
  try { if (autostartInstalled()) register.push({ kind: 'codetycoon-autostart' }); } catch {}

  const manifest = {
    format: FORMAT, version: VERSION, created: new Date().toISOString(), by: `code-tycoon ${pkg.version}`,
    source: { platform: env.platform, home: '@@ct-home@@', user: env.user, host: os.hostname() },
    tools: s.tools.filter(t => t.present).map(t => ({ id: t.id, name: t.name, install: t.install, logins: t.logins })),
    projects: projects.map(p => ({ ...p, path: undefined, original: p.path })),
    files, installs, register, skipped,
    secrets: Object.keys(secrets).length,
  };
  return { manifest, blobs, secrets };
}

function modeOf(abs) { try { return fs.statSync(abs).mode & 0o777; } catch { return undefined; } }

const README = m => `# Code Tycoon setup snapshot

Made ${m.created} by ${m.by} on ${m.source.platform}.

- \`manifest.json\`: every file and where it goes, with \`@@ct-home@@\` and \`@@ct-project:<n>@@\` in place of absolute paths
- \`files/\`: the files, named by their SHA-256; secrets replaced by \`@@ct-secret:<id>@@\`
- \`vault.json\`: those secrets, AES-256-GCM, key wrapped by your passphrase (scrypt) and your recovery key

Restore on any machine with Node 22.13+:

    npx code-tycoon restore <this folder or git url>

Format: https://github.com/silverbronze/code-tycoon/blob/main/docs/setup-snapshot.md
`;

export async function snapshot(target, opts = {}, log = console.log) {
  const viaGit = isGitUrl(target);
  const dir = viaGit ? path.join(DATA_DIR, 'snapshots', crypto.createHash('sha256').update(target).digest('hex').slice(0, 12)) : path.resolve(target);
  if (viaGit) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      const r = await git(dir, ['pull', '--ff-only'], 120000);
      if (!r.ok && !/no tracking|couldn't find remote ref|does not have any commits/i.test(r.err)) throw new Error('git pull failed: ' + r.err);
    } else {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      const r = await git(path.dirname(dir), ['clone', target, dir], 300000);
      if (!r.ok) throw new Error('git clone failed: ' + r.err);
    }
  }
  fs.mkdirSync(dir, { recursive: true });

  const { manifest, blobs, secrets } = await buildSnapshot(machine(), log);

  // the vault: reuse the existing data key (and so the recovery key) when the passphrase opens it
  const vaultFile = path.join(dir, 'vault.json');
  let vault, key, recovery = null;
  if (fs.existsSync(vaultFile) && !opts.newVault) {
    vault = JSON.parse(fs.readFileSync(vaultFile, 'utf8'));
    const pass = await askSecret('Vault passphrase: ');
    key = unlock(vault, pass);
    readSecrets(vault, key); // proves the data still opens
  } else {
    log('A new vault keeps your API keys, MCP tokens and SSH keys encrypted with a passphrase.');
    log('It is never stored or sent anywhere. Lose it and the recovery key, and the secrets are gone.');
    const pass = await askSecret('New vault passphrase: ');
    if (pass.length < 10) throw new Error('use a passphrase of at least 10 characters');
    if (!process.env.CODETYCOON_PASSPHRASE && await askSecret('Repeat it: ') !== pass) throw new Error('the two passphrases differ');
    ({ vault, key, recovery } = createVault(pass));
  }
  writeSecrets(vault, key, secrets);

  // files/: write new blobs, drop ones nothing points to any more
  const fdir = path.join(dir, 'files');
  const keep = new Set(blobs.keys());
  for (const [h, buf] of blobs) {
    const f = path.join(fdir, h.slice(0, 2), h);
    if (!fs.existsSync(f)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); }
  }
  for (const sub of fs.existsSync(fdir) ? fs.readdirSync(fdir) : []) {
    for (const h of fs.readdirSync(path.join(fdir, sub))) if (!keep.has(h)) fs.rmSync(path.join(fdir, sub, h));
    if (!fs.readdirSync(path.join(fdir, sub)).length) fs.rmdirSync(path.join(fdir, sub));
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(vaultFile, JSON.stringify(vault, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'README.md'), README(manifest));

  if (viaGit) {
    await git(dir, ['add', '-A']);
    const st = await git(dir, ['status', '--porcelain']);
    if (st.out) {
      const c = await git(dir, ['-c', 'user.name=Code Tycoon', '-c', 'user.email=snapshot@codetycoon.local', 'commit', '-m', `Setup snapshot ${manifest.created}`]);
      if (!c.ok) throw new Error('git commit failed: ' + c.err);
      const p = await git(dir, ['push', '-u', 'origin', 'HEAD'], 300000);
      if (!p.ok) throw new Error('git push failed: ' + p.err);
    }
  }

  const bytes = [...blobs.values()].reduce((n, b) => n + b.length, 0);
  const last = { at: Date.now(), target, files: manifest.files.length };
  fs.writeFileSync(LAST_FILE, JSON.stringify(last));
  const n = c => manifest.files.filter(f => f.cls === c).length;
  log(`Snapshot written to ${viaGit ? target : dir}`);
  log(`  ${manifest.files.length} entries (${fmtBytes(bytes)}): ${n('config')} config, ${n('memory')} memory, ${n('skill')} skill, ${n('other')} other, ${n('secret')} secret files, ${n('repo')} repos`);
  log(`  ${manifest.secrets} secrets in the vault, ${manifest.projects.length} projects`);
  if (recovery) {
    log('');
    log('RECOVERY KEY (write it down now; it is shown only this once):');
    log('');
    log('    ' + recovery);
    log('');
    log('It opens the vault if you forget the passphrase.');
  }
  return { dir, manifest, recovery };
}
