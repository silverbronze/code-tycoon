import { api, live, type PulseT, type PulseDetail, type ProcBreakdown } from './api';
import { h, put, ago, dur } from './util';

const GB = 1024 ** 3;
const gb = (n: number) => (n / GB).toFixed(n < 10 * GB ? 1 : 0);
const mb = (n: number) => n >= GB ? gb(n) + ' GB' : Math.round(n / 1024 ** 2) + ' MB';
const STATE: Record<string, string> = { 'needs-you': 'Needs you', working: 'Working', waiting: 'Your turn', idle: 'Idle' };

// short: the label in the strip over the city, which has less room
type Item = { key: string; value: string | number; label: string; short?: string; cls: string; title: string };

// The top-line numbers shown on every page: sessions across all projects and
// how hard the local machine is working. 'big' fills the overview hero with
// tiles; 'strip' is the slim pill over the city. Each number opens a popover
// with what it is made of.
export class Pulse {
  el: HTMLDivElement;
  private timer = 0;
  private off: () => void;
  private pending = 0;
  private pop: HTMLDivElement | null = null;
  private openKey: string | null = null;
  private last: PulseT | null = null;

  constructor(private variant: 'big' | 'strip') {
    this.el = h('div', { class: 'pulse ' + variant + (variant === 'strip' ? ' glass' : '') });
    this.refresh();
    this.timer = window.setInterval(() => this.refresh(), 5000);
    this.off = live.on(m => { if (m.type === 'session' && !this.pending) this.pending = window.setTimeout(() => { this.pending = 0; this.refresh(); }, 800); });
  }

  async refresh() {
    let p: PulseT;
    try { p = await api.pulse(); } catch { return; }
    this.last = p;
    this.el.innerHTML = '';
    put(this.el, ...this.items(p).map(it => {
      const attrs = { class: (this.variant === 'big' ? 'big' : 'pu') + ' tap' + (it.cls ? ' ' + it.cls : '') + (this.openKey === it.key ? ' sel' : ''),
        title: it.title, 'data-k': it.key, onclick: (e: Event) => { e.stopPropagation(); this.toggle(it.key, e.currentTarget as HTMLElement); } };
      return this.variant === 'big'
        ? h('button', attrs, h('b', {}, it.value), h('span', {}, it.label))
        : h('button', attrs, h('b', {}, it.value), ' ', it.short ?? it.label);
    }));
    if (this.pop && this.openKey) this.place(this.el.querySelector(`[data-k="${this.openKey}"]`));
  }

  private items(p: PulseT): Item[] {
    const sys = p.system;
    const out: Item[] = [
      { key: 'sessions', value: p.open, label: 'sessions open', short: 'open', cls: p.open ? 'on' : '', title: 'Claude Code sessions open right now, all projects' },
      { key: 'needs', value: p.needs, label: 'sessions waiting on you', short: 'waiting on you', cls: p.needs ? 'alarm' : '', title: 'Sessions waiting for your answer or permission' },
      { key: 'tracked', value: p.tracked, label: 'tracked projects', short: 'tracked', cls: '', title: 'Projects drawn as cities' },
    ];
    if (sys.procs) {
      const { node, claude } = sys.procs;
      const many = claude.n > p.open * 3 + 4;
      out.push({ key: 'node', value: node.n, label: 'node processes', short: 'node', cls: '', title: `Node.js processes on this machine: ${mb(node.mem)} RAM, ${node.cpu}% CPU` });
      out.push({ key: 'claude', value: claude.n, label: `Claude processes, ${mb(claude.mem)} RAM`, short: `Claude procs · ${mb(claude.mem)}`, cls: many ? 'warn' : '',
        title: `Claude Code processes (CLI, extension, subagents): ${mb(claude.mem)} RAM, ${claude.cpu}% CPU.` + (many ? ' Far more than the open sessions; some may be leftovers from closed windows.' : '') });
    }
    if (sys.cpu != null) out.push({ key: 'cpu', value: `${sys.cpu}%`, label: 'CPU', cls: sys.cpu >= 85 ? 'alarm' : sys.cpu >= 60 ? 'warn' : '', title: `Whole machine (${sys.cores} cores), last few seconds` });
    const ram = sys.memUsed / sys.memTotal;
    out.push({ key: 'ram', value: `${gb(sys.memUsed)}/${gb(sys.memTotal)} GB`, label: 'RAM in use', short: 'RAM', cls: ram >= 0.9 ? 'alarm' : ram >= 0.75 ? 'warn' : '', title: `Whole machine: ${Math.round(ram * 100)}% of RAM in use` });
    return out;
  }

