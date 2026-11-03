import './coach.css';
import { api, type Coach, type CoachSession, type CoachKind, type CoachRoll, type CoachHabit } from './api';
import { h, put, ago, dur, money } from './util';

// How sessions use context and cache, for the whole machine or one project, with
// the sessions behind each number and what would have saved money in each.
const LABEL: Record<string, string> = { 'cold-resume': 'Cold resume', 'big-context': 'Large context', 'topic-switch': 'New topic, old session',
  compacted: 'Auto-compacted', 'model-switch': 'Model switched', 'cache-reset': 'Cache rebuilt', 'model-fit': 'Pricier model than needed',
  'big-results': 'Bulky tool output', 'heavy-start': 'Heavy start', compact: 'Compaction' };
const MARK: Record<string, string> = { 'cold-resume': '#111111', compact: '#5c5c5c', 'topic-switch': '#9a9a9a', 'model-switch': '#d2232a', 'cache-reset': '#d2232a', 'big-results': '#bdbdbd' };
const BIG = 150e3;
const k = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n));
const pct = (x: number) => `${Math.round(x * 100)}%`;
const PRICE_NOTE = 'API list prices. A subscription is not billed per token, but the same tokens count against its usage limits.';

export class CoachPanel {
  el = h('section', { class: 'coach' });
  private days = 7;
  private pid: string | null = null;
  private kind: CoachKind | null = null;
  private open: string | null = null;
  private data: Coach | null = null;
  private details = new Map<string, CoachSession>();
  private timer = 0;
  private loading = false;

  constructor() { this.load(); this.timer = window.setInterval(() => this.load(), 60e3); }

  private async load() {
    if (this.loading) return;
    this.loading = true;
    try { this.data = await api.coach(this.days, this.pid); this.details.clear(); } catch {} finally { this.loading = false; }
    this.render();
  }
  private set(p: Partial<{ days: number; pid: string | null; kind: CoachKind | null }>) {
    const refetch = (p.days != null && p.days !== this.days) || (p.pid !== undefined && p.pid !== this.pid);
    Object.assign(this, p);
    if (p.pid !== undefined) { this.kind = null; this.open = null; }
    if (refetch) { this.data = null; this.render(); this.load(); } else this.render();
  }

  render() {
    const d = this.data;
    this.el.innerHTML = '';
    const head = h('div', { class: 'co-head' },
      h('div', {}, h('h2', { class: 'ov-h' }, 'Working with Claude'),
        h('p', { class: 'co-sub' }, 'How your sessions use context and the prompt cache, and what a different habit would have saved.')),
      h('div', { class: 'co-ctl' },
        seg([['7 days', 7], ['30 days', 30]], this.days, v => this.set({ days: v }))));
    if (!d) return put(this.el, head, h('div', { class: 'co-empty' }, 'Reading sessions…'));
    const t = d.totals;
    const proj = this.pid ? d.projects.find(p => p.id === this.pid) : null;
    put(this.el, head,
      h('div', { class: 'co-scope' },
        h('button', { class: 'co-chip' + (!this.pid ? ' on' : ''), onclick: () => this.set({ pid: null }) }, 'All projects'),
        ...(this.pid && !proj ? [h('button', { class: 'co-chip on' }, this.pid)] : []),
        ...(this.pid ? [] : d.projects).map(p => h('button', { class: 'co-chip', onclick: () => this.set({ pid: p.id }) }, p.name)),
        proj ? h('b', { class: 'co-chip on' }, proj.name) : null,
        this.pid ? h('a', { class: 'co-go', href: '#/p/' + encodeURIComponent(this.pid), title: 'Open this project as a city' }, 'Open the city →') : null),
      t.sessions ? this.tiles(t) : h('div', { class: 'co-empty' }, `No API calls in tracked projects in the last ${this.days} days.`),
      t.sessions ? h('div', { class: 'co-cols' + (this.pid ? ' one' : '') }, this.habits(t, d), this.pid ? null : this.projects(d)) : null,
      t.sessions ? this.sessions(d) : null,
      h('p', { class: 'co-note' }, `Amounts are ${PRICE_NOTE} Only tracked projects are measured.`));
    return this.el;
  }

