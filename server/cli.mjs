// node server/cli.mjs index [projectRootOrName]   - backfill one project (or all tracked)
// node server/cli.mjs stats  <projectRootOrName>  - counts used to verify the parser
import { db } from './db.mjs';
import { discover, indexProject, setTracked, trackedSet } from './indexer.mjs';
import { projectId } from './paths.mjs';

const [cmd, arg] = process.argv.slice(2);

function resolve(found, a) {
  if (!a) return null;
  const want = projectId(a);
  if (found.has(want)) return want;
  const byName = [...found.keys()].filter(k => k.split('/').pop() === a.toLowerCase());
  return byName.length === 1 ? byName[0] : null;
}

const found = discover();
if (cmd === 'index') {
  const ids = arg ? [resolve(found, arg)] : [...trackedSet()];
  if (ids.includes(null)) { console.error('unknown project', arg); process.exit(1); }
  for (const pid of ids) {
    setTracked(pid, true);
    const t0 = Date.now();
    const r = indexProject(pid, found, (d, n) => process.stdout.write(`\r${pid}: ${d}/${n} files`));
    console.log(`\n${pid}: ${r.files} files, ${r.fresh.length} new items in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
} else if (cmd === 'stats') {
  const pid = resolve(found, arg);
  console.log(db.prepare('SELECT * FROM projects WHERE id=?').get(pid));
  console.log(db.prepare('SELECT kind, COUNT(*) n, SUM(inferred) inferred FROM events WHERE project_id=? GROUP BY kind ORDER BY n DESC').all(pid));
  console.log('tasks', db.prepare('SELECT COUNT(*) n FROM tasks WHERE project_id=?').get(pid).n,
    'agents', db.prepare('SELECT COUNT(*) n FROM agents a JOIN sessions s ON s.id=a.session_id WHERE s.project_id=?').get(pid).n);
  console.log(db.prepare('SELECT target, COUNT(*) n FROM events WHERE project_id=? AND kind=\'remote\' GROUP BY target ORDER BY n DESC LIMIT 15').all(pid));
} else {
  console.log([...found].map(([k, v]) => `${v.files.length}\t${k}`).join('\n'));
}
