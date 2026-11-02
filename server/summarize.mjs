// Task titles and subsystem descriptions through the user's own Claude Code CLI
// (`claude -p`, Haiku). Runs from an empty folder with project-only settings and
// no session persistence, so these calls fire no hooks and leave no transcripts:
// Visualizer never draws its own summarizer.
import { spawn } from 'node:child_process';
import { db, kvGet, kvSet } from './db.mjs';
import { SUMMARIZER_CWD, findClaudeCli, rel } from './paths.mjs';
import { BASE_ROLES, STYLES } from './roles.mjs';

const BATCH = 20;
let running = false;
let disabled = process.env.VISUALIZER_NO_LLM === '1';
let failures = 0;
const listeners = [];
export function onSummaries(fn) { listeners.push(fn); }

function runClaude(prompt, timeoutMs = 120e3) {
  return new Promise((resolve, reject) => {
    const p = spawn(findClaudeCli(), ['-p', '--model', 'haiku', '--no-session-persistence', '--setting-sources', 'project',
      '--tools', '', '--output-format', 'json'], { cwd: SUMMARIZER_CWD, windowsHide: true,
      env: { ...process.env, VISUALIZER_INTERNAL: '1' } });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('timeout')); }, timeoutMs);
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        if (j.is_error) return reject(new Error(String(j.result).slice(0, 200)));
        const text = String(j.result || '');
        const m = text.match(/\{[\s\S]*\}/);
        resolve(m ? JSON.parse(m[0]) : {});
      } catch (e) { reject(new Error(`claude exited ${code}: ${(err || out).slice(0, 300)}`)); }
    });
    p.stdin.end(prompt);
  });
}

function describeTask(t, root) {
  const ev = db.prepare(`SELECT kind, path, target, COUNT(*) n FROM events WHERE task_id=? AND kind IN ('write','read','remote','spawn')
    GROUP BY kind, path, target ORDER BY (kind='write') DESC, n DESC LIMIT 10`).all(t.id);
  const places = ev.map(e => `${e.kind}:${e.path ? (rel(root, e.path) ?? e.path.split('/').slice(-2).join('/')) : e.target}`);
  return { id: t.id, prompt: t.prompt.replace(/\s+/g, ' ').slice(0, 700), did: places };
}

async function titleBatch(pid) {
  const root = db.prepare('SELECT root FROM projects WHERE id=?').get(pid)?.root;
  const tasks = db.prepare('SELECT id, prompt FROM tasks WHERE project_id=? AND title IS NULL ORDER BY ts DESC LIMIT ?').all(pid, BATCH);
  if (!tasks.length) return 0;
  const items = tasks.map(t => describeTask(t, root));
  const prompt = `You label work items in a software project's activity log. For each item, write a title of 3-8 words that says what was done or asked, in plain words (sentence case, no trailing period, no quotes). Use the files touched as context. If the prompt is a short reply ("yes", "go", "done"), infer the task from the files.
Return ONLY a JSON object mapping each id to its title.

${JSON.stringify(items)}`;
  const res = await runClaude(prompt);
  const up = db.prepare('UPDATE tasks SET title=? WHERE id=?');
  const titled = [];
  for (const t of tasks) {
    const title = typeof res[t.id] === 'string' ? res[t.id].trim().slice(0, 90) : null;
    up.run(title || '—', t.id); // '—' marks "tried", so a bad answer is not retried forever
    titled.push({ id: t.id, title: title || null });
  }
  for (const l of listeners) l({ type: 'titles', pid, titles: titled });
  return tasks.length;
}

// Plain-English names, one per module ("Payment API"), then the project's
// districts: the roles its code plays (Storefront, Database, Security...) and
// which role every file has. Only what is missing is asked for, so a growing
// project costs one small call now and then, not a full re-description.
const describing = new Set();
export async function describeModules(pid, { modules, places }) {
  if (disabled || describing.has(pid)) return;
  describing.add(pid);
  try {
    const named = await nameModules(pid, modules);
    const zoned = await assignRoles(pid, modules, places);
    if (named || zoned) for (const l of listeners) l({ type: 'subsys', pid });
  } catch (e) { console.warn('[summarize] names:', e.message); }
  finally { describing.delete(pid); }
}

