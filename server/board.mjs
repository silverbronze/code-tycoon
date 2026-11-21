// The task board: tasks for any project, written in one place.
//
// A task is routed to the project it belongs to (named in the text, or a small model
// reads every project's name, README and recent work), then run by a real, visible
// Claude Code session in that project's folder, so it walks the city like any session.
// A run is unattended: whatever it cannot do alone comes back as asks, the user's to-do:
//   - questions it leaves in its report (a decision, a secret to put somewhere, a manual
//     step, approval for something irreversible)
//   - commands and tools it was not allowed to use (Claude Code's permission denials)
// Answering the last open ask of a task resumes the same session with the answers.
// In a git project every task works in a worktree of its own (worktree.mjs), so any number
// run side by side; when a task is done its branch is committed and merged into the branch
// the main folder is on (conflicts go back to the session to resolve first). A project that
// is not a git repo (or a task that started in the main folder before worktrees) has one
// run in the main folder at a time; the rest wait in a queue.
//
// A task with distinct stages runs in steps: the first run writes a plan (steps, and which
// earlier steps each one needs) and does step 1; every later step is one more run of the
// same session (or, without resume, a fresh run handed the plan and the step reports).
// A step that waits for the user does not hold up the steps that don't need it. With
// "pause", the board stops after each step for the user to check it before going on.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from './db.mjs';
import { SUMMARIZER_CWD, OWN_DIR_RE, PROJECTS_DIR } from './paths.mjs';
import { listProjects } from './indexer.mjs';
import { runAgent, provider, codexBlocked } from './llm.mjs';
import { projectModel } from './optimize.mjs';
import { syncSoon } from './gitsync.mjs';
import { repoOf, makeWorktree, dropWorktree, commitAll, ahead, changedFiles, predict, mergeIntoBase, mergeBaseIn, unresolved, finishMerge, abortMerge } from './worktree.mjs';

db.exec('CREATE TABLE IF NOT EXISTS board (id TEXT PRIMARY KEY, created INTEGER, v TEXT)');

const RUN_USD = process.env.CODETYCOON_TASK_USD || '10';
const RUN_MS = Number(process.env.CODETYCOON_TASK_MINUTES || 60) * 60e3;
const SURE = 0.7; // below this the user picks the project
const ASK_KINDS = new Set(['decision', 'secret', 'action', 'info', 'approval']);

const listeners = [];
export function onBoard(fn) { listeners.push(fn); }
const tasks = new Map();
const procs = new Map(); // task id -> child process
const planning = new Set(); // task ids whose plan is being made
const newId = () => crypto.randomBytes(5).toString('hex');

const openAsks = t => t.asks.filter(a => a.answer == null);
const view = t => { const w = blockedBy(t); return { ...t, open: openAsks(t).length, wait: w ? { id: w.id, text: w.text.slice(0, 100), project: w.project } : null }; };
function save(t, pub = true) {
  t.updated = Date.now();
  db.prepare('INSERT INTO board(id, created, v) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET v=excluded.v').run(t.id, t.created, JSON.stringify(t));
  if (pub) for (const l of listeners) l({ type: 'board', task: view(t) });
}

export function listBoard() {
  return { tasks: [...tasks.values()].sort((a, b) => b.created - a.created).map(view),
    projects: profiles().map(p => ({ id: p.id, name: p.name, root: p.root, tracked: p.tracked })) };
}

// ------------------------------------------------------------------ routing
let profCache = null;
function about(root) {
  let out = '';
  try { const pj = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); if (pj.description) out = String(pj.description) + '. '; } catch {}
  for (const f of ['README.md', 'readme.md', 'README', 'CLAUDE.md']) {
    let s; try { s = fs.readFileSync(path.join(root, f), 'utf8').slice(0, 3000); } catch { continue; }
    s = s.replace(/```[\s\S]*?```/g, ' ').replace(/<[^>]+>/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s*https?:\/\/\S+\s*$/gm, ' ').replace(/[#>*_`|]/g, ' ').replace(/\s+/g, ' ').trim();
    out += s;
    break;
  }
  return out.slice(0, 280);
}
// Every project with Claude Code history whose folder still exists, with what it is about.
function profiles() {
  if (profCache && Date.now() - profCache.at < 10 * 60e3) return profCache.list;
  const qT = db.prepare("SELECT title FROM tasks WHERE project_id=? AND title IS NOT NULL AND title!='—' ORDER BY ts DESC LIMIT 6");
  const qS = db.prepare('SELECT title FROM sessions WHERE project_id=? AND title IS NOT NULL ORDER BY last_ts DESC LIMIT 4');
  const list = listProjects(false).filter(p => p.root && !OWN_DIR_RE.test(p.root + '/') && fs.existsSync(p.root)).slice(0, 40).map(p => ({
    id: p.id, name: p.name, root: p.root, tracked: !!p.tracked, about: about(p.root),
    recent: [...new Set([...qS.all(p.id), ...qT.all(p.id)].map(r => String(r.title).slice(0, 70)))].slice(0, 8) }));
  profCache = { at: Date.now(), list };
  return list;
}
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function setProject(t, p, route) {
  Object.assign(t, { pid: p.id, project: p.name, root: p.root, route, state: 'ready' });
}

// several lines, or a list: may hold tasks for several projects
const isList = s => /(^|\n)\s*(\d+[.)]|[-*•])\s/.test(s) || s.split(/\n+/).filter(l => l.trim()).length > 1;

