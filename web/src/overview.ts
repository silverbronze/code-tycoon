import { api, live, type Project, type OpenSession, type Weekly, type Setup } from './api';
import { h, put, ago, bytes, dur, tail, money } from './util';
import { notify } from './notify';
import { Pulse } from './pulse';
import { CoachPanel } from './coach';

const VERB: Record<string, string> = { write: 'Editing', read: 'Reading', search: 'Searching', touch: 'Touching', cmd: 'Running', remote: 'Calling', skill: 'Using skill', spawn: 'Spawning agent', ask: 'Asking you', other: 'Using' };
const GROUPS: [string, string][] = [['needs-you', 'Needs you'], ['working', 'Working'], ['waiting', 'Your turn'], ['idle', 'Idle']];

export class Overview {
  root: HTMLDivElement;
  private timer = 0;
  private off: (() => void) | null = null;
  private showAll = false;
  private confirmUntrack: string | null = null;
  private pulse = new Pulse('big');
  private coach = new CoachPanel();
  private setup: Setup | null = null;
  private setupBusy = false;
  private setupError = '';

  constructor(parent: HTMLElement) {
    this.root = h('div', { class: 'overview' });
    parent.appendChild(this.root);
    this.render();
    api.setup().then(s => { this.setup = s; this.render(); }).catch(() => {});
    this.timer = window.setInterval(() => this.render(), 5000);
    live.subscribe(null);
    this.off = live.on(m => { if (m.type === 'session' || m.type === 'indexed') this.render(); });
  }

  async render() {
    let res;
    try { res = await api.projects(this.showAll); } catch { return; }
    const ps = res.projects as (Project & { spark: number[] | null })[];
    const tracked = ps.filter(p => p.tracked), other = ps.filter(p => !p.tracked);
    const scroll = this.root.scrollTop;
    this.root.innerHTML = '';
    put(this.root,
      h('div', { class: 'ov-hero' },
        h('div', { class: 'brand' }, h('div', {}, h('h1', {}, h('img', { src: '/logo-light.svg', alt: 'Code Tycoon' })), h('p', {}, 'Your projects as living cities. Every Claude Code session is a light moving through them.'))),
        h('div', { class: 'ov-stats' },
          this.pulse.el,
          notify.supported ? h('button', { class: 'big notif' + (notify.on ? ' on' : ''), title: 'Desktop notifications when a session needs you or two sessions edit one file, while this tab is in the background',
            onclick: async () => { await notify.toggle(); this.render(); } }, h('b', {}, notify.on ? 'On' : 'Off'), h('span', {}, 'desktop alerts')) : null,
          this.setupToggle('hooks', 'live updates', 'Claude Code tells Code Tycoon about every step the moment it happens (adds a hook to ~/.claude/settings.json, a backup is kept). Off, sessions show up a few seconds late from their transcripts.'),
          this.setupToggle('autostart', 'start at login', 'Start Code Tycoon hidden when you log in, so this page is always there at http://127.0.0.1:4400'))),
      this.setupBanner(),
      res.sessions.length ? this.openSessions(res.sessions) : null,
      tracked.length ? this.coach.el : null,
      tracked.length ? h('h2', { class: 'ov-h' }, 'Tracked') : null,
      h('div', { class: 'grid' }, ...tracked.map(p => this.card(p))),
      h('div', { class: 'ov-h2row' }, h('h2', { class: 'ov-h' }, 'Other projects with Claude Code history'),
        h('label', { class: 'showall' }, h('input', { type: 'checkbox', checked: this.showAll, onchange: (e: Event) => { this.showAll = (e.target as HTMLInputElement).checked; this.render(); } }), 'include temp & headless folders')),
      h('div', { class: 'grid small' }, ...other.map(p => this.card(p))),
    );
    this.root.scrollTop = scroll;
  }

  private async changeSetup(change: Partial<Record<'hooks' | 'autostart', boolean>>) {
    this.setupBusy = true; this.setupError = ''; this.render();
    try { this.setup = await api.setSetup(change); } catch (e) { this.setupError = (e as Error).message; }
    this.setupBusy = false; this.render();
  }

