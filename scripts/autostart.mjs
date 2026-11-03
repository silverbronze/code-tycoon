// npm run autostart:install / autostart:uninstall
// Starts the server at login, logging to ~/.visualizer/server.log:
//   Windows: a hidden launcher in the user's Startup folder
//   macOS:   a LaunchAgent in ~/Library/LaunchAgents
//   Linux:   a systemd user service in ~/.config/systemd/user
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
if (mode !== 'install' && mode !== 'uninstall') { console.log('usage: autostart.mjs install|uninstall'); process.exit(1); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = os.homedir();
const log = path.join(home, '.visualizer', 'server.log');
// launchd and systemd start with a bare PATH, so node is named by its full path
const node = process.execPath;

if (mode === 'install' && !fs.existsSync(path.join(root, 'dist', 'index.html'))) { console.log('run `npm run build` first'); process.exit(1); }
fs.mkdirSync(path.dirname(log), { recursive: true });

const xml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// systemd: quote each argument, escape \ " and %
const unitArg = s => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%') + '"';

const targets = {
  win32: {
    file: path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Visualizer.vbs'),
    // window style 0 = hidden; False = do not wait
    body: () => [
      'Set sh = CreateObject("WScript.Shell")',
      `sh.CurrentDirectory = "${root}"`,
      `sh.Run "cmd /c node --no-warnings server\\index.mjs >> ""${log}"" 2>&1", 0, False`,
      '',
    ].join('\r\n'),
  },
  darwin: {
    file: path.join(home, 'Library', 'LaunchAgents', 'dev.visualizer.server.plist'),
    body: () => `<?xml version="1.0" encoding="UTF-8"?>
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
    body: () => `[Unit]
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
  catch { console.log(`could not run \`systemctl --user ${args.join(' ')}\`; this needs a systemd user session`); }
}

const t = targets[process.platform];
if (!t) { console.log(`autostart is not set up for ${process.platform}`); process.exit(1); }
if (mode === 'install') {
  fs.mkdirSync(path.dirname(t.file), { recursive: true });
  fs.writeFileSync(t.file, t.body());
  t.after?.(true);
  console.log('installed', t.file);
} else {
  if (fs.existsSync(t.file)) t.after?.(false);
  fs.rmSync(t.file, { force: true });
  console.log('removed', t.file);
}
