// OpenAI Codex CLI: ~/.codex (or CODEX_HOME). config.toml holds MCP servers, often with
// bearer tokens in http_headers; those are cut into the vault like any other secret.
import path from 'node:path';

export default {
  id: 'codex',
  name: 'Codex CLI',
  install: 'npm install -g @openai/codex',
  bin: 'codex',
  dirs: env => [{
    dir: env.vars.CODEX_HOME || path.join(env.home, '.codex'),
    rules: [
      ['auth.json', 'login', { note: 'Codex sign-in or API key' }],
      ['config.toml', 'config'],
      ['AGENTS.md', 'memory'], ['AGENTS.override.md', 'memory'],
      ['prompts/', 'config'], ['rules/', 'config'], ['skills/', 'skill'],
      ['memories_*.sqlite', 'memory'],
      ['sessions/', 'history'], ['archived_sessions/', 'history'], ['history.jsonl', 'history'],
      ['*.sqlite', 'state'], ['log/', 'state'], ['cache/', 'state'], ['tmp/', 'state'], ['.sandbox/', 'state'],
      ['thread-writer-locks/', 'state'], ['plugins/', 'state'], ['models_cache.json', 'state'], ['installation_id', 'state'],
      ['.sandbox_migration', 'state'], ['version.json', 'state'],
    ],
  }],
  files: () => [],
  logins: ['Codex CLI (run `codex login`)'],
};
