// What every file in a tool's folder is, for the scan, the snapshot and restore.
//
//   config   settings, MCP servers, commands: copied, secrets cut out into the vault
//   memory   instructions and memory (CLAUDE.md, AGENTS.md, project memory): copied
//   skill    skills: copied
//   secret   a file that is a secret as a whole (token, private key): goes into the vault
//   login    an OAuth sign-in: never copied, restore asks for a fresh sign-in
//   history  transcripts, databases, large data: out of scope, the audit reports it
//   deps     installed packages (node_modules, venv): reinstalled, not copied
//   state    caches, locks, telemetry: skipped
//   junk     logs, backups, old copies: skipped, counted
//   other    files nobody declared: copied like config and named in the audit
//   autostart  a launcher that starts something at login (Windows Startup folder)
export const COPIED = new Set(['config', 'memory', 'skill', 'other', 'autostart']);

// Rules shared by every folder walk. A pattern ending in `/` is a folder rule:
// the whole folder takes that class.
export const COMMON_RULES = [
  ['**/node_modules/', 'deps'],
  ['**/.venv/', 'deps'], ['**/venv/', 'deps'], ['**/__pycache__/', 'state'],
  ['**/.git/', 'state'], ['**/cache/', 'state'], ['**/.cache/', 'state'],
  ['**/*backup*/', 'junk'], ['**/*-backups/', 'junk'],
  ['**/*.log', 'junk'], ['**/*.log.*', 'junk'], ['**/*.bak', 'junk'], ['**/*.bak-*', 'junk'], ['**/*.old', 'junk'],
  ['**/*.backup-*', 'junk'], ['**/*.orig', 'junk'], ['**/.DS_Store', 'junk'], ['**/Thumbs.db', 'junk'], ['**/desktop.ini', 'junk'],
  ['**/*.pid', 'state'], ['**/*.lock', 'state'], ['**/*-wal', 'state'], ['**/*-shm', 'state'],
];

// A copied file bigger than this is data, not setup.
export const MAX_COPY = 5 << 20;