  // --- popover -------------------------------------------------------------
  private toggle(key: string, anchor: HTMLElement) {
    if (this.openKey === key) return this.close();
    this.close();
    this.openKey = key;
    anchor.classList.add('sel');
    this.pop = h('div', { class: 'pulse-pop glass', onclick: (e: Event) => e.stopPropagation(), onpointerdown: (e: Event) => e.stopPropagation(), onwheel: (e: Event) => e.stopPropagation() },
      h('div', { class: 'pp-load' }, key === 'node' || key === 'claude' || key === 'cpu' || key === 'ram' ? 'Looking at processes…' : 'Loading…'));
    document.body.appendChild(this.pop);
    this.place(anchor);
    document.addEventListener('pointerdown', this.outside, true);
    document.addEventListener('keydown', this.esc);
    const pop = this.pop;
    api.pulseDetail(key).then(d => { if (this.pop === pop) { pop.innerHTML = ''; put(pop, this.body(d)); this.place(this.el.querySelector(`[data-k="${key}"]`)); } })
      .catch(() => { if (this.pop === pop) pop.textContent = 'Could not load this.'; });
  }

  private outside = (e: Event) => { if (this.pop && !this.pop.contains(e.target as Node) && !this.el.contains(e.target as Node)) this.close(); };
  private esc = (e: KeyboardEvent) => { if (e.key === 'Escape') this.close(); };

  private close() {
    this.pop?.remove(); this.pop = null; this.openKey = null;
    this.el.querySelectorAll('.sel').forEach(x => x.classList.remove('sel'));
    document.removeEventListener('pointerdown', this.outside, true);
    document.removeEventListener('keydown', this.esc);
  }

  // under the number, kept inside the window
  private place(anchor: Element | null) {
    if (!this.pop || !anchor) return;
    const a = anchor.getBoundingClientRect(), w = Math.min(560, window.innerWidth - 24);
    const left = Math.max(12, Math.min(window.innerWidth - w - 12, a.left + a.width / 2 - w / 2));
    Object.assign(this.pop.style, { left: `${left}px`, top: `${a.bottom + 8}px`, width: `${w}px`, maxHeight: `${window.innerHeight - a.bottom - 24}px` });
  }

  private body(d: PulseDetail): Node {
    const now = Date.now();
    if (d.kind === 'sessions' || d.kind === 'needs') {
      const list = [...d.sessions].sort((a, b) => order(a.state) - order(b.state) || b.since - a.since);
      return h('div', {},
        h('div', { class: 'pp-h' }, d.kind === 'needs' ? 'Waiting for your answer or permission' : 'Open Claude Code sessions, all projects'),
        list.length ? list.map(s => {
          const go = s.tracked ? () => { this.close(); location.hash = '#/p/' + encodeURIComponent(s.pid) + '/s/' + encodeURIComponent(s.id); } : null;
          const act = s.needs?.msg || (s.action ? `${s.action.tool} ${s.action.path?.split('/').slice(-2).join('/') || s.action.target || ''}` : '') || (s.prompt ? '“' + s.prompt.slice(0, 90) + '”' : '');
          return h('div', { class: 'pp-row' + (go ? ' link' : ''), onclick: go, title: go ? 'Open the project and follow this session' : 'Track the project to open it' },
            h('span', { class: 'state ' + s.state }, STATE[s.state] || s.state),
            h('div', { class: 'pp-main' }, h('div', { class: 'pp-t' }, h('span', { class: 'pp-proj' }, s.project || '—'), ' ', s.title || s.prompt?.slice(0, 80) || s.id.slice(0, 8)),
              act ? h('div', { class: 'pp-sub' + (s.state === 'needs-you' ? ' red' : '') }, act) : null),
            h('span', { class: 'pp-n' }, dur(now - s.since)));
        }) : h('div', { class: 'pp-empty' }, d.kind === 'needs' ? 'Nothing is waiting on you.' : 'No open sessions.'));
    }
    if (d.kind === 'tracked') {
      return h('div', {},
        h('div', { class: 'pp-h' }, 'Projects drawn as cities'),
        d.projects.map(p => h('div', { class: 'pp-row link', onclick: () => { this.close(); location.hash = '#/p/' + encodeURIComponent(p.id); } },
          h('div', { class: 'pp-main' }, h('div', { class: 'pp-t' }, p.name, p.open ? h('span', { class: 'pp-tag on' }, `${p.open} open`) : null),
            h('div', { class: 'pp-sub mono' }, p.root)),
          h('span', { class: 'pp-n' }, `${p.sessions} sessions · ${p.prompts} tasks · ${ago(p.last_ts)}`))),
        d.projects.length ? null : h('div', { class: 'pp-empty' }, 'No tracked projects. Pick one on the overview.'));
    }
    return this.procs(d as ProcBreakdown, now);
  }