async function nameModules(pid, modules) {
  const subsys = kvGet('subsys:' + pid) || {};
  const needM = modules.filter(m => !subsys[m.id]);
  if (!needM.length) return false;
  const res = await runClaude(`You name the parts of one software project for an architecture map.
"modules": folders with sample file names (an id ending in /* stands for several look-alike folders). For each id give "name": a 1-3 word plain-English name for what it is (e.g. "Payment API", "Crawler jobs"), and "desc": one sentence on its role.
Return ONLY JSON: {"modules": {"<id>": {"name": "...", "desc": "..."}}}.

${JSON.stringify({ modules: needM.map(m => ({ id: m.id || '(root)', files: m.files, sample: m.sample })) })}`, 180e3);
  for (const [k, v] of Object.entries(res.modules || {})) if (v && typeof v === 'object') subsys[k === '(root)' ? '' : k] = { name: String(v.name || '').slice(0, 40), desc: String(v.desc || '').slice(0, 200) };
  for (const m of needM) if (!subsys[m.id]) subsys[m.id] = { name: '', desc: '' }; // tried; do not ask again
  kvSet('subsys:' + pid, subsys);
  return true;
}

const SHOWN = 120;    // file paths listed per module; the rest follow its default
const PER_CALL = 450; // file paths per assignment call
async function assignRoles(pid, modules, places) {
  const subsys = kvGet('subsys:' + pid) || {};
  const saved = kvGet('roles:' + pid) || { districts: null, modules: {}, places: {} };
  if (!saved.districts) {
    const res = await runClaude(`You zone one software project like a city planner: every district is one job the code does, e.g. "Storefront", "Database", "Security", "Payments & orders". A district cuts across folders: a login helper inside a storefront folder still belongs to Security.
Starting vocabulary (keep an id when its meaning fits; drop ones the project does not need; add project-specific districts with short kebab-case ids):
${JSON.stringify(BASE_ROLES)}
Pick 6-12 districts for this project. Always keep "security" and "database" if the project has any auth or data-access code, and keep "workspace" for leftovers.
Give every district a "style": the look of its buildings, from this list: ${JSON.stringify(STYLES.map(x => ({ id: x.id, look: x.desc })))}
Return ONLY JSON: {"districts": [{"id": "...", "name": "1-3 words", "desc": "one short sentence", "style": "..."}]}

${JSON.stringify({
      modules: modules.map(m => ({ id: m.id || '(root)', name: subsys[m.id]?.name || undefined, files: m.files, sample: m.all.slice(0, 15).map(p => p.split('/').pop()) })),
      places: places.map(p => p.label),
    })}`, 180e3);
    const list = (Array.isArray(res.districts) ? res.districts : []).filter(d => d && /^[a-z0-9-]{2,24}$/.test(d.id) && d.name)
      .map(d => ({ id: d.id, name: String(d.name).slice(0, 28), desc: String(d.desc || '').slice(0, 160), style: STYLES.some(x => x.id === d.style) ? d.style : undefined }));
    if (list.length < 3) throw new Error('no usable district list');
    if (!list.some(d => d.id === 'workspace')) list.push(BASE_ROLES.find(d => d.id === 'workspace'));
    saved.districts = list;
    kvSet('roles:' + pid, saved);
  }
  // districts zoned before styles existed: one small call picks a look for the project's own ones
  const unstyled = saved.districts.filter(d => !d.style && !BASE_ROLES.some(b => b.id === d.id));
  if (unstyled.length && !saved.styled) {
    saved.styled = true; // asked once; keyword rules cover whatever comes back empty
    const res = await runClaude(`Pick the look of each city district's buildings. Districts are jobs code does in one software project.
Looks: ${JSON.stringify(STYLES.map(x => ({ id: x.id, look: x.desc })))}
Return ONLY JSON: {"<district id>": "<look id>"}

${JSON.stringify(unstyled.map(d => ({ id: d.id, name: d.name, desc: d.desc })))}`, 90e3).catch(() => ({}));
    for (const d of unstyled) if (STYLES.some(x => x.id === res?.[d.id])) d.style = res[d.id];
    kvSet('roles:' + pid, saved);
  }
  const ids = new Set(saved.districts.map(d => d.id));
  // modules never zoned, or grown by a fifth since
  const need = modules.filter(m => { const s = saved.modules[m.id]; if (!s) return true; const seen = new Set(s.seen); const fresh = m.all.filter(p => !seen.has(p)).length; return fresh >= Math.max(5, m.all.length * 0.2); });
  const needP = places.filter(p => !(p.id in saved.places));
  if (!need.length && !needP.length) return false;
  const batches = [];
  let cur = [], n = 0;
  for (const m of need) {
    const k = Math.min(SHOWN, m.all.length);
    if (cur.length && n + k > PER_CALL) { batches.push(cur); cur = []; n = 0; }
    cur.push(m); n += k;
  }
  if (cur.length || needP.length) batches.push(cur);
  for (const [bi, batch] of batches.entries()) {
    const askP = bi === 0 ? needP : [];
    const res = await runClaude(`Assign the files of one software project to its districts (the job the code does, not the folder it sits in).
Districts: ${JSON.stringify(saved.districts)}
For each module give "d": the district most of its files belong to, and "x": only the files whose district differs from "d", as {"<path>": "<district id>"}. Judge each file by its full path and name: auth, login, sessions, passwords, rate limits, bot rules and firewall config are Security; SQL, migrations, schemas and DB access helpers are Database; tests go to a testing district if there is one. When a module lists "more", the unlisted files follow "d".
For each place (data stores and outside systems) give the district it serves.
Return ONLY JSON: {"modules": {"<module id>": {"d": "...", "x": {}}}, "places": {"<place id>": "..."}}

${JSON.stringify({
      modules: batch.map(m => ({ id: m.id || '(root)', name: subsys[m.id]?.name || undefined, files: m.all.slice(0, SHOWN), more: m.all.length > SHOWN ? m.all.length - SHOWN : undefined })),
      places: askP.length ? askP.map(p => ({ id: p.id, label: p.label, kind: p.kind, named_in: p.refs.length ? p.refs : undefined })) : undefined,
    })}`, 240e3);
    for (const m of batch) {
      const r = res.modules?.[m.id || '(root)'];
      const d = r && ids.has(r.d) ? r.d : saved.modules[m.id]?.d || 'workspace';
      const x = { ...(saved.modules[m.id]?.x || {}) };
      for (const [p, v] of Object.entries(r?.x || {})) if (ids.has(v) && m.all.includes(p)) { if (v === d) delete x[p]; else x[p] = v; }
      saved.modules[m.id] = { d, x, seen: m.all };
    }
    for (const p of askP) { const v = res.places?.[p.id]; saved.places[p.id] = ids.has(v) ? v : null; }
    kvSet('roles:' + pid, saved);
  }
  return true;
}

