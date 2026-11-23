// code-tycoon tunnel connect <relay url> [--token <t>] | off | status
// Writes ~/.codetycoon/tunnel.json; the running server picks it up within 30 s (server/tunnel.mjs).
// The token can also come from CODETYCOON_TUNNEL_TOKEN, which keeps it out of the shell history.
import fs from 'node:fs';
import { TUNNEL_FILE } from './tunnel.mjs';
import { DATA_DIR, PORT } from './paths.mjs';

// argv: tunnel <sub> [url] [--token t]
const a = process.argv.slice(2), sub = a[1], url = a[2] && !a[2].startsWith('--') ? a[2] : null;
const flag = n => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : null; };
const read = () => { try { return JSON.parse(fs.readFileSync(TUNNEL_FILE, 'utf8')); } catch { return null; } };
const write = j => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(TUNNEL_FILE, JSON.stringify(j, null, 2), { mode: 0o600 }); };

if (sub === 'connect') {
  const token = flag('--token') || process.env.CODETYCOON_TUNNEL_TOKEN || read()?.token;
  if (!url || !/^wss?:\/\//.test(url) || !token) {
    console.error('usage: code-tycoon tunnel connect wss://<relay>/tunnel/connect --token <token>');
    process.exit(1);
  }
  write({ url, token, on: true });
  console.log(`Saved. The running Code Tycoon connects to ${url} within 30 seconds.`);
} else if (sub === 'off') {
  const j = read();
  if (j) write({ ...j, on: false });
  console.log('Tunnel off. The running Code Tycoon disconnects within 30 seconds.');
} else {
  const j = read();
  console.log(j ? `Config: ${j.url} (${j.on === false ? 'off' : 'on'})` : 'Not set up: code-tycoon tunnel connect <relay url> --token <token>');
  try {
    const s = await (await fetch(`http://127.0.0.1:${PORT}/api/tunnel`, { signal: AbortSignal.timeout(2000) })).json();
    console.log(`Server: ${s.state}${s.since ? ' since ' + new Date(s.since).toLocaleString() : ''}${s.error ? ` (${s.error})` : ''}`);
  } catch { console.log('Server: Code Tycoon is not running'); }
}
