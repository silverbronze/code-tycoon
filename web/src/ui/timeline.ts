import type { Timeline as TL, City } from '../api';

const KIND_COLORS: Record<string, string> = {
  write: '#ffab4a', read: '#56d6ff', search: '#56d6ff', touch: '#3f8fb0', cmd: '#6f7a96', remote: '#a37bff', skill: '#a37bff',
  spawn: '#ff6fd8', prompt: '#ffffff', ask: '#ff5470', other: '#47506a',
};
const STACK = ['write', 'read', 'cmd', 'remote', 'other'];
const groupOf = (k: string) => k === 'search' || k === 'touch' ? 'read' : k === 'skill' ? 'remote' : STACK.includes(k) ? k : 'other';
const COST_COLOR = '#4dffa6';
const DAY = 86400e3;

type Commit = City['commits'][number];
export interface TimelineOpts {
  data: TL; city: City; colors: string[];
  onSeek: (t: number, final: boolean) => void;
  onHover: (info: { session: number; task: number | null } | null, x: number, y: number) => void;
  onHoverCommit: (c: Commit | null, x: number, y: number) => void;
  onPickSession: (s: number) => void;
  onPickCommit: (c: Commit) => void;
  onView: (v0: number, v1: number) => void;
}

export class TimelineView {
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  t0: number; t1: number; v0: number; v1: number;
  cursor: number;
  liveEdge: number;
  lanes: number[] = [];   // session -> lane in the current view, -1 when outside it
  laneCount = 1;
  focusSession: number | null = null;
  mode: 'actions' | 'cost' = 'actions';
  private packedFor = '';
  private drag = false;
  private dirty = true;
  private dpr = Math.min(devicePixelRatio || 1, 2);
  private tasksBySession: number[][] = [];

  constructor(parent: HTMLElement, public o: TimelineOpts) {
    this.el = document.createElement('div');
    this.el.className = 'timeline-canvas';
    this.canvas = document.createElement('canvas');
    this.el.appendChild(this.canvas);
    parent.appendChild(this.el);
    this.ctx = this.canvas.getContext('2d')!;
    const ev = o.data.events.ts;
    const ss = o.data.sessions;
    // the city starts at its first commit or first action, whichever came first: replay begins on empty ground
    this.t0 = Math.min(ev[0] ?? Date.now(), o.city.project.t0 ?? Infinity, ...ss.map(s => s.first)) - 60e3;
    this.liveEdge = Math.max(Date.now(), ev[ev.length - 1] ?? 0);
    this.t1 = this.liveEdge + 60e3;
    // open on the last day: weeks of history squeezed into one strip read as noise
    this.v0 = Math.max(this.t0, this.t1 - DAY); this.v1 = this.t1;
    this.cursor = this.t1;
    this.indexTasks();
    new ResizeObserver(() => { this.resize(); }).observe(this.el);
    this.bind();
    const loop = () => { if (this.dirty) this.draw(); requestAnimationFrame(loop); };
    loop();
  }

  indexTasks() {
    const sIdx = new Map(this.o.data.sessions.map((s, i) => [s.id, i]));
    this.tasksBySession = [];
    this.o.data.tasks.forEach((t, i) => { const si = sIdx.get(t.s); if (si != null) (this.tasksBySession[si] ||= []).push(i); });
  }

  // Lanes for the sessions inside the view only, so a busy month does not
  // squeeze today's three sessions into hairlines.
  packLanes() {
    const ends: number[] = [];
    const ss = this.o.data.sessions;
    const order = ss.map((s, i) => i).filter(i => ss[i].first <= this.v1 && Math.max(ss[i].last, ss[i].first + 60e3) >= this.v0).sort((a, b) => ss[a].first - ss[b].first);
    this.lanes = new Array(ss.length).fill(-1);
    const gap = (this.v1 - this.v0) * 0.004;
    for (const i of order) {
      let lane = ends.findIndex(e => e < ss[i].first - gap);
      if (lane < 0) { lane = ends.length; ends.push(0); }
      ends[lane] = Math.max(ss[i].last, ss[i].first + 60e3);
      this.lanes[i] = lane;
    }
    this.laneCount = Math.max(1, ends.length);
    this.packedFor = `${this.v0}|${this.v1}|${ss.length}`;
  }

