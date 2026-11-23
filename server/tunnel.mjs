// Tunnel: reach this PC's Code Tycoon from anywhere, through a relay you trust.
//
// The server keeps one outbound WebSocket open to the relay (no open port on this PC). The
// relay sends the browser's requests down it; each is replayed against this server on
// 127.0.0.1, exactly as a local page would send it (localhost Host, no Origin), so every
// check the server makes still applies. The answer goes back the same way. Browser
// WebSockets (the live /ws feed) are carried through it too.
//
// The tunnel lives as long as this server runs: when the PC or the app is off, the relay
// has nobody to send to and answers "your PC is not connected" itself.
//
// Config: ~/.codetycoon/tunnel.json { "url": "wss://…/tunnel/connect", "token": "…" }, or
// CODETYCOON_TUNNEL_URL + CODETYCOON_TUNNEL_TOKEN. Re-read every 30 s, so `code-tycoon tunnel`
// changes take effect without a restart.
//
// Frames (JSON text; bodies base64):
//   relay → PC  {t:'req', id, method, path, headers, body}     PC → relay {t:'res', id, status, headers, body}
//   relay → PC  {t:'wso', id, path, headers}                   PC → relay {t:'wsa', id} | {t:'wsc', id, code}
//   both ways   {t:'wsm', id, data, bin}  {t:'wsc', id, code}
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { DATA_DIR, PORT } from './paths.mjs';

export const TUNNEL_FILE = path.join(DATA_DIR, 'tunnel.json');
const MAX_BODY = 50 * 1024 * 1024;
// headers that belong to one hop, or that would leak the relay's side into this server
const DROP = new Set(['host', 'origin', 'cookie', 'connection', 'upgrade', 'keep-alive', 'transfer-encoding', 'te', 'trailer',
  'proxy-authorization', 'proxy-authenticate', 'content-length', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-accept',
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip']);
const clean = h => Object.fromEntries(Object.entries(h || {}).filter(([k]) => !DROP.has(k.toLowerCase())));

export function tunnelConfig() {
  const env = { url: process.env.CODETYCOON_TUNNEL_URL, token: process.env.CODETYCOON_TUNNEL_TOKEN };
  if (env.url && env.token) return env;
  try { const j = JSON.parse(fs.readFileSync(TUNNEL_FILE, 'utf8')); if (j.url && j.token && j.on !== false) return { url: j.url, token: j.token }; } catch {}
  return null;
}

const status = { state: 'off', url: null, since: null, error: null };
export const tunnelStatus = () => ({ ...status });

let ws = null, cfgKey = '', retry = 0, timer = null;
const socks = new Map(); // id -> local WebSocket (a browser's /ws, carried through)

function connect(cfg) {
  clearTimeout(timer);
  Object.assign(status, { state: 'connecting', url: cfg.url, error: null });
  const sock = new WebSocket(cfg.url, { headers: { authorization: 'Bearer ' + cfg.token }, handshakeTimeout: 15e3, maxPayload: MAX_BODY * 2 });
  ws = sock;
  let ping = null;
  sock.on('open', () => {
    retry = 0;
    Object.assign(status, { state: 'connected', since: Date.now(), error: null });
    console.log('[tunnel] connected to', cfg.url);
    ping = setInterval(() => { try { sock.ping(); } catch {} }, 25e3);
  });
  sock.on('unexpected-response', (_req, res) => { status.error = res.statusCode === 401 ? 'the relay refused the token' : 'relay answered ' + res.statusCode; sock.terminate(); });
  sock.on('error', e => { status.error = status.error || e.message; });
  sock.on('message', (m, isBin) => { if (!isBin) handle(sock, String(m)); });
  sock.on('close', () => {
    clearInterval(ping);
    for (const s of socks.values()) try { s.close(); } catch {}
    socks.clear();
    if (ws !== sock) return; // replaced or switched off on purpose
    ws = null;
    if (status.state === 'connected') console.log('[tunnel] disconnected');
    status.state = 'connecting';
    const wait = Math.min(60e3, 2e3 * 2 ** Math.min(retry++, 5));
    timer = setTimeout(() => { const c = tunnelConfig(); if (c) connect(c); else stop(); }, wait);
  });
}

function stop() {
  clearTimeout(timer);
  const s = ws; ws = null;
  if (s) try { s.close(); } catch {}
  Object.assign(status, { state: 'off', url: null, since: null, error: null });
}

const send = (sock, o) => { if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(o)); };

function handle(sock, text) {
  let f; try { f = JSON.parse(text); } catch { return; }
  if (f.t === 'req') return request(sock, f);
  if (f.t === 'wso') return openWs(sock, f);
  const s = socks.get(f.id);
  if (!s) return;
  if (f.t === 'wsm') { if (s.readyState === WebSocket.OPEN) s.send(f.bin ? Buffer.from(f.data, 'base64') : f.data, { binary: !!f.bin }); }
  else if (f.t === 'wsc') { socks.delete(f.id); try { s.close(); } catch {} }
}

// one HTTP request, replayed against this server as a local page would send it
function request(sock, f) {
  const body = f.body ? Buffer.from(f.body, 'base64') : null;
  const headers = { ...clean(f.headers), host: `127.0.0.1:${PORT}` };
  if (body) headers['content-length'] = body.length;
  const req = http.request({ host: '127.0.0.1', port: PORT, method: f.method, path: f.path, headers }, res => {
    const parts = []; let n = 0;
    res.on('data', c => { n += c.length; if (n <= MAX_BODY) parts.push(c); });
    res.on('end', () => {
      if (n > MAX_BODY) return send(sock, { t: 'res', id: f.id, status: 502, headers: { 'content-type': 'text/plain' }, body: Buffer.from('response too large for the tunnel').toString('base64') });
      send(sock, { t: 'res', id: f.id, status: res.statusCode, headers: clean(res.headers), body: Buffer.concat(parts).toString('base64') });
    });
  });
  req.setTimeout(120e3, () => req.destroy(new Error('timed out')));
  req.on('error', e => send(sock, { t: 'res', id: f.id, status: 502, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ error: 'PC: ' + e.message })).toString('base64') }));
  req.end(body || undefined);
}

// a browser WebSocket (the live feed), opened against this server
function openWs(sock, f) {
  const s = new WebSocket(`ws://127.0.0.1:${PORT}${f.path}`, { headers: { ...clean(f.headers), host: `127.0.0.1:${PORT}` } });
  socks.set(f.id, s);
  s.on('open', () => send(sock, { t: 'wsa', id: f.id }));
  s.on('message', (m, bin) => send(sock, { t: 'wsm', id: f.id, data: bin ? Buffer.from(m).toString('base64') : String(m), bin: !!bin }));
  s.on('close', code => { if (socks.delete(f.id)) send(sock, { t: 'wsc', id: f.id, code }); });
  s.on('error', () => { if (socks.delete(f.id)) send(sock, { t: 'wsc', id: f.id, code: 1011 }); });
}

// started by the server once it listens; follows tunnel.json from then on
export function startTunnel() {
  const tick = () => {
    const c = tunnelConfig(), k = c ? c.url + '\n' + c.token : '';
    if (k === cfgKey) return;
    cfgKey = k;
    if (ws) { const s = ws; ws = null; try { s.close(); } catch {} }
    if (c) connect(c); else stop();
  };
  tick();
  setInterval(tick, 30e3).unref();
}
