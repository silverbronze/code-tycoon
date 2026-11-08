import { api, live, type Health } from './api';
import { h, put, ago } from './util';

const FACTOR_HINT: Record<string, string> = {
  shipping: 'Open Insights: what landed this week', tidiness: 'Open Review: uncommitted files, riskiest first',
  efficiency: 'Open Insights: cost per landed task', harmony: 'Open alerts: collisions between sessions', stability: 'Colour the city by churn',
};
const tone = (s: number | null) => s == null ? '' : s >= 70 ? 'good' : s >= 50 ? 'warn' : 'bad';

// The city's health score in the top bar: a chip with the score and the commit
// streak; a click opens what the score is made of, its trend, milestones and the
// cosmetics they unlock. A factor opens the view that explains it (onFactor).
export class HealthChip {
  el: HTMLButtonElement;
  private data: Health | null = null;
  private pop: HTMLDivElement | null = null;
  private timer = 0;
  private pending = 0;
  private off: () => void;

  constructor(private pid: string, private opts: { onData?: (d: Health, prev: Health | null) => void; onFactor?: (key: string) => void } = {}) {
    this.el = h('button', { class: 'chip health', title: 'City health: how well work in this project lands', onclick: (e: Event) => { e.stopPropagation(); this.toggle(); } }, 'Health …');
    this.refresh();
    this.timer = window.setInterval(() => this.refresh(), 60e3);
    // a commit or a finished task can move the score; wait for the burst to settle
    this.off = live.on(m => { if (m.type === 'session' && !this.pending) this.pending = window.setTimeout(() => { this.pending = 0; this.refresh(); }, 15e3); });
  }

  async refresh() {
    let d: Health;
    try { d = await api.health(this.pid); } catch { return; }
    const prev = this.data;
    this.data = d;
    this.opts.onData?.(d, prev);
    this.el.className = 'chip health ' + tone(d.score);
    this.el.innerHTML = '';
    put(this.el, h('i', { class: 'hl-dot' }), 'Health ', h('b', {}, d.score ?? '–'),
      d.streak.current ? h('span', { class: 'hl-streak', title: `${d.streak.current} days in a row with a commit` }, ` · ${d.streak.current}d streak`) : null);
    if (this.pop) this.fill();
  }

  private toggle() {
    if (this.pop) return this.close();
    this.pop = h('div', { class: 'pulse-pop health-pop glass', onclick: (e: Event) => e.stopPropagation(), onpointerdown: (e: Event) => e.stopPropagation(), onwheel: (e: Event) => e.stopPropagation() });
    document.body.appendChild(this.pop);
    this.el.classList.add('sel');
    this.fill();
    document.addEventListener('pointerdown', this.outside, true);
    document.addEventListener('keydown', this.esc);
  }

  private outside = (e: Event) => { if (this.pop && !this.pop.contains(e.target as Node) && !this.el.contains(e.target as Node)) this.close(); };
  private esc = (e: KeyboardEvent) => { if (e.key === 'Escape') this.close(); };

  private close() {
    this.pop?.remove(); this.pop = null;
    this.el.classList.remove('sel');
    document.removeEventListener('pointerdown', this.outside, true);
    document.removeEventListener('keydown', this.esc);
  }

  private fill() {
    const pop = this.pop, d = this.data;
    if (!pop) return;
    pop.innerHTML = '';
    if (!d) { put(pop, h('div', { class: 'pp-load' }, 'Loading…')); return this.place(); }
    put(pop,
      h('div', { class: 'hl-head' },
        h('div', { class: 'hl-score ' + tone(d.score) }, d.score ?? '–'),
        h('div', {}, h('div', { class: 'hl-grade' }, d.grade ? `City is ${d.grade}` : 'Not enough activity to score'),
          h('div', { class: 'pp-sub' }, `Last 7 days · updated ${ago(d.at)}`))),
      d.tip ? h('div', { class: 'pp-note' }, d.tip) : null,
      h('div', { class: 'pp-h' }, 'What the score is made of'),
      d.factors.map(f => h('div', { class: 'pp-row hl-factor' + (f.score == null ? ' off' : '') + (this.opts.onFactor ? ' link' : ''),
        title: this.opts.onFactor ? FACTOR_HINT[f.key] : '', onclick: () => { if (this.opts.onFactor) { this.close(); this.opts.onFactor(f.key); } } },
        h('div', { class: 'pp-main' },
          h('div', { class: 'pp-t' }, f.label, h('span', { class: 'dim' }, ` · ${Math.round(f.weight * 100)}%`)),
          h('div', { class: 'pp-sub' }, f.value),
          h('div', { class: 'pp-track' }, h('span', { class: 'pp-bar hl-' + tone(f.score), style: { width: `${f.score ?? 0}%` } }))),
        h('span', { class: 'pp-n' }, f.score ?? '–'))),
      d.history.length > 1 ? [h('div', { class: 'pp-h' }, 'Last 30 days'), this.spark(d.history)] : null,
      h('div', { class: 'pp-h' }, `Commit streak: ${d.streak.current} ${d.streak.current === 1 ? 'day' : 'days'}` + (d.streak.current && !d.streak.today ? ' (commit today to keep it)' : '') + ` · best ${d.streak.best}`),
      h('div', { class: 'hl-miles' }, d.milestones.map(m => h('div', { class: 'hl-mile' + (m.got ? ' got' : ''), title: m.got ? 'Unlocked' : `${m.have} of ${m.need}` },
        h('span', { class: 'hl-medal' }, m.got ? '★' : '☆'), h('span', {}, m.label),
        m.got ? null : h('span', { class: 'pp-track hl-mtrack' }, h('span', { class: 'pp-bar', style: { width: `${Math.round(m.progress * 100)}%` } }))))),
      d.cosmetics?.length ? [h('div', { class: 'pp-h' }, 'Cosmetics (never change the score)'),
        h('div', { class: 'hl-cos' }, d.cosmetics.map(c => h('button', { class: 'hl-cosb' + (c.on ? ' on' : '') + (c.unlocked ? '' : ' locked'), disabled: !c.unlocked,
          title: c.unlocked ? (c.on ? 'Shown in the city. Click to hide' : 'Hidden. Click to show') : `Unlocks with: ${c.unlock}`,
          onclick: async () => { c.on = !c.on; this.fill(); await api.cosmetic(this.pid, c.key, c.on); this.opts.onData?.(d, d); } },
          h('i', {}), c.label, c.unlocked ? null : h('span', { class: 'dim' }, ` · ${c.unlock}`))))] : null);
    this.place();
  }

  // one bar per recorded day, 0-100
  private spark(hist: Health['history']) {
    const wrap = h('div', { class: 'hl-spark' });
    for (const x of hist) put(wrap, h('i', { class: 'hl-' + tone(x.score), style: { height: `${Math.max(4, x.score)}%` }, title: `${x.day}: ${x.score}` }));
    return wrap;
  }

  private place() {
    if (!this.pop) return;
    const a = this.el.getBoundingClientRect(), w = Math.min(380, window.innerWidth - 24);
    const left = Math.max(12, Math.min(window.innerWidth - w - 12, a.left));
    Object.assign(this.pop.style, { left: `${left}px`, top: `${a.bottom + 8}px`, width: `${w}px`, maxHeight: `${window.innerHeight - a.bottom - 24}px` });
  }

  dispose() {
    clearInterval(this.timer); clearTimeout(this.pending);
    this.off();
    this.close();
  }
}
