// The Claude account's plan limits (the 5-hour session window and the weekly ones), the same
// numbers Claude Code's /usage shows. Read with the OAuth token Claude Code keeps; we never
// refresh it ourselves (that would rotate the refresh token and log Claude Code out), so
// while it is expired we keep the last answer and mark it stale.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const URL = 'https://api.anthropic.com/api/oauth/usage';
const EVERY = 60e3;      // ask at most once a minute
const BACKOFF = 5 * 60e3; // after a failure

let last = null;     // { at, plan, limits: [...] }
let tried = 0, wait = EVERY, error = null, inflight = null;

function credentials() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  let raw = null;
  try { raw = fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8'); } catch {}
  // macOS keeps them in the login keychain instead
  if (!raw && process.platform === 'darwin') {
    try { raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', timeout: 3000 }); } catch {}
  }
  if (!raw) return null;
  try { return JSON.parse(raw).claudeAiOauth || null; } catch { return null; }
}

const LABEL = { session: '5-hour session', weekly_all: 'Week, all models', weekly_scoped: 'Week' };
const SHORT = { session: '5h', weekly_all: 'week' };

function parse(j) {
  const t = s => s ? Date.parse(s) || null : null;
  let limits = Array.isArray(j.limits) ? j.limits.map(l => {
    const model = l.scope?.model?.display_name;
    return { kind: l.kind, group: l.group, percent: Math.round(Number(l.percent) || 0), resets: t(l.resets_at), severity: l.severity || 'normal',
      label: l.kind === 'weekly_scoped' && model ? `Week, ${model}` : LABEL[l.kind] || l.kind, short: SHORT[l.kind] || null };
  }) : [];
  // older answer shape: five_hour / seven_day / seven_day_<model>
  if (!limits.length) for (const [k, v] of Object.entries(j)) {
    if (!v || typeof v !== 'object' || v.utilization == null) continue;
    const kind = k === 'five_hour' ? 'session' : k === 'seven_day' ? 'weekly_all' : k.startsWith('seven_day_') ? 'weekly_scoped' : null;
    if (!kind) continue;
    const model = kind === 'weekly_scoped' ? k.slice(10).replace(/^./, c => c.toUpperCase()) : null;
    limits.push({ kind, group: kind === 'session' ? 'session' : 'weekly', percent: Math.round(v.utilization), resets: t(v.resets_at), severity: 'normal',
      label: model ? `Week, ${model}` : LABEL[kind], short: SHORT[kind] || null });
  }
  const extra = j.extra_usage?.is_enabled ? { used: j.extra_usage.used_credits, limit: j.extra_usage.monthly_limit, percent: j.extra_usage.utilization, currency: j.extra_usage.currency } : null;
  return { limits, extra };
}

async function fetchLimits() {
  const c = credentials();
  if (!c?.accessToken) { error = 'no Claude login found'; return; }
  if (c.expiresAt && c.expiresAt < Date.now()) { error = 'login token expired; it renews the next time Claude Code runs'; return; }
  const r = await fetch(URL, { headers: { Authorization: `Bearer ${c.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' }, signal: AbortSignal.timeout(10e3) });
  if (!r.ok) { error = `usage endpoint answered ${r.status}`; wait = BACKOFF; return; }
  last = { at: Date.now(), plan: c.subscriptionType || null, tier: c.rateLimitTier || null, ...parse(await r.json()) };
  error = null; wait = EVERY;
}

// Never waits on the network: returns what we have and refreshes in the background.
export function accountLimits() {
  // a call that stalled (seen while the server's startup backfill blocked the loop) is dropped
  if (inflight && Date.now() - tried > 30e3) { inflight = null; error = 'the usage endpoint did not answer'; wait = EVERY; }
  if (!inflight && Date.now() - tried > wait) {
    tried = Date.now();
    const p = inflight = fetchLimits().catch(e => { error = e.message; wait = BACKOFF; }).finally(() => { if (inflight === p) inflight = null; });
  }
  if (!last) return error ? { error, limits: [] } : null;
  return { ...last, stale: Date.now() - last.at > 10 * 60e3, error };
}

// the first answer, for a page that has nothing yet
export async function accountLimitsNow() {
  accountLimits();
  if (inflight) await Promise.race([inflight, new Promise(r => setTimeout(r, 12e3))]);
  return accountLimits();
}