  private tiles(t: CoachRoll) {
    const tile = (v: string, label: string, tip: string, bad = false) => h('div', { class: 'co-tile' + (bad ? ' bad' : ''), title: tip }, h('b', {}, v), h('span', {}, label));
    return h('div', { class: 'co-tiles' },
      tile(money(t.cost), `spent · ${t.sessions} sessions`, `${t.calls} API calls. ${PRICE_NOTE}`),
      tile(pct(t.hit), 'cache hit rate', 'Share of input tokens read from the prompt cache (cheap) rather than sent or written again', t.hit < 0.85),
      tile(money(t.coldLost), `lost to ${t.coldResumes} cold resumes`, 'Extra paid for writing a whole context again after the cache expired, against reading it from cache', t.coldResumes > 0),
      tile(pct(t.bigShare), 'calls in large-context sessions', `Share of API calls in sessions that went past ${k(BIG)} tokens; the peak was ${k(t.peak)}`, t.bigShare > 0.5),
      tile(String(t.compactions), 'compactions', 'Times a session was compacted, automatically or with /compact', t.compactions > 0),
      tile(k(t.base), 'tokens before your first word', `Median starting context: system prompt, tools, MCP servers, CLAUDE.md, memory. Each 10k trimmed saves about ${money(t.per10k)} over this period.`, t.base > 120e3),
      tile(money(t.save), 'could have been saved', 'Sum of the estimates below. They overlap a little (a large context also makes a cold resume dearer), so read it as an upper bound.'));
  }

  private habits(t: CoachRoll, d: Coach) {
    const list = t.habits.filter(x => x.save > 0.01 || x.kind === 'compacted');
    return h('div', { class: 'co-box' },
      h('div', { class: 'co-bh' }, 'Habits that cost the most', this.kind ? h('button', { class: 'co-clear', onclick: () => this.set({ kind: null }) }, 'show all sessions') : null),
      list.length ? list.map(x => {
        const on = this.kind === x.kind;
        return h('div', { class: 'co-habit' + (on ? ' on' : ''), onclick: () => this.set({ kind: on ? null : x.kind }),
          title: on ? 'Collapse' : 'Show where this happened and how to avoid it', 'aria-expanded': String(on) },
          h('div', { class: 'co-hrow' }, h('i', { class: 'co-caret' }, on ? '▾' : '▸'), h('b', {}, x.label), h('span', { class: 'co-n' }, `${x.sessions} session${x.sessions === 1 ? '' : 's'}`),
            h('span', { class: 'co-save' }, x.save > 0.01 ? '≈' + money(x.save) : '')),
          h('p', {}, x.habit),
          on ? this.habitDetail(x, d) : null);
      }) : h('div', { class: 'co-empty' }, 'Nothing worth changing. Sessions stay small and hit the cache.'));
  }

