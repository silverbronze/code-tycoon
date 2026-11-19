// The task board on the overview: write a task for any project, Code Tycoon finds the
// project and runs it in a real Claude Code session there. What the session cannot do
// alone (questions, secrets, manual steps, commands it was not allowed to run) shows up
// in "Your to-do"; answering the last one sends the answers back and the session carries on.
import { api, live, type Board, type BoardTask, type BoardAsk, type BoardStep } from './api';
import { h, ago, dur, money, autoGrow } from './util';
import { notify } from './notify';
import './board.css';

const STATE: Record<BoardTask['state'], string> = { routing: 'Finding project', unrouted: 'Pick project', ready: 'Ready', queued: 'Queued', running: 'Running',
  'needs-you': 'Needs you', done: 'Done', failed: 'Failed', stopped: 'Stopped', paused: 'Paused' };
const KIND: Record<BoardAsk['kind'], string> = { decision: 'Decide', secret: 'Secret', action: 'Do this', info: 'Tell it', approval: 'Approve', permission: 'Allow?' };
const AUTO_KEY = 'vz-board-auto', MODE_KEY = 'vz-board-mode2', PAUSE_KEY = 'vz-board-pause';
const MARK: Record<BoardStep['state'], string> = { todo: '○', running: '●', done: '✓', 'needs-you': '!', failed: '✕', stopped: '■' };
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} };
const short = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

export class BoardPanel {
  el: HTMLElement;
  private data: Board | null = null;
  private drafts = new Map<string, string>();
  private errors = new Map<string, string>();
  private busy = new Set<string>();
  private open = new Set<string>();
  private showDone = false;
  private text: HTMLTextAreaElement;
  private fitText: () => void;
  private pick: HTMLSelectElement;
  private mode: HTMLSelectElement;
  private auto: HTMLInputElement;
  private pause: HTMLInputElement;
  private addBtn: HTMLButtonElement;
  private addErr: HTMLElement;
  private todoEl: HTMLElement;
  private listEl: HTMLElement;
  private off: () => void;
  private timer = 0;

