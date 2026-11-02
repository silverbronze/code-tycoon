#!/usr/bin/env node
// npx code-tycoon [start] [--no-open]   - run the server and open the city
// npx code-tycoon hooks install|uninstall - live updates from Claude Code hooks
// npx code-tycoon index [project]       - backfill one project (or all tracked)
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = f => path.join(here, '..', 'server', f);
const args = process.argv.slice(2);
const cmd = args.includes('--help') || args.includes('-h') ? 'help' : args.find(a => !a.startsWith('-')) || 'start';
const port = Number(process.env.VISUALIZER_PORT || 4400);
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
  if (await up()) { console.log(`Code Tycoon is already running on ${url}`); open(); process.exit(0); }
  await import('../server/index.mjs');
  for (let i = 0; i < 50 && !(await up()); i++) await new Promise(r => setTimeout(r, 200));
  open();
} else if (cmd === 'hooks' && ['install', 'uninstall'].includes(args[1])) {
  run('hooks-install.mjs', [args[1]]);
} else if (cmd === 'index' || cmd === 'stats') {
  run('cli.mjs', args);
} else {
  console.log(`Usage:
  npx code-tycoon [--no-open]          start the server on ${url} and open it
  npx code-tycoon hooks install        instant live updates (backs up ~/.claude/settings.json first)
  npx code-tycoon hooks uninstall      remove the hooks
  npx code-tycoon index [project]      backfill one project, or every tracked one`);
  process.exit(cmd === 'help' ? 0 : 1);
}