// A short plain-English paragraph on what a day of work held.
export async function summarizeDay(d, sessionTitles) {
  if (disabled) throw new Error('titling is off');
  const facts = {
    tasks: d.tasks.map(t => ({ session: sessionTitles[t.s] || t.s.slice(0, 8), what: t.title || t.prompt })).slice(0, 80),
    busiest_modules: d.modules.map(m => `${m.name} (${m.n} edits)`),
    files_edited_by_several_sessions: d.shared.map(x => x.p),
    commits: d.commits.map(c => c.s),
    new_connections: d.ties.map(t => `${t.an} → ${t.bn} (${t.why})`),
  };
  const res = await runClaude(`You write a daily recap of work done in one software project by several Claude Code sessions.
Write 3-5 short sentences in plain words: what got done, which areas changed most, anything worth checking (files edited by several sessions, new connections between parts). No headings, no lists, no praise.
Return ONLY JSON: {"text": "..."}

${JSON.stringify(facts)}`);
  return String(res.text || '').trim();
}

// Work through untitled tasks of tracked projects, newest first.
export async function pump(pids) {
  if (running || disabled) return;
  running = true;
  try {
    for (const pid of pids) {
      while (true) {
        let n;
        try { n = await titleBatch(pid); failures = 0; }
        catch (e) {
          console.warn('[summarize]', e.message);
          if (++failures >= 3) { disabled = true; console.warn('[summarize] disabled after 3 failures; titles fall back to prompts'); }
          break;
        }
        if (!n) break;
      }
    }
  } finally { running = false; }
}

export function summarizerStatus() {
  const r = db.prepare("SELECT COUNT(*) total, SUM(title IS NOT NULL) done FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.tracked=1").get();
  return { enabled: !disabled, running, total: r.total, done: r.done || 0 };
}
