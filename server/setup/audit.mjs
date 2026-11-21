// The audit: what would be lost if this disk died today, ranked. No account,
// nothing leaves the machine. Used by `code-tycoon audit` and the Setup panel.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, norm, key } from '../paths.mjs';
import { scan, machine } from './scan.mjs';
import { COPIED } from './adapters/common.mjs';
import { cutFile } from './secrets.mjs';
import { fmtBytes, isText } from './util.mjs';

export const LAST_FILE = path.join(DATA_DIR, 'setup-last.json');
export function lastSnapshot() { try { return JSON.parse(fs.readFileSync(LAST_FILE, 'utf8')); } catch { return null; } }

const RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

// How many secrets the config files hold (counted, never shown).
function countSecrets(entries) {
  const found = new Map();
  let files = 0;
  for (const e of entries) {
    if (e.cls === 'secret') { files++; continue; }
    if (!COPIED.has(e.cls) || e.size > 1 << 20) continue;
    let buf; try { buf = fs.readFileSync(e.abs); } catch { continue; }
    if (!isText(buf)) continue;
    const before = found.size;
    cutFile(buf.toString('utf8'), e.abs, found);
    if (found.size > before) files++;
  }
  return { values: found.size, files };
}

export async function audit(env = machine()) {
  const s = await scan(env);
  const home = norm(env.home);
  const tilde = p => { const n = norm(p); return n.toLowerCase().startsWith(home.toLowerCase()) ? '~' + n.slice(home.length) : n; };
  const items = [];
  const add = (level, kind, title, detail, fix, extra = {}) => items.push({ level, kind, title, detail, fix, ...extra });

  // projects
  const { protectState } = await import('./protect.mjs');
  const prot = protectState();
  for (const p of s.projects) {
    const where = tilde(p.root);
    if (p.synced) {
      if (!p.git || !p.remotes.length || p.unpushed) add('info', 'project', `${p.name} is synced by ${p.synced}`, `${where}: ${p.git ? (p.remotes.length ? `${p.unpushed} unpushed commits` : 'no git remote') : 'not in git'}, but ${p.synced} keeps a copy.`, null, { project: p.root });
      continue;
    }
    if (!p.git) {
      if (p.files) add('high', 'project', `${p.name} is not in git`, `${where}: ${p.files} files, ${fmtBytes(p.size)}, only on this disk.`, `git init, commit, and push to a private remote`, { project: p.root });
      continue;
    }
    // protected: unpushed and uncommitted work sit in backup refs the guard keeps fresh
    const guard = prot.projects[key(p.root)];
    if (guard && p.remotes.length) {
      if (p.unpushed || p.dirty) add('low', 'project', `${p.name}: unpushed work backed up by Code Tycoon`,
        `${where}: ${[p.unpushed ? `${p.unpushed} commits` : '', p.dirty ? `${p.dirty} uncommitted changes` : ''].filter(Boolean).join(', ')} in ${guard.own ? 'its private repo' : 'hidden refs on ' + p.remote}${guard.checked || guard.at ? `, checked ${new Date(guard.checked || guard.at).toLocaleString()}` : ''}`, null, { project: p.root });
      if (p.localOnly.secrets.length) add('high', 'project', `${p.name}: ${p.localOnly.secrets.length} secret file${p.localOnly.secrets.length > 1 ? 's' : ''} git ignores`,
        p.localOnly.secrets.map(x => x.path).join(', '), 'a snapshot keeps them in the encrypted vault', { project: p.root });
      continue;
    }
    if (!p.remotes.length) add('critical', 'project', `${p.name} has no remote`, `${where}: all ${p.commits} commits exist only on this disk.`, 'create a private repo and `git push -u origin --all`', { project: p.root });
    else if (p.unpushed) add('high', 'project', `${p.name}: ${p.unpushed} unpushed commit${p.unpushed > 1 ? 's' : ''}`,
      `${where}${p.unpushedBranches.length ? ` (${p.unpushedBranches.map(b => b.name + (b.ahead ? ` +${b.ahead}` : ' no upstream')).join(', ')})` : ''}`, '`git push`', { project: p.root });
    if (p.localOnly.secrets.length) add('high', 'project', `${p.name}: ${p.localOnly.secrets.length} secret file${p.localOnly.secrets.length > 1 ? 's' : ''} git ignores`,
      p.localOnly.secrets.map(x => x.path).join(', '), 'a snapshot keeps them in the encrypted vault', { project: p.root });
    if (p.dirty) add('medium', 'project', `${p.name}: ${p.dirty} uncommitted change${p.dirty > 1 ? 's' : ''}`, where, 'commit and push', { project: p.root });
    if (p.localOnly.dataCount) add('low', 'project', `${p.name}: ${fmtBytes(p.localOnly.dataBytes)} of ignored data`,
      p.localOnly.data.slice(0, 5).map(d => d.path + (d.dir ? '/' : '')).join(', ') + (p.localOnly.dataCount > 5 ? `, +${p.localOnly.dataCount - 5} more` : ''), 'back it up with a backup tool if it matters', { project: p.root });
  }

  // tools
  const last = lastSnapshot();
  const copied = s.entries.filter(e => COPIED.has(e.cls) || e.cls === 'secret');
  const changed = last ? copied.filter(e => (e.mtime || 0) > last.at) : copied;
  const toolRows = s.tools.map(t => {
    const mine = s.entries.filter(e => e.tool === t.id);
    const by = {};
    for (const e of mine) { by[e.cls] ||= { n: 0, files: 0, bytes: 0 }; by[e.cls].n++; by[e.cls].files += e.files || 1; by[e.cls].bytes += e.size || 0; }
    return { ...t, dirs: t.dirs.map(tilde), classes: by };
  });
  const setupFiles = copied.length;
  const setupBytes = copied.reduce((n, e) => n + e.size, 0);
  if (!last) add('high', 'setup', `Your AI setup exists only on this disk`,
    `${setupFiles} files (${fmtBytes(setupBytes)}): settings, MCP servers, instructions, memory and skills for ${s.tools.filter(t => t.present).map(t => t.name).join(', ')}.`, '`code-tycoon snapshot <folder or private git url>`');
  else if (changed.length) add('medium', 'setup', `${changed.length} setup file${changed.length > 1 ? 's' : ''} changed since your last snapshot`,
    `last snapshot ${new Date(last.at).toISOString().slice(0, 16).replace('T', ' ')} to ${last.target}: ${changed.slice(0, 6).map(e => tilde(e.abs)).join(', ')}${changed.length > 6 ? ', …' : ''}`, '`code-tycoon snapshot` again');

  const secrets = countSecrets(s.entries);
  if (secrets.values || secrets.files) add('info', 'secrets', `${secrets.values} secret value${secrets.values === 1 ? '' : 's'} in config files, ${s.entries.filter(e => e.cls === 'secret').length} secret files`,
    'API keys, MCP tokens, SSH keys. A snapshot cuts them out and keeps them in a vault encrypted with your passphrase.', null);

  const repos = s.entries.filter(e => e.cls === 'repo');
  if (repos.length) add('info', 'setup', `${repos.length} git checkout${repos.length > 1 ? 's' : ''} inside tool folders`, repos.map(r => tilde(r.abs)).join(', '), 'cloned back from their remote on restore');

  const other = s.entries.filter(e => e.cls === 'other');
  if (other.length) {
    const tops = [...new Set(other.map(e => e.tool + ':' + e.rel.split('/')[0]))];
    add('low', 'setup', `${other.length} files no adapter knows`, tops.slice(0, 12).map(t => t.split(':')[1]).join(', ') + (tops.length > 12 ? ', …' : ''), 'included in snapshots and secret-scanned; say if any should be skipped');
  }
  const logins = s.tools.filter(t => t.present).flatMap(t => t.logins || []);
  if (logins.length) add('info', 'login', 'Sign-ins are never copied', logins.join('; '), 'sign in again after a restore');
  const hist = s.entries.filter(e => e.cls === 'history');
  const histBytes = hist.reduce((n, e) => n + e.size, 0);
  if (histBytes) add('info', 'history', `${fmtBytes(histBytes)} of session history and databases`, 'Transcripts, Code Tycoon\'s database. Not part of a setup snapshot.', 'use a backup tool if you want to keep them');

  items.sort((a, b) => RANK[a.level] - RANK[b.level]);
  const counts = {};
  for (const i of items) counts[i.level] = (counts[i.level] || 0) + 1;
  return {
    at: s.at, ms: s.ms, machine: s.machine, counts, items, tools: toolRows,
    setup: { files: setupFiles, bytes: setupBytes, secrets, changed: last ? changed.length : null },
    projects: s.projects.map(p => ({ name: p.name, root: tilde(p.root), git: p.git, remote: p.remote, branch: p.branch, unpushed: p.unpushed, dirty: p.dirty, synced: p.synced,
      localSecrets: p.localOnly.secrets.length, ignoredBytes: p.localOnly.dataBytes })),
    last: last ? { at: last.at, target: last.target } : null,
  };
}

