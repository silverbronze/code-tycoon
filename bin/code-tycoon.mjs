#!/usr/bin/env node
// npx code-tycoon [start] [--no-open]   - run the server and open the city
// npx code-tycoon hooks install|uninstall - live updates from Claude Code hooks
// npx code-tycoon autostart install|uninstall - start the server at login
// npx code-tycoon index [project]       - backfill one project (or all tracked)
// npx code-tycoon audit | snapshot <target> | restore <source> - back up and rebuild the AI setup
// npx code-tycoon tunnel connect <relay url> --token <t> | off | status - reach this PC from anywhere
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = f => path.join(here, '..', 'server', f);
const args = process.argv.slice(2);
const cmd = args.includes('--help') || args.includes('-h') ? 'help' : args.find(a => !a.startsWith('-')) || 'start';
const port = Number(process.env.CODETYCOON_PORT || process.env.VISUALIZER_PORT || 4400);
const url = `http://127.0.0.1:${port}`;

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Code Tycoon needs Node 22.13 or newer (built-in node:sqlite); this is ${process.versions.node}.`);
  process.exit(1);
}

function run(file, rest) {
  const p = spawn(process.execPath, ['--no-warnings', server(file), ...rest], { stdio: 'inherit' });
  p.on('exit', code => process.exit(code ?? 0));
}

function open() {
  if (args.includes('--no-open')) return;
  const [bin, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(bin, a, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
}

async function up() {
  try { return (await fetch(url + '/api/pulse', { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
}

if (cmd === 'start') {
  const { refreshAutostart } = await import('../server/autostart.mjs');
  refreshAutostart();
  if (await up()) { console.log(`Code Tycoon is already running on ${url}`); open(); process.exit(0); }
  await import('../server/index.mjs');
  for (let i = 0; i < 50 && !(await up()); i++) await new Promise(r => setTimeout(r, 200));
  open();
} else if (cmd === 'hooks' && ['install', 'uninstall'].includes(args[1])) {
  run('hooks-install.mjs', [args[1]]);
} else if (cmd === 'autostart' && ['install', 'uninstall'].includes(args[1])) {
  run('autostart.mjs', [args[1]]);
} else if (cmd === 'index' || cmd === 'stats') {
  run('cli.mjs', args);
} else if (cmd === 'audit' || cmd === 'protect' || cmd === 'snapshot' || cmd === 'restore') {
  run('setup/cli.mjs', args);
} else if (cmd === 'tunnel') {
  run('tunnel-cli.mjs', args);
} else {
  console.log(`Usage:
  npx code-tycoon [--no-open]          start the server on ${url} and open it
  npx code-tycoon hooks install        instant live updates (backs up ~/.claude/settings.json first)
  npx code-tycoon hooks uninstall      remove the hooks
  npx code-tycoon autostart install    start the server hidden at every login
  npx code-tycoon autostart uninstall  stop starting it at login
  npx code-tycoon index [project]      backfill one project, or every tracked one
  npx code-tycoon audit [--json]       what of your AI setup and projects exists only on this disk
  npx code-tycoon protect [--to github|<folder>]
                                       put unpushed projects in private repos and keep them pushed
  npx code-tycoon snapshot <target>    save settings, MCP servers, memory, skills and an encrypted
                                       vault of secrets to a folder or your own private git repo
  npx code-tycoon restore <source>     rebuild that setup here (asks before writing; --yes to skip)
  npx code-tycoon tunnel connect <relay url> --token <token>
                                       reach this PC's Code Tycoon from anywhere through a relay
  npx code-tycoon tunnel off | status`);
  process.exit(cmd === 'help' ? 0 : 1);
}