  // One habit opened: each time it happened (session, the prompts involved, what went wrong,
  // what would have been better), then the steps that keep it from happening again.
  private habitDetail(x: CoachHabit, d: Coach) {
    const MAX = 8;
    const hits = d.sessions.flatMap(s => s.findings.filter(f => f.kind === x.kind).map(f => ({ s, f }))).sort((a, b) => b.f.save - a.f.save || b.f.ts - a.f.ts);
    const goTo = (sid: string) => {
      this.open = sid; this.render();
      this.el.querySelector(`[data-sid="${CSS.escape(sid)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    return h('div', { class: 'co-hd', onclick: (e: Event) => e.stopPropagation() },
      h('div', { class: 'co-hsub' }, 'Where it happened'),
      hits.length ? h('div', { class: 'co-finds' }, ...hits.slice(0, MAX).map(({ s, f }) => h('div', { class: 'co-find' },
        h('div', { class: 'co-fh' },
          h('button', { class: 'co-slink', onclick: () => goTo(s.id), title: 'Open this session below' }, s.title),
          this.pid ? null : h('span', { class: 'co-n' }, s.project || ''),
          h('span', { class: 'co-age' }, ago(f.ts)),
          f.save > 0.01 ? h('span', { class: 'co-save' }, '≈' + money(f.save)) : null),
        f.tasks?.length ? h('div', { class: 'co-tasks' }, h('span', {}, f.tasks.length === 1 ? 'Task' : 'Tasks'),
          ...f.tasks.slice(0, 3).map(n => h('q', {}, n)), f.tasks.length > 3 ? h('span', {}, `+${f.tasks.length - 3} more`) : null) : null,
        h('p', {}, h('b', { class: 'co-prob' }, 'Problem: '), f.text),
        h('p', { class: 'co-fix' }, h('b', {}, 'Better: '), f.fix)))) :
        h('div', { class: 'co-empty' }, 'The sessions behind this are older or smaller than the ones listed below.'),
      hits.length > MAX ? h('div', { class: 'co-n co-more' }, `${hits.length - MAX} more in the sessions below`) : null,
      x.steps?.length ? h('div', { class: 'co-steps' }, h('div', { class: 'co-hsub' }, 'Next time'),
        h('ul', {}, ...x.steps.map(st => h('li', {}, st)))) : null);
  }

  private projects(d: Coach) {
    return h('div', { class: 'co-box' },
      h('div', { class: 'co-bh' }, 'By project'),
      h('div', { class: 'co-ptab' },
        h('div', { class: 'co-pr hd' }, h('span', {}, 'Project'), h('span', {}, 'Spent'), h('span', {}, 'Cache'), h('span', {}, 'Start'), h('span', {}, 'Could save'), h('span', {}, 'Top habit')),
        ...d.projects.map(p => h('div', { class: 'co-pr', onclick: () => this.set({ pid: p.id }), title: 'Analytics for this project' },
          h('span', { class: 'co-pn' }, p.name), h('span', {}, money(p.cost)), h('span', {}, pct(p.hit)), h('span', {}, k(p.base)),
          h('span', { class: 'co-save' }, money(p.save)), h('span', { class: 'co-ph' }, p.habits.find(x => x.save > 0.01)?.label || '—')))));
  }

  private sessions(d: Coach) {
    const list = d.sessions.filter(s => !this.kind || s.findings.some(f => f.kind === this.kind));
    return h('div', { class: 'co-box' },
      h('div', { class: 'co-bh' }, this.kind ? `Sessions with “${LABEL[this.kind]}”` : 'Sessions to learn from', h('span', { class: 'co-n' }, 'most to gain first')),
      list.length ? list.map(s => this.sessionRow(s)) : h('div', { class: 'co-empty' }, 'No sessions.'));
  }

  private sessionRow(s: CoachSession) {
    const open = this.open === s.id;
    const kinds = [...new Set(s.findings.map(f => f.kind))];
    const row = h('div', { class: 'co-srow' + (open ? ' open' : ''), onclick: () => { this.open = open ? null : s.id; this.render(); } },
      h('span', { class: 'co-sp' }, s.project || '—'),
      h('span', { class: 'co-st' }, s.title),
      h('span', { class: 'co-kinds' }, ...kinds.slice(0, 3).map(x => h('i', { class: 'co-k', style: '--k:' + (MARK[x] || '#8c8c8c') }, LABEL[x])), kinds.length > 3 ? h('i', { class: 'co-k more' }, '+' + (kinds.length - 3)) : null),
      h('span', { class: 'co-num', title: 'Spent (API-equivalent)' }, money(s.cost)),
      h('span', { class: 'co-num', title: 'Peak context' }, k(s.peak)),
      h('span', { class: 'co-save co-num', title: 'Estimated saving with the habits below' }, s.save > 0.01 ? '≈' + money(s.save) : ''),
      h('span', { class: 'co-age' }, ago(s.last)));
    return h('div', { class: 'co-sess', 'data-sid': s.id }, row, open ? this.detail(s) : null);
  }

  private detail(s: CoachSession) {
    const box = h('div', { class: 'co-detail' });
    const full = this.details.get(s.id);
    if (!full) {
      box.append(h('div', { class: 'co-empty' }, 'Loading…'));
      api.coachSession(s.id).then(d => { if (!('error' in d)) { this.details.set(s.id, d); if (this.open === s.id) this.render(); } }).catch(() => {});
      return box;
    }
    const tracked = !!s.pid;
    put(box,
      h('div', { class: 'co-facts' },
        h('span', {}, h('b', {}, full.calls), ' API calls'), h('span', {}, h('b', {}, full.tasks), ' prompts'),
        h('span', {}, h('b', {}, pct(full.hit)), ' cache hits'), h('span', {}, 'started at ', h('b', {}, k(full.base))),
        h('span', {}, 'peak ', h('b', {}, k(full.peak))), full.agents ? h('span', {}, h('b', {}, full.agents), ` subagents (${money(full.agentCost)})`) : null,
        h('span', {}, 'cache lasts ', h('b', {}, dur(full.ttl))), h('span', {}, h('b', {}, full.model)),
        tracked ? h('a', { class: 'co-go', href: '#/p/' + encodeURIComponent(s.pid) + '/s/' + encodeURIComponent(s.id), onclick: (e: Event) => e.stopPropagation() }, 'Follow in the city →') : null),
      full.curve?.length ? chart(full) : null,
      full.findings.length ? h('div', { class: 'co-finds' }, ...full.findings.map(f => h('div', { class: 'co-find' },
        h('div', { class: 'co-fh' }, h('i', { class: 'co-k', style: '--k:' + (MARK[f.kind] || '#8c8c8c') }, LABEL[f.kind]), h('span', { class: 'co-age' }, ago(f.ts)),
          f.save > 0.01 ? h('span', { class: 'co-save' }, '≈' + money(f.save)) : null),
        h('p', {}, f.text), h('p', { class: 'co-fix' }, h('b', {}, 'Better: '), f.fix)))) : h('div', { class: 'co-empty' }, 'This session used context and cache well.'));
    return box;
  }

  dispose() { clearInterval(this.timer); }
}

function seg<T>(opts: [string, T][], cur: T, on: (v: T) => void) {
  return h('div', { class: 'co-seg' }, ...opts.map(([l, v]) => h('button', { class: v === cur ? 'on' : '', onclick: () => on(v) }, l)));
}

// Context size per API call, with the moments the cache started over or the session was compacted.
function chart(s: CoachSession) {
  const pts = s.curve!, marks = s.marks || [];
  const W = innerWidth < 640 ? 380 : 760, H = 170, L = 44, R = 12, T = 12, B = 24; // a narrow viewBox on phones keeps the labels legible
  const max = Math.max(BIG * 1.15, ...pts.map(p => p[1])) * 1.05;
  const x = (i: number) => L + (pts.length < 2 ? 0 : i / (pts.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  const idxOf = (ts: number) => { const i = pts.findIndex(p => p[0] >= ts); return i < 0 ? pts.length - 1 : i; };
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'co-chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Context size over ${s.calls} API calls, peak ${k(s.peak)} tokens`);
  const ticks = [0, max / 2, max].map(v => Math.round(v / 50e3) * 50e3).filter((v, i, a) => a.indexOf(v) === i);
  let inner = ticks.map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="co-grid"/><text x="${L - 6}" y="${y(v) + 3}" class="co-ax" text-anchor="end">${k(v)}</text>`).join('');
  inner += `<line x1="${L}" x2="${W - R}" y1="${y(BIG)}" y2="${y(BIG)}" class="co-thr"/><text x="${W - R}" y="${y(BIG) - 4}" class="co-ax" text-anchor="end">${k(BIG)}: consider a fresh session</text>`;
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
  inner += `<polyline points="${x(0)},${y(0)} ${line} ${x(pts.length - 1)},${y(0)}" class="co-area"/><polyline points="${line}" class="co-line"/>`;
  for (const m of marks) {
    const i = idxOf(m.ts), c = MARK[m.kind] || '#8c8c8c';
    inner += `<line x1="${x(i)}" x2="${x(i)}" y1="${T}" y2="${H - B}" stroke="${c}" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.8"/><circle cx="${x(i)}" cy="${y(pts[i][1])}" r="4.5" fill="${c}" stroke="#ffffff" stroke-width="2"/>`;
  }
  inner += `<text x="${L}" y="${H - 6}" class="co-ax">first call</text><text x="${W - R}" y="${H - 6}" class="co-ax" text-anchor="end">latest · ${s.calls} calls</text>`;
  inner += `<line class="co-cross" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/><rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" class="co-hit"/>`;
  svg.innerHTML = inner;
  const tip = h('div', { class: 'co-tip' });
  const wrap = h('div', { class: 'co-cw' }, svg, tip);
  const cross = svg.querySelector('.co-cross') as SVGLineElement, hit = svg.querySelector('.co-hit') as SVGRectElement;
  hit.addEventListener('mousemove', (e: MouseEvent) => {
    const r = svg.getBoundingClientRect(), sx = (e.clientX - r.left) / r.width * W;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round((sx - L) / (W - L - R) * (pts.length - 1))));
    const near = marks.filter(m => idxOf(m.ts) === i);
    cross.setAttribute('x1', String(x(i))); cross.setAttribute('x2', String(x(i))); cross.setAttribute('visibility', 'visible');
    tip.innerHTML = '';
    put(tip, h('b', {}, k(pts[i][1]) + ' tokens'), h('span', {}, new Date(pts[i][0]).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })),
      ...near.map(m => h('span', { style: { color: MARK[m.kind] } }, LABEL[m.kind] + (m.pre ? ` ${k(m.pre)} → ${k(m.post || 0)}` : ''))));
    tip.style.display = 'flex';
    const px = x(i) / W * r.width;
    tip.style.left = Math.min(r.width - 170, Math.max(0, px + 10)) + 'px';
  });
  hit.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; });
  const kinds = [...new Set(marks.map(m => m.kind))];
  return h('div', {}, wrap, h('div', { class: 'co-legend' },
    h('span', {}, h('i', { style: { background: 'var(--cyan)' } }), 'context per API call'),
    ...kinds.map(kd => h('span', {}, h('i', { style: { background: MARK[kd] || '#8c8c8c' } }), LABEL[kd]))));
}
