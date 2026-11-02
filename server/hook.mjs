// Claude Code hook (command fallback; the installer prefers an HTTP hook):
// forwards the hook payload to Visualizer. Installed as a copy in
// ~/.visualizer/hook.mjs. Must never block or fail a session: short timeout,
// always exit 0, silent when Visualizer is not running.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.env.VISUALIZER_INTERNAL === '1') process.exit(0);
const port = Number(process.env.VISUALIZER_PORT || 4400);
let token = '';
try { token = fs.readFileSync(path.join(os.homedir(), '.visualizer', 'token'), 'utf8').trim(); } catch {}
let body = '';
const done = () => process.exit(0);
setTimeout(done, 400).unref();
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { body += d; });
process.stdin.on('end', () => {
  const req = http.request({ host: '127.0.0.1', port, path: '/hook', method: 'POST', timeout: 300,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-visualizer-token': token } }, res => { res.resume(); res.on('end', done); });
  req.on('error', done);
  req.on('timeout', () => { req.destroy(); done(); });
  req.end(body);
});