  private setupToggle(k: 'hooks' | 'autostart', label: string, tip: string) {
    const on = this.setup?.[k];
    if (on == null) return null;
    return h('button', { class: 'big notif' + (on ? ' on' : ''), title: tip, disabled: this.setupBusy,
      onclick: () => this.changeSetup({ [k]: !on }) }, h('b', {}, on ? 'On' : 'Off'), h('span', {}, label));
  }

  // First run: both switches in one place, until they are on or put off for later.
  private setupBanner() {
    const s = this.setup;
    let later = false;
    try { later = localStorage.getItem('vz-setup-later') === '1'; } catch {}
    if (!s || (s.hooks && s.autostart !== false) || (later && !this.setupError)) return null;
    const missing = { hooks: !s.hooks, autostart: s.autostart === false };
    return h('section', { class: 'setup' },
      h('div', { class: 'setup-text' },
        h('b', {}, 'Finish setting up'),
        h('ul', {},
          missing.hooks ? h('li', {}, h('em', {}, 'Live updates'), ': see each session read, write and run commands the moment it happens.') : null,
          missing.autostart ? h('li', {}, h('em', {}, 'Start at login'), ': keep Code Tycoon running in the background, so this page is always ready.') : null),
        this.setupError ? h('p', { class: 'setup-err' }, 'Could not finish: ', this.setupError) : null),
      h('div', { class: 'setup-acts' },
        h('button', { class: 'chip go', disabled: this.setupBusy, onclick: () => this.changeSetup({ ...(missing.hooks ? { hooks: true } : {}), ...(missing.autostart ? { autostart: true } : {}) }) },
          this.setupBusy ? 'Setting up…' : 'Turn on'),
        h('button', { class: 'chip', onclick: () => { try { localStorage.setItem('vz-setup-later', '1'); } catch {} this.setupError = ''; this.render(); } }, 'Not now')));
  }

  // Every open session in every project, the ones waiting on you first.
  private openSessions(list: OpenSession[]) {
    const now = Date.now();
    const rows = GROUPS.flatMap(([state, label]) => {
      const g = list.filter(s => s.state === state).sort((a, b) => state === 'working' ? b.since - a.since : a.since - b.since);
      if (!g.length) return [];
      return [h('div', { class: 'os-group' }, label, h('span', {}, g.length)), ...g.map(s => {
        const act = s.action ? `${VERB[s.action.kind] || 'Using'} ${s.action.path ? tail(s.action.path, 2) : s.action.target || s.action.detail || s.action.tool}` : '';
        const go = s.tracked ? () => { location.hash = '#/p/' + encodeURIComponent(s.pid) + '/s/' + encodeURIComponent(s.id); } : null;
        return h('div', { class: 'os-row ' + s.state + (go ? ' link' : ''), onclick: go, title: go ? 'Open the project and follow this session' : 'Track the project to open it' },
          h('span', { class: 'state ' + s.state }, label),
          h('span', { class: 'os-proj' }, s.project || '—'),
          h('span', { class: 'os-title' }, s.title || s.prompt?.slice(0, 80) || s.id.slice(0, 8)),
          h('span', { class: 'os-act' }, s.needs?.msg || act || (s.prompt ? '“' + s.prompt.slice(0, 90) + '”' : '')),
          h('span', { class: 'os-age' }, dur(now - s.since)));
      })];
    });
    return h('section', { class: 'os' }, h('h2', { class: 'ov-h' }, 'Open sessions, all projects'), h('div', { class: 'os-list' }, ...rows));
  }

