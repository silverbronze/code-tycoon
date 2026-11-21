// GitHub for `code-tycoon protect`: sign-in by device flow (a short code approved on
// github.com; needs only a public client ID, no secret) or a token from the environment,
// and creating private repos. The token is kept in ~/.codetycoon/github.json (owner-only)
// and handed to git per command, never written into a repo's config.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../paths.mjs';

const FILE = path.join(DATA_DIR, 'github.json');
const API = 'https://api.github.com';
const UA = { 'user-agent': 'code-tycoon', accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
// Set once Code Tycoon's GitHub App is registered; until then CODETYCOON_GITHUB_CLIENT_ID.
const CLIENT_ID = process.env.CODETYCOON_GITHUB_CLIENT_ID || '';

export function savedLogin() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; } }
export function githubToken() {
  return process.env.CODETYCOON_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || savedLogin()?.token || null;
}
export const canDeviceLogin = () => !!CLIENT_ID;

async function api(method, url, token, body) {
  const r = await fetch(API + url, { method, headers: { ...UA, authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

const who = new Map(); // token -> { login, at }
export async function whoami(token = githubToken()) {
  if (!token) return null;
  const hit = who.get(token);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.login;
  const r = await api('GET', '/user', token);
  const login = r.status === 200 ? r.data.login : null;
  who.set(token, { login, at: Date.now() });
  return login;
}

// Step one of the device flow: the code to show the person.
export async function startDeviceLogin() {
  if (!CLIENT_ID) throw new Error('GitHub sign-in is not set up in this build; set CODETYCOON_GITHUB_TOKEN to a token that may create repos');
  const r = await fetch('https://github.com/login/device/code', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: 'repo' }), signal: AbortSignal.timeout(30000) });
  const d = await r.json();
  if (!d.device_code) throw new Error('GitHub refused the sign-in: ' + (d.error_description || d.error || r.status));
  return { device: d.device_code, code: d.user_code, url: d.verification_uri, interval: d.interval || 5, expires: Date.now() + d.expires_in * 1000 };
}

// Step two: wait until the person approves, then keep the token.
export async function finishDeviceLogin(start) {
  let wait = start.interval * 1000;
  while (Date.now() < start.expires) {
    await new Promise(r => setTimeout(r, wait));
    const r = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, device_code: start.device, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }), signal: AbortSignal.timeout(30000) });
    const d = await r.json();
    if (d.access_token) {
      const login = await whoami(d.access_token);
      fs.writeFileSync(FILE, JSON.stringify({ token: d.access_token, login, at: Date.now() }), { mode: 0o600 });
      return login;
    }
    if (d.error === 'slow_down') wait += 5000;
    else if (d.error !== 'authorization_pending') throw new Error('GitHub sign-in failed: ' + (d.error_description || d.error));
  }
  throw new Error('the sign-in code expired; try again');
}

export function logout() { fs.rmSync(FILE, { force: true }); }

// A private repo under the signed-in account, or under an organization.
// An empty repo of that name that is already there is reused (a second run after a failed push).
export async function createRepo(name, owner = null) {
  const token = githubToken();
  if (!token) throw new Error('not signed in to GitHub');
  const me = await whoami(token);
  if (!me) throw new Error('the GitHub token was refused');
  const where = owner && owner.toLowerCase() !== me.toLowerCase() ? `/orgs/${owner}/repos` : '/user/repos';
  const r = await api('POST', where, token, { name, private: true, auto_init: false, description: 'Protected by Code Tycoon' });
  const full = `${owner || me}/${name}`;
  if (r.status === 201) return { url: r.data.clone_url, full: r.data.full_name, created: true };
  if (r.status === 422) {
    const ex = await api('GET', `/repos/${full}`, token);
    if (ex.status === 200 && ex.data.size === 0 && ex.data.private) return { url: ex.data.clone_url, full, created: false };
    throw new Error(`${full} already exists and is not an empty private repo`);
  }
  throw new Error(`GitHub could not create ${full}: ${r.data.message || r.status}`);
}

// git arguments that authenticate one command against github.com with our token
export function gitAuth(url) {
  const token = githubToken();
  if (!token || !/^https:\/\/github\.com\//i.test(url)) return [];
  const basic = Buffer.from('x-access-token:' + token).toString('base64');
  return ['-c', `http.https://github.com/.extraheader=Authorization: Basic ${basic}`];
}