  constructor() {
    this.text = h('textarea', { class: 'bd-text', rows: 2, 'data-k': 'new', placeholder: 'A task for any of your projects, or a list of them. Code Tycoon splits a list into separate tasks, finds each one’s project and runs it in a Claude Code session there.',
      onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.add(); } } });
    this.fitText = autoGrow(this.text);
    this.pick = h('select', { class: 'bd-sel', title: 'Which project the task is for' }, h('option', { value: '' }, 'Find the project for me'));
    this.mode = h('select', { class: 'bd-sel', title: 'What the session may run without asking you. File edits are always allowed.',
      onchange: () => lsSet(MODE_KEY, this.mode.value) },
      h('option', { value: 'full' }, 'Allow all commands'), h('option', { value: 'ask' }, 'Ask me before commands'));
    this.mode.value = lsGet(MODE_KEY) === 'ask' ? 'ask' : 'full';
    this.auto = h('input', { type: 'checkbox', checked: lsGet(AUTO_KEY) !== '0', onchange: () => lsSet(AUTO_KEY, this.auto.checked ? '1' : '0') });
    this.pause = h('input', { type: 'checkbox', checked: lsGet(PAUSE_KEY) === '1', onchange: () => lsSet(PAUSE_KEY, this.pause.checked ? '1' : '0') });
    this.addBtn = h('button', { class: 'chip go', onclick: () => this.add() }, 'Add task');
    this.addErr = h('div', { class: 'bd-err' });
    this.todoEl = h('div', { class: 'bd-todo' });
    this.listEl = h('div', { class: 'bd-list' });
    this.el = h('section', { class: 'board' },
      h('h2', { class: 'ov-h' }, 'Tasks, all projects'),
      h('div', { class: 'bd-compose' }, this.text,
        h('div', { class: 'bd-row' }, this.pick, this.mode,
          h('label', { class: 'bd-auto', title: 'Start the session as soon as the project is known. Off, the task waits for Run.' }, this.auto, 'Start right away'),
          h('label', { class: 'bd-auto', title: 'A task with several stages runs as a plan of steps. On, it stops after each step for you to check before it goes on.' }, this.pause, 'Pause after each step'),
          h('span', { class: 'bd-hint' }, 'Ctrl+Enter'), this.addBtn),
        this.addErr),
      this.todoEl, this.listEl);
    this.load();
    this.timer = window.setInterval(() => this.load(), 60e3);
    this.off = live.on(m => {
      if (m.type === 'connected') this.load();
      if (m.type === 'board' && this.data) {
        const t = m.task as BoardTask, i = this.data.tasks.findIndex(x => x.id === t.id);
        const was = i >= 0 ? this.data.tasks[i] : null;
        if (i >= 0) this.data.tasks[i] = t; else this.data.tasks.unshift(t);
        if ((t.state === 'needs-you' || t.state === 'unrouted' || t.state === 'paused') && was?.state !== t.state) this.alert(t);
        this.render();
      }
      if (m.type === 'board-removed' && this.data) { this.data.tasks = this.data.tasks.filter(x => x.id !== m.id); this.render(); }
    });
  }

  private async load() {
    try { this.data = await api.board(); } catch { return; }
    this.render();
  }

  // a desktop notification while the tab is in the background
  private alert(t: BoardTask) {
    if (!notify.on || (document.visibilityState === 'visible' && document.hasFocus())) return;
    const n = new Notification(t.state === 'unrouted' ? 'Which project is this task for?' : t.state === 'paused' ? 'A step is done: check it' : 'A task needs you', { body: short(t.text, 120), tag: 'vz-board-' + t.id });
    n.onclick = () => { window.focus(); location.hash = '#/'; n.close(); };
  }

  // The overview rebuilds the page around this panel; keep the caret where it was.
  saveFocus() {
    const a = document.activeElement as HTMLTextAreaElement | null;
    if (!a || !this.el.contains(a) || !a.dataset?.k) return null;
    return { k: a.dataset.k, s: a.selectionStart, e: a.selectionEnd };
  }
  restoreFocus(f: { k: string; s: number | null; e: number | null } | null) {
    if (!f) return;
    const el = this.el.querySelector<HTMLTextAreaElement>(`[data-k="${CSS.escape(f.k)}"]`);
    if (!el) return;
    el.focus();
    try { if (f.s != null) el.setSelectionRange(f.s, f.e ?? f.s); } catch {}
  }

  private async add() {
    const text = this.text.value.trim();
    if (!text) { this.text.focus(); return; }
    this.addBtn.disabled = true; this.addErr.textContent = '';
    try {
      await api.addTask({ text, pid: this.pick.value || null, mode: this.mode.value as 'ask' | 'full', autoRun: this.auto.checked, pause: this.pause.checked });
      this.text.value = ''; this.fitText(); this.pick.value = '';
    } catch (e) { this.addErr.textContent = (e as Error).message; }
    this.addBtn.disabled = false;
  }

  private async act(t: BoardTask, action: Parameters<typeof api.taskAction>[1], b: Record<string, unknown> = {}, key = t.id) {
    if (this.busy.has(key)) return;
    this.busy.add(key); this.errors.delete(key); this.render();
    try {
      const r = await api.taskAction(t.id, action, b);
      if (r.task && this.data) { const i = this.data.tasks.findIndex(x => x.id === t.id); if (i >= 0) this.data.tasks[i] = r.task; }
      if (action === 'answer' || action === 'again') this.drafts.delete(key);
    } catch (e) { this.errors.set(key, (e as Error).message); }
    this.busy.delete(key); this.render();
  }

  private render() {
    const d = this.data;
    if (!d) return;
    const focus = this.saveFocus();
    // project picker: keep the choice across refreshes
    const want = this.pick.value;
    if (this.pick.options.length !== d.projects.length + 1) {
      this.pick.replaceChildren(h('option', { value: '' }, 'Find the project for me'), ...d.projects.map(p => h('option', { value: p.id }, p.name)));
      this.pick.value = want;
    }
    this.todoEl.replaceChildren(...this.todo(d));
    this.listEl.replaceChildren(...this.list(d));
    this.restoreFocus(focus);
  }

  // ---------------------------------------------------------------- your to-do
  private todo(d: Board) {
    const items: HTMLElement[] = [], finished: HTMLElement[] = [];
    for (const t of [...d.tasks].sort((a, b) => a.updated - b.updated)) {
      if (t.state === 'unrouted') items.push(this.routeItem(t, d));
      if (t.state === 'paused') items.push(this.reviewItem(t));
      for (const a of t.asks) if (a.answer == null) items.push(this.askItem(t, a));
      if (t.state === 'done' && t.seen === false) finished.push(this.doneItem(t));
    }
    if (!items.length && !finished.length) return [];
    return [h('div', { class: 'bd-todo-h' }, h('b', {}, 'Your to-do'), items.length ? h('span', {}, items.length) : null,
      h('em', {}, items.length ? 'What the sessions can’t do without you. Answering a task’s last question sends the answers back and the session carries on.' : 'Finished tasks, in one line each.')),
      ...items, ...finished.reverse()];
  }

  // a finished task: one line on what was done, the full reply one click away
  private doneItem(t: BoardTask) {
    const key = t.id + ':seen', busy = this.busy.has(key);
    const line = t.tldr || (t.summary ? short(t.summary.split(/(?<=[.!?])\s/)[0], 140) : 'Done.');
    return h('div', { class: 'bd-item done' },
      this.head(t, 'Done'),
      h('div', { class: 'bd-q' }, line),
      h('div', { class: 'bd-opts' },
        t.sid ? h('button', { class: 'chip', onclick: () => showOutput(t, this.data?.projects.find(p => p.id === t.pid)?.tracked ?? false) }, 'Full output') : null,
        h('button', { class: 'chip go', disabled: busy, title: 'Take it off the to-do', onclick: () => this.act(t, 'seen', {}, key) }, 'OK')),
      this.err(key));
  }

  private head(t: BoardTask, tag: string, cls = '', step?: number | null) {
    const st = step != null ? t.steps.find(x => x.n === step) : null;
    return h('div', { class: 'bd-ihead' }, h('span', { class: 'bd-tag ' + cls }, tag), h('span', { class: 'bd-proj' }, t.project || 'No project yet'),
      st ? h('span', { class: 'bd-part', title: st.title }, `Step ${st.n}/${t.steps.length}`) : null,
      h('span', { class: 'bd-task', title: t.text }, short(t.text, 140)));
  }

  private routeItem(t: BoardTask, d: Board) {
    const key = t.id + ':route', busy = this.busy.has(key);
    const sel = h('select', { class: 'bd-sel' }, h('option', { value: '' }, 'Another project…'), ...d.projects.map(p => h('option', { value: p.id }, p.name)));
    const picks = t.route?.picks || [];
    return h('div', { class: 'bd-item' },
      this.head(t, 'Project?', 'alarm'),
      h('div', { class: 'bd-q' }, 'Which project is this task for?'),
      t.route?.why ? h('div', { class: 'bd-why' }, t.route.why, t.route.conf ? ` (${Math.round(t.route.conf * 100)}% sure)` : '') : null,
      h('div', { class: 'bd-opts' },
        ...picks.map(p => h('button', { class: 'chip', disabled: busy, title: p.why, onclick: () => this.act(t, 'route', { pid: p.pid }, key) }, p.name)),
        sel, h('button', { class: 'chip', disabled: busy, onclick: () => { if (sel.value) this.act(t, 'route', { pid: sel.value }, key); } }, 'Use'),
        h('button', { class: 'chip ghost', disabled: busy, onclick: () => this.act(t, 'delete', {}, key) }, 'Drop task')),
      this.err(key));
  }

  private askItem(t: BoardTask, a: BoardAsk) {
    const key = t.id + ':' + a.id, busy = this.busy.has(key);
    const send = (v: string) => this.act(t, 'answer', { ask: a.id, answer: v }, key);
    if (a.kind === 'permission') {
      return h('div', { class: 'bd-item' },
        this.head(t, KIND.permission, 'alarm', a.step),
        h('div', { class: 'bd-q' }, a.question, a.why ? h('span', { class: 'bd-why' }, ' ', a.why) : null),
        a.cmd ? h('pre', { class: 'bd-cmd' }, a.cmd) : a.detail ? h('pre', { class: 'bd-cmd' }, a.detail) : null,
        h('div', { class: 'bd-opts' },
          h('button', { class: 'chip go', disabled: busy, onclick: () => send('Allow') }, 'Allow'),
          h('button', { class: 'chip', disabled: busy, title: 'The session may run any command for this task, without asking again', onclick: () => send('Allow all commands for this task') }, 'Allow all for this task'),
          h('button', { class: 'chip', disabled: busy, onclick: () => send('Deny') }, 'Deny')),
        this.err(key));
    }
    const box = h('textarea', { class: 'bd-ans', rows: 1, 'data-k': key, placeholder: a.kind === 'secret' ? 'Never paste the secret here. Put it where asked, then press Done.' : 'Your answer',
      oninput: () => this.drafts.set(key, box.value),
      onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && box.value.trim()) { e.preventDefault(); send(box.value); } } });
    box.value = this.drafts.get(key) || ''; autoGrow(box);
    const manual = a.kind === 'secret' || a.kind === 'action';
    return h('div', { class: 'bd-item' },
      this.head(t, KIND[a.kind], a.kind === 'approval' || a.kind === 'secret' ? 'alarm' : '', a.step),
      h('div', { class: 'bd-q' }, a.question),
      a.why ? h('div', { class: 'bd-why' }, a.why) : null,
      a.options.length ? h('div', { class: 'bd-opts' }, ...a.options.map(o => h('button', { class: 'chip', disabled: busy, onclick: () => send(o) }, o))) : null,
      h('div', { class: 'bd-answer' }, box,
        manual ? h('button', { class: 'chip go', disabled: busy, title: 'You did it yourself', onclick: () => send(box.value.trim() ? 'Done. ' + box.value.trim() : 'Done') }, 'Done') : null,
        h('button', { class: 'chip' + (manual ? '' : ' go'), disabled: busy, onclick: () => { if (box.value.trim()) send(box.value); else box.focus(); } }, 'Send')),
      this.err(key));
  }

  // a paused plan: the step it just did, for the user to check before it goes on
  private reviewItem(t: BoardTask) {
    const key = t.id + ':review', busy = this.busy.has(key);
    const done = [...t.steps].filter(s => s.state === 'done' && s.runs.length).sort((a, b) => Math.max(...b.runs) - Math.max(...a.runs))[0];
    const nx = t.steps.find(s => s.state === 'todo' || s.state === 'needs-you');
    return h('div', { class: 'bd-item' },
      this.head(t, 'Check', '', done?.n),
      h('div', { class: 'bd-q' }, done ? `Step ${done.n} is done: ${done.title}` : 'A step is done'),
      done?.summary ? h('div', { class: 'bd-why' }, done.summary) : null,
      nx ? h('div', { class: 'bd-why' }, `Next: step ${nx.n}, ${nx.title}`) : null,
      h('div', { class: 'bd-opts' },
        h('button', { class: 'chip go', disabled: busy, onclick: () => this.act(t, 'run', {}, key) }, 'Continue'),
        h('button', { class: 'chip', disabled: busy, title: 'Run the remaining steps without stopping', onclick: () => this.act(t, 'run', { pause: false }, key) }, 'Continue without pausing'),
        t.sid && this.data?.projects.find(p => p.id === t.pid)?.tracked ? h('button', { class: 'chip', onclick: () => { location.hash = '#/p/' + encodeURIComponent(t.pid!) + '/s/' + encodeURIComponent(t.sid!); } }, 'Open the session') : null),
      this.err(key));
  }

  private err(key: string) { const e = this.errors.get(key); return e ? h('div', { class: 'bd-err' }, e) : null; }

  // ---------------------------------------------------------------- the tasks
  private list(d: Board) {
    if (!d.tasks.length) return [h('div', { class: 'bd-empty' }, 'No tasks yet. Write one above: the session runs on its own and lists here whatever it needs from you.')];
    // newest first, with the pieces of one split together and in their order
    const firstOf = new Map<string, number>();
    for (const t of d.tasks) if (t.group) firstOf.set(t.group.id, Math.min(firstOf.get(t.group.id) ?? Infinity, t.created));
    const sorted = [...d.tasks].sort((a, b) => ((b.group ? firstOf.get(b.group.id)! : b.created) - (a.group ? firstOf.get(a.group.id)! : a.created))
      || ((a.group?.i ?? 0) - (b.group?.i ?? 0)));
    // a done task stays up top until its branch is merged
    const finished = (t: BoardTask) => t.state === 'done' && !unmerged(t);
    const active = sorted.filter(t => !finished(t)), done = sorted.filter(finished);
    return [
      ...active.map(t => this.row(t)),
      done.length ? h('button', { class: 'bd-more', onclick: () => { this.showDone = !this.showDone; this.render(); } }, `${this.showDone ? 'Hide' : 'Show'} done (${done.length})`) : null,
      ...(this.showDone ? done.map(t => this.row(t)) : []),
    ].filter(Boolean) as HTMLElement[];
  }

  private row(t: BoardTask) {
    const busy = this.busy.has(t.id), isOpen = this.open.has(t.id);
    const tracked = !!(t.pid && this.data?.projects.find(p => p.id === t.pid)?.tracked);
    const last = t.runs.at(-1);
    const btn = (label: string, action: Parameters<typeof api.taskAction>[1], cls = 'chip', title?: string) =>
      h('button', { class: cls, disabled: busy, title, onclick: (e: Event) => { e.stopPropagation(); this.act(t, action); } }, label);
    const acts = [
      t.state === 'ready' ? btn('Run', 'run', 'chip go') : null,
      (t.state === 'failed' || t.state === 'stopped') ? btn(t.runs.length ? 'Continue' : 'Run', t.runs.length ? 'again' : 'run', 'chip go', 'Resume the session where it stopped') : null,
      t.state === 'paused' ? btn('Continue', 'run', 'chip go', 'Go on with the next step') : null,
      t.state === 'running' ? btn('Stop', 'stop') : null,
      t.state === 'queued' && t.wait ? h('button', { class: 'chip', disabled: busy, title: 'Start now without waiting for the task it depends on',
        onclick: (e: Event) => { e.stopPropagation(); this.act(t, 'run', { force: true }); } }, 'Start anyway') : null,
      t.state === 'queued' ? btn('Unqueue', 'stop', 'chip', t.wait ? 'Take it out of the queue' : 'Waits for another task in the same project') : null,
      canMerge(t) ? btn('Merge', 'merge', 'chip go', `Merge ${t.wt!.branch} into ${t.wt!.base} now`) : null,
      tracked && (t.state === 'running' || t.sid) ? h('button', { class: 'chip', title: 'Open the project and follow the session', onclick: (e: Event) => {
        e.stopPropagation(); location.hash = '#/p/' + encodeURIComponent(t.pid!) + (t.sid ? '/s/' + encodeURIComponent(t.sid) : ''); } }, 'Watch') : null,
    ];
    const N = t.steps.length, cur = last?.step != null ? t.steps.find(s => s.n === last.step) : null;
    const doneN = t.steps.filter(s => s.state === 'done').length;
    const line = t.state === 'running' && last && cur ? `Step ${cur.n}/${N}: ${cur.title}. Working for ${dur(Date.now() - last.started)}`
      : t.state === 'running' && !last ? 'Planning: one piece of work, or steps?'
      : t.state === 'running' && last ? `Working for ${dur(Date.now() - last.started)}${t.runs.length > 1 ? `, run ${t.runs.length}` : ''}`
      : t.state === 'paused' ? `${doneN} of ${N} steps done. Check it, then continue`
      : t.state === 'needs-you' && N ? `${t.open} thing${t.open === 1 ? '' : 's'} in your to-do. ${doneN} of ${N} steps done`
      : t.state === 'routing' ? 'Reading your projects to find where this belongs…'
      : t.state === 'queued' && t.wait ? `Waits for “${short(t.wait.text, 70)}”${t.wait.project ? ` in ${t.wait.project}` : ''} to be done`
      : t.state === 'queued' ? `Waits for the task running in this project${t.tree ? '' : ': it is not a git repo, so its tasks share one folder'}`
      : t.state === 'done' && unmerged(t) ? mergeLine(t)!
      : t.state === 'needs-you' ? `${t.open} thing${t.open === 1 ? '' : 's'} in your to-do${t.summary ? '. ' + t.summary : ''}`
      : t.state === 'done' && t.tldr ? t.tldr
      : t.error ? t.error : t.summary || (t.state === 'ready' ? 'Press Run to start a session' : '');
    return h('div', { class: 'bd-task-row ' + t.state + (isOpen ? ' open' : '') },
      h('div', { class: 'bd-main', onclick: () => { if (isOpen) this.open.delete(t.id); else this.open.add(t.id); this.render(); } },
        h('span', { class: 'bd-state ' + t.state }, STATE[t.state]),
        h('span', { class: 'bd-proj' }, t.project || '—'),
        h('div', { class: 'bd-body' }, h('div', { class: 'bd-text-1' },
          t.group ? h('span', { class: 'bd-part', title: 'Split from: ' + short(t.group.source, 300) }, `${t.group.i + 1}/${t.group.n}`) : null, short(t.text, 160)), line ? h('div', { class: 'bd-line' }, short(line, 240)) : null),
        h('span', { class: 'bd-meta' }, N ? h('span', { class: 'bd-dots', title: t.steps.map(s => `${MARK[s.state]} ${s.n}. ${s.title}`).join('\n') }, t.steps.map(s => MARK[s.state]).join('')) : null,
          t.cost ? money(t.cost) : '', h('i', {}, ago(t.updated))),
        h('div', { class: 'bd-acts' }, ...acts)),
      isOpen ? this.detail(t, busy) : null,
      this.err(t.id));
  }

  private detail(t: BoardTask, busy: boolean) {
    const key = t.id + ':note';
    const note = h('textarea', { class: 'bd-ans', rows: 1, 'data-k': key, placeholder: t.state === 'done' ? 'A follow-up for the same session' : 'Anything to add before it continues',
      oninput: () => this.drafts.set(key, note.value) });
    note.value = this.drafts.get(key) || ''; autoGrow(note);
    const answered = t.asks.filter(a => a.answer != null && a.answer !== '(closed)');
    const canFollow = t.runs.length && !t.open && (t.state === 'done' || t.state === 'failed' || t.state === 'stopped');
    return h('div', { class: 'bd-detail' },
      h('div', { class: 'bd-full' }, t.text),
      t.route && t.project ? h('div', { class: 'bd-why' }, `Project: ${t.project}. ${t.route.why}`) : null,
      t.wt ? h('div', { class: 'bd-why' }, mergeLine(t)) : null,
      t.group ? h('div', { class: 'bd-split' }, h('span', { class: 'bd-why' }, `Part ${t.group.i + 1} of ${t.group.n}, split from what you wrote:`),
        h('div', { class: 'bd-src' }, t.group.source),
        h('button', { class: 'chip', disabled: busy, title: 'Undo the split: one task with your original text, routed to one project', onclick: () => this.act(t, 'join') }, 'Join back into one task')) : null,
      t.steps.length ? h('div', { class: 'bd-steps' }, h('span', { class: 'bd-why' }, 'The plan:'), ...t.steps.map(s => h('div', { class: 'bd-step ' + s.state },
        h('span', { class: 'bd-mark', title: s.state }, MARK[s.state]),
        h('div', {}, h('b', {}, `${s.n}. ${s.title}`), s.after.length ? h('span', { class: 'bd-why' }, ` after ${s.after.join(', ')}`) : null,
          s.cost ? h('span', { class: 'bd-why' }, ' · ' + money(s.cost)) : null,
          s.summary && s.state !== 'todo' ? h('div', { class: 'bd-sum' }, s.summary) : null)))) : null,
      t.runs.length ? h('div', { class: 'bd-runs' }, ...t.runs.map(r => h('div', { class: 'bd-run' },
        h('b', {}, `Run ${r.n + 1}${r.step != null ? ` · step ${r.step}` : ''}`), h('span', {}, r.status), h('span', {}, r.ended ? dur(r.ended - r.started) : 'running'), r.cost ? h('span', {}, money(r.cost)) : null,
        r.summary || r.error ? h('div', { class: 'bd-sum' }, r.summary || r.error) : null))) : null,
      answered.length ? h('div', { class: 'bd-qa' }, ...answered.map(a => h('div', {}, h('span', { class: 'bd-why' }, a.cmd ? `Command ${a.cmd}` : a.question), ' → ', h('b', {}, a.answer)))) : null,
      h('div', { class: 'bd-opts' },
        h('label', { class: 'bd-auto' }, 'Commands',
          h('select', { class: 'bd-sel', disabled: busy || t.state === 'running', onchange: (e: Event) => this.act(t, 'mode', { mode: (e.target as HTMLSelectElement).value }) },
            h('option', { value: 'ask', selected: t.mode === 'ask' }, 'ask me'), h('option', { value: 'full', selected: t.mode === 'full' }, 'allow all'))),
        h('label', { class: 'bd-auto', title: 'Stop after each step of the plan for you to check it' },
          h('input', { type: 'checkbox', checked: t.pause, disabled: busy, onchange: (e: Event) => this.act(t, 'pause', { pause: (e.target as HTMLInputElement).checked }) }), 'Pause after each step'),
        canFollow ? [note, h('button', { class: 'chip', disabled: busy, onclick: () => this.act(t, 'again', { note: note.value }, t.id) }, t.state === 'done' ? 'Send follow-up' : 'Continue')] : null,
        t.state !== 'done' && t.state !== 'running' ? h('button', { class: 'chip', disabled: busy, title: 'Mark as done and drop its open questions', onclick: () => this.act(t, 'close') }, 'Mark done') : null,
        t.state !== 'running' ? h('button', { class: 'chip ghost', disabled: busy, onclick: () => this.act(t, 'delete') }, 'Delete') : null));
  }

  dispose() { this.off(); clearInterval(this.timer); this.el.remove(); }
}

