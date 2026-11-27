// Sign in / sign out of a Code Tycoon account, from the overview header.
// Signing in is the device-code flow (server/connect.mjs): the server asks the relay for a code,
// you approve it on the relay's page while signed in there, and the account token is saved in
// ~/.codetycoon/tunnel.json — so it lasts across restarts until Sign out.
import { h } from './util';

type Status = {
  state: 'off' | 'connecting' | 'connected' | 'revoked';
  error: string | null;
  account: { login: string; account_url?: string; device?: string } | null;
  saved: { login: string | null; on: boolean } | null;
  signin: { state: 'starting' | 'waiting' | 'done' | 'failed'; code?: string; url?: string; login?: string; error?: string } | null;
  fromEnv: boolean;
  relay: string;
};

const call = async (path = '', post = false): Promise<Status> => {
  const r = await fetch('/api/tunnel' + path, post ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' } : undefined);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
};

export class AccountChip {
  el = h('div', { class: 'acct' });
  private s: Status | null = null;
  private busy = false;
  private confirm = false;
  private popup: Window | null = null;
  private timer = 0;

  constructor() { this.load(); }

  private async load(path = '', post = false) {
    window.clearTimeout(this.timer);
    try { this.s = await call(path, post); } catch { /* server restarting: keep the last state */ }
    const sin = this.s?.signin;
    // the approval page opens in the tab reserved on click (a popup opened after an await is blocked)
    if (sin?.state === 'waiting' && sin.url && this.popup) {
      try { if (!this.popup.closed) this.popup.location.href = sin.url; } catch {}
      this.popup = null;
    }
    if (sin?.state === 'failed' && this.popup) { try { this.popup.close(); } catch {} this.popup = null; }
    if (sin?.state === 'done') this.popup = null;
    this.render();
    const waiting = sin?.state === 'waiting' || sin?.state === 'starting' || this.s?.state === 'connecting';
    this.timer = window.setTimeout(() => this.load(), waiting ? 2000 : 15000);
  }

  private async act(path: string) {
    this.busy = true; this.confirm = false; this.render();
    await this.load(path, true);
    this.busy = false; this.render();
  }

  private signIn() {
    this.popup = window.open('about:blank', '_blank');
    this.act('/signin');
  }

  private add(...kids: (Node | string | null)[]) { for (const k of kids) if (k != null) this.el.append(k); }

  private render() {
    const s = this.s;
    this.el.replaceChildren();
    if (!s) return;
    const sin = s.signin;
    const login = s.account?.login || s.saved?.login || sin?.login;
    const signedIn = !!s.saved?.on || s.fromEnv;

    if (sin?.state === 'waiting' && !signedIn) {
      this.add(
        h('span', { class: 'acct-what' }, 'Enter ', h('b', { class: 'acct-code' }, sin.code || ''), ' on '),
        h('a', { href: sin.url, target: '_blank', rel: 'noopener' }, 'the sign-in page'),
        h('span', { class: 'acct-dim' }, ' · waiting…'));
      return;
    }
    if (signedIn && s.state !== 'revoked') {
      const live = s.state === 'connected';
      this.add(
        h('i', { class: 'acct-dot' + (live ? ' on' : '') }),
        h('span', { class: 'acct-what', title: live ? 'Connected: you can open this PC\'s Code Tycoon from anywhere' : (s.error || 'Connecting to ' + s.relay) },
          'Signed in', login ? [' as ', h('b', {}, login)] : null, live ? null : h('span', { class: 'acct-dim' }, ' · connecting…')),
        live && s.account?.account_url ? h('a', { href: s.account.account_url, target: '_blank', rel: 'noopener', class: 'acct-dim' }, 'open from anywhere') : null);
      if (s.fromEnv) return; // the account comes from CODETYCOON_TUNNEL_* settings, not a sign-in
      if (this.confirm) {
        this.add(h('span', { class: 'acct-dim' }, 'Sign out? This PC stops being reachable from your account.'),
          h('button', { class: 'chip', disabled: this.busy, onclick: () => this.act('/signout') }, this.busy ? 'Signing out…' : 'Sign out'),
          h('button', { class: 'chip', onclick: () => { this.confirm = false; this.render(); } }, 'Cancel'));
      } else this.add(h('button', { class: 'chip', onclick: () => { this.confirm = true; this.render(); } }, 'Sign out'));
      return;
    }
    const note = s.state === 'revoked' ? 'This PC was disconnected from your account.'
      : sin?.state === 'failed' ? 'Sign-in failed: ' + sin.error : null;
    this.add(
      note ? h('span', { class: 'acct-dim' }, note) : null,
      h('button', { class: 'chip go', disabled: this.busy || sin?.state === 'starting', title: 'Sign in to your Code Tycoon account to open this PC\'s Code Tycoon from anywhere. You stay signed in until you sign out.', onclick: () => this.signIn() },
        this.busy || sin?.state === 'starting' ? 'Signing in…' : s.state === 'revoked' ? 'Sign in again' : 'Sign in'));
  }
}
