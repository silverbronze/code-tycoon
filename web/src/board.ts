// The task board on the overview: write a task for any project, Code Tycoon finds the
// project and runs it in a real Claude Code session there. What the session cannot do
// alone (questions, secrets, manual steps, commands it was not allowed to run) shows up
// in "Your to-do"; answering the last one sends the answers back and the session carries on.
import { api, live, type Board, type BoardTask, type BoardAsk, type BoardStep, type ShipInfo, type ShipRecipe, type ShipStep } from './api';
import { h, ago, dur, money, autoGrow } from './util';
import { notify } from './notify';
import './board.css';

const STATE: Record<BoardTask['state'], string> = { routing: 'Finding project', unrouted: 'Pick project', targets: 'Pick projects', ready: 'Ready', queued: 'Queued', running: 'Running',
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
  private ticks = new Map<string, Set<string>>(); // fan-out: the projects ticked so far, per task
  private moreOpen = new Set<string>();
  private apart = new Set<string>(); // fan-out questions the user answers per project
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
    this.text = h('textarea', { class: 'bd-text', rows: 2, 'data-k': 'new', placeholder: 'A task for any of your projects, a list of them, or one change for many (“in all my sites…”). Code Tycoon splits a list into separate tasks, finds each one’s project and runs it in a Claude Code session there.',
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
        if ((t.state === 'needs-you' || t.state === 'unrouted' || t.state === 'targets' || t.state === 'paused') && was?.state !== t.state) this.alert(t);
        this.render();
      }
      if (m.type === 'ship' && this.data) { this.data.ships = { ...this.data.ships, [m.pid]: m.info as ShipInfo }; this.render(); }
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
    const n = new Notification(t.state === 'unrouted' ? 'Which project is this task for?' : t.state === 'targets' ? 'Which projects should this task run in?' : t.state === 'paused' ? 'A step is done: check it' : 'A task needs you', { body: short(t.text, 120), tag: 'vz-board-' + t.id });
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
    const sorted = [...d.tasks].sort((a, b) => a.updated - b.updated);
    // the same open question from several projects of one fan-out: one item, one answer for all
    const twins = new Map<string, { t: BoardTask; a: BoardAsk }[]>();
    const twinKey = (t: BoardTask, a: BoardAsk) => t.group?.fan && !this.apart.has(t.group.id + ':' + (a.twin || a.id)) ? t.group.id + ':' + (a.twin || a.id) : null;
    for (const t of sorted) for (const a of t.asks) {
      const k = a.answer == null && twinKey(t, a);
      if (k) twins.set(k, [...(twins.get(k) || []), { t, a }]);
    }
    for (const t of sorted) {
      if (t.state === 'unrouted') items.push(this.routeItem(t, d));
      if (t.state === 'targets') items.push(this.targetsItem(t, d));
      if (t.state === 'paused') items.push(this.reviewItem(t));
      for (const a of t.asks) {
        if (a.answer != null) continue;
        const k = twinKey(t, a), all = k ? twins.get(k)! : [];
        if (all.length > 1) { if (all[0].a === a) items.push(this.askItem(t, a, all)); }
        else items.push(this.askItem(t, a));
      }
      if (t.state === 'done' && t.seen === false && !shipPending(t)) finished.push(this.doneItem(t));
    }
    // projects whose finished tasks wait for the user to confirm, once, how the project goes live
    const waiting = new Map<string, BoardTask[]>();
    for (const t of sorted) if (t.pid && t.state === 'done' && t.ship?.state === 'unconfirmed') waiting.set(t.pid, [...(waiting.get(t.pid) || []), t]);
    for (const [pid, ts] of waiting) items.unshift(this.recipeItem(pid, ts));
    if (!items.length && !finished.length) return [];
    return [h('div', { class: 'bd-todo-h' }, h('b', {}, 'Your to-do'), items.length ? h('span', {}, items.length) : null,
      h('em', {}, items.length ? 'What the sessions can’t do without you. Answering a task’s last question sends the answers back and the session carries on.' : 'Finished tasks, in one line each.')),
      ...items, ...finished.reverse()];
  }

  // a finished task: one line on what was done, the full reply one click away
  private doneItem(t: BoardTask) {
    const key = t.id + ':seen', busy = this.busy.has(key);
    const line = t.tldr || (t.summary ? short(t.summary.split(/(?<=[.!?])\s/)[0], 140) : 'Done.');
    const s = t.ship, live = s?.state === 'live';
    return h('div', { class: 'bd-item done' },
      this.head(t, live ? 'Live' : 'Done'),
      h('div', { class: 'bd-q' }, line),
      s ? h('div', { class: 'bd-why' }, live && s.proof?.url ? [h('a', { href: s.proof.url, target: '_blank', rel: 'noopener' }, s.proof.url), ' · '] : null, shipLine(t)) : null,
      live && s.proof?.shot ? shotImg(t) : null,
      h('div', { class: 'bd-opts' },
        t.sid ? h('button', { class: 'chip', onclick: () => showOutput(t, this.data?.projects.find(p => p.id === t.pid)?.tracked ?? false) }, 'Full output') : null,
        h('button', { class: 'chip go', disabled: busy, title: 'Take it off the to-do', onclick: () => this.act(t, 'seen', {}, key) }, 'OK')),
      this.err(key));
  }

  private head(t: BoardTask, tag: string, cls = '', step?: number | null, proj?: string) {
    const st = step != null ? t.steps.find(x => x.n === step) : null;
    return h('div', { class: 'bd-ihead' }, h('span', { class: 'bd-tag ' + cls }, tag), h('span', { class: 'bd-proj', title: proj }, proj ? short(proj, 60) : t.project || 'No project yet'),
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

  // one change for several projects: the user ticks the projects it runs in
  private targetsItem(t: BoardTask, d: Board) {
    const key = t.id + ':fan', busy = this.busy.has(key);
    const picks = t.fan?.picks || [];
    let on = this.ticks.get(t.id);
    if (!on) { on = new Set(picks.map(p => p.pid)); this.ticks.set(t.id, on); }
    const ticked = on;
    const box = (pid: string, name: string) => h('label', { class: 'bd-tick' + (ticked.has(pid) ? ' on' : '') },
      h('input', { type: 'checkbox', checked: ticked.has(pid), disabled: busy, onchange: (e: Event) => {
        if ((e.target as HTMLInputElement).checked) ticked.add(pid); else ticked.delete(pid);
        this.render(); } }), name);
    const rest = d.projects.filter(p => !picks.some(x => x.pid === p.id));
    const n = ticked.size;
    return h('div', { class: 'bd-item' },
      this.head(t, 'Projects?', 'alarm'),
      h('div', { class: 'bd-q' }, `The same change for ${picks.length} projects. Which should it run in?`),
      t.route?.why ? h('div', { class: 'bd-why' }, t.route.why) : null,
      h('div', { class: 'bd-ticks' }, ...picks.map(p => box(p.pid, p.name))),
      rest.length ? h('details', { class: 'bd-more-p', open: this.moreOpen.has(t.id), ontoggle: (e: Event) => { if ((e.target as HTMLDetailsElement).open) this.moreOpen.add(t.id); else this.moreOpen.delete(t.id); } },
        h('summary', {}, `Other projects (${rest.length})`), h('div', { class: 'bd-ticks' }, ...rest.map(p => box(p.id, p.name)))) : null,
      h('div', { class: 'bd-opts' },
        h('button', { class: 'chip go', disabled: busy || !n, title: 'One session per project, all at once', onclick: () => this.act(t, 'fan', { pids: [...ticked] }, key) },
          n === 1 ? 'Run in 1 project' : `Run in ${n} projects`),
        h('button', { class: 'chip ghost', disabled: busy, onclick: () => this.act(t, 'delete', {}, key) }, 'Drop task')),
      this.err(key));
  }

  // all: the same question from other projects of a fan-out, answered together
  private askItem(t: BoardTask, a: BoardAsk, all: { t: BoardTask; a: BoardAsk }[] = []) {
    const key = t.id + ':' + a.id, busy = this.busy.has(key), many = all.length > 1;
    const send = (v: string) => this.act(t, 'answer', { ask: a.id, answer: v, all: many }, key);
    const proj = many ? all.map(x => x.t.project).join(', ') : undefined;
    const tag = (k: string) => many ? `${k} ×${all.length}` : k;
    const apart = many ? h('button', { class: 'chip ghost', disabled: busy, title: 'Show this question once per project, to answer each one differently',
      onclick: () => { this.apart.add(t.group!.id + ':' + (a.twin || a.id)); this.render(); } }, 'Answer each separately') : null;
    if (a.kind === 'permission') {
      return h('div', { class: 'bd-item' },
        this.head(t, tag(KIND.permission), 'alarm', a.step, proj),
        h('div', { class: 'bd-q' }, a.question, a.why ? h('span', { class: 'bd-why' }, ' ', a.why) : null),
        a.cmd ? h('pre', { class: 'bd-cmd' }, a.cmd) : a.detail ? h('pre', { class: 'bd-cmd' }, a.detail) : null,
        h('div', { class: 'bd-opts' },
          h('button', { class: 'chip go', disabled: busy, onclick: () => send('Allow') }, 'Allow'),
          h('button', { class: 'chip', disabled: busy, title: 'The session may run any command for this task, without asking again', onclick: () => send('Allow all commands for this task') }, 'Allow all for this task'),
          h('button', { class: 'chip', disabled: busy, onclick: () => send('Deny') }, 'Deny'), apart),
        this.err(key));
    }
    const box = h('textarea', { class: 'bd-ans', rows: 1, 'data-k': key, placeholder: a.kind === 'secret' ? 'Never paste the secret here. Put it where asked, then press Done.' : 'Your answer',
      oninput: () => this.drafts.set(key, box.value),
      onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && box.value.trim()) { e.preventDefault(); send(box.value); } } });
    box.value = this.drafts.get(key) || ''; autoGrow(box);
    const manual = a.kind === 'secret' || a.kind === 'action';
    return h('div', { class: 'bd-item' },
      this.head(t, tag(KIND[a.kind]), a.kind === 'approval' || a.kind === 'secret' ? 'alarm' : '', a.step, proj),
      h('div', { class: 'bd-q' }, a.question),
      a.why ? h('div', { class: 'bd-why' }, a.why) : null,
      a.options.length ? h('div', { class: 'bd-opts' }, ...a.options.map(o => h('button', { class: 'chip', disabled: busy, onclick: () => send(o) }, o))) : null,
      h('div', { class: 'bd-answer' }, box,
        manual ? h('button', { class: 'chip go', disabled: busy, title: 'You did it yourself', onclick: () => send(box.value.trim() ? 'Done. ' + box.value.trim() : 'Done') }, 'Done') : null,
        h('button', { class: 'chip' + (manual ? '' : ' go'), disabled: busy, onclick: () => { if (box.value.trim()) send(box.value); else box.focus(); } }, many ? `Send to all ${all.length}` : 'Send')),
      apart ? h('div', { class: 'bd-opts' }, apart) : null,
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

  // ---------------------------------------------------------------- shipping
  // A project's ship recipe, asked once: after the user confirms it, every finished task there
  // is checked, shipped and verified by the board on its own.
  private recipeItem(pid: string, ts: BoardTask[]) {
    const info = this.data?.ships[pid], name = ts[0].project || pid;
    return h('div', { class: 'bd-item' },
      h('div', { class: 'bd-ihead' }, h('span', { class: 'bd-tag alarm' }, 'Ship?'), h('span', { class: 'bd-proj' }, name),
        h('span', { class: 'bd-task' }, `${ts.length} finished task${ts.length > 1 ? 's' : ''} wait${ts.length > 1 ? '' : 's'} to go live`)),
      h('div', { class: 'bd-q' }, `How does ${name} go live? Confirm it once: from then on every finished task there is checked, shipped and verified without asking you.`),
      this.recipeEditor(pid, info, true));
  }

  private recipeDrafts = new Map<string, { check: string; ship: string; url: string; expect: string; live: string; shot: boolean; base: ShipRecipe | null }>();
  private recipeOpen = new Set<string>();
  private recipeEditor(pid: string, info: ShipInfo | undefined, asking: boolean) {
    const key = 'ship:' + pid, busy = this.busy.has(key);
    if (info?.detecting && !info.recipe) return h('div', { class: 'bd-why' }, 'Reading the project to work out how it is checked and shipped…');
    const r = info?.recipe || null;
    let d = this.recipeDrafts.get(pid);
    if (!d || (d.base !== r && !this.dirty.has(pid))) {
      d = { check: stepsText(r?.check), ship: stepsText(r?.ship), url: r?.verify?.url || '', expect: r?.verify?.expect || 'ok', live: r?.live || '', shot: !!r?.screenshot, base: r };
      this.recipeDrafts.set(pid, d);
    }
    const dd = d;
    const edit = (k: 'check' | 'ship' | 'url' | 'expect' | 'live') => (e: Event) => { dd[k] = (e.target as HTMLInputElement).value; this.dirty.add(pid); };
    const area = (k: 'check' | 'ship', ph: string) => {
      const a = h('textarea', { class: 'bd-ans', rows: 2, 'data-k': key + ':' + k, placeholder: ph, oninput: edit(k) });
      a.value = dd[k]; autoGrow(a); return a;
    };
    const field = (k: 'url' | 'expect' | 'live', ph: string) => h('input', { class: 'bd-ans bd-in', 'data-k': key + ':' + k, placeholder: ph, value: dd[k], oninput: edit(k) });
    const recipe = (): ShipRecipe => ({
      check: parseSteps(dd.check), ship: parseSteps(dd.ship),
      verify: dd.url.trim() ? { url: dd.url.trim(), expect: dd.expect.trim() || 'ok', within: r?.verify?.within || 180 } : r?.verify?.self ? { self: true } : null,
      live: dd.live.trim() || null, screenshot: dd.shot, notes: r?.notes || null });
    const save = (b: { confirmed?: boolean; off?: boolean; recipe?: ShipRecipe }) => this.shipAct(pid, () => api.setShip(pid, b));
    return h('div', { class: 'bd-recipe' },
      info?.why || r?.notes ? h('div', { class: 'bd-why' }, [r?.notes, info?.why].filter(Boolean).join(' ')) : null,
      h('label', { class: 'bd-rl' }, 'Checks that must pass first, one command per line'), area('check', 'npm test'),
      h('label', { class: 'bd-rl' }, 'Ship steps, in order (empty: nothing to deploy, check only). Add “when: <regex>” to run a step only when a changed file matches'),
      area('ship', 'npm run deploy'),
      r?.verify?.self ? h('div', { class: 'bd-why' }, 'Live check: Code Tycoon answers on the new commit after the restart.') :
        h('div', { class: 'bd-rrow' }, h('label', { class: 'bd-rl' }, 'Check that it is live at'), field('url', 'https://… (empty: no live check)'),
          h('label', { class: 'bd-rl' }, 'expect'), field('expect', 'ok, sha, or text the page must show')),
      h('div', { class: 'bd-rrow' }, h('label', { class: 'bd-rl' }, 'Where you open it'), field('live', 'https://…'),
        h('label', { class: 'bd-auto' }, h('input', { type: 'checkbox', checked: dd.shot, onchange: (e: Event) => { dd.shot = (e.target as HTMLInputElement).checked; this.dirty.add(pid); } }), 'Screenshot it for the card')),
      h('div', { class: 'bd-opts' },
        h('button', { class: 'chip go', disabled: busy, onclick: () => save({ recipe: recipe(), confirmed: true, off: false }) }, asking ? 'Confirm and ship' : info?.confirmed ? 'Save' : 'Confirm'),
        h('button', { class: 'chip', disabled: busy || info?.detecting, title: 'Read the project again and propose a recipe', onclick: () => { this.dirty.delete(pid); this.shipAct(pid, () => api.detectShip(pid)); } }, info?.detecting ? 'Working it out…' : 'Work it out again'),
        info?.off ? h('button', { class: 'chip', disabled: busy, onclick: () => save({ off: false }) }, 'Ship this project again')
          : h('button', { class: 'chip ghost', disabled: busy, title: 'Finished tasks here stay merged on this PC and are never deployed', onclick: () => save({ off: true }) }, 'Never ship this project')),
      this.err(key));
  }
  // in a task's details: how its project ships, one click from editing
  private recipeBox(t: BoardTask) {
    const pid = t.pid!, info = this.data?.ships[pid], r = info?.recipe;
    const isOpen = this.recipeOpen.has(pid);
    const what = info?.off ? 'off for this project' : !r ? 'not set up yet' : `${info?.confirmed ? '' : 'not confirmed yet: '}${r.check.length ? r.check.map(s => s.run).join(', ') : 'no checks'} → ${r.ship.length ? r.ship.map(s => s.run).join(', ') : 'nothing to deploy'}${r.verify?.url ? ' → ' + r.verify.url : r.verify?.self ? ' → the app answers' : ''}`;
    return h('div', { class: 'bd-shipbox' },
      h('div', { class: 'bd-why' }, `Shipping ${t.project || ''}: ${what} `,
        h('button', { class: 'chip', onclick: () => { if (isOpen) this.recipeOpen.delete(pid); else this.recipeOpen.add(pid); this.render(); } }, isOpen ? 'Close' : 'Edit')),
      isOpen ? this.recipeEditor(pid, info, false) : null);
  }

  private dirty = new Set<string>(); // recipes the user is editing: a server update doesn't overwrite them
  private async shipAct(pid: string, fn: () => Promise<ShipInfo>) {
    const key = 'ship:' + pid;
    if (this.busy.has(key)) return;
    this.busy.add(key); this.errors.delete(key); this.render();
    try {
      const info = await fn();
      if (this.data) this.data.ships = { ...this.data.ships, [pid]: info };
      this.dirty.delete(pid); this.recipeDrafts.delete(pid); this.recipeOpen.delete(pid);
    } catch (e) { this.errors.set(key, (e as Error).message); }
    this.busy.delete(key); this.render();
  }

  // ---------------------------------------------------------------- the tasks
  private list(d: Board) {
    if (!d.tasks.length) return [h('div', { class: 'bd-empty' }, 'No tasks yet. Write one above: the session runs on its own and lists here whatever it needs from you.')];
    // newest first, with the pieces of one split together and in their order
    const firstOf = new Map<string, number>();
    for (const t of d.tasks) if (t.group) firstOf.set(t.group.id, Math.min(firstOf.get(t.group.id) ?? Infinity, t.created));
    const sorted = [...d.tasks].sort((a, b) => ((b.group ? firstOf.get(b.group.id)! : b.created) - (a.group ? firstOf.get(a.group.id)! : a.created))
      || ((a.group?.i ?? 0) - (b.group?.i ?? 0)));
    // a done task stays up top until its branch is merged and shipped
    const finished = (t: BoardTask) => t.state === 'done' && !shipPending(t);
    // the tasks of one fan-out are one entry, done when all of them are
    const entries: BoardTask[][] = [], fans = new Map<string, BoardTask[]>();
    for (const t of sorted) {
      if (!t.group?.fan) { entries.push([t]); continue; }
      const g = fans.get(t.group.id);
      if (g) g.push(t); else { const e = [t]; fans.set(t.group.id, e); entries.push(e); }
    }
    const show = (e: BoardTask[]) => e[0].group?.fan ? this.fanCard(e) : this.row(e[0]);
    const active = entries.filter(e => !e.every(finished)), done = entries.filter(e => e.every(finished));
    return [
      ...active.map(show),
      done.length ? h('button', { class: 'bd-more', onclick: () => { this.showDone = !this.showDone; this.render(); } }, `${this.showDone ? 'Hide' : 'Show'} done (${done.length})`) : null,
      ...(this.showDone ? done.map(show) : []),
    ].filter(Boolean) as HTMLElement[];
  }

  // one change in several projects: one card, a chip per project, actions for all of them
  private fanCard(ts: BoardTask[]) {
    const g = ts[0].group!, key = 'fan:' + g.id, busy = this.busy.has(key), isOpen = this.open.has(key);
    const ORDER: BoardTask['state'][] = ['needs-you', 'paused', 'running', 'queued', 'failed', 'stopped', 'ready', 'routing', 'done'];
    const st = ORDER.find(s => ts.some(t => t.state === s)) || ts[0].state;
    const counts = ORDER.map(s => [s, ts.filter(t => t.state === s).length] as const).filter(([, n]) => n);
    const merged = ts.filter(t => t.wt?.merge?.state === 'merged').length;
    const line = counts.map(([s, n]) => `${n} ${STATE[s].toLowerCase()}`).join(' · ') + (merged ? ` · ${merged} merged` : '');
    const cost = ts.reduce((a, t) => a + (t.cost || 0), 0);
    const pick = (f: (t: BoardTask) => boolean) => ts.filter(f);
    const ready = pick(t => t.state === 'ready'), stuck = pick(t => t.state === 'failed' || t.state === 'stopped');
    const running = pick(t => t.state === 'running' || t.state === 'queued'), merge = pick(canMerge);
    const btn = (label: string, list: BoardTask[], action: (t: BoardTask) => Parameters<typeof api.taskAction>[1], cls = 'chip', title?: string) =>
      list.length ? h('button', { class: cls, disabled: busy, title, onclick: (e: Event) => { e.stopPropagation(); this.actAll(key, list, action); } }, list.length === ts.length || list.length === 1 && ts.length === 1 ? label : `${label} (${list.length})`) : null;
    const acts = [
      btn('Run all', ready, () => 'run', 'chip go'),
      btn('Continue', stuck, t => t.runs.length ? 'again' : 'run', 'chip go', 'Resume the ones that failed or were stopped'),
      btn('Stop all', running, () => 'stop'),
      btn('Merge', merge, () => 'merge', 'chip go', 'Merge every branch that waits'),
    ];
    const strip = h('div', { class: 'bd-fan-strip' }, ...ts.map(t => h('span', { class: 'bd-fan-p ' + t.state,
      title: `${t.project}: ${STATE[t.state]}${t.tldr ? '. ' + t.tldr : t.error ? '. ' + t.error : ''}` }, t.project || '?')));
    return h('div', { class: 'bd-task-row bd-fan ' + st + (isOpen ? ' open' : '') },
      h('div', { class: 'bd-main', onclick: () => { if (isOpen) this.open.delete(key); else this.open.add(key); this.render(); } },
        h('span', { class: 'bd-state ' + st }, STATE[st]),
        h('span', { class: 'bd-proj' }, `${ts.length} projects`),
        h('div', { class: 'bd-body' }, h('div', { class: 'bd-text-1' }, short(ts[0].text, 160)), h('div', { class: 'bd-line' }, line), strip),
        h('span', { class: 'bd-meta' }, cost ? money(cost) : '', h('i', {}, ago(Math.max(...ts.map(t => t.updated))))),
        h('div', { class: 'bd-acts' }, ...acts)),
      isOpen ? h('div', { class: 'bd-fan-rows' },
        ...ts.map(t => this.row(t)),
        ts.every(t => t.state !== 'running') ? h('div', { class: 'bd-opts' },
          h('button', { class: 'chip ghost', disabled: busy, onclick: () => this.actAll(key, ts, () => 'delete') }, `Delete all ${ts.length}`)) : null) : null,
      this.err(key));
  }

  private async actAll(key: string, list: BoardTask[], action: (t: BoardTask) => Parameters<typeof api.taskAction>[1]) {
    if (this.busy.has(key)) return;
    this.busy.add(key); this.errors.delete(key); this.render();
    const errs: string[] = [];
    await Promise.all(list.map(async t => {
      try {
        const r = await api.taskAction(t.id, action(t));
        if (r.task && this.data) { const i = this.data.tasks.findIndex(x => x.id === t.id); if (i >= 0) this.data.tasks[i] = r.task; }
      } catch (e) { errs.push(`${t.project}: ${(e as Error).message}`); }
    }));
    if (errs.length) this.errors.set(key, errs.join('; '));
    this.busy.delete(key); this.render();
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
      t.state === 'running' || shipBusy(t) ? btn('Stop', 'stop', 'chip', shipBusy(t) ? 'Stop shipping' : undefined) : null,
      canShip(t) ? btn('Ship again', 'ship', 'chip go', 'Run the ship recipe again (after fixing something outside the code)') : null,
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
      : t.state === 'done' && t.ship && t.ship.state !== 'nothing' ? shipLine(t)!
      : t.state === 'needs-you' && t.ship?.state === 'failed' ? shipLine(t)!
      : t.state === 'needs-you' ? `${t.open} thing${t.open === 1 ? '' : 's'} in your to-do${t.summary ? '. ' + t.summary : ''}`
      : t.state === 'done' && t.tldr ? t.tldr
      : t.error ? t.error : t.summary || (t.state === 'ready' ? 'Press Run to start a session' : '');
    return h('div', { class: 'bd-task-row ' + t.state + (isOpen ? ' open' : '') },
      h('div', { class: 'bd-main', onclick: () => { if (isOpen) this.open.delete(t.id); else this.open.add(t.id); this.render(); } },
        h('span', { class: 'bd-state ' + stateOf(t)[0] }, stateOf(t)[1]),
        h('span', { class: 'bd-proj' }, t.project || '—'),
        h('div', { class: 'bd-body' }, h('div', { class: 'bd-text-1' },
          t.group && !t.group.fan ? h('span', { class: 'bd-part', title: 'Split from: ' + short(t.group.source, 300) }, `${t.group.i + 1}/${t.group.n}`) : null, short(t.text, 160)), line ? h('div', { class: 'bd-line' }, short(line, 240)) : null),
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
      t.ship ? h('div', { class: 'bd-why' }, t.ship.proof?.url ? [h('a', { href: t.ship.proof.url, target: '_blank', rel: 'noopener' }, t.ship.proof.url), ' · '] : null, shipLine(t)) : null,
      t.ship?.log && t.ship.state !== 'live' ? h('pre', { class: 'bd-cmd' }, t.ship.log.slice(-1500)) : null,
      t.ship?.proof?.shot ? shotImg(t) : null,
      t.pid ? this.recipeBox(t) : null,
      t.group?.fan ? h('div', { class: 'bd-why' }, `The same change in ${t.group.n} projects: ${(t.group.names || []).join(', ')}`) : null,
      t.group && !t.group.fan ? h('div', { class: 'bd-split' }, h('span', { class: 'bd-why' }, `Part ${t.group.i + 1} of ${t.group.n}, split from what you wrote:`),
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
      answered.length ? h('div', { class: 'bd-qa' }, ...answered.map(a => h('div', {}, h('span', { class: 'bd-why' }, a.cmd ? `Command ${a.cmd}` : a.question), ' → ', h('b', {}, a.answer), a.auto ? h('span', { class: 'bd-why' }, ` (your answer in ${a.auto})`) : null))) : null,
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

// ---------------------------------------------------------------- shipping (server/ship.mjs)
const SHIP_BUSY = ['queued', 'checking', 'shipping', 'restarting', 'verifying'];
const shipBusy = (t: BoardTask) => !!t.ship && SHIP_BUSY.includes(t.ship.state);
// not finished yet: still merging, shipping, being fixed, or waiting for its project's recipe
const shipPending = (t: BoardTask) => unmerged(t) || shipBusy(t) || t.ship?.state === 'fixing' || t.ship?.state === 'unconfirmed';
const canShip = (t: BoardTask) => !!t.ship && ['failed', 'stopped'].includes(t.ship.state) && t.state !== 'running';
// the state chip: a done task reads as shipping, live or not shipped
function stateOf(t: BoardTask): [string, string] {
  const s = t.ship?.state;
  if (t.state !== 'done' || !s) return [t.state, STATE[t.state]];
  if (s === 'live') return ['done', 'Live'];
  if (SHIP_BUSY.includes(s)) return ['running', 'Shipping'];
  if (s === 'unconfirmed') return ['paused', 'Not shipped'];
  if (s === 'failed' || s === 'stopped') return ['failed', 'Not shipped'];
  return ['done', 'Done'];
}
function shipLine(t: BoardTask) {
  const s = t.ship;
  if (!s) return null;
  const at = s.step ? `: ${s.step}` : '';
  switch (s.state) {
    case 'queued': return 'Waits to ship: another task ships in this project first';
    case 'checking': return 'Checking before shipping' + at;
    case 'shipping': return 'Shipping' + at;
    case 'restarting': return s.why || 'Restarting Code Tycoon on the new code';
    case 'verifying': return 'Checking that it is live' + at;
    case 'live': return s.proof ? `${s.proof.checked ? 'Live and checked' : 'Shipped (no live address to check)'}: ${s.proof.why}${s.proof.sha && !s.proof.why.includes(s.proof.sha) ? ` · commit ${s.proof.sha}` : ''}` : 'Live';
    case 'fixing': return `Shipping failed at ${s.stage}${at}; ${t.state === 'needs-you' ? 'the session needs your answer to fix it' : `the session is fixing it (try ${s.tries} of 2)`}`;
    case 'failed': return `Shipping failed at ${s.stage}${at}${s.back?.ok ? `. Rolled back (revert ${s.back.sha})` : s.back ? `. Could not roll back: ${s.back.why}` : ''}`;
    case 'unconfirmed': return 'Not shipped yet: confirm once how this project goes live (in your to-do)';
    case 'off': return 'Not deployed: shipping is off for this project';
    case 'nothing': return 'Changed nothing, so there was nothing to ship';
    case 'stopped': return 'Shipping stopped' + (s.why ? ': ' + s.why : '');
  }
}
const shotImg = (t: BoardTask) => { const src = `/api/board/${encodeURIComponent(t.id)}/shot?t=${t.ship?.proof?.at || 0}`;
  return h('a', { class: 'bd-shot', href: src, target: '_blank', rel: 'noopener', title: 'The live page after shipping' }, h('img', { src, alt: 'Screenshot of the live page', loading: 'lazy' })); };
const stepsText = (xs?: ShipStep[]) => (xs || []).map(s => s.when ? `${s.run}   when: ${s.when}` : s.run).join('\n');
const parseSteps = (txt: string): ShipStep[] => txt.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
  const m = l.match(/^(.*?)\s+when:\s*(.+)$/);
  return m ? { run: m[1].trim(), when: m[2].trim() } : { run: l, when: null };
});

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