// a task's own branch (git projects): where its merge into the main folder stands
const unmerged = (t: BoardTask) => !!t.wt?.merge && !['merged', 'nothing'].includes(t.wt.merge.state);
const canMerge = (t: BoardTask) => t.state === 'done' && !!t.wt?.merge && ['waiting', 'conflict', 'failed'].includes(t.wt.merge.state);
function mergeLine(t: BoardTask) {
  const w = t.wt, m = w?.merge;
  if (!w || !m) return null;
  const fs = m.files?.length ? ` (${m.files.slice(0, 4).join(', ')}${m.files.length > 4 ? ` and ${m.files.length - 4} more` : ''})` : '';
  switch (m.state) {
    case 'working': return `Works on its own branch ${w.branch}, merged into ${w.base} when done`;
    case 'merged': return `Merged into ${m.into || w.base}${m.sha ? ` as ${m.sha}` : ''}${fs}`;
    case 'nothing': return 'Changed no tracked files, so there was nothing to merge';
    case 'resolving': return `Resolving conflicts with ${w.base}${fs}`;
    case 'waiting': return `Waits to merge into ${w.base}: ${m.why || 'not yet'}${fs}. Tried again every 3 minutes`;
    case 'conflict': return `Can't merge into ${w.base}: ${m.why || 'conflicts'}${fs}. Fix it on ${w.branch} in ${w.dir}, then press Merge`;
    case 'failed': return `Merge failed: ${m.why || 'unknown error'}`;
  }
}