  private card(p: Project & { spark: number[] | null }) {
    const go = () => { location.hash = '#/p/' + encodeURIComponent(p.id); };
    const indexing = p.indexing;
    const confirming = this.confirmUntrack === p.id;
    return h('div', { class: 'pcard' + (p.tracked ? ' tracked' : '') + (p.open ? ' live' : ''), onclick: p.tracked ? go : null },
      h('div', { class: 'row' },
        h('h3', {}, p.name),
        p.open ? h('span', { class: 'pill live' }, h('i'), `${p.open} open`) : null,
        p.needs ? h('span', { class: 'pill alarm' }, `${p.needs} waiting on you`) : null,
        p.tracked ? h('button', { class: 'untrack' + (confirming ? ' confirm' : ''), title: 'Stop tracking (history stays in the database)',
          onclick: async (e: Event) => {
            e.stopPropagation();
            if (!confirming) { this.confirmUntrack = p.id; this.render(); setTimeout(() => { if (this.confirmUntrack === p.id) { this.confirmUntrack = null; this.render(); } }, 4000); return; }
            this.confirmUntrack = null; await api.untrack(p.id); this.render();
          } }, confirming ? 'Untrack?' : '×') : null),
      h('div', { class: 'path' }, p.root),
      p.tracked ? h('div', { class: 'nums' },
        h('span', {}, h('b', {}, p.sessions), ' sessions'), h('span', {}, h('b', {}, p.prompts), ' tasks'), h('span', {}, 'last ', ago(p.last_ts)),
        p.cost14 ? h('span', { title: 'Last 14 days at API list prices (a subscription is not billed per token)' }, h('b', {}, money(p.cost14)), ' API-equiv.') : null) :
        h('div', { class: 'nums' }, h('span', {}, bytes(p.bytes), ' of transcripts')),
      p.spark ? spark(p.spark) : null,
      p.tracked ? this.weekRow(p.id) : null,
      !p.tracked ? h('button', { class: 'chip', disabled: !!indexing, onclick: async (e: Event) => { e.stopPropagation(); (e.target as HTMLButtonElement).textContent = 'Indexing…'; await api.track(p.id); go(); } }, indexing ? `Indexing ${indexing.done}/${indexing.total}` : 'Track & open') : null);
  }

  // This week against last on four numbers: cost per landed task, share landed,
  // rework, and how long finished turns waited for you. Fetched every 5 minutes.
  private weeks = new Map<string, { at: number; d: Weekly | null }>();
  private weekRow(pid: string) {
    const hit = this.weeks.get(pid);
    if (!hit || Date.now() - hit.at > 5 * 60e3) {
      this.weeks.set(pid, { at: Date.now(), d: hit?.d ?? null });
      api.weekly(pid).then(d => { this.weeks.set(pid, { at: Date.now(), d }); this.render(); }).catch(() => {});
    }
    const d = hit?.d; if (!d) return null;
    const w = d.week, p = d.prev;
    const land = (s: Weekly['week']) => s.writing ? s.landed / s.writing : null;
    const cell = (k: string, v: string, a: number | null, b: number | null, good: 'up' | 'down', tip: string) => {
      const move = a != null && b != null && b !== 0 && Math.abs(a - b) / Math.abs(b) >= 0.05 ? (a > b) === (good === 'up') ? 'good' : 'bad' : '';
      return h('span', { class: 'wk ' + move, title: tip }, h('b', {}, v), move ? (a! > b! ? ' ▲' : ' ▼') : '', h('i', {}, k));
    };
    const pct = (x: number | null) => x == null ? '–' : `${Math.round(x * 100)}%`;
    return h('div', { class: 'weekrow', title: 'This week, with the arrow showing the move from last week (green: better)' },
      cell('$ / landed', w.perLanded == null ? '–' : money(w.perLanded), w.perLanded, p.perLanded, 'down', 'API-equivalent cost per task that reached a commit'),
      cell('landed', pct(land(w)), land(w), land(p), 'up', w.writing ? `${w.landed} of ${w.writing} writing tasks reached a commit` : 'Not a git repository, or nothing written this week'),
      cell('rework', pct(w.rework), w.rework, p.rework, 'down', 'Share of edits another task rewrote within 3 days'),
      cell('wait', w.waitMedian ? dur(w.waitMedian) : '–', w.waitMedian, p.waitMedian, 'down', 'Median time a finished turn waited for your next prompt'));
  }

  dispose() { clearInterval(this.timer); this.off?.(); this.pulse.dispose(); this.coach.dispose(); this.root.remove(); }
}

function spark(v: number[]) {
  const max = Math.max(1, ...v), W = 140, H = 28;
  const pts = v.map((n, i) => `${(i / (v.length - 1)) * W},${H - (n / max) * (H - 3) - 1}`).join(' ');
  const el = h('div', { class: 'spark', title: 'tasks per day, last 14 days' });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="0,${H} ${pts} ${W},${H}" fill="rgba(0,0,0,0.06)" stroke="none"/><polyline points="${pts}" fill="none" stroke="#111111" stroke-width="1.5"/></svg>`;
  return el;
}
