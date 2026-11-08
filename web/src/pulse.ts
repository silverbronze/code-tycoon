import { api, live, type PulseT, type PulseDetail, type ProcBreakdown, type IdleScan, type IdleProc, type StopResult } from './api';
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
  private flash = ''; // what the last stop did, shown until the popover closes

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
    const ram = sys.memUsed / sys.memTotal;
    if (sys.procs) {
      const { node, claude } = sys.procs;
      // worth a look once idle sessions hold real memory; red when the machine is short of it
      const idle = p.idle && p.idle.mem >= IDLE_WORTH ? p.idle : null;
      const many = claude.n > p.open * 3 + 4;
      out.push({ key: 'node', value: node.n, label: 'node processes', short: 'node', cls: '', title: `Node.js processes on this machine: ${mb(node.mem)} RAM, ${node.cpu}% CPU` });
      out.push({ key: 'claude', value: claude.n, label: `Claude processes, ${mb(claude.mem)} RAM` + (idle ? `, ${mb(idle.mem)} idle` : ''),
        short: `Claude procs · ${mb(claude.mem)}` + (idle ? ` · ${mb(idle.mem)} idle` : ''), cls: idle ? (ram >= 0.85 ? 'alarm' : 'warn') : many ? 'warn' : '',
        title: `Claude Code processes (CLI, extension, subagents): ${mb(claude.mem)} RAM, ${claude.cpu}% CPU.` +
          (idle ? ` ${idle.n} of them belong to sessions nobody has used for ${IDLE_HOURS}+ hours and hold ${mb(idle.mem)}. Click to stop them.`
            : many ? ' Far more than the open sessions; some may be leftovers from closed windows.' : '') });
    }
    if (sys.cpu != null) out.push({ key: 'cpu', value: `${sys.cpu}%`, label: 'CPU', cls: sys.cpu >= 85 ? 'alarm' : sys.cpu >= 60 ? 'warn' : '', title: `Whole machine (${sys.cores} cores), last few seconds` });
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
    this.load(key);
  }

  private load(key: string) {
    const pop = this.pop;
    if (!pop) return;
    api.pulseDetail(key).then(d => { if (this.pop === pop) { pop.innerHTML = ''; put(pop, this.body(d)); this.place(this.el.querySelector(`[data-k="${key}"]`)); } })
      .catch(() => { if (this.pop === pop) pop.textContent = 'Could not load this.'; });
  }

  private outside = (e: Event) => { if (this.pop && !this.pop.contains(e.target as Node) && !this.el.contains(e.target as Node)) this.close(); };
  private esc = (e: KeyboardEvent) => { if (e.key === 'Escape') this.close(); };

  private close() {
    this.pop?.remove(); this.pop = null; this.openKey = null; this.flash = '';
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
    const idle = d.idle?.items.length ? d.idle : null;
    return h('div', {},
      this.flash ? h('div', { class: 'pp-note ok' }, this.flash) : null,
      idle ? this.idleList(idle, now) : null,
      h('div', { class: 'pp-h' }, head),
      cli > open + 2 && !idle ? h('div', { class: 'pp-note' }, `${cli} Claude Code CLI processes but ${open} open sessions. The extra ones are usually sessions whose panel or window was closed while the process kept running; the oldest ones below are the likely leftovers.`) : null,
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

  // Sessions whose process (with its MCP servers and shells) outlived its use. "Stop all"
  // takes only sessions; a stray helper with no session is stopped one at a time.
  private idleList(idle: IdleScan, now: number) {
    const sess = idle.items.filter(i => i.kind === 'session');
    const sum = (xs: IdleProc[]) => xs.reduce((a, i) => a + i.mem, 0);
    const stop = async (items: IdleProc[], btn: HTMLButtonElement) => {
      btn.disabled = true; btn.textContent = 'Stopping…';
      let r: StopResult;
      try { r = await api.stopProcs(items.map(i => i.pid)); } catch { btn.textContent = 'Could not stop'; return; }
      this.flash = `Stopped ${r.stopped.length} process${r.stopped.length === 1 ? '' : 'es'}, freed ${mb(r.freed)}.`
        + (r.failed.length ? ` ${r.failed.length} would not stop.` : '') + (r.skipped.length ? ` ${r.skipped.length} became active and were left running.` : '');
      this.refresh();
      if (this.openKey) this.load(this.openKey);
    };
    // the first click arms the button, the second one stops
    const confirmBtn = (label: string, items: IdleProc[], cls = '') => {
      const b = h('button', { class: 'pp-stop' + cls, title: 'Ends the process and everything it started. The session stays in history; resume it from the Claude panel.' }, label);
      let armed = false;
      b.onclick = (e: Event) => {
        e.stopPropagation();
        if (!armed) { armed = true; b.classList.add('armed'); b.textContent = items.length > 1 ? `Stop ${items.length}? Click again` : 'Sure?'; setTimeout(() => { if (armed && !b.disabled) { armed = false; b.classList.remove('armed'); b.textContent = label; } }, 4000); return; }
        stop(items, b);
      };
      return b;
    };
    const why = (i: IdleProc) => i.reason === 'ended' ? `session ended ${ago(i.seen, now)}, process kept running`
      : i.reason === 'unseen' ? `no session since it started ${ago(i.born, now)}`
      : i.reason === 'orphan' ? `its session is gone; running since ${ago(i.born, now)}`
      : `last active ${ago(i.seen, now)}`;
    return h('div', { class: 'pp-idle' },
      h('div', { class: 'pp-idle-head' },
        h('div', {}, h('b', {}, `${idle.n} idle, holding ${mb(idle.mem)}`),
          h('div', { class: 'pp-sub' }, `Claude Code processes nobody has used for ${IDLE_HOURS}+ hours, with the MCP servers and shells they started.`)),
        sess.length > 1 ? confirmBtn(`Stop all · free ${mb(sum(sess))}`, sess, ' all') : null),
      idle.items.map(i => h('div', { class: 'pp-row' },
        h('div', { class: 'pp-main' },
          h('div', { class: 'pp-t' }, i.session?.project ? h('span', { class: 'pp-proj' }, i.session.project) : null, ' ',
            i.session?.title || i.label || (i.session ? 'Untitled session' : 'Claude Code panel')),
          h('div', { class: 'pp-sub' }, why(i), i.helpers ? ` · +${i.helpers} helper${i.helpers === 1 ? '' : 's'}` : '',
            i.helperNames.length ? h('span', { class: 'dim' }, ` (${i.helperNames.join(', ')})`) : null, i.ver ? h('span', { class: 'dim' }, ` · v${i.ver}`) : null)),
        h('span', { class: 'pp-n' }, mb(i.mem)),
        confirmBtn('Stop', [i]))));
  }

  dispose() { this.close(); clearInterval(this.timer); clearTimeout(this.pending); this.off(); this.el.remove(); }
}

// matches IDLE_AFTER in server/idle.mjs
const IDLE_HOURS = 2;
const IDLE_WORTH = 300 * 1024 ** 2;
const order = (s: string) => ['needs-you', 'working', 'waiting', 'idle'].indexOf(s);
