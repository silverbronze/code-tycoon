// Voice control: a short recording from the browser goes to Deepgram (speech to text in
// English, Russian or Hebrew), then one small model call turns what was said into actions.
// Task board actions run here; page actions (open a project, switch the map layer, follow a
// session) go back to the browser. The Deepgram key never reaches the browser: it is read
// from DEEPGRAM_API_KEY or ~/.codetycoon/deepgram.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, SUMMARIZER_CWD } from './paths.mjs';
import { runAgent } from './llm.mjs';
import { listBoard, create, boardAction } from './board.mjs';
import { openSessions } from './live.mjs';

const KEY_FILE = path.join(DATA_DIR, 'deepgram');
const LANGS = new Set(['en', 'ru', 'he']);
const LANG_NAME = { en: 'English', ru: 'Russian', he: 'Hebrew' };

function key() {
  if (process.env.DEEPGRAM_API_KEY) return process.env.DEEPGRAM_API_KEY.trim();
  try { return fs.readFileSync(KEY_FILE, 'utf8').trim() || null; } catch { return null; }
}
export const voiceStatus = () => ({ ready: !!key() });

// lang: 'en' | 'ru' | 'he' | 'auto'. Auto lets Deepgram detect the language (it cannot be
// limited to three); a detection outside them is retried in English.
async function listen(buf, type, lang) {
  const k = key();
  if (!k) throw new Error('No Deepgram key. Put it in ~/.codetycoon/deepgram or set DEEPGRAM_API_KEY.');
  const once = async l => {
    const q = new URLSearchParams({ model: 'nova-3', smart_format: 'true' });
    if (l) q.set('language', l); else q.set('detect_language', 'true');
    const r = await fetch('https://api.deepgram.com/v1/listen?' + q, { method: 'POST', body: buf, signal: AbortSignal.timeout(30e3),
      headers: { authorization: 'Token ' + k, 'content-type': type || 'audio/webm' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Deepgram: ' + (j.err_msg || j.message || r.status));
    const c = j.results?.channels?.[0];
    return { text: String(c?.alternatives?.[0]?.transcript || '').trim(), lang: l || c?.detected_language || null };
  };
  if (LANGS.has(lang)) return once(lang);
  const r = await once(null);
  return r.lang && !LANGS.has(r.lang) ? once('en') : r;
}

const short = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// what the model may act on: projects, the board, the open sessions, and the page the user is on
function context(page) {
  const b = listBoard();
  const names = new Map(b.projects.map(p => [p.id, p.name]));
  const live = b.tasks.filter(t => t.state !== 'done');
  const done = b.tasks.filter(t => t.state === 'done').sort((a, c) => c.updated - a.updated).slice(0, 5);
  const task = t => ({ id: t.id, project: t.project, state: t.state, text: short(t.text, 200),
    steps: t.steps?.length ? `${t.steps.filter(s => s.state === 'done').length}/${t.steps.length} done` : undefined,
    summary: t.summary ? short(t.summary, 200) : undefined, answer: t.answer ? short(t.answer, 800) : undefined,
    asks: t.asks.filter(a => a.answer == null).map(a => ({ id: a.id, kind: a.kind, question: short(a.question, 240), options: a.options?.length ? a.options : undefined, cmd: a.cmd ? short(a.cmd, 160) : undefined })) });
  return {
    page: page?.pid ? { project: page.pid, name: names.get(page.pid) || null, layer: page.layer || null } : { overview: true },
    projects: b.projects.map(p => ({ id: p.id, name: p.name, tracked: p.tracked })),
    tasks: live.map(task), recentlyDone: done.map(t => ({ id: t.id, project: t.project, text: short(t.text, 120), answer: t.answer ? short(t.answer, 800) : undefined })),
    sessions: openSessions().slice(0, 30).map(s => ({ id: s.id, project: s.pid, name: names.get(s.pid) || null, title: short(s.title, 100), state: s.state })),
  };
}

function prompt(text, lang, ctx) {
  return `You turn a spoken command into actions in Code Tycoon, an app that shows the user's code projects as a city and runs coding tasks on a task board.
The user speaks English, Russian or Hebrew, and may mix them. Speech recognition makes mistakes: read project names and words by how they sound.

The user said${lang ? ` (${LANG_NAME[lang] || lang})` : ''}: ${JSON.stringify(text)}

Current state:
${JSON.stringify(ctx)}

Reply with one JSON object and nothing else:
{"say": "<a short reply to the user, in the language they spoke>", "actions": [ ... ]}

Actions (use ids from the state, never invent them):
- {"do":"overview"}  go to the overview (the home page with the task board)
- {"do":"open","pid":"<project id>","layer":"city"|"domain"|"schematic"|null}  open a project (tracked projects only); layer: city = the 3D city, domain = the domain map, schematic = the schematic map
- {"do":"layer","layer":"city"|"domain"|"schematic"}  switch the map on the current project
- {"do":"follow","pid":"<project id>","sid":"<session id>"}  open a project and follow one of its open sessions
- {"do":"add","text":"<the task>","pid":"<project id>"|null}  add a task to the board. Write the task clearly in the language it was spoken, without filler words. pid only when the user names the project (or says "here"/"this project" while on a project page); null lets the board find the project. A list of several tasks is one "add" with the whole list: the board splits it.
- {"do":"answer","task":"<task id>","ask":"<ask id>","answer":"<answer>"}  answer an open question in the to-do. For a permission ask the answer is "Allow", "Allow all commands for this task" or "Deny". For one with options, use the option's exact text. For a manual step the user did ("done", "I did it"), answer "Done".
- {"do":"run","task":"<task id>"}  start a ready task, or continue a paused one
- {"do":"again","task":"<task id>","note":"<what to add>"|null}  continue a failed or stopped task, or send a follow-up to a done one (note is required then)
- {"do":"stop","task":"<task id>"}  stop a running task
- {"do":"done","task":"<task id>"}  mark a task done
- {"do":"route","task":"<task id>","pid":"<project id>"}  pick the project for a task that asks which project it is for

Rules:
- Only act on what the user clearly asked. When it is unclear which task or question they mean, act on nothing and ask in "say".
- A question ("what needs me?", "what's running?") gets no actions: answer it from the state in "say", in one or two sentences.
- Never delete anything.
- An answer to several questions that all match what was said (e.g. the same command asked several times) answers each of them; leave the others open.
- A task carries on only once its last open question is answered; until then it keeps waiting. Don't say it restarts unless that was its last open question.
- "say" is short and plain: what you did, or the answer.`;
}

const KINDS = new Set(['overview', 'open', 'layer', 'follow', 'add', 'answer', 'run', 'again', 'stop', 'done', 'route']);
const UI = new Set(['overview', 'open', 'layer', 'follow']);
const LAYERS = new Set(['city', 'domain', 'schematic']);

// run the board actions here; return the page actions for the browser
function act(actions, ctx, prefs) {
  const pids = new Set(ctx.projects.map(p => p.id)), tracked = new Set(ctx.projects.filter(p => p.tracked).map(p => p.id));
  const ui = [], did = [], errors = [];
  for (const a of Array.isArray(actions) ? actions : []) {
    if (!a || !KINDS.has(a.do)) continue;
    if (UI.has(a.do)) {
      if (a.do === 'open' || a.do === 'follow') {
        if (!tracked.has(a.pid)) { errors.push('That project is not tracked yet.'); continue; }
        ui.push({ do: a.do, pid: a.pid, sid: a.do === 'follow' ? String(a.sid || '') || null : null, layer: LAYERS.has(a.layer) ? a.layer : null });
      } else if (a.do === 'layer') { if (LAYERS.has(a.layer)) ui.push({ do: 'layer', layer: a.layer }); }
      else ui.push({ do: 'overview' });
      continue;
    }
    let r;
    if (a.do === 'add') {
      r = create({ text: a.text, pid: pids.has(a.pid) ? a.pid : null, mode: prefs.mode, autoRun: prefs.autoRun !== false, pause: !!prefs.pause, model: prefs.model });
      if (r.task) did.push({ do: 'add', task: r.task.id, text: short(r.task.text, 120) });
    } else {
      const id = String(a.task || '');
      const b = a.do === 'answer' ? { ask: String(a.ask || ''), answer: a.answer } : a.do === 'again' ? { note: a.note || '' } : a.do === 'route' ? { pid: a.pid } : {};
      r = boardAction(id, { done: 'close' }[a.do] || a.do, b);
      if (!r.error) did.push({ do: a.do, task: id });
    }
    if (r.error) errors.push(r.error);
  }
  return { ui, did, errors };
}

// body: the recording. q: { lang, pid, layer, mode, autoRun, pause } from the page.
// text: skip speech recognition (typed commands, tests).
export async function voiceCommand({ audio, type, text, lang, page, prefs = {} }) {
  const heard = text != null ? { text: String(text).trim(), lang: LANGS.has(lang) ? lang : null } : await listen(audio, type, lang);
  if (!heard.text) return { text: '', lang: heard.lang, say: null, ui: [], did: [], errors: ['Nothing heard. Try again, a bit closer to the mic.'] };
  const ctx = context(page);
  const { res, cost } = await runAgent({ want: 'small', tools: 'none', cwd: SUMMARIZER_CWD, prompt: prompt(heard.text, heard.lang, ctx), timeoutMs: 60e3 });
  const out = act(res.actions, ctx, prefs);
  return { text: heard.text, lang: heard.lang, say: typeof res.say === 'string' ? res.say : null, ...out, cost };
}
