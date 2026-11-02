// npm run autostart:install / autostart:uninstall
// Windows: a hidden launcher in the user's Startup folder runs the server at login.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
if (process.platform !== 'win32') { console.log('autostart is only set up for Windows'); process.exit(1); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const startup = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const file = path.join(startup, 'Visualizer.vbs');

if (mode === 'install') {
  if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) { console.log('run `npm run build` first'); process.exit(1); }
  const log = path.join(process.env.USERPROFILE, '.visualizer', 'server.log');
  // window style 0 = hidden; False = do not wait
  const vbs = [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${root}"`,
    `sh.Run "cmd /c node --no-warnings server\\index.mjs >> ""${log}"" 2>&1", 0, False`,
    '',
  ].join('\r\n');
  fs.writeFileSync(file, vbs);
  console.log('installed', file);
} else if (mode === 'uninstall') {
  fs.rmSync(file, { force: true });
  console.log('removed', file);
} else {
  console.log('usage: autostart.mjs install|uninstall'); process.exit(1);
}