// One model call splits the text into separate tasks and routes each one. A single task
// keeps the user's text as is; pieces become tasks of their own (t is the first), run
// side by side in their projects, and one that needs another finished first waits for it.
async function route(t) {
  t.state = 'routing'; save(t);
  const ps = profiles();
  if (!ps.length) { Object.assign(t, { state: 'unrouted', route: { how: 'none', why: 'No projects found', picks: [] } }); return save(t); }
  // one request that names one project needs no model
  const named = ps.filter(p => p.name.length >= 3 && new RegExp(`(^|[^\\w-])${esc(p.name)}([^\\w-]|$)`, 'i').test(t.text));
  if (named.length === 1 && (t.noSplit || !isList(t.text))) {
    setProject(t, named[0], { how: 'named', why: `The task names ${named[0].name}`, conf: 1, picks: [] });
    save(t);
    if (t.autoRun) start(t.id);
    return;
  }
  const list = ps.map((p, i) => `p${i + 1}: ${p.name} (${p.root})${p.about ? `\n  about: ${p.about}` : ''}${p.recent.length ? `\n  recent work: ${p.recent.join('; ')}` : ''}`).join('\n');
  const prompt = `${t.noSplit ? 'Route the user\'s text, as one task,' : 'Split the user\'s text into separate tasks and route each one'} to the software project it belongs to.

Projects:
${list}

Text: """${t.text.slice(0, 6000)}"""
${t.noSplit ? '' : `
Splitting rules:
- Split only where parts of the text belong to DIFFERENT projects. Everything for one project is one task, however many items, ideas or steps it lists. Most texts are one task.
- Each task's text keeps the user's own words, plus any context or instruction from the text that applies to it (such as "don't commit", a link, a deadline).
- "after": the number (1-based) of an earlier task in your list that must be finished first, because this one depends on its result; otherwise null.
`}
Return ONLY JSON: {"tasks": [{"text": "the task", "project": "p<n> or null", "confidence": 0.0-1.0, "why": "one short sentence", "others": [{"project": "p<n>", "why": "one short sentence"}], "after": null}]}
A project the text names, even misspelled or inside a phrase ("the content factory" → Factory), is strong evidence for it.
confidence is how sure you are that this is the right project; use null when none fits. "others": up to 3 other likely projects.${t.noSplit ? ' Return exactly one task.' : ' At most 10 tasks.'}`;
  let pieces;
  try {
    const { res, cost } = await runAgent({ want: 'small', tools: 'none', cwd: SUMMARIZER_CWD, prompt, timeoutMs: 120e3 });
    t.cost += cost || 0;
    pieces = (Array.isArray(res.tasks) ? res.tasks : [res]).filter(x => x && typeof x === 'object').slice(0, 10);
  } catch (e) {
    Object.assign(t, { state: 'unrouted', route: { how: 'error', why: 'Could not route: ' + e.message, picks: [] } });
    return save(t);
  }
  pieces = pieces.filter(x => String(x.text || '').trim());
  // the text names the project the model picked: trust it ("voice" may name a project and
  // also just be a word, so a named project alone is not proof); with one named project,
  // it also takes every piece the model is not sure about
  const idx = x => Number(String(x.project || '').replace(/\D/g, '')) - 1;
  const namedIdx = new Set(named.map(p => ps.indexOf(p)));
  for (const x of pieces) {
    const conf = Number(x.confidence) || 0;
    if (namedIdx.has(idx(x))) x.confidence = Math.max(conf, 0.9);
    else if (conf < SURE && named.length === 1) Object.assign(x, { project: 'p' + (ps.indexOf(named[0]) + 1), confidence: SURE, why: `The text names ${named[0].name}` });
  }
  // a split is only worth it across projects: pieces for one project are one task again
  const byProject = new Map();
  for (const [i, x] of pieces.entries()) {
    const k = ps[idx(x)] ? idx(x) : 'none:' + i;
    const g = byProject.get(k);
    if (g) { g.text += '\n\n' + x.text; g.confidence = Math.min(Number(g.confidence) || 0, Number(x.confidence) || 0); g.merged.push(i); }
    else byProject.set(k, { ...x, merged: [i] });
  }
  if (byProject.size > 1 && byProject.size < pieces.length) {
    const at = new Map(); [...byProject.values()].forEach((g, j) => g.merged.forEach(i => at.set(i + 1, j + 1)));
    pieces = [...byProject.values()].map((g, j) => { const a = at.get(Number(g.after)); return { ...g, after: a && a < j + 1 ? a : null }; });
  }
  if (pieces.length <= 1 || byProject.size <= 1 || t.noSplit) {
    placeOn(t, pieces[0] || {}, ps);
    save(t);
    if (t.state === 'ready' && t.autoRun) start(t.id);
    return;
  }
  const group = t.id, source = t.text, all = [];
  pieces.forEach((x, i) => {
    const u = i === 0 ? t : { ...blank(), mode: t.mode, autoRun: t.autoRun, pause: t.pause, created: t.created + i };
    Object.assign(u, { text: String(x.text).trim().slice(0, 8000), group: { id: group, i, n: pieces.length, source } });
    placeOn(u, x, ps);
    tasks.set(u.id, u);
    all.push(u);
  });
  pieces.forEach((x, i) => { const a = Number(x.after); if (a >= 1 && a - 1 < i) all[i].after = all[a - 1].id; });
  for (const u of all) save(u);
  for (const u of all) if (u.state === 'ready' && u.autoRun) start(u.id);
}

// a routing answer for one task: its project when sure, otherwise the user picks
function placeOn(t, x, ps) {
  const at = v => ps[Number(String(v || '').replace(/\D/g, '')) - 1] || null;
  const p = at(x.project), conf = Math.max(0, Math.min(1, Number(x.confidence) || 0));
  const picks = [p && { pid: p.id, name: p.name, why: String(x.why || '') },
    ...(Array.isArray(x.others) ? x.others : []).map(o => { const q = at(o?.project); return q && { pid: q.id, name: q.name, why: String(o.why || '') }; })]
    .filter((y, i, a) => y && a.findIndex(z => z?.pid === y.pid) === i).slice(0, 4);
  const r = { how: 'model', why: String(x.why || '').slice(0, 300), conf, picks };
  if (p && conf >= SURE) setProject(t, p, r);
  else Object.assign(t, { state: 'unrouted', route: r });
}

