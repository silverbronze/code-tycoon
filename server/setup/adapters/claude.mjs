// Claude Code: ~/.claude (or CLAUDE_CONFIG_DIR) plus the MCP servers and per-project
// settings kept in ~/.claude.json, which also holds the account and caches we never copy.
import path from 'node:path';

const configDir = env => env.vars.CLAUDE_CONFIG_DIR || path.join(env.home, '.claude');

export default {
  id: 'claude',
  name: 'Claude Code',
  install: 'npm install -g @anthropic-ai/claude-code',
  bin: 'claude',
  dirs: env => [{
    dir: configDir(env),
    rules: [
      ['.credentials.json', 'login', { note: 'Claude Code sign-in' }],
      ['.claude.json', env.vars.CLAUDE_CONFIG_DIR ? 'config' : 'junk', { pick: 'claude-json' }],
      ['settings.json', 'config', { json: true, transform: 'claude-settings' }],
      ['settings.local.json', 'config', { json: true }],
      ['keybindings.json', 'config', { json: true }],
      ['CLAUDE.md', 'memory'],
      ['statusline*', 'config'],
      ['agents/', 'config'], ['commands/', 'config'], ['output-styles/', 'config'], ['hooks/', 'config'], ['rules/', 'memory'],
      ['skills/', 'skill'],
      // project memory sits next to the transcripts; only memory/ is setup
      ['projects/*/', 'history', { except: { memory: 'memory' }, perProject: true }],
      ['plugins/installed_plugins.json', 'config', { json: true }],
      ['plugins/known_marketplaces.json', 'config', { json: true }],
      ['plugins/', 'state'],
      ['history.jsonl', 'history'], ['plans/', 'history'], ['file-history/', 'history'],
      ['shell-snapshots/', 'state'], ['session-env/', 'state'], ['sessions/', 'state'], ['todos/', 'state'], ['statsig/', 'state'],
      ['telemetry/', 'state'], ['cache/', 'state'], ['debug/', 'state'], ['downloads/', 'state'], ['ide/', 'state'], ['backups/', 'junk'],
      ['paste-cache/', 'state'], ['image-cache/', 'state'], ['logs/', 'state'], ['state/', 'state'], ['tasks/', 'state'], ['teams/', 'state'],
      ['policy-limits*', 'state'], ['remote-settings*', 'state'], ['stats-cache.json', 'state'], ['.last-cleanup', 'state'],
      ['mcp-needs-auth-cache.json', 'state'], ['*-state.json', 'state'], ['*-token', 'secret'], ['*credentials*/', 'secret'],
      ['*token*', 'secret'], ['*.pem', 'secret'], ['*.key', 'secret'],
    ],
  }],
  files: env => env.vars.CLAUDE_CONFIG_DIR ? [] : [
    { abs: path.join(env.home, '.claude.json'), class: 'config', pick: 'claude-json' },
  ],
  logins: ['Claude Code (run `claude`, then /login)'],
};

// ~/.claude.json: only the parts that are setup. The rest is the account, caches and counters.
export function pickClaudeJson(j) {
  const out = {};
  if (j.mcpServers && Object.keys(j.mcpServers).length) out.mcpServers = j.mcpServers;
  const projects = {};
  for (const [p, v] of Object.entries(j.projects || {})) {
    const keep = {};
    for (const k of ['mcpServers', 'allowedTools', 'enabledMcpjsonServers', 'disabledMcpjsonServers', 'mcpContextUris']) {
      const x = v?.[k];
      if (x && (Array.isArray(x) ? x.length : Object.keys(x).length)) keep[k] = x;
    }
    if (Object.keys(keep).length) projects[p] = keep;
  }
  if (Object.keys(projects).length) out.projects = projects;
  return out;
}

// Put the picked parts back into an existing ~/.claude.json without touching the account.
export function mergeClaudeJson(target, picked) {
  const out = { ...target };
  if (picked.mcpServers) out.mcpServers = { ...(target.mcpServers || {}), ...picked.mcpServers };
  if (picked.projects) {
    out.projects = { ...(target.projects || {}) };
    for (const [p, v] of Object.entries(picked.projects)) out.projects[p] = { ...(out.projects[p] || {}), ...v };
  }
  return out;
}
