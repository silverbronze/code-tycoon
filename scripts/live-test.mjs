// End-to-end live check: two real Claude Code sessions edit the same file in a
// demo repo; Visualizer must show both and raise a collision alert.
// usage: node scripts/live-test.mjs <demoRepoPath>
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { findClaudeCli, projectId } from '../server/paths.mjs';

const demo = process.argv[2];
const pid = projectId(demo);
const base = 'http://127.0.0.1:' + (process.env.VISUALIZER_PORT || 4400);
const enc = encodeURIComponent(pid);
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(2) + 's';

function claude(prompt) {
  return new Promise(resolve => {
    // prompt goes on stdin: --allowedTools is variadic and would swallow a trailing prompt argument
    const p = spawn(findClaudeCli(), ['-p', '--model', 'haiku', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Edit,Write'],
      { cwd: demo, windowsHide: true });
    p.stdin.end(prompt);
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('close', code => resolve({ code, out: out.trim().slice(0, 200) }));
  });
}

// 1. make sure the project exists and is tracked
let list = await (await fetch(base + '/api/projects?all=1')).json();
if (!list.projects.some(p => p.id === pid)) {
  console.log(at(), 'seeding a first session so the project has a transcript folder');
  console.log(await claude('Reply with the single word OK. Do not use tools.'));
  await new Promise(r => setTimeout(r, 6000));
}
await fetch(`${base}/api/projects/${enc}/track`, { method: 'POST' });
for (let i = 0; i < 30; i++) { const r = await fetch(`${base}/api/projects/${enc}/live`); if (r.status === 200) break; await new Promise(r => setTimeout(r, 1000)); }
await fetch(`${base}/api/projects/${enc}/city`);
console.log(at(), 'project tracked');

// 2. watch the live feed
const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
const log = [];
await new Promise(r => ws.on('open', r));
ws.send(JSON.stringify({ type: 'subscribe', pid }));
ws.on('message', m => {
  const j = JSON.parse(m);
  const t = Date.now();
  if (j.type === 'events') for (const e of j.events) log.push({ t, type: 'event', s: e.s.slice(0, 8), k: e.k, tt: e.tt, ti: e.ti, via: e.via, d: e.d });
  else if (j.type === 'session') log.push({ t, type: 'session', s: j.session.id.slice(0, 8), state: j.session.state, hooks: j.session.hooks });
  else if (j.type === 'alert') log.push({ t, type: 'alert', kind: j.alert.kind, text: j.alert.text });
  else log.push({ t, type: j.type });
});

// 3. two sessions, same file, at the same time
const task = who => `Use the Edit tool to append exactly one new line "// touched by session ${who}" at the end of src/config.js. Then reply DONE.`;
const [a, b] = await Promise.all([claude(task('A')), claude(task('B'))]);
console.log(at(), 'sessions finished', a.code, b.code);
await new Promise(r => setTimeout(r, 3000));
ws.close();

const kinds = ['prompt', 'read', 'write', 'search', 'cmd', 'touch', 'remote', 'spawn', 'skill', 'ask', 'other'];
for (const e of log) console.log(((e.t - t0) / 1000).toFixed(2).padStart(7), e.type.padEnd(8), e.s || '', e.k != null ? kinds[e.k] : '', e.via || '', e.state || '', e.kind || '', e.text || e.d || '');
const writes = log.filter(e => e.type === 'event' && kinds[e.k] === 'write');
const sessionsWriting = new Set(writes.map(w => w.s));
const alert = log.find(e => e.type === 'alert' && e.kind === 'collision');
console.log('\nwriting sessions:', sessionsWriting.size, 'write events:', writes.length, 'via:', [...new Set(writes.map(w => w.via))].join(','));
if (alert && writes.length >= 2) {
  const second = writes.filter(w => w.s !== writes[0].s)[0] || writes[1];
  console.log(`collision alert ${((alert.t - second.t) / 1000).toFixed(2)}s after the second session's write: PASS`);
} else console.log('collision alert: FAIL', alert ? '' : '(no alert)');
process.exit(0);
