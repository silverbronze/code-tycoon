// Connecting this PC to an account on a relay: the device-code flow (`tunnel login`), setup codes
// (`setup --code`), and forgetting the device (`uninstall`). Shared by tunnel-cli.mjs and setup-cli.mjs.
// The relay hands out a device token once; it is stored only here, in ~/.codetycoon/tunnel.json (600).
import fs from 'node:fs';
import os from 'node:os';
import { TUNNEL_FILE } from './tunnel.mjs';
import { DATA_DIR, PORT } from './paths.mjs';

export const DEFAULT_RELAY = process.env.CODETYCOON_RELAY || 'https://app.codetycoon.dev';
const LOCAL = `http://127.0.0.1:${PORT}`;

export const readTunnel = () => { try { return JSON.parse(fs.readFileSync(TUNNEL_FILE, 'utf8')); } catch { return null; } };
export function writeTunnel(j) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TUNNEL_FILE, JSON.stringify(j, null, 2), { mode: 0o600 });
  try { fs.chmodSync(TUNNEL_FILE, 0o600); } catch {}
}
// https://relay → its base URL; also accepts the wss://…/tunnel/connect form
export function relayBase(u) {
  const s = String(u || DEFAULT_RELAY).trim().replace(/\/+$/, '');
  return s.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/tunnel\/connect$/, '');
}
export function osName() {
  const p = process.platform;
  return p === 'win32' ? 'Windows' : p === 'darwin' ? 'macOS' : p === 'linux' ? 'Linux' : p;
}
export const machineName = () => os.hostname().replace(/\.local$/, '').slice(0, 60) || 'My PC';

async function post(url, body, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(20e3) });
  let j = {}; try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error(j.error || `the relay answered ${r.status}`);
  return j;
}

// the running server: re-read tunnel.json now instead of within 30 s
export async function localStatus() {
  try { return await (await fetch(LOCAL + '/api/tunnel', { signal: AbortSignal.timeout(2000) })).json(); } catch { return null; }
}
export async function reloadLocal() {
  try { await fetch(LOCAL + '/api/tunnel/reload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(3000) }); return true; } catch { return false; }
}

function save(relay, j) {
  writeTunnel({ url: j.relay_ws, token: j.token, on: true, relay, login: j.login });
}

// setup code from the signed-in welcome page: already tied to the account, works once
export async function redeem(code, relay = DEFAULT_RELAY) {
  const base = relayBase(relay);
  const j = await post(base + '/tunnel/device/redeem', { code, name: machineName(), os: osName() });
  save(base, j);
  return j;
}

// device code: print a code, the user approves it on the relay's /_/connect page
export async function deviceLogin(relay = DEFAULT_RELAY, { onCode } = {}) {
  const base = relayBase(relay);
  const start = await post(base + '/tunnel/device/start', { os: osName() });
  onCode?.(start);
  const until = Date.now() + (start.expires_in || 600) * 1000;
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, (start.interval || 3) * 1000));
    let j;
    try { j = await post(base + '/tunnel/device/poll', { device_code: start.device_code }); } catch { continue; }
    if (j.state === 'ok') { save(base, j); return j; }
    if (j.state === 'expired') break;
  }
  throw new Error('the code expired before it was approved; run `code-tycoon tunnel login` again');
}

// Sign in from the app (POST /api/tunnel/signin): the same device-code flow, run in the background
// while the page polls GET /api/tunnel. state: waiting (code + url to approve) | done | failed
let signin = null;
export const signinState = () => signin && { ...signin };
export function startSignin(relay = DEFAULT_RELAY, onDone = () => {}) {
  if (signin?.state === 'waiting' || signin?.state === 'starting') return signinState();
  signin = { state: 'starting' };
  deviceLogin(relay, { onCode: s => { signin = { state: 'waiting', code: s.user_code, url: s.verify_url, until: Date.now() + (s.expires_in || 600) * 1000 }; } })
    .then(j => { signin = { state: 'done', login: j.login }; onDone(); },
      e => { signin = { state: 'failed', error: e.message.replace(/; run `.*$/, '') }; });
  return signinState();
}
// whether this PC holds an account token, and the login it was saved for (never the token itself)
export function savedAccount() {
  const t = readTunnel();
  return t?.token ? { login: t.login || null, on: t.on !== false } : null;
}
export async function signOut() {
  signin = null;
  return forget();
}

// uninstall: tell the relay this PC is gone (best effort), then forget the token here
export async function forget() {
  const t = readTunnel();
  if (!t?.token) return false;
  try { await post(relayBase(t.relay || t.url) + '/tunnel/device/forget', {}, { authorization: 'Bearer ' + t.token }); } catch {}
  fs.rmSync(TUNNEL_FILE, { force: true });
  return true;
}

// wait until the running server is connected and the relay said who we are
export async function waitConnected(ms = 60e3) {
  const until = Date.now() + ms;
  let s = null;
  while (Date.now() < until) {
    s = await localStatus();
    if (s?.state === 'revoked') return s;
    if (s?.state === 'connected' && s.account) return s;
    await new Promise(r => setTimeout(r, 1000));
  }
  return s;
}

export function openBrowser(url) {
  return import('node:child_process').then(({ spawn }) => {
    const [bin, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(bin, a, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
  });
}