// ------------------------------------------------------------------ running
// the task this one waited for, done in another project: where it is and what it did
function depOf(t) {
  const d = t.after && tasks.get(t.after);
  return d && d.root && d.root !== t.root ? d : null;
}
function firstPrompt(t) {
  const d = depOf(t), planning = !t.steps.length;
  return `You are working on a task from the user's task board. You run unattended: nobody answers questions or approves anything while you work, so never stop midway to ask.

Task:
${t.text}
${t.group ? `
This task is one part of a longer message; the other parts went to other projects. Do only your part, but read the whole message for context (links, names, "the first video"...):
"""
${t.group.source.slice(0, 6000)}
"""
` : ''}${d ? `
This task builds on another task, done first in the project ${d.project} at ${d.root} (you can read that folder):
- that task: ${d.text}
- its report: ${d.summary || '(none)'}
` : ''}
Do as much of the task as you can on your own, and make sensible choices on small things (say which in your summary). Leave a question for the user only for what you cannot or must not decide or do alone:
- a choice between real alternatives that changes the result, where a wrong guess wastes the work
- credentials, API keys, accounts, payments, or facts only the user knows
- anything irreversible or outward-facing: deploying, publishing, pushing, sending messages or email, deleting data, spending money
- a manual step outside this machine (a dashboard setting, a phone, a purchase)
First do everything that does not depend on the answers. If a command you need is blocked, do not look for a way around it and do not add it to asks: blocked commands are shown to the user to allow on their own. ${t.wt ? `You work in a git worktree of your own (branch ${t.wt.branch}, made from ${t.wt.base}), so other tasks can work in this project at the same time. When the task is done the board commits your changes and merges them into ${t.wt.base}: do not commit, switch branches or merge yourself. Files git ignores (node_modules, .env, data folders) are linked from the main folder ${t.wt.top}, so changes to those are shared with it at once. Uncommitted work in the main folder is not in your worktree; you can read it there.` : 'Do not commit unless the task says so.'} Never write secrets into files tracked by git.
${planning ? `
Work in steps when the task has distinct stages, where a later one builds on what an earlier one produces (for example: gather material, then design options, then build), or separate parts the user would want to check one at a time. Then read just enough to plan, write a plan of 2 to 6 steps into the report, do ONLY step 1, and stop with the report: you will be told to go on with the next step in this same session. The user sees the plan as a checklist. In the plan, "after" lists the steps whose result a step needs, so one step can go ahead while another waits for the user. A task that is one piece of work (a fix, a small feature, a question) needs no plan: do it whole and leave "plan" and "step" out.
` : ''}
End your reply with this JSON report as the very last thing:
{"status": "done" | "needs-you" | "failed", ${planning ? '"plan": [{"title": "short step title", "after": [1]}], ' : ''}"step": 1, "tldr": "the result in one plain line, 12 words at most, no hedging (e.g. 'Fixed the login redirect.')", "summary": "what you did and what is left, 3 sentences at most", "asks": [{"kind": "decision" | "secret" | "action" | "info" | "approval", "question": "one clear question", "why": "what it blocks", "options": ["short choice"], "step": 1}]}
"status" and "summary" are about the step you just did${planning ? ' (or the whole task, without a plan)' : ''}; "step" is its number, and an ask's "step" is the step it blocks. Use "needs-you" when asks is not empty, and give options when the answer is a choice. For a secret, ask the user to put it somewhere (an .env file, an environment variable) and reply "done"; never ask them to paste a secret.`;
}

// ------------------------------------------------------------------ steps
const STEP_WORD = { todo: 'not started', running: 'in progress', done: 'done', 'needs-you': 'waits for the user', failed: 'failed', stopped: 'stopped' };
function toSteps(plan, old = []) {
  const list = plan.filter(x => x && (x.title || typeof x === 'string')).slice(0, 8);
  return list.map((x, i) => {
    const n = i + 1, title = String(x.title || x).replace(/\s+/g, ' ').trim().slice(0, 200);
    const after = Array.isArray(x.after) ? [...new Set(x.after.map(Number).filter(a => a >= 1 && a < n))] : n > 1 ? [n - 1] : [];
    const was = old.find(s => s.n === n && s.state !== 'todo');
    return was ? { ...was, title, after } : { n, title, after, state: 'todo', summary: null, cost: 0, runs: [] };
  });
}
const planText = t => t.steps.map(s => `${s.n}. ${s.title}${s.after.length ? ` (needs ${s.after.join(', ')})` : ''}: ${STEP_WORD[s.state] || s.state}${s.summary && s.state !== 'todo' ? '. ' + s.summary : ''}`).join('\n');
const stepWaits = (t, n) => t.asks.some(a => a.step === n && a.answer == null);
// the step to run next: one whose questions are all answered, then (when the user asked
// to go again) one that failed or was stopped, then the first one whose needs are done
function pickStep(t, retry = false) {
  const st = t.steps;
  if (!st.length) return null;
  const done = new Set(st.filter(s => s.state === 'done').map(s => s.n));
  return st.find(s => s.state === 'needs-you' && !stepWaits(t, s.n))
    || (retry && st.find(s => s.state === 'failed' || s.state === 'stopped' || s.state === 'running'))
    || st.find(s => s.state === 'todo' && s.after.every(d => done.has(d)))
    || null;
}
// Before the first run, a small model decides from the text alone whether the task is one
// piece of work or stages: the same answer whichever model or provider then does the work.
async function planFor(t) {
  const prompt = `A coding agent is about to work on this task in the project ${t.project}. Decide whether it should run as a plan of steps, one session turn per step, with the user able to check each step's result.

Task: """${(t.group ? t.group.source : t.text).slice(0, 6000)}"""${t.group ? `\n(The agent does only this part of it: """${t.text.slice(0, 2000)}""")` : ''}

Use steps only when the task has distinct stages, where a later stage builds on what an earlier one produces (gather material, then design options, then build), or separate deliverables worth checking one at a time. A fix, a small feature, one document, one question: no steps. Most tasks need none.
Steps: 2 to 6, in order, each a short imperative title naming its result. "after" lists the earlier steps whose result a step needs ([] if none), so independent steps can go ahead while another waits for the user.
Return ONLY JSON: {"steps": []} or {"steps": [{"title": "...", "after": []}, {"title": "...", "after": [1]}]}`;
  const { res, cost } = await runAgent({ want: 'small', tools: 'none', cwd: SUMMARIZER_CWD, prompt, timeoutMs: 90e3 });
  t.cost += cost || 0;
  const plan = Array.isArray(res?.steps) ? res.steps : [];
  return plan.length >= 2 ? toSteps(plan) : [];
}
function stepPrompt(t, s, resume) {
  if (!t.runs.length) return `${firstPrompt(t)}\n\nThe board planned this task in steps (if the plan does not fit what you find, change it, see below):\n${planText(t)}\n\nNow do step 1: ${s.title}\nDo only this step, then stop and end with the JSON report, with "step": 1; you will be told to go on with the next step in this same session. Add "plan" to the report only if the plan has to change; then give the whole plan, in order, as [{"title": "...", "after": [n]}].`;
  const a = answers(t);
  const waiting = t.steps.filter(x => x !== s && x.state === 'needs-you').map(x => x.n);
  const lead = !s.runs.length ? `Now do step ${s.n}: ${s.title}`
    : s.state === 'needs-you' ? `Now finish step ${s.n}: ${s.title}`
    : `Step ${s.n} was cut short${t.error ? ` (${t.error})` : ''}. Finish it: ${s.title}`;
  const body = `${a ? `The user answered what you left for them:\n${a}\n\n` : ''}The plan so far:\n${planText(t)}\n\n${lead}
Do only this step${waiting.length ? ` (step ${waiting.join(', ')} still waits for the user; leave it alone)` : ''}, then stop and end with the JSON report, with "step": ${s.n}. Add "plan" to the report only if the plan has to change; then give the whole plan again, done steps included, in the same order.`;
  return resume ? body : `${firstPrompt(t)}\n\nThis task was started in an earlier session; the files already hold that work, so check them first.\n${body}`;
}
// what the task is now, after a step's run: done, waiting, or (null) on to the next step
function afterStep(t) {
  const st = t.steps;
  if (st.every(s => s.state === 'done')) return 'done';
  if (st.some(s => s.state === 'failed')) return 'failed';
  if (pickStep(t)) return t.pause ? 'paused' : null;
  if (openAsks(t).length) return 'needs-you';
  t.error = 'the plan is stuck: no step can run';
  return 'failed';
}

