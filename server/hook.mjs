// Claude Code hook (command fallback; the installer prefers an HTTP hook):
// forwards the hook payload to Code Tycoon. Installed as a copy in
// ~/.codetycoon/hook.mjs. Must never block or fail a session: short timeout,
// always exit 0, silent when Code Tycoon is not running.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.env.CODETYCOON_INTERNAL === '1' || process.env.VISUALIZER_INTERNAL === '1') process.exit(0);
const port = Number(process.env.CODETYCOON_PORT || process.env.VISUALIZER_PORT || 4400);
let token = '';
// ~/.visualizer until the server's first start after the rename moves it
for (const d of ['.codetycoon', '.visualizer']) {
  try { token = fs.readFileSync(path.join(os.homedir(), d, 'token'), 'utf8').trim(); break; } catch {}
}
let body = '';
const done = () => process.exit(0);
setTimeout(done, 400).unref();
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { body += d; });
process.stdin.on('end', () => {
  const req = http.request({ host: '127.0.0.1', port, path: '/hook', method: 'POST', timeout: 300,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-codetycoon-token': token } }, res => { res.resume(); res.on('end', done); });
  req.on('error', done);
  req.on('timeout', () => { req.destroy(); done(); });
  req.end(body);
});