// **bold** and `code` of a reply as DOM nodes (text only, never HTML); the rest stays as written
function inlineMd(s: string) {
  return s.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/).map(p =>
    p.startsWith('**') && p.endsWith('**') && p.length > 4 ? h('b', {}, p.slice(2, -2))
      : p.startsWith('`') && p.endsWith('`') && p.length > 2 ? h('code', {}, p.slice(1, -1))
      : document.createTextNode(p));
}

// The session's final reply, read by the server from the transcript it already indexed.
// On <body>, fixed, so nothing on the overview draws over it.
function showOutput(t: BoardTask, tracked: boolean) {
  document.querySelector('.bd-out-wrap')?.remove();
  const body = h('div', { class: 'bd-out-text' }, 'Loading…');
  const close = () => { wrap.remove(); removeEventListener('keydown', esc); };
  const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  const wrap = h('div', { class: 'bd-out-wrap', onclick: (e: Event) => { if (e.target === wrap) close(); } },
    h('div', { class: 'bd-out' },
      h('div', { class: 'bd-ihead' }, h('span', { class: 'bd-tag' }, 'Output'), h('span', { class: 'bd-proj' }, t.project || ''),
        h('span', { class: 'bd-task', title: t.text }, short(t.text, 120))),
      t.tldr ? h('div', { class: 'bd-q' }, t.tldr) : null,
      body,
      h('div', { class: 'bd-opts' },
        tracked && t.pid && t.sid ? h('button', { class: 'chip', onclick: () => { close(); location.hash = '#/p/' + encodeURIComponent(t.pid!) + '/s/' + encodeURIComponent(t.sid!); } }, 'Open the session') : null,
        h('button', { class: 'chip go', onclick: close }, 'Close'))));
  addEventListener('keydown', esc);
  document.body.append(wrap);
  api.taskOutput(t.id).then(r => { body.replaceChildren(...inlineMd(r.text || r.summary || 'The session left no reply.')); })
    .catch(() => { body.textContent = t.summary || 'Could not read the session.'; });
}
