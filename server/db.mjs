import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { VIS_DIR } from './paths.mjs';

export const db = new DatabaseSync(process.env.VISUALIZER_DB || path.join(VIS_DIR, 'visualizer.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, root TEXT, name TEXT, tracked INTEGER DEFAULT 0,
  sessions INTEGER DEFAULT 0, prompts INTEGER DEFAULT 0, first_ts INTEGER, last_ts INTEGER,
  bytes INTEGER DEFAULT 0, indexed_bytes INTEGER DEFAULT 0
);
-- one row per transcript file; offset = bytes already parsed
CREATE TABLE IF NOT EXISTS transcripts (
  file TEXT PRIMARY KEY, slug TEXT, project_id TEXT, session_id TEXT, agent_id TEXT,
  offset INTEGER DEFAULT 0, size INTEGER DEFAULT 0, state TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, project_id TEXT, title TEXT, cwd TEXT, branch TEXT, entrypoint TEXT,
  version TEXT, model TEXT, first_ts INTEGER, last_ts INTEGER, prompts INTEGER DEFAULT 0,
  last_kind TEXT, last_stop TEXT, last_prompt TEXT
);
CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project_id, last_ts);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, session_id TEXT, description TEXT, type TEXT, tool_use_id TEXT,
  first_ts INTEGER, last_ts INTEGER
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, session_id TEXT, project_id TEXT, ts INTEGER, end_ts INTEGER,
  prompt TEXT, title TEXT, n_read INTEGER DEFAULT 0, n_write INTEGER DEFAULT 0,
  n_cmd INTEGER DEFAULT 0, n_remote INTEGER DEFAULT 0, n_agent INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id, ts);
CREATE INDEX IF NOT EXISTS tasks_session ON tasks(session_id, ts);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, project_id TEXT, session_id TEXT, agent_id TEXT, task_id TEXT,
  ts INTEGER, kind TEXT, tool TEXT, path TEXT, target TEXT, detail TEXT,
  inferred INTEGER DEFAULT 0, tuid TEXT
);
CREATE INDEX IF NOT EXISTS events_project ON events(project_id, ts);
CREATE INDEX IF NOT EXISTS events_path ON events(project_id, path);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
-- the file panel matches paths case-insensitively
CREATE INDEX IF NOT EXISTS events_lpath ON events(project_id, lower(path));
-- alerts outlive the toast: kept until dismissed (needs-you resolves itself)
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY, project_id TEXT, kind TEXT, ts INTEGER, text TEXT, sessions TEXT,
  path TEXT, module TEXT, dismissed INTEGER DEFAULT 0, resolved INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS alerts_project ON alerts(project_id, ts);
-- one row per API message (a message is repeated on several transcript records)
CREATE TABLE IF NOT EXISTS usage (
  msg_id TEXT PRIMARY KEY, project_id TEXT, session_id TEXT, task_id TEXT, ts INTEGER, model TEXT,
  tin INTEGER, tout INTEGER, tcr INTEGER, tcw INTEGER, cost REAL
);
CREATE INDEX IF NOT EXISTS usage_task ON usage(task_id);
CREATE INDEX IF NOT EXISTS usage_project ON usage(project_id, ts);
`);
// columns added after the first release
// chk: what a command checks (test/build/types/lint); ok: 1 the tool succeeded, 0 it failed; res: what it said
for (const sql of ['ALTER TABLE sessions ADD COLUMN hook_ts INTEGER', 'ALTER TABLE events ADD COLUMN chk TEXT',
  'ALTER TABLE events ADD COLUMN ok INTEGER', 'ALTER TABLE events ADD COLUMN res TEXT',
  // coaching: 1-hour cache writes (the rest are 5-minute), the subagent a call belongs to, tool result size in chars
  'ALTER TABLE usage ADD COLUMN tcw1h INTEGER DEFAULT 0', 'ALTER TABLE usage ADD COLUMN agent TEXT',
  'ALTER TABLE events ADD COLUMN res_len INTEGER']) { try { db.exec(sql); } catch {} }
db.exec(`CREATE INDEX IF NOT EXISTS events_tuid ON events(tuid);
CREATE INDEX IF NOT EXISTS events_chk ON events(project_id, chk, ts);
CREATE INDEX IF NOT EXISTS usage_session ON usage(session_id, ts);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, ts);
-- one row per context compaction (manual /compact or automatic)
CREATE TABLE IF NOT EXISTS compactions (
  session_id TEXT, project_id TEXT, ts INTEGER, trigger TEXT, pre INTEGER, post INTEGER, PRIMARY KEY(session_id, ts)
);`);

export function kvGet(k) {
  const r = db.prepare('SELECT v FROM kv WHERE k=?').get(k);
  return r ? JSON.parse(r.v) : null;
}
export function kvSet(k, v) {
  db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, JSON.stringify(v));
}

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