  extend(now: number) { if (now > this.liveEdge) { const atEnd = this.v1 >= this.t1 - 1; this.liveEdge = now; this.t1 = now + 60e3; if (atEnd) { this.v0 += this.t1 - this.v1; this.v1 = this.t1; } this.dirty = true; } }
  setCursor(t: number) { this.cursor = t; this.dirty = true; }
  invalidate() { this.packedFor = ''; this.dirty = true; }
  setMode(m: 'actions' | 'cost') { this.mode = m; this.dirty = true; }

  resize() {
    const r = this.el.getBoundingClientRect();
    this.canvas.width = r.width * this.dpr; this.canvas.height = r.height * this.dpr;
    this.canvas.style.width = r.width + 'px'; this.canvas.style.height = r.height + 'px';
    this.dirty = true;
  }

  private x(t: number) { return (t - this.v0) / (this.v1 - this.v0) * this.canvas.width / this.dpr; }
  private tAt(x: number) { return this.v0 + x / (this.canvas.width / this.dpr) * (this.v1 - this.v0); }

  private get histH() { return 46; }
  private get laneTop() { return this.histH + 18; }
  private viewChanged() { this.dirty = true; this.o.onView(this.v0, this.v1); }

  private commitAt(x: number, y: number): Commit | null {
    if (y < this.histH || y > this.laneTop) return null;
    let best: Commit | null = null, bd = 6;
    for (const c of this.o.city.commits) { const d = Math.abs(this.x(c.ts) - x); if (d < bd) { bd = d; best = c; } }
    return best;
  }

