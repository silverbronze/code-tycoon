import { api, live, type PulseT, type PulseDetail, type ProcBreakdown, type IdleScan, type IdleProc, type StopResult } from './api';
import { h, put, ago, dur } from './util';

const GB = 1024 ** 3;
const gb = (n: number) => (n / GB).toFixed(n < 10 * GB ? 1 : 0);
const mb = (n: number) => n >= GB ? gb(n) + ' GB' : Math.round(n / 1024 ** 2) + ' MB';
const STATE: Record<string, string> = { 'needs-you': 'Needs you', working: 'Working', waiting: 'Your turn', idle: 'Idle' };

// short: the label in the strip over the city, which has less room.
// The overview ('big') splits items into a headline (work) and a row of meters
// (machine and plan): meter = its label there, frac = bar fill 0..1, chip = an
// extra action-looking note (idle memory).
type Item = { key: string; value: string | number; label: string; short?: string; cls: string; title: string; meter?: string; mval?: string; frac?: number; chip?: string };
const WORK = new Set(['sessions', 'needs', 'tracked']);

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
  // idle-list state that outlives a rebuild of the popover (all reset when it closes)
  private gone = new Set<number>();     // pids stopped here; a stale rescan must not bring them back
  private stopping = new Set<number>(); // pids with a stop request in flight
  private armed: { key: string; until: number } | null = null; // 'all' or a pid, armed by the first tap
  private freed = 0;
  private nStopped = 0;

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
    const its = this.items(p);
    const btn = (it: Item, base: string, ...kids: Parameters<typeof h>[2][]) => h('button', {
      class: base + ' tap' + (it.cls ? ' ' + it.cls : '') + (this.openKey === it.key ? ' sel' : ''),
      title: it.title, 'data-k': it.key, onclick: (e: Event) => { e.stopPropagation(); this.toggle(it.key, e.currentTarget as HTMLElement); } }, ...kids);
    if (this.variant === 'strip') put(this.el, ...its.map(it => btn(it, 'pu', h('b', {}, it.value), ' ', it.short ?? it.label)));
    else put(this.el,
      // the numbers you act on, as one line
      h('div', { class: 'pu-head' }, its.filter(it => WORK.has(it.key)).map((it, i) => [
        i ? h('span', { class: 'pu-sep' }, '·') : null,
        btn(it, 'pu-w' + (it.value ? '' : ' zero'), h('b', {}, it.value), ' ', it.label)])),
      // the machine and the plan, as meters on a fixed grid
      h('div', { class: 'pu-meters' }, its.filter(it => it.meter).map(it => btn(it, 'pu-m',
        h('span', { class: 'pu-ml' }, it.meter),
        it.frac != null ? h('span', { class: 'pu-track' }, h('i', { style: { width: `${Math.max(1, Math.min(100, it.frac * 100))}%` } })) : null,
        h('b', {}, it.mval ?? it.value),
        it.chip ? h('span', { class: 'pu-chip' }, it.chip) : null))));
    if (this.pop && this.openKey) this.place(this.el.querySelector(`[data-k="${this.openKey}"]`));
  }

  private items(p: PulseT): Item[] {
    const sys = p.system;
    const out: Item[] = [
      { key: 'sessions', value: p.open, label: 'sessions open', short: 'open', cls: p.open ? 'on' : '', title: 'Claude Code sessions open right now, all projects' },
      { key: 'needs', value: p.needs, label: 'waiting on you', cls: p.needs ? 'alarm' : '', title: 'Sessions waiting for your answer or permission' },
      { key: 'tracked', value: p.tracked, label: p.tracked === 1 ? 'project tracked' : 'projects tracked', short: 'tracked', cls: '', title: 'Projects drawn as cities' },
    ];
    // the account's 5-hour and weekly plan limits; the model-scoped weekly ones live in the popover
    for (const l of p.limits?.limits || []) {
      if (!l.short) continue;
      const session = l.kind === 'session';
      out.push({ key: 'limits', value: `${l.percent}%`, label: session ? '5-hour limit used' : 'weekly limit used', short: session ? '5h limit' : 'week limit',
        meter: session ? '5-hour limit' : 'Weekly limit', frac: l.percent / 100, cls: limitCls(l.percent), title: `${l.label}: ${l.percent}% of your plan's limit used` + (l.resets ? `, resets ${resetsAt(l.resets)}` : '')
          + (p.limits!.stale ? ' (last known; Claude Code renews its login the next time it runs)' : '') });
    }
    const ram = sys.memUsed / sys.memTotal;
    if (sys.procs) {
      const { node, claude } = sys.procs;
      // worth a look once idle sessions hold real memory; red when the machine is short of it
      const idle = p.idle && p.idle.mem >= IDLE_WORTH ? p.idle : null;
      const many = claude.n > p.open * 3 + 4;
      out.push({ key: 'node', value: node.n, label: 'node processes', short: 'node', cls: '', title: `Node.js processes on this machine: ${mb(node.mem)} RAM, ${node.cpu}% CPU` });
      out.push({ key: 'claude', value: claude.n, label: `Claude processes, ${mb(claude.mem)} RAM` + (idle ? `, ${mb(idle.mem)} idle` : ''),
        short: `Claude procs · ${mb(claude.mem)}` + (idle ? ` · ${mb(idle.mem)} idle` : ''),
        meter: 'Claude', mval: `${claude.n} procs · ${mb(claude.mem)}`, chip: idle ? `${mb(idle.mem)} idle · free` : undefined, cls: idle ? (ram >= 0.85 ? 'alarm' : 'warn') : many ? 'warn' : '',
        title: `Claude Code processes (CLI, extension, subagents): ${mb(claude.mem)} RAM, ${claude.cpu}% CPU.` +
          (idle ? ` ${idle.n} of them belong to sessions nobody has used for ${IDLE_HOURS}+ hours and hold ${mb(idle.mem)}. Click to stop them.`
            : many ? ' Far more than the open sessions; some may be leftovers from closed windows.' : '') });
    }
    if (sys.cpu != null) out.push({ key: 'cpu', value: `${sys.cpu}%`, label: 'CPU', meter: 'CPU', frac: sys.cpu / 100, cls: sys.cpu >= 85 ? 'alarm' : sys.cpu >= 60 ? 'warn' : '', title: `Whole machine (${sys.cores} cores), last few seconds` });
    out.push({ key: 'ram', value: `${gb(sys.memUsed)}/${gb(sys.memTotal)} GB`, label: 'RAM in use', short: 'RAM', meter: 'RAM', frac: ram, cls: ram >= 0.9 ? 'alarm' : ram >= 0.75 ? 'warn' : '', title: `Whole machine: ${Math.round(ram * 100)}% of RAM in use` });
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
    this.gone.clear(); this.armed = null; this.freed = 0; this.nStopped = 0; // `stopping` empties itself as requests return
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
    if (d.kind === 'limits') {
      const plan = d.plan ? d.plan[0].toUpperCase() + d.plan.slice(1) + (d.tier && /max_(\d+x)/.test(d.tier) ? ` (Max ${d.tier.match(/max_(\d+x)/)![1]})` : '') : null;
      return h('div', { class: 'pp-limits' },
        h('div', { class: 'pp-h' }, 'Plan limits of the Claude account signed in to Claude Code' + (plan ? ` · ${plan}` : '')),
        d.error ? h('div', { class: 'pp-note' + (d.limits.length ? ' dim' : '') }, (d.limits.length ? 'Showing the last known numbers: ' : 'Could not read the limits: ') + d.error) : null,
        d.limits.map(l => h('div', { class: 'pp-row' },
          h('div', { class: 'pp-main' }, h('div', { class: 'pp-t' }, l.label),
            h('div', { class: 'pp-track' }, h('i', { class: 'pp-bar ' + limitCls(l.percent), style: { width: `${Math.max(1, Math.min(100, l.percent))}%` } }))),
          h('span', { class: 'pp-n' }, `${l.percent}%`, l.resets ? h('span', { class: 'dim' }, ` · resets ${resetsAt(l.resets)}`) : null))),
        d.extra ? h('div', { class: 'pp-note dim' }, `Extra usage is on: ${d.extra.used ?? 0} of ${d.extra.limit ?? '∞'} ${d.extra.currency || ''} this month.`) : null,
        d.at ? h('div', { class: 'pp-sub', style: { padding: '6px 6px 0' } }, `Checked ${ago(d.at)} · refreshed every minute`) : null);
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
            h('span', { class: 'pp-n' }, mb(i.mem), h('span', { class: 'dim' }, ` · ${mb(i.priv)} · ${i.cpu}%`)),
            machine ? null : h('span', { class: 'pp-ses', title: i.session ? `${i.session.project ? i.session.project + ' · ' : ''}${i.session.title || i.session.id}` : '' },
              i.session ? [i.session.project ? h('span', { class: 'dim' }, i.session.project + ' · ') : null, i.session.title || h('span', { class: 'dim' }, i.session.id.slice(0, 8))]
                : h('span', { class: 'dim' }, i.owner || d.kind === 'claude' ? 'session not identified' : 'not started by a Claude Code session'))))));
      }),
      // the overview has no node meter: those are mostly MCP servers the sessions started
      d.kind === 'claude' && this.variant === 'big' && this.last?.system.procs ? h('div', { class: 'pp-row link pp-more', onclick: () => { this.openKey = 'node'; this.load('node'); } },
        h('div', { class: 'pp-main' }, `${this.last.system.procs.node.n} node processes, mostly MCP servers and tools these sessions started`),
        h('span', { class: 'pp-n' }, `${mb(this.last.system.procs.node.mem)} →`)) : null);
  }

  // Sessions whose process (with its MCP servers and shells) outlived its use. "Stop all"
  // takes only sessions; a stray helper with no session is stopped one at a time.
  //
  // The list redraws itself from local state: a stopped row leaves at once, "Stop all" always
  // means the rows still shown, and an armed button stays armed when the slow rescan after a
  // stop lands and the popover is rebuilt (before, that rebuild reset the armed "Stop all"
  // under the finger and it took another two taps; a failed request left a dead button).
  private idleList(idle: IdleScan, now: number) {
    const box = h('div', { class: 'pp-idle' });
    const sum = (xs: IdleProc[]) => xs.reduce((a, i) => a + i.mem, 0);
    const why = (i: IdleProc) => i.reason === 'ended' ? `session ended ${ago(i.seen, now)}, process kept running`
      : i.reason === 'unseen' ? `no session since it started ${ago(i.born, now)}`
      : i.reason === 'orphan' ? `its session is gone; running since ${ago(i.born, now)}`
      : `last active ${ago(i.seen, now)}`;
    const draw = () => {
      const items = idle.items.filter(i => !this.gone.has(i.pid));
      const allSess = items.filter(i => i.kind === 'session');
      const sess = allSess.filter(i => !this.stopping.has(i.pid));
      if (!items.length) { box.replaceChildren(); box.style.display = 'none'; return; }
      // the first click arms the button, the second one stops
      const confirmBtn = (key: string, label: string, pick: () => IdleProc[], cls = '') => {
        const busy = key === 'all' ? !sess.length : this.stopping.has(Number(key));
        const n = pick().length;
        const armed = !busy && this.armed?.key === key && this.armed.until > Date.now();
        const b = h('button', { class: 'pp-stop' + cls + (armed ? ' armed' : ''), title: 'Ends the process and everything it started. The session stays in history; resume it from the Claude panel.' },
          busy ? 'Stopping…' : armed ? (n > 1 ? `Stop ${n}? Tap again` : 'Sure?') : label) as HTMLButtonElement;
        b.disabled = busy;
        b.onclick = (e: Event) => {
          e.stopPropagation();
          const targets = pick();
          if (!targets.length) return;
          if (!(this.armed?.key === key && this.armed.until > Date.now())) {
            this.armed = { key, until: Date.now() + 4000 };
            setTimeout(() => { if (this.armed?.key === key && this.armed.until <= Date.now()) { this.armed = null; draw(); } }, 4050);
            return draw();
          }
          this.armed = null;
          stop(targets);
        };
        return b;
      };
      box.style.display = '';
      box.replaceChildren(
        h('div', { class: 'pp-idle-head' },
          h('div', {}, h('b', {}, `${items.length} idle, holding ${mb(sum(items))}`),
            h('div', { class: 'pp-sub' }, `Claude Code processes nobody has used for ${IDLE_HOURS}+ hours, with the MCP servers and shells they started.`)),
          allSess.length > 1 ? confirmBtn('all', `Stop all · free ${mb(sum(sess))}`, () => items.filter(i => i.kind === 'session' && !this.stopping.has(i.pid) && !this.gone.has(i.pid)), ' all') : null),
        ...items.map(i => h('div', { class: 'pp-row' },
          h('div', { class: 'pp-main' },
            h('div', { class: 'pp-t' }, i.session?.project ? h('span', { class: 'pp-proj' }, i.session.project) : null, ' ',
              i.session?.title || i.label || (i.session ? 'Untitled session' : 'Claude Code panel')),
            h('div', { class: 'pp-sub' }, why(i), i.helpers ? ` · +${i.helpers} helper${i.helpers === 1 ? '' : 's'}` : '',
              i.helperNames.length ? h('span', { class: 'dim' }, ` (${i.helperNames.join(', ')})`) : null, i.ver ? h('span', { class: 'dim' }, ` · v${i.ver}`) : null)),
          h('span', { class: 'pp-n' }, mb(i.mem)),
          confirmBtn(String(i.pid), 'Stop', () => this.gone.has(i.pid) || this.stopping.has(i.pid) ? [] : [i]))));
    };
    const stop = async (items: IdleProc[]) => {
      const pids = items.map(i => i.pid);
      pids.forEach(p => this.stopping.add(p));
      draw();
      let r: StopResult | null = null;
      try { r = await api.stopProcs(pids); } catch {}
      pids.forEach(p => this.stopping.delete(p));
      const note = this.pop?.querySelector('.pp-note.ok');
      if (!r) this.flash = `Could not reach Code Tycoon to stop ${pids.length === 1 ? 'that process' : `${pids.length} processes`}. Try again.`;
      else {
        // stopped, or already gone: either way not worth showing again
        for (const p of r.stopped) this.gone.add(p);
        for (const p of pids) if (!r.failed.includes(p) && !r.skipped.includes(p)) this.gone.add(p);
        this.freed += r.freed; this.nStopped += r.stopped.length;
        this.flash = `Stopped ${this.nStopped} process${this.nStopped === 1 ? '' : 'es'}, freed ${mb(this.freed)}.`
          + (r.failed.length ? ` ${r.failed.length} would not stop.` : '') + (r.skipped.length ? ` ${r.skipped.length} became active and were left running.` : '');
      }
      if (note) note.textContent = this.flash; else if (this.pop) box.before(h('div', { class: 'pp-note ok' }, this.flash));
      draw();
      this.refresh();
      // rebuild from a fresh scan only when no other stop is still running, or it would wipe its "Stopping…"
      if (this.openKey && !this.stopping.size) this.load(this.openKey);
    };
    draw();
    return box;
  }

  dispose() { this.close(); clearInterval(this.timer); clearTimeout(this.pending); this.off(); this.el.remove(); }
}

// matches IDLE_AFTER in server/idle.mjs
const IDLE_HOURS = 2;
const IDLE_WORTH = 300 * 1024 ** 2;
const order = (s: string) => ['needs-you', 'working', 'waiting', 'idle'].indexOf(s);
const limitCls = (pct: number) => pct >= 90 ? 'alarm' : pct >= 75 ? 'warn' : '';
// "in 2h 10m (14:30)" today, "Sun 05:00" further out
function resetsAt(ts: number) {
  const d = new Date(ts), ms = ts - Date.now();
  const clock = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (ms <= 0) return 'now';
  return ms < 24 * 3600e3 ? `in ${dur(ms)} (${clock})` : `${d.toLocaleDateString([], { weekday: 'short' })} ${clock}`;
}
