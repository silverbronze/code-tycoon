// Self-update for installs made by site/install.sh and site/install.ps1.
// Those put each version in ~/.codetycoon/pkg/<version>/node_modules/code-tycoon. Once a day the
// server asks the npm registry for the latest version; when it is newer, it installs it next to the
// running one with its own npm and points the login launcher (autostart) at it, so the next start
// runs the new version. A failed install keeps the old one and is reported in /api/tunnel (update).
// Other installs (npx, a git checkout, a container) are left alone. CODETYCOON_AUTOUPDATE=0 turns it off.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './paths.mjs';
import { autostartInstalled } from './autostart.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PKG_DIR = path.join(DATA_DIR, 'pkg');
const version = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch { return null; } };
const CURRENT = version(ROOT);
const status = { current: CURRENT, latest: null, ready: null, checked: null, error: null };
export const updateStatus = () => ({ ...status, managed: managed() });

// is this copy one the install scripts made?
export function managed() {
  const rel = path.relative(PKG_DIR, ROOT);
  return !rel.startsWith('..') && !path.isAbsolute(rel) && /^[^\\/]+[\\/]node_modules[\\/]code-tycoon$/.test(rel);
}

const semver = v => (/^(\d+)\.(\d+)\.(\d+)$/.exec(v || '') || []).slice(1).map(Number);
export function newer(a, b) { // a > b, plain releases only (the registry's 0.0.0-stage placeholder never counts)
  const x = semver(a), y = semver(b);
  if (x.length !== 3 || y.length !== 3) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// npm next to the node that runs us (the install script's own Node, or the system one)
export function npmCommand() {
  const dir = path.dirname(process.execPath);
  for (const cli of [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')])
    if (fs.existsSync(cli)) return [process.execPath, [cli]];
  return [process.platform === 'win32' ? 'npm.cmd' : 'npm', []];
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: cmd.endsWith('.cmd') });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('exit', code => code === 0 ? resolve() : reject(new Error((err.trim().split('\n').pop() || 'npm exited with ' + code).slice(0, 200))));
  });
}

export async function latestVersion() {
  const r = await fetch('https://registry.npmjs.org/code-tycoon/latest', { signal: AbortSignal.timeout(15e3) });
  if (!r.ok) throw new Error('npm registry answered ' + r.status);
  return (await r.json()).version;
}

export async function checkForUpdate() {
  status.checked = Date.now();
  try {
    const latest = status.latest = await latestVersion();
    if (!newer(latest, CURRENT) || status.ready === latest) return status;
    const dest = path.join(PKG_DIR, latest), app = path.join(dest, 'node_modules', 'code-tycoon');
    if (version(app) !== latest) {
      fs.rmSync(dest, { recursive: true, force: true });
      const [cmd, pre] = npmCommand();
      await run(cmd, [...pre, 'install', `code-tycoon@${latest}`, '--prefix', dest, '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error']);
      if (version(app) !== latest) throw new Error('the new version did not install completely');
    }
    // the launcher starts the new copy from the next login on (only if the user wants a launcher)
    if (autostartInstalled()) execFileSync(process.execPath, ['--no-warnings', path.join(app, 'server', 'autostart.mjs'), 'install'], { stdio: 'ignore', windowsHide: true });
    writeShim(app);
    status.ready = latest; status.error = null;
    console.log(`[update] Code Tycoon ${latest} is installed; it starts next time (running ${CURRENT})`);
    prune(latest);
  } catch (e) {
    status.error = 'update failed, still on ' + CURRENT + ': ' + e.message;
    console.warn('[update]', status.error);
  }
  return status;
}

// ~/.codetycoon/bin/code-tycoon(.cmd): runs the installed copy with its Node (nothing on PATH)
export const SHIM_DIR = path.join(DATA_DIR, 'bin');
export function writeShim(app = ROOT) {
  fs.mkdirSync(SHIM_DIR, { recursive: true });
  const main = path.join(app, 'bin', 'code-tycoon.mjs');
  if (process.platform === 'win32') {
    // `(goto) 2>nul &` leaves the batch file before node runs: `uninstall --all` deletes this file,
    // and cmd would otherwise complain that it can't find it (exit code and arguments pass through)
    fs.writeFileSync(path.join(SHIM_DIR, 'code-tycoon.cmd'), `@(goto) 2>nul & "${process.execPath}" --no-warnings "${main}" %*\r\n`);
    return path.join(SHIM_DIR, 'code-tycoon.cmd');
  }
  const f = path.join(SHIM_DIR, 'code-tycoon');
  const q = s => "'" + s.replace(/'/g, "'\\''") + "'";
  fs.writeFileSync(f, `#!/bin/sh\nexec ${q(process.execPath)} --no-warnings ${q(main)} "$@"\n`, { mode: 0o755 });
  return f;
}

// keep the running version and the new one, nothing older
function prune(keep) {
  try {
    for (const d of fs.readdirSync(PKG_DIR)) if (d !== keep && d !== CURRENT) fs.rmSync(path.join(PKG_DIR, d), { recursive: true, force: true });
  } catch {}
}

export function startUpdates() {
  if (!managed() || process.env.CODETYCOON_AUTOUPDATE === '0' || process.env.CODETYCOON_CONTAINER) return;
  setTimeout(() => { checkForUpdate(); setInterval(checkForUpdate, 24 * 3600e3).unref(); }, 10 * 60e3).unref();
}
