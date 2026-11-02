// npm run hooks:install / hooks:uninstall
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

const mode = process.argv[2];
const raw = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, 'utf8') : '{}';
const settings = JSON.parse(raw);
const backup = path.join(VIS_DIR, `settings.backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(backup, raw);

let token = '';
try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
if (!token && mode === 'install') { token = crypto.randomBytes(24).toString('hex'); fs.writeFileSync(TOKEN_FILE, token); }

const isOurs = h => (typeof h?.command === 'string' && h.command.includes('.visualizer') && h.command.includes('hook.mjs'))
  || (h?.type === 'http' && typeof h.url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/hook$/.test(h.url) && !!h.headers?.['x-visualizer-token']);
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
} else if (mode !== 'uninstall') {
  console.log('usage: hooks-install.mjs install|uninstall'); process.exit(1);
}
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
console.log(`${mode}ed Code Tycoon hooks (${useCommand ? 'command' : 'http'}) in ${SETTINGS}\nbackup: ${backup}${mode === 'install' ? '\ncleanupPeriodDays: ' + settings.cleanupPeriodDays : ''}`);
