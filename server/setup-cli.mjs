// code-tycoon setup [--code <setup code>] [--relay <url>]
//   One non-interactive, idempotent command (agents run it; site/install.* call it): checks for
//   Claude Code, installs the hooks and the login launcher, connects this PC to the account the
//   setup code belongs to, starts the server and waits until the tunnel is up. Plain progress
//   lines; exit 0 = done, 1 = failed, with the reason in one sentence.
// code-tycoon uninstall [--all]
//   Removes the launcher and the hooks, disconnects this PC from its account and stops the server.
//   Asks before deleting ~/.codetycoon (your data); --all deletes it without asking.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn, execFileSync } from 'node:child_process';
import { DATA_DIR, PORT, CLAUDE_DIR, findClaudeCli } from './paths.mjs';
import { setHooks, hooksInstalled } from './hooks-install.mjs';
import { setAutostart, autostartSupported, launchRoot } from './autostart.mjs';
import { managed, writeShim } from './update.mjs';
import { redeem, readTunnel, reloadLocal, localStatus, waitConnected, forget, relayBase, DEFAULT_RELAY } from './connect.mjs';

const a = process.argv.slice(2), sub = a[0];
const flag = n => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : null; };
const say = s => console.log(s);
const fail = s => { console.log('Setup failed: ' + s); process.exit(1); };
const LOCAL = `http://127.0.0.1:${PORT}`;
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const up = async () => { try { return (await fetch(LOCAL + '/api/pulse', { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } };

function onPath(cmd) {
  try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; }
}
// Claude Code (or Codex) must be here: without it there is nothing to show
function agentFound() {
  const cli = findClaudeCli();
  if (cli !== 'claude' && fs.existsSync(cli)) return 'Claude Code';
  if (onPath('claude')) return 'Claude Code';
  if (fs.existsSync(path.join(CLAUDE_DIR, 'projects'))) return 'Claude Code';
  if (onPath('codex') || fs.existsSync(path.join(os.homedir(), '.codex', 'sessions'))) return 'Codex';
  return null;
}

// On Windows a spawned child inherits this process's stdout handle, and whoever ran setup (an
// agent's shell, the install script) would wait on it until the server exits. The login launcher
// starts it through WScript.Shell.Run, which passes no handles on, so that is used when it exists.
function startServer() {
  const root = launchRoot();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const vbs = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'CodeTycoon.vbs');
  if (process.platform === 'win32' && fs.existsSync(vbs)) {
    spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return;
  }
  const log = fs.openSync(path.join(DATA_DIR, 'server.log'), 'a');
  const p = spawn(process.execPath, ['--no-warnings', path.join(root, 'server', 'index.mjs')], { cwd: root, detached: true, stdio: ['ignore', log, log], windowsHide: true });
  p.unref();
}

async function setup() {
  const code = flag('--code') || process.env.CT_SETUP_CODE || null;
  const relay = flag('--relay') || DEFAULT_RELAY;
  say(`Node ${process.versions.node}: ok`);
  const agent = agentFound();
  if (!agent) fail('Claude Code is not installed on this computer (Code Tycoon shows what it does, so install it first: https://claude.com/claude-code).');
  say(`${agent}: found`);

  try { say('Hooks: ' + (hooksInstalled() ? 'already installed' : setHooks('install'))); }
  catch (e) { fail('could not install the Claude Code hooks: ' + e.message); }
  if (autostartSupported()) {
    try { say('Start at login: ' + setAutostart('install')); }
    catch (e) { fail('could not set up start at login: ' + e.message); }
  }
  if (managed()) say('Command: ' + writeShim() + ' (e.g. `tunnel status`, `uninstall`)');

  if (code) {
    try { const j = await redeem(code, relay); say(`Setup code: ok, this PC joins ${j.login}'s account`); }
    catch (e) { fail(e.message + (/fetch failed|ENOTFOUND|ECONN/.test(e.message) ? ' (no internet?)' : '')); }
  } else if (!readTunnel()?.token) say(`Not connected to an account. Get a setup code at ${relayBase(relay)}/_/welcome, or run: code-tycoon tunnel login`);

  // a script install that runs an older version than this one: restart it on the new one
  const running = await up() ? await localStatus() : null;
  if (running?.update?.managed && running.update.current !== VERSION) {
    const pid = serverPid();
    if (pid && pid !== process.pid) {
      try { process.kill(pid); say(`Server: stopped version ${running.update.current}`); } catch {}
      for (let i = 0; i < 20 && (await up()); i++) await new Promise(r => setTimeout(r, 250));
    }
  }
  if (await up()) {
    say('Server: already running on ' + LOCAL);
    if (!(await reloadLocal())) say('Server: an older Code Tycoon is running; it connects within 30 seconds');
  } else {
    startServer();
    for (let i = 0; i < 60 && !(await up()); i++) await new Promise(r => setTimeout(r, 500));
    if (!(await up())) fail(`the server did not start; see ${path.join(DATA_DIR, 'server.log')}`);
    say('Server: started on ' + LOCAL);
  }

  if (!readTunnel()?.token) { say('Done (local only).'); return; }
  say('Tunnel: connecting…');
  const s = await waitConnected(60e3);
  if (s?.state === 'revoked') fail(s.error);
  if (s?.state !== 'connected') fail('the tunnel did not connect within a minute' + (s?.error ? ` (${s.error})` : '') + '; run `code-tycoon tunnel status` to see why.');
  say(`connected as ${s.account.login}`);
  if (!s.account.confirmed) say('Last step, in the browser: confirm "Is this your PC?" on the page where you got the setup code.');
}

// the server on our port, by its process id (netstat / lsof); only a node process is stopped
function serverPid() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
      const m = out.split('\n').map(l => l.trim().split(/\s+/)).find(c => c[1] === `127.0.0.1:${PORT}` && c[3] === 'LISTENING') || out.split('\n').map(l => l.trim().split(/\s+/)).find(c => /:(\d+)$/.exec(c[1] || '')?.[1] === String(PORT) && c[3] === 'LISTENING');
      const pid = m && Number(m[4]);
      if (!pid) return null;
      const name = execFileSync('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
      return /node/i.test(name) ? pid : null;
    }
    const pid = Number(execFileSync('lsof', ['-ti', `tcp:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n')[0]);
    if (!pid) return null;
    return /node/.test(execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' })) ? pid : null;
  } catch { return null; }
}

async function uninstall() {
  const all = a.includes('--all');
  if (autostartSupported()) { try { say('Start at login: ' + setAutostart('uninstall')); } catch (e) { say('Start at login: ' + e.message); } }
  try { say('Hooks: ' + setHooks('uninstall')); } catch (e) { say('Hooks: ' + e.message); }
  say(await forget() ? 'Tunnel: this PC was disconnected from its account' : 'Tunnel: was not connected');
  const pid = await up() ? serverPid() : null;
  if (pid && pid !== process.pid) {
    try { process.kill(pid); say('Server: stopped'); } catch (e) { say('Server: could not stop it (' + e.message + ')'); }
    await new Promise(r => setTimeout(r, 1500));
  } else if (await up()) say('Server: still running on ' + LOCAL + '; stop it yourself');

  let del = all;
  if (!all && fs.existsSync(DATA_DIR)) {
    if (process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      del = /^y/i.test(await rl.question(`Delete ${DATA_DIR} too (your Code Tycoon data, settings and the app itself)? [y/N] `));
      rl.close();
    } else say(`Kept ${DATA_DIR} (your data). Run \`code-tycoon uninstall --all\` to delete it too.`);
  }
  if (del && fs.existsSync(DATA_DIR)) {
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); say('Deleted ' + DATA_DIR); }
    catch {
      // this very process may run from ~/.codetycoon (the install script's Node): finish once it exits
      if (process.platform === 'win32') spawn('cmd', ['/c', `ping -n 3 127.0.0.1 >nul & rmdir /s /q "${DATA_DIR}"`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      else spawn('sh', ['-c', `sleep 2; rm -rf "${DATA_DIR}"`], { detached: true, stdio: 'ignore' }).unref();
      say('Deleting ' + DATA_DIR + ' as soon as this command ends');
    }
  }
  say('Code Tycoon is uninstalled.');
}

if (sub === 'setup') await setup();
else if (sub === 'uninstall') await uninstall();
else { console.log('usage: code-tycoon setup [--code <code>] [--relay <url>] | uninstall [--all]'); process.exit(1); }
