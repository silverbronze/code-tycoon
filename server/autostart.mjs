// npm run autostart:install / autostart:uninstall, or the setup buttons on the overview
// Starts the server at login, logging to ~/.visualizer/server.log:
//   Windows: a hidden launcher in the user's Startup folder
//   macOS:   a LaunchAgent in ~/Library/LaunchAgents
//   Linux:   a systemd user service in ~/.config/systemd/user
// Run through npx, the package sits in npm's cache, which npm may clear, so the
// app is copied to ~/.visualizer/app and the launcher points there.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = os.homedir();
const APP = path.join(home, '.visualizer', 'app');
const log = path.join(home, '.visualizer', 'server.log');
// launchd and systemd start with a bare PATH, so node is named by its full path
const node = process.execPath;
const fromNpx = /[\\/]_npx[\\/]/.test(ROOT);

const xml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// systemd: quote each argument, escape \ " and %
const unitArg = s => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%') + '"';
// cmd /c strips the outer pair of quotes, VBScript doubles every quote
const vbs = s => '"' + s.replace(/"/g, '""') + '"';

const targets = {
  win32: {
    file: path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Visualizer.vbs'),
    // window style 0 = hidden; False = do not wait
    body: root => [
      'Set sh = CreateObject("WScript.Shell")',
      `sh.CurrentDirectory = "${root}"`,
      `sh.Run ${vbs(`cmd /c ""${node}" --no-warnings server\\index.mjs >> "${log}" 2>&1"`)}, 0, False`,
      '',
    ].join('\r\n'),
  },
  darwin: {
    file: path.join(home, 'Library', 'LaunchAgents', 'dev.visualizer.server.plist'),
    body: root => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.visualizer.server</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string><string>--no-warnings</string><string>server/index.mjs</string></array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`,
  },
  linux: {
    file: path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', 'visualizer.service'),
    body: root => `[Unit]
Description=Code Tycoon (Visualizer) server

[Service]
WorkingDirectory=${unitArg(root)}
ExecStart=${unitArg(node)} --no-warnings server/index.mjs
StandardOutput=append:${log}
StandardError=append:${log}
Restart=on-failure

[Install]
WantedBy=default.target
`,
    after: on => systemctl(on ? ['enable', 'visualizer.service'] : ['disable', 'visualizer.service']),
  },
};

function systemctl(args) {
  try { execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' }); execFileSync('systemctl', ['--user', ...args], { stdio: 'ignore' }); }
  catch { throw new Error(`could not run \`systemctl --user ${args.join(' ')}\`; this needs a systemd user session`); }
}

// the parts of the package the server needs, plus its one dependency
function copyApp() {
  const ws = path.dirname(createRequire(import.meta.url).resolve('ws'));
  fs.rmSync(APP, { recursive: true, force: true });
  for (const d of ['bin', 'server', 'dist', 'package.json']) fs.cpSync(path.join(ROOT, d), path.join(APP, d), { recursive: true });
  fs.cpSync(ws, path.join(APP, 'node_modules', 'ws'), { recursive: true });
}

const target = () => targets[process.platform];
export const autostartSupported = () => !!target();
export const autostartInstalled = () => !!target() && fs.existsSync(target().file);

export function setAutostart(mode) {
  if (mode !== 'install' && mode !== 'uninstall') throw new Error('usage: autostart.mjs install|uninstall');
  const t = target();
  if (!t) throw new Error(`autostart is not set up for ${process.platform}`);
  if (mode === 'uninstall') {
    if (fs.existsSync(t.file)) t.after?.(false);
    fs.rmSync(t.file, { force: true });
    return 'removed ' + t.file;
  }
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) throw new Error('run `npm run build` first');
  if (fromNpx) copyApp();
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.mkdirSync(path.dirname(t.file), { recursive: true });
  fs.writeFileSync(t.file, t.body(fromNpx ? APP : ROOT));
  t.after?.(true);
  return 'installed ' + t.file;
}

// A newer `npx code-tycoon` refreshes the copy the launcher starts next login.
export function refreshAutostart() {
  if (!fromNpx || !autostartInstalled()) return;
  const version = f => { try { return JSON.parse(fs.readFileSync(path.join(f, 'package.json'), 'utf8')).version; } catch { return null; } };
  if (version(APP) !== version(ROOT)) try { copyApp(); } catch {}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(setAutostart(process.argv[2])); } catch (e) { console.log(e.message); process.exit(1); }
}