// the answers the session has not been given yet (each is sent once)
function answers(t) {
  const xs = t.asks.filter(a => a.answer != null && !a.sent && a.answer !== '(closed)');
  for (const a of xs) a.sent = true;
  return xs.map(a => a.kind === 'permission'
    ? `- ${a.cmd ? `Command \`${a.cmd}\`` : `Tool ${a.tool}`}: ${/^deny/i.test(a.answer) ? 'denied. Do not use it; do without it or say what is left.' : 'allowed. It will run if you try again.'}`
    : `- You asked (${a.kind}): ${a.question}\n  The user answered: ${a.answer}`).join('\n');
}
function followUp(t) {
  const a = answers(t);
  return `${a ? `The user answered what you left for them:\n${a}\n\n` : `You were cut short${t.error ? ` (${t.error})` : ''}.\n\n`}Carry on with the task from where you stopped. End with the same JSON report as before.`;
}

// The last {"status": ...} object in the reply (the reply may contain code with braces).
// the one line the to-do shows for a finished task: the report's tldr, else the summary's first sentence
function tldrOf(tl, summary) {
  const one = s => String(s || '').replace(/\s+/g, ' ').trim();
  let s = one(tl) || (one(summary).match(/^.+?[.!?](?=\s|$)/)?.[0] ?? one(summary));
  return s.length > 140 ? s.slice(0, 139) + '…' : s || null;
}

// The full final reply of a task's session, read from the transcript Code Tycoon already
// indexed (the session profile), not by asking the CLI again: every assistant text after the
// last prompt, with the JSON report cut off.
export function taskOutput(id) {
  const t = tasks.get(id);
  if (!t) return { error: 'unknown task' };
  if (!t.sid) return { error: 'no session yet' };
  let file = db.prepare('SELECT file FROM transcripts WHERE session_id=? AND agent_id IS NULL LIMIT 1').get(t.sid)?.file;
  if (!file || !fs.existsSync(file)) {
    // untracked project: its transcript is not indexed, but it sits in ~/.claude/projects
    try {
      for (const d of fs.readdirSync(PROJECTS_DIR)) {
        const f = path.join(PROJECTS_DIR, d, t.sid + '.jsonl');
        if (fs.existsSync(f)) { file = f; break; }
      }
    } catch {}
  }
  const base = { sid: t.sid, pid: t.pid, project: t.project, tldr: t.tldr || tldrOf(null, t.summary), summary: t.summary };
  if (!file || !fs.existsSync(file)) return { ...base, text: null };
  // the last assistant message with text (its blocks come one per line, sharing message.id)
  let parts = [], msg = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"assistant"')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const c = o.message?.content;
    if (o.type !== 'assistant' || !Array.isArray(c)) continue;
    const texts = c.filter(b => b.type === 'text' && b.text?.trim()).map(b => b.text.trim());
    if (!texts.length) continue;
    if (o.message.id !== msg) { parts = []; msg = o.message.id; }
    parts.push(...texts);
  }
  const { prose } = report(parts.join('\n\n'));
  return { ...base, text: prose || null };
}

function report(text) {
  const s = String(text || '');
  for (let k = s.lastIndexOf('"status"'); k >= 0; k = s.lastIndexOf('"status"', k - 1)) {
    const a = s.lastIndexOf('{', k);
    if (a < 0) break;
    for (let b = s.lastIndexOf('}'); b > k; b = s.lastIndexOf('}', b - 1)) {
      try { const j = JSON.parse(s.slice(a, b + 1)); if (j && typeof j === 'object') return { j, prose: s.slice(0, a).replace(/```(json)?\s*$/, '').trim() }; } catch {}
    }
  }
  return { j: null, prose: s.trim() };
}