const MARK = { critical: '!!', high: '! ', medium: '~ ', low: '. ', info: 'i ' };
export function formatAudit(a) {
  const L = [];
  L.push(`Code Tycoon setup audit, ${new Date(a.at).toLocaleString()} (${(a.ms / 1000).toFixed(1)} s)`);
  L.push('');
  L.push('If this disk died today:');
  for (const i of a.items) {
    L.push(`${MARK[i.level]} ${i.level.toUpperCase().padEnd(8)} ${i.title}`);
    if (i.detail) L.push(`             ${i.detail}`);
    if (i.fix) L.push(`             -> ${i.fix}`);
  }
  L.push('');
  L.push('Tools:');
  for (const t of a.tools) {
    if (!t.present) { L.push(`  ${t.name}: not found`); continue; }
    const c = t.classes, f = k => c[k] ? `${k === 'repo' ? c[k].n : c[k].files} ${k}` : null;
    L.push(`  ${t.name} (${t.dirs.join(', ')}): ${['config', 'memory', 'skill', 'secret', 'other', 'repo'].map(f).filter(Boolean).join(', ') || 'nothing to keep'}`);
  }
  L.push('');
  L.push(`Projects: ${a.projects.length} (${a.projects.filter(p => p.git && p.remote && !p.unpushed && !p.dirty).length} fully pushed)`);
  L.push(a.last ? `Last snapshot: ${new Date(a.last.at).toLocaleString()} -> ${a.last.target}` : 'No snapshot yet.');
  return L.join('\n');
}
