// code-tycoon tunnel login [--relay <url>] | connect <wss url> [--token <t>] | off | status
// login: prints a code, you approve it in the browser while signed in, the relay hands this PC its
// own device token. connect: a token you made by hand (headless boxes), or from
// CODETYCOON_TUNNEL_TOKEN, which keeps it out of the shell history.
// Both write ~/.codetycoon/tunnel.json; the running server picks it up at once (or within 30 s).
import { readTunnel, writeTunnel, deviceLogin, reloadLocal, localStatus, waitConnected, openBrowser, DEFAULT_RELAY } from './connect.mjs';

// argv: tunnel <sub> [url] [--token t] [--relay r]
const a = process.argv.slice(2), sub = a[1], url = a[2] && !a[2].startsWith('--') ? a[2] : null;
const flag = n => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : null; };

function describe(s) {
  if (!s) return 'Server: Code Tycoon is not running (start it: npx code-tycoon)';
  if (s.state === 'revoked') return 'Server: ' + s.error;
  let line = `Server: ${s.state}${s.since ? ' since ' + new Date(s.since).toLocaleString() : ''}${s.error && s.state !== 'connected' ? ` (${s.error})` : ''}`;
  const ac = s.account;
  if (ac) {
    line += `\nAccount: ${ac.login}${ac.device ? ` · this PC is "${ac.device}"` : ''}`;
    if (!ac.confirmed) line += '\n  Waiting for you to confirm this PC in the browser ("Is this your PC?").';
    else if (ac.live === false) line += '\n  Standing by: another PC of this account is live. Restart Code Tycoon here to switch to this one.';
    if (ac.account_url) line += `\n  Devices: ${ac.account_url}`;
  }
  if (s.update?.ready) line += `\nUpdate: ${s.update.ready} is installed and starts next time.`;
  else if (s.update?.error) line += `\nUpdate: ${s.update.error}`;
  return line;
}

if (sub === 'login') {
  const relay = flag('--relay') || DEFAULT_RELAY;
  try {
    const j = await deviceLogin(relay, {
      onCode: s => {
        console.log(`Open ${s.verify_url.replace(/\?.*$/, '')} and enter ${s.user_code}`);
        if (a.includes('--no-open')) console.log('(waiting for the approval…)');
        else { console.log('(opening it in your browser; waiting for the approval…)'); openBrowser(s.verify_url); }
      },
    });
    console.log(`Approved for ${j.login}. Token saved in ~/.codetycoon/tunnel.json.`);
    if (await reloadLocal()) {
      const s = await waitConnected(20e3);
      console.log(s?.state === 'connected' ? `connected as ${s.account.login}` : describe(s));
    } else console.log('Code Tycoon is not running here; it connects as soon as it starts (npx code-tycoon).');
  } catch (e) { console.error('Login failed: ' + e.message); process.exit(1); }
} else if (sub === 'connect') {
  const token = flag('--token') || process.env.CODETYCOON_TUNNEL_TOKEN || readTunnel()?.token;
  if (!url || !/^wss?:\/\//.test(url) || !token) {
    console.error('usage: code-tycoon tunnel connect wss://<relay>/tunnel/connect --token <token>');
    process.exit(1);
  }
  writeTunnel({ url, token, on: true });
  console.log(await reloadLocal() ? `Saved. Connecting to ${url}.` : `Saved. Code Tycoon connects to ${url} when it starts.`);
} else if (sub === 'off') {
  const j = readTunnel();
  if (j) writeTunnel({ ...j, on: false });
  await reloadLocal();
  console.log('Tunnel off.');
} else if (!sub || sub === 'status') {
  const j = readTunnel();
  console.log(j ? `Config: ${j.url} (${j.on === false ? 'off' : 'on'})` : 'Not set up: code-tycoon tunnel login');
  console.log(describe(await localStatus()));
} else {
  console.error('usage: code-tycoon tunnel login [--relay <url>] | connect <wss url> --token <t> | off | status');
  process.exit(1);
}