// A look around (cd, ls, cat, git status...) that was blocked only because it is a compound
// command: the session gets by with its read tools, so it is not worth a to-do.
const LOOK = /^(cd|ls|dir|pwd|cat|head|tail|wc|echo|find|grep|rg|type|which|where|file|stat|tree|git (status|log|diff|show|branch|remote|rev-parse|ls-files)|Get-ChildItem|Get-Content|Get-Location|Select-String|Test-Path|Resolve-Path|Write-Output|gci|gc|sls)\b/i;
function lookAround(cmd) {
  if (/>|\$\(|`/.test(cmd.replace(/2>\s*\/dev\/null|2>&1|2>\$null/g, ''))) return false;
  return cmd.split(/&&|\|\||;|\||\(|\)/).map(s => s.trim()).filter(Boolean).every(s => LOOK.test(s));
}

function denialAsks(denials, run) {
  const out = [], seen = new Set();
  for (const d of denials || []) {
    const cmd = typeof d.tool_input?.command === 'string' ? d.tool_input.command : null;
    const shell = /^(Bash|PowerShell)$/.test(d.tool_name);
    const key = shell && cmd ? 'cmd:' + cmd : 'tool:' + d.tool_name;
    if (seen.has(key) || (shell && cmd && lookAround(cmd))) continue;
    seen.add(key);
    const input = cmd ? null : JSON.stringify(d.tool_input || {}).slice(0, 300);
    out.push({ id: newId(), run, kind: 'permission', tool: d.tool_name, cmd: shell ? cmd : null, detail: input,
      question: shell ? 'Allow this command?' : `Allow ${d.tool_name}?`, why: String(d.tool_input?.description || '').slice(0, 300),
      options: ['Allow', 'Allow all commands for this task', 'Deny'],
      rules: shell && cmd ? [`Bash(${cmd})`, `PowerShell(${cmd})`] : [d.tool_name], answer: null });
  }
  return out;
}

function run(t, retry = true) {
  if (t.tree == null) t.tree = treeFor(t);
  if (!t.runs.length && !t.steps.length && !t.planned) {
    Object.assign(t, { state: 'running', error: null, planned: true });
    save(t);
    planning.add(t.id);
    planFor(t).then(st => { if (planning.has(t.id)) t.steps = st; }, e => console.error('[board] plan:', e.message))
      .finally(() => {
        if (!planning.delete(t.id)) return; // stopped while planning
        if (tasks.has(t.id)) run(t, retry);
      });
    return;
  }
  // its own worktree (made again for a follow-up after the last one was merged)
  if (t.tree && !(t.wt && fs.existsSync(t.wt.dir))) {
    try { t.wt = makeWorktree(t.id, t.root); t.tree = !!t.wt; }
    catch (e) {
      Object.assign(t, { state: 'failed', error: e.message });
      save(t);
      return;
    }
  }
  if (t.wt) t.wt.merge = { state: 'working' };
  const prov = provider();
  const last = t.runs.length - 1;
  const resume = prov === 'claude' && t.provider === 'claude' && t.sid ? t.sid : null;
  const step = pickStep(t, retry);
  const prompt = step ? stepPrompt(t, step, resume) : last < 0 ? firstPrompt(t) : resume ? followUp(t)
    : `${firstPrompt(t)}\n\nThis task was started before; the files already hold that work, so check them first.\nLast report: ${t.summary || '(none)'}\n${answers(t)}`;
  const rec = { n: last + 1, step: step?.n ?? null, started: Date.now(), ended: null, sid: null, cost: 0, status: 'running', summary: null, error: null };
  t.runs.push(rec);
  if (step) { step.state = 'running'; step.runs.push(rec.n); }
  Object.assign(t, { state: 'running', error: null, provider: prov });
  save(t);
  let goOn = false;
  const dep = depOf(t);
  runAgent({ want: projectModel(t.pid), tools: 'task', perm: t.mode, allow: t.allow, resume, persist: true, dirs: dep && fs.existsSync(dep.root) ? [dep.root] : [], name: 'Task: ' + t.text.replace(/\s+/g, ' ').slice(0, 50),
    budgetUsd: RUN_USD, cwd: t.wt ? t.wt.cwd : t.root, prompt, timeoutMs: RUN_MS, onSpawn: p => procs.set(t.id, p) })
    .then(({ text, cost, sid, denials }) => {
      const { j, prose } = report(text);
      // the plan: written by the first run, or rewritten later (done steps keep their state)
      const plan = Array.isArray(j?.plan) ? j.plan : null;
      if (plan && (plan.length >= 2 || t.steps.length)) t.steps = toSteps(plan, t.steps);
      const has = n => t.steps.some(s => s.n === n);
      // the step this run did: the one it was given, or step 1 of the plan it just wrote;
      // a run may report having done more than one ("step": [1, 2])
      const mine = rec.step ?? (t.steps.length ? 1 : null);
      rec.step = mine;
      const did = mine == null ? [] : [...new Set([mine, ...[].concat(j?.step ?? []).map(Number)])].filter(has);
      const stepOf = x => did.includes(Number(x?.step)) ? Number(x.step) : has(Number(x?.step)) && t.steps.find(s => s.n === Number(x.step)).state !== 'done' ? Number(x.step) : mine;
      const asks = (Array.isArray(j?.asks) ? j.asks : []).filter(a => a && a.question).slice(0, 8).map(a => ({
        id: newId(), run: rec.n, step: stepOf(a), kind: ASK_KINDS.has(a.kind) ? a.kind : 'info', question: String(a.question).slice(0, 600), why: String(a.why || '').slice(0, 400),
        options: (Array.isArray(a.options) ? a.options : []).map(o => String(o).slice(0, 80)).filter(Boolean).slice(0, 5), answer: null }));
      asks.push(...denialAsks(denials, rec.n).map(a => ({ ...a, step: mine })));
      t.asks.push(...asks);
      const summary = String(j?.summary || prose.slice(-700) || '').slice(0, 1200);
      const status = asks.length ? 'needs-you' : j?.status === 'failed' ? 'failed' : 'done';
      const tldr = tldrOf(j?.tldr, summary);
      Object.assign(rec, { sid, cost, summary, tldr, status });
      Object.assign(t, { sid: sid || t.sid, cost: t.cost + (cost || 0), summary, tldr });
      if (!t.steps.length) { t.state = status; return; }
      for (const n of did) {
        const s = t.steps.find(x => x.n === n);
        s.state = stepWaits(t, n) ? 'needs-you' : n === mine && j?.status === 'failed' ? 'failed' : 'done';
        if (n === mine) { s.summary = summary; s.cost += cost || 0; if (!s.runs.includes(rec.n)) s.runs.push(rec.n); }
        else s.summary = s.summary || 'Done together with step ' + mine;
      }
      // an ask about a later step holds that step back too
      for (const a of asks) { const s = t.steps.find(x => x.n === a.step); if (s && s.state === 'todo') s.state = 'needs-you'; }
      const st = afterStep(t);
      if (st) t.state = st; else goOn = true;
    })
    .catch(e => {
      const stopped = e.message === 'stopped';
      Object.assign(rec, { status: stopped ? 'stopped' : 'failed', error: e.message });
      Object.assign(t, { state: stopped ? 'stopped' : 'failed', error: e.message });
      const s = rec.step != null && t.steps.find(x => x.n === rec.step);
      if (s) s.state = stopped ? 'stopped' : 'failed';
    })
    .finally(() => {
      rec.ended = Date.now();
      procs.delete(t.id);
      // on to the next step, in the same session, keeping the project
      if (goOn && tasks.has(t.id)) { save(t, false); return run(t, false); }
      // finished: its TL;DR waits in the to-do until the user has seen it
      t.seen = t.state !== 'done';
      save(t);
      next(t.pid);
      if (t.state === 'done') {
        if (t.wt) integrate(t).finally(() => settled(t));
        else settled(t);
      }
      if (!t.wt) retryMerges(t.pid); // the main folder is free again
    });
}

// ------------------------------------------------------------------ merging
// A finished task's branch goes into the base branch of the main folder: commit what the
// session left, have the session resolve conflicts with work merged meanwhile, then merge.
// A merge that git refuses (the user's uncommitted changes in the same files, the main
// folder on another branch) waits and is tried again every few minutes.
const MERGED = new Set(['merged', 'nothing']);
const merging = new Set();
const taskTitle = t => (t.tldr || t.text).replace(/\s+/g, ' ').trim().slice(0, 72);
async function integrate(t) {
  const w = t.wt;
  if (!w || merging.has(t.id) || MERGED.has(w.merge?.state) || t.state !== 'done') return;
  merging.add(t.id);
  const setM = m => { w.merge = { ...m, at: Date.now() }; save(t); };
  try {
    const here = fs.existsSync(w.dir);
    if (here) commitAll(w, `${taskTitle(t)}\n\nTask ${t.id} from the Code Tycoon board:\n${t.text.slice(0, 2000)}`);
    if (!ahead(w)) { dropWorktree(w, { deleteBranch: true }); return setM({ state: 'nothing', why: 'The task changed no tracked files' }); }
    if (rootBusy(t.pid)) return setM({ state: 'waiting', why: 'Another task is working in the main folder' });
    let p = predict(w);
    if (!p.clean) {
      if (!here) return setM({ state: 'conflict', files: p.files, why: `Conflicts with ${w.base}, and the worktree folder is gone` });
      setM({ state: 'resolving', files: p.files });
      if (!await resolve(t, w)) return;
      p = predict(w);
      if (!p.clean) return setM({ state: 'conflict', files: p.files, why: `Still conflicts with ${w.base}` });
    }
    const files = changedFiles(w);
    const r = mergeIntoBase(w, `Merge task: ${taskTitle(t)}`);
    if (!r.ok) return setM({ state: 'waiting', why: r.why, files: r.files });
    dropWorktree(w, { deleteBranch: true });
    setM({ state: 'merged', sha: r.sha, files: files.slice(0, 50), into: w.base });
    syncSoon(t.pid, 1000); // pushed right away where git sync is on
  } catch (e) {
    setM({ state: 'failed', why: e.message });
  } finally { merging.delete(t.id); }
}

// git merged the base into the task branch with conflicts: the task's session resolves them
async function resolve(t, w) {
  const setM = m => { w.merge = { ...m, at: Date.now() }; save(t); };
  const m = mergeBaseIn(w);
  if (m.clean) return true;
  const prompt = `The board is merging your task branch ${w.branch} into ${w.base}. ${w.base} moved on while you worked (other work was merged), and git left conflicts in:
${m.files.map(f => '- ' + f).join('\n')}

Resolve every conflict so the result keeps both sides' intent: your task's change and the other change. Check that it still works (a build or a quick test if the project has one). Do not commit and do not abort the merge.
End with this JSON report as the very last thing: {"status": "done" | "failed", "summary": "what you kept from each side, 2 sentences at most"}`;
  const resume = provider() === 'claude' && t.provider === 'claude' && t.sid ? t.sid : null;
  try {
    const { text, cost, sid } = await runAgent({ want: projectModel(t.pid), tools: 'task', perm: t.mode, allow: t.allow, resume, persist: true, name: 'Merge: ' + taskTitle(t).slice(0, 50),
      budgetUsd: RUN_USD, cwd: w.cwd, prompt, timeoutMs: 30 * 60e3, onSpawn: p => procs.set(t.id, p) });
    t.cost += cost || 0; t.sid = sid || t.sid;
    const { j } = report(text);
    const left = unresolved(w, m.files);
    if (j?.status === 'failed' || left.length) {
      abortMerge(w);
      setM({ state: 'conflict', files: left.length ? left : m.files, why: String(j?.summary || 'The session could not resolve the conflicts').slice(0, 400) });
      return false;
    }
    finishMerge(w);
    return true;
  } catch (e) {
    abortMerge(w);
    setM({ state: 'conflict', files: m.files, why: 'Resolving stopped: ' + e.message });
    return false;
  } finally { procs.delete(t.id); }
}
function retryMerges(pid) {
  for (const t of tasks.values()) if ((!pid || t.pid === pid) && t.state === 'done' && t.wt && t.wt.merge?.state === 'waiting') integrate(t).finally(() => settled(t));
}
setInterval(() => retryMerges(null), 3 * 60e3).unref();

// the task this one waits for (it needs that one's result), while it is not done and merged
function blockedBy(t) {
  const d = t.after && tasks.get(t.after);
  return d && (d.state !== 'done' || (d.wt && !MERGED.has(d.wt.merge?.state))) ? d : null;
}
// a task works in a worktree when its project is a git repo; one that already ran in the
// main folder stays there
const TREES = process.env.CODETYCOON_TASK_WORKTREE !== '0';
function treeFor(t) {
  if (t.tree != null) return t.tree;
  if (t.runs.length) return false;
  return TREES && !!t.root && !!repoOf(t.root);
}
// a run in the main folder (no worktree): one per project at a time
const rootBusy = pid => [...tasks.values()].some(x => x.pid === pid && x.state === 'running' && !x.tree);
function next(pid) {
  let free = !rootBusy(pid);
  const qs = [...tasks.values()].filter(x => x.pid === pid && x.state === 'queued' && !blockedBy(x)).sort((a, b) => a.created - b.created);
  for (const q of qs) {
    if (treeFor(q)) run(q);
    else if (free) { run(q); free = false; }
  }
}
// a task finished: whatever waited for it may start now
function settled(t) {
  for (const pid of new Set([...tasks.values()].filter(x => x.after === t.id && x.state === 'queued').map(x => x.pid))) next(pid);
}

// ------------------------------------------------------------------ actions
const get = id => tasks.get(id);
// group: the split it came from ({ id, i, n, source }); after: a task that must be done first
function blank() {
  return { id: newId(), text: '', created: Date.now(), updated: Date.now(), pid: null, project: null, root: null, route: null,
    mode: 'full', autoRun: false, state: 'routing', runs: [], sid: null, provider: null,
    cost: 0, asks: [], allow: [], summary: null, error: null, group: null, after: null, noSplit: false, steps: [], pause: false };
}

export function create({ text, pid, mode, autoRun, pause }) {
  text = String(text || '').trim();
  if (!text) return { error: 'write a task first' };
  if (text.length > 8000) return { error: 'task is too long (8000 characters at most)' };
  // tasks bypass permissions unless the user picks "ask me"
  const t = { ...blank(), text, mode: mode === 'ask' ? 'ask' : 'full', autoRun: !!autoRun, pause: !!pause };
  tasks.set(t.id, t);
  const p = pid && profiles().find(x => x.id === pid);
  if (pid && !p) { tasks.delete(t.id); return { error: 'unknown project' }; }
  if (p) {
    setProject(t, p, { how: 'you', why: 'Picked by you', conf: 1, picks: [] });
    save(t);
    if (t.autoRun) start(t.id);
  } else route(t);
  return { task: view(t) };
}

export function setRoute(id, pid) {
  const t = get(id);
  if (!t) return { error: 'unknown task' };
  if (t.state === 'running') return { error: 'busy' };
  if (t.runs.length) return { error: 'this task already ran in ' + t.project };
  const p = profiles().find(x => x.id === pid);
  if (!p) return { error: 'unknown project' };
  setProject(t, p, { ...(t.route || {}), how: 'you', why: 'Picked by you', conf: 1 });
  save(t);
  if (t.autoRun) return start(id);
  return { task: view(t) };
}

export function start(id) {
  const t = get(id);
  if (!t) return { error: 'unknown task' };
  if (t.state === 'running' || t.state === 'queued') return { task: view(t) };
  if (!t.pid || !t.root) return { error: 'pick a project first' };
  if (!fs.existsSync(t.root)) return { error: 'folder not found: ' + t.root };
  const blocked = codexBlocked('task');
  if (blocked) return { error: blocked };
  if (blockedBy(t) || (!treeFor(t) && rootBusy(t.pid))) { t.state = 'queued'; save(t); return { task: view(t) }; }
  run(t);
  return { task: view(t) };
}

export function answer(id, askId, value) {
  const t = get(id);
  const a = t?.asks.find(x => x.id === askId);
  if (!a) return { error: 'unknown question' };
  if (a.answer != null) return { error: 'already answered' };
  const v = String(value ?? '').trim().slice(0, 4000);
  if (!v) return { error: 'empty answer' };
  Object.assign(a, { answer: v, answeredAt: Date.now() });
  if (a.kind === 'permission') {
    if (/^allow all/i.test(v)) t.mode = 'full';
    else if (/^allow/i.test(v)) t.allow = [...new Set([...t.allow, ...(a.rules || [])])];
  }
  save(t);
  // the last answer sends them all back to the session; in a plan, the last answer a
  // step waits for sends that step back (other steps may still wait for the user)
  if (t.state === 'needs-you' && (t.steps.length ? pickStep(t) : !openAsks(t).length)) return start(id);
  return { task: view(t) };
}

// run again after a failure or a stop (resumes the session), or once more after "done"
// (in a plan, a follow-up after "done" is one more step)
export function again(id, note) {
  const t = get(id);
  if (!t) return { error: 'unknown task' };
  if (t.state === 'running') return { error: 'busy' };
  note = String(note || '').trim().slice(0, 4000);
  if (t.steps.length && t.state === 'done') {
    if (!note) return { error: 'write the follow-up first' };
    const n = t.steps.length + 1;
    t.steps.push({ n, title: 'Follow-up: ' + note.replace(/\s+/g, ' ').slice(0, 160), after: [], state: 'todo', summary: null, cost: 0, runs: [] });
    t.asks.push({ id: newId(), run: t.runs.length - 1, step: n, kind: 'info', question: 'A follow-up from the user', why: '', options: [], answer: note, answeredAt: Date.now() });
    return start(id);
  }
  if (t.steps.length ? !pickStep(t, true) : openAsks(t).length) return { error: 'answer the open questions first' };
  if (note) t.asks.push({ id: newId(), run: t.runs.length - 1, step: pickStep(t, true)?.n ?? null, kind: 'info', question: 'Anything else?', why: '', options: [], answer: note, answeredAt: Date.now() });
  return start(id);
}

export function setPause(id, on) {
  const t = get(id);
  if (!t) return { error: 'unknown task' };
  t.pause = !!on;
  save(t);
  return { task: view(t) };
}

export function stop(id) {
  const t = get(id);
  if (t?.state === 'queued') { t.state = 'ready'; save(t); return { task: view(t) }; }
  const p = procs.get(id);
  if (!p && planning.delete(id)) { t.state = 'stopped'; save(t); next(t.pid); return { task: view(t) }; } // still planning
  if (!p) return { error: 'not running' };
  p.stopped = true; p.kill();
  return { ok: true };
}

export function setMode(id, mode) {
  const t = get(id);
  if (!t) return { error: 'unknown task' };
  t.mode = mode === 'ask' ? 'ask' : 'full';
  save(t);
  return { task: view(t) };
}

export function close(id) {
  const t = get(id);
  if (!t) return { error: 'unknown task' };
  if (t.state === 'running') return { error: 'stop it first' };
  for (const a of openAsks(t)) Object.assign(a, { answer: '(closed)', answeredAt: Date.now() });
  t.state = 'done';
  save(t);
  if (t.wt) integrate(t).finally(() => settled(t));
  else settled(t);
  return { task: view(t) };
}

// merge a finished task's branch now (after a wait or a conflict the user sorted out)
export function mergeNow(id) {
  const t = get(id);
  if (!t) return { error: 'unknown task' };
  if (!t.wt) return { error: 'this task has no branch of its own' };
  if (t.state !== 'done') return { error: 'the task is not done yet' };
  if (MERGED.has(t.wt.merge?.state)) return { error: 'already merged' };
  if (merging.has(id)) return { error: 'merging already' };
  t.wt.merge = { ...t.wt.merge, state: 'waiting' };
  integrate(t).finally(() => settled(t));
  return { task: view(t) };
}

// undo a split: the pieces go, the first one takes the original text and is routed as one task
export function join(id) {
  const t = get(id);
  if (!t?.group) return { error: 'not part of a split' };
  const all = [...tasks.values()].filter(x => x.group?.id === t.group.id);
  if (all.some(x => x.runs.length || x.state === 'running')) return { error: 'some of these tasks already ran; delete the ones you don\'t want instead' };
  const first = all.find(x => x.group.i === 0) || t;
  for (const x of all) if (x !== first) remove(x.id);
  Object.assign(first, { text: first.group.source, group: null, after: null, noSplit: true, pid: null, project: null, root: null, route: null });
  route(first);
  return { task: view(first) };
}

export function remove(id) {
  const t = get(id);
  if (!t) return { error: 'unknown task' };
  if (t.state === 'running' || merging.has(id)) return { error: 'stop it first' };
  // its worktree folder goes; an unmerged branch stays, so the work can still be found
  if (t.wt && fs.existsSync(t.wt.dir)) { try { commitAll(t.wt, `${taskTitle(t)} (task deleted from the board)`); } catch {} dropWorktree(t.wt); }
  tasks.delete(id);
  db.prepare('DELETE FROM board WHERE id=?').run(id);
  for (const l of listeners) l({ type: 'board-removed', id });
  // whatever waited for it waits no more
  const waiting = [...tasks.values()].filter(x => x.after === id);
  for (const x of waiting) { x.after = null; save(x); }
  for (const pid of new Set(waiting.filter(x => x.state === 'queued').map(x => x.pid))) next(pid);
  return { ok: true };
}

export function boardAction(id, action, b = {}) {
  switch (action) {
    case 'route': return setRoute(id, String(b.pid || ''));
    case 'run': {
      // force: start without waiting for the task it depends on
      const t = get(id);
      if (t && b.force && t.after) { t.after = null; if (t.state === 'queued') { t.state = 'ready'; save(t, false); } }
      // "continue without pausing" from a paused task
      if (t && b.pause === false) t.pause = false;
      return start(id);
    }
    case 'pause': return setPause(id, b.pause);
    case 'again': return again(id, b.note);
    case 'answer': return answer(id, String(b.ask || ''), b.answer);
    case 'stop': return stop(id);
    case 'mode': return setMode(id, b.mode);
    case 'close': return close(id);
    case 'merge': return mergeNow(id);
    case 'join': return join(id);
    case 'seen': { const t = get(id); if (!t) return { error: 'unknown task' }; t.seen = true; save(t); return { task: view(t) }; }
    case 'delete': return remove(id);
    default: return { error: 'unknown action' };
  }
}

// ------------------------------------------------------------------ startup
for (const r of db.prepare('SELECT v FROM board ORDER BY created').all()) {
  try { const t = JSON.parse(r.v); tasks.set(t.id, t); } catch {}
}
// tasks saved before steps: answers of earlier runs were already sent (runs used to pick
// the answers to send by run number)
for (const t of tasks.values()) {
  t.steps ||= []; t.pause ??= false;
  // "allow all" became the default (2026-11-16): tasks saved before then switch once
  if (!t.fullDefault) { t.mode = 'full'; t.fullDefault = true; save(t, false); }
  for (const a of t.asks) if (a.sent == null) a.sent = a.answer != null && a.run < t.runs.length - 1;
}
for (const t of tasks.values()) {
  if (t.state !== 'running') continue;
  const rec = t.runs.at(-1);
  if (rec && !rec.ended) Object.assign(rec, { ended: Date.now(), status: 'stopped', error: 'interrupted by a restart' });
  Object.assign(t, { state: 'stopped', error: 'interrupted by a restart' });
  for (const s of t.steps) if (s.state === 'running') s.state = 'stopped';
  if (!t.runs.length) t.planned = false; // cut off while planning: plan again
  save(t, false);
}
// a merge cut off by a restart: undo the half-done merge in the worktree and try again
for (const t of tasks.values()) {
  if (t.wt?.merge?.state !== 'resolving') continue;
  if (fs.existsSync(t.wt.dir)) abortMerge(t.wt);
  t.wt.merge = { state: 'waiting', why: 'interrupted by a restart', at: Date.now() };
  save(t, false);
}
setTimeout(() => {
  for (const t of tasks.values()) if (t.state === 'done' && t.wt && !MERGED.has(t.wt.merge?.state) && t.wt.merge?.state !== 'conflict') integrate(t).finally(() => settled(t));
}, 5000).unref();
setImmediate(() => {
  for (const t of tasks.values()) if (t.state === 'routing') route(t);
  for (const pid of new Set([...tasks.values()].filter(t => t.state === 'queued').map(t => t.pid))) next(pid);
});
