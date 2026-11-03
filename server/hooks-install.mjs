// npm run hooks:install / hooks:uninstall, or the setup buttons on the overview
// Adds Visualizer's hook to ~/.claude/settings.json (backup first) and keeps
// transcripts from being auto-deleted after 30 days. The hook is an HTTP hook:
// Claude Code posts the payload itself (about 10 ms, silent when Visualizer is
// down) instead of starting a node process per event. VISUALIZER_HOOK=command
// installs the old command hook instead.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CLAUDE_DIR, VIS_DIR, PORT } from './paths.mjs';

const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const HOOK = path.join(VIS_DIR, 'hook.mjs');
const TOKEN_FILE = path.join(VIS_DIR, 'token');
const URL = `http://127.0.0.1:${PORT}/hook`;
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

const isOurs = h => (typeof h?.command === 'string' && h.command.includes('.visualizer') && h.command.includes('hook.mjs'))
  || (h?.type === 'http' && typeof h.url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/hook$/.test(h.url) && !!h.headers?.['x-visualizer-token']);

function readSettings() {
  const raw = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, 'utf8') : '{}';
  return { raw, settings: JSON.parse(raw) };
}

export function hooksInstalled() {
  try { return EVENTS.every(ev => (readSettings().settings.hooks?.[ev] || []).some(g => (g.hooks || []).some(isOurs))); } catch { return false; }
}

export function setHooks(mode) {
  if (mode !== 'install' && mode !== 'uninstall') throw new Error('usage: hooks-install.mjs install|uninstall');
  const { raw, settings } = readSettings();
  const backup = path.join(VIS_DIR, `settings.backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(backup, raw);

  let token = '';
  try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
  if (!token && mode === 'install') { token = crypto.randomBytes(24).toString('hex'); fs.writeFileSync(TOKEN_FILE, token); }

  const useCommand = process.env.VISUALIZER_HOOK === 'command';
  settings.hooks ||= {};
  for (const ev of EVENTS) {
    const groups = (settings.hooks[ev] || []).map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isOurs(h)) })).filter(g => g.hooks.length);
    if (mode === 'install') {
      const entry = useCommand ? { type: 'command', command: `node "${HOOK}"`, timeout: 5 }
        : { type: 'http', url: URL, timeout: 2, headers: { 'x-visualizer-token': token } };
      groups.push(TOOL_EVENTS.has(ev) ? { matcher: '*', hooks: [entry] } : { hooks: [entry] });
    }
    if (groups.length) settings.hooks[ev] = groups; else delete settings.hooks[ev];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;

  if (mode === 'install') {
    fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'hook.mjs'), HOOK);
    if (!(settings.cleanupPeriodDays >= 3650)) settings.cleanupPeriodDays = 3650;
  }
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  return `${mode}ed Code Tycoon hooks (${useCommand ? 'command' : 'http'}) in ${SETTINGS}\nbackup: ${backup}${mode === 'install' ? '\ncleanupPeriodDays: ' + settings.cleanupPeriodDays : ''}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(setHooks(process.argv[2])); } catch (e) { console.log(e.message); process.exit(1); }
}