  private bind() {
    const c = this.canvas;
    const scrub = (e: PointerEvent, final: boolean) => {
      const r = c.getBoundingClientRect();
      const t = Math.max(this.t0, Math.min(this.t1, this.tAt(e.clientX - r.left)));
      this.cursor = t; this.dirty = true; this.o.onSeek(t, final);
    };
    c.addEventListener('pointerdown', e => {
      const r = c.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const cm = this.commitAt(x, y);
      if (cm) { this.o.onPickCommit(cm); return; }
      if (y > this.laneTop && e.detail === 2) { const s = this.sessionAt(x, y); if (s != null) { this.o.onPickSession(s); return; } }
      this.drag = true; c.setPointerCapture(e.pointerId); scrub(e, false);
    });
    c.addEventListener('pointermove', e => {
      if (this.drag) { scrub(e, false); return; }
      const r = c.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const cm = this.commitAt(x, y);
      c.style.cursor = cm ? 'pointer' : 'crosshair';
      this.o.onHoverCommit(cm, e.clientX, e.clientY);
      if (cm) { this.o.onHover(null, 0, 0); return; }
      const s = y > this.laneTop ? this.sessionAt(x, y) : null;
      if (s == null) { this.o.onHover(null, 0, 0); return; }
      const t = this.tAt(x);
      const tasks = this.tasksBySession[s] || [];
      let task: number | null = null;
      for (const ti of tasks) { const tk = this.o.data.tasks[ti]; if (tk.ts <= t + (this.v1 - this.v0) * 0.004) task = ti; }
      this.o.onHover({ session: s, task }, e.clientX, e.clientY);
    });
    c.addEventListener('pointerleave', () => { this.o.onHover(null, 0, 0); this.o.onHoverCommit(null, 0, 0); });
    c.addEventListener('pointerup', e => { if (this.drag) { this.drag = false; scrub(e, true); } });
    c.addEventListener('wheel', e => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
        const span = this.v1 - this.v0, d = (e.deltaX || e.deltaY) / r.width * span;
        const nv0 = Math.max(this.t0, Math.min(this.t1 - span, this.v0 + d));
        this.v0 = nv0; this.v1 = nv0 + span;
      } else {
        const t = this.tAt(e.clientX - r.left);
        const f = Math.exp(e.deltaY * 0.0015);
        const span = Math.max(60e3, Math.min(this.t1 - this.t0, (this.v1 - this.v0) * f));
        const k = (t - this.v0) / (this.v1 - this.v0);
        this.v0 = Math.max(this.t0, t - span * k); this.v1 = Math.min(this.t1, this.v0 + span);
        this.v0 = Math.max(this.t0, this.v1 - span);
      }
      this.viewChanged();
    }, { passive: false });
    c.addEventListener('dblclick', e => { if ((e.clientY - c.getBoundingClientRect().top) <= this.laneTop) { this.v0 = this.t0; this.v1 = this.t1; this.viewChanged(); } });
  }

  zoomTo(a: number, b: number) { const pad = (b - a) * 0.08 + 60e3; this.v0 = Math.max(this.t0, a - pad); this.v1 = Math.min(this.t1, b + pad); this.viewChanged(); }
  showSpan(span: number) { this.v1 = this.t1; this.v0 = Math.max(this.t0, this.t1 - span); this.viewChanged(); }

  private laneH() { return Math.max(2, Math.min(12, (this.canvas.height / this.dpr - this.laneTop - 6) / this.laneCount)); }
  private lanesShown() { return Math.max(1, Math.floor((this.canvas.height / this.dpr - this.laneTop - 6) / this.laneH())); }
  private sessionAt(x: number, y: number) {
    const lane = Math.floor((y - this.laneTop) / this.laneH());
    const shown = this.lanesShown();
    const t = this.tAt(x);
    const slack = (this.v1 - this.v0) * 0.003;
    const ss = this.o.data.sessions;
    for (let i = ss.length - 1; i >= 0; i--) if (this.lanes[i] >= 0 && this.lanes[i] % shown === lane && ss[i].first - slack <= t && Math.max(ss[i].last, ss[i].first + 60e3) + slack >= t) return i;
    return null;
  }

  draw() {
    this.dirty = false;
    if (this.packedFor !== `${this.v0}|${this.v1}|${this.o.data.sessions.length}`) this.packLanes();
    const { ctx } = this;
    const W = this.canvas.width / this.dpr, H = this.canvas.height / this.dpr;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const d = this.o.data;
    const span = this.v1 - this.v0;

    // nights (20:00-07:00) behind everything, while single days are readable
    if (span < 12 * DAY) {
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      const day = new Date(this.v0); day.setHours(0, 0, 0, 0);
      for (let t = day.getTime() - DAY; t < this.v1; t += DAY) {
        const nightA = new Date(t); nightA.setHours(20, 0, 0, 0);
        const nightB = new Date(t + DAY); nightB.setHours(7, 0, 0, 0);
        const xa = Math.max(0, this.x(nightA.getTime())), xb = Math.min(W, this.x(nightB.getTime()));
        if (xb > xa) ctx.fillRect(xa, 0, xb - xa, H);
      }
      ctx.fillStyle = 'rgba(160,180,230,0.16)';
      for (let t = day.getTime(); t < this.v1; t += DAY) { const mx = this.x(t); if (mx > 0) ctx.fillRect(mx, 0, 1, H); }
    }

    // histogram: actions stacked by kind, or API-equivalent cost by task start
    const bins = Math.max(40, Math.floor(W / 3));
    const bw = W / bins;
    if (this.mode === 'actions') {
      const counts = STACK.map(() => new Float32Array(bins));
      const ev = d.events;
      let lo = 0, hi = ev.ts.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (ev.ts[m] < this.v0) lo = m + 1; else hi = m; }
      for (let i = lo; i < ev.ts.length && ev.ts[i] <= this.v1; i++) {
        const b = Math.floor((ev.ts[i] - this.v0) / span * bins);
        if (b >= 0 && b < bins) counts[STACK.indexOf(groupOf(d.kinds[ev.k[i]]))][b]++;
      }
      let max = 1;
      for (let b = 0; b < bins; b++) { let s = 0; for (const c of counts) s += c[b]; max = Math.max(max, s); }
      for (let b = 0; b < bins; b++) {
        let y = this.histH;
        for (let k = 0; k < STACK.length; k++) {
          const v = counts[k][b]; if (!v) continue;
          const h = Math.sqrt(v / max) * (this.histH - 4);
          ctx.fillStyle = KIND_COLORS[STACK[k]];
          ctx.globalAlpha = 0.85;
          ctx.fillRect(b * bw, y - h, Math.max(1, bw - 0.6), h);
          y -= h;
        }
      }
    } else {
      const cost = new Float32Array(bins);
      let total = 0;
      for (const t of d.tasks) { if (t.ts < this.v0 || t.ts > this.v1 || !t.cost) continue; const b = Math.floor((t.ts - this.v0) / span * bins); if (b >= 0 && b < bins) { cost[b] += t.cost; total += t.cost; } }
      const max = Math.max(0.01, ...cost);
      ctx.fillStyle = COST_COLOR; ctx.globalAlpha = 0.8;
      for (let b = 0; b < bins; b++) if (cost[b]) { const h = Math.sqrt(cost[b] / max) * (this.histH - 4); ctx.fillRect(b * bw, this.histH - h, Math.max(1, bw - 0.6), h); }
      ctx.globalAlpha = 1;
      ctx.font = '10px "JetBrains Mono", monospace'; ctx.fillStyle = '#9fe8c4';
      ctx.fillText(`$${total.toFixed(total >= 100 ? 0 : 2)} in view · peak bar $${max.toFixed(2)} (API-equiv.)`, 6, 11);
    }
    ctx.globalAlpha = 1;

    // time axis
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(0, this.histH + 1, W, 16);
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillStyle = '#7d869c';
    const ticks = niceTicks(this.v0, this.v1, Math.floor(W / 110));
    for (const t of ticks.list) {
      const x = this.x(t);
      ctx.fillRect(x, this.histH + 1, 1, 4);
      ctx.fillText(fmtTick(t, ticks.step), x + 3, this.histH + 13);
    }
    // commits
    ctx.fillStyle = '#e7f36b';
    for (const c of this.o.city.commits) {
      if (c.ts < this.v0 || c.ts > this.v1) continue;
      const x = this.x(c.ts);
      ctx.beginPath(); ctx.moveTo(x, this.histH + 3); ctx.lineTo(x + 4, this.histH + 8); ctx.lineTo(x, this.histH + 13); ctx.lineTo(x - 4, this.histH + 8); ctx.fill();
    }

    // session lanes; when they do not fit, lanes wrap and overlap
    const lh = this.laneH(), shown = this.lanesShown();
    d.sessions.forEach((s, i) => {
      if (this.lanes[i] < 0) return;
      const a = Math.max(s.first, this.v0), b = Math.min(Math.max(s.last, s.first + 60e3), this.v1);
      const y = this.laneTop + (this.lanes[i] % shown) * lh;
      const x0 = this.x(a), x1 = Math.max(x0 + 2, this.x(b));
      const dim = this.focusSession != null && this.focusSession !== i;
      ctx.globalAlpha = dim ? 0.18 : 0.55;
      ctx.fillStyle = this.o.colors[i];
      ctx.fillRect(x0, y + 1, x1 - x0, Math.max(1, lh - 2));
      ctx.globalAlpha = dim ? 0.25 : 1;
      for (const ti of this.tasksBySession[i] || []) {
        const t = d.tasks[ti];
        if (t.ts < this.v0 || t.ts > this.v1) continue;
        ctx.fillRect(this.x(t.ts), y, 1.5, lh);
      }
    });
    ctx.globalAlpha = 1;

    // cursor + live edge
    const cx = this.x(this.cursor);
    ctx.fillStyle = 'rgba(124,240,255,0.12)';
    ctx.fillRect(cx - 6, 0, 12, H);
    ctx.fillStyle = '#7cf0ff';
    ctx.fillRect(cx - 0.75, 0, 1.5, H);
    const le = this.x(this.liveEdge);
    if (le > 0 && le < W) {
      ctx.fillStyle = 'rgba(255,84,112,0.6)'; ctx.fillRect(le, 0, 1, H);
      ctx.fillStyle = '#ff8095'; ctx.font = '600 9.5px "JetBrains Mono", monospace';
      ctx.fillText('NOW', Math.min(le + 3, W - 24), this.histH + 13);
    }
  }
}

function niceTicks(a: number, b: number, n: number) {
  const steps = [60e3, 5 * 60e3, 15 * 60e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];
  const step = steps.find(s => (b - a) / s <= Math.max(2, n)) || steps[steps.length - 1];
  const off = new Date().getTimezoneOffset() * 60e3;
  const list: number[] = [];
  for (let t = Math.ceil((a - off) / step) * step + off; t <= b; t += step) list.push(t);
  return { list, step };
}
function fmtTick(t: number, step: number) {
  const d = new Date(t);
  if (step >= DAY) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (d.getHours() === 0 && d.getMinutes() === 0) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
export { KIND_COLORS };
