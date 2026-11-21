// Global npm packages: MCP servers and CLIs (hostinger-api-mcp, @porkbunllc/mcp-server,
// codex, shopify) are often installed with `npm install -g`, and configs point into
// npm's global folder. A snapshot records the packages and maps that folder to
// @@ct-npmroot@@; restore installs the packages and fills the placeholder with this
// machine's folder.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = args => spawnSync(npm, args, { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true, timeout: 60000 });

export function npmRoot() {
  const r = run(['root', '-g']);
  const p = r.status === 0 ? r.stdout.trim().split(/\r?\n/).pop() : null;
  return p && fs.existsSync(p) ? p : null;
}

// [{ name, version }] of what was installed with -g, minus npm itself
export function npmGlobals() {
  const r = run(['ls', '-g', '--depth=0', '--json']);
  try {
    const deps = JSON.parse(r.stdout).dependencies || {};
    return Object.entries(deps).filter(([n]) => !['npm', 'corepack'].includes(n)).map(([name, d]) => ({ name, version: d.version || null }));
  } catch { return []; }
}

// Install the ones missing here. Returns { installed, failed }.
export function installGlobals(pkgs, log = () => {}) {
  const root = npmRoot();
  const missing = pkgs.filter(p => !root || !fs.existsSync(path.join(root, ...p.name.split('/'))));
  if (!missing.length) return { installed: [], failed: [] };
  log(`Installing global npm packages: ${missing.map(p => p.name).join(', ')}…`);
  const r = spawnSync(npm, ['install', '-g', '--no-audit', '--no-fund', ...missing.map(p => p.version ? `${p.name}@${p.version}` : p.name)],
    { stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
  return r.status === 0 ? { installed: missing.map(p => p.name), failed: [] } : { installed: [], failed: missing.map(p => p.name) };
}