  private procs(d: ProcBreakdown, now: number) {
    const machine = d.kind === 'cpu' || d.kind === 'ram';
    const open = this.last?.open ?? 0;
    const cli = d.kind === 'claude' ? d.groups.filter(g => g.label.startsWith('Claude Code')).reduce((a, g) => a + g.n, 0) : 0;
    const head = machine
      ? d.kind === 'cpu' ? `Whole machine: ${d.cpu}% CPU over the last second, ${d.n} processes. Heaviest programs:`
        : `Whole machine: ${mb(d.memUsed!)} of ${mb(d.memTotal!)} in use. Heaviest programs by RAM:`
      : `${d.n} ${d.kind} processes · ${mb(d.mem)} in RAM · ${mb(d.priv)} committed · ${d.cpu}% CPU`;
    const top = Math.max(1e-9, ...d.groups.map(g => d.kind === 'cpu' ? g.cpu : g.mem));
    return h('div', {},
      h('div', { class: 'pp-h' }, head),
      cli > open + 2 ? h('div', { class: 'pp-note' }, `${cli} Claude Code CLI processes but ${open} open sessions. The extra ones are usually sessions whose panel or window was closed while the process kept running; the oldest ones below are the likely leftovers.`) : null,
      d.kind === 'node' ? h('div', { class: 'pp-note dim' }, '“Under N sessions” = started by that many Claude Code sessions, so each session runs its own copy of every MCP server.') : null,
      d.groups.map(g => {
        const bar = h('i', { class: 'pp-bar', style: { width: `${Math.max(2, (d.kind === 'cpu' ? g.cpu : g.mem) / top * 100)}%` } });
        const sum = h('summary', { class: 'pp-row' },
          h('span', { class: 'pp-x' }, `${g.n}×`),
          h('div', { class: 'pp-main' }, h('div', { class: 'pp-t' }, g.label, g.owners && !machine ? h('span', { class: 'pp-tag' }, `under ${g.owners} session${g.owners > 1 ? 's' : ''}`) : null),
            machine ? h('div', { class: 'pp-track' }, bar) : null),
          h('span', { class: 'pp-n', title: 'in RAM now · committed (incl. paged out) · CPU' }, machine && d.kind === 'cpu' ? `${g.cpu}%` : mb(g.mem),
            machine ? '' : h('span', { class: 'dim' }, ` · ${mb(g.priv)} · ${g.cpu}%`)));
        if (machine || !g.items.length) return h('div', { class: 'pp-grp' }, sum);
        return h('details', { class: 'pp-grp' }, sum,
          h('div', { class: 'pp-items' }, g.items.map(i => h('div', { class: 'pp-item' },
            h('span', { class: 'mono' }, `pid ${i.pid}`),
            h('span', {}, i.born ? `started ${dur(now - i.born)} ago` : ''),
            i.kids != null ? h('span', { class: 'dim' }, `${i.kids} child process${i.kids === 1 ? '' : 'es'}`) : h('span', {}),
            h('span', { class: 'pp-n' }, mb(i.mem), h('span', { class: 'dim' }, ` · ${mb(i.priv)} · ${i.cpu}%`))))));
      }));
  }

  dispose() { this.close(); clearInterval(this.timer); clearTimeout(this.pending); this.off(); this.el.remove(); }
}

const order = (s: string) => ['needs-you', 'working', 'waiting', 'idle'].indexOf(s);
