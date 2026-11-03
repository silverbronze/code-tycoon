import type { City } from './api';
import { StreetGrid, type Pt } from './city/route';
import { h } from './util';

// The schematic layer: the project as an architecture diagram for developers. It
// does not copy the city's floor plan; it lays itself out by these rules.
//
//  1. Top to bottom is dependency order. Districts that import more than they are
//     imported sit higher, foundations lower, and outside systems fill the bottom
//     band grouped by kind. Import arrows mostly point down.
//  2. Every card has the same size. Size never stands for a number; numbers are
//     written on the card.
//  3. Text sits inside its card at a readable screen size, or is not drawn. Zoomed
//     out, each district is one block listing its main modules; zoomed in, every
//     module is a card. Nothing overlaps.
//  4. The overview wires districts, not modules: one connector per pair of
//     districts and kind of tie, with the count on it, and only the strongest few.
//     Hovering a district shows all of its connectors.
//  5. Hovering a card previews its own wiring; everything it doesn't touch steps back.
//  6. Clicking a card floats it out of the map, like a leaf on water, into its own
//     diagram (an island) below the overview: the module in the middle, what
//     imports it on the left, what it imports and the systems it names on the
//     right, every neighbour a full card under its district (a long list folds each
//     district into one card that opens on click). Zooming never collapses an
//     island. The map is still there above, drag up to reach it, and it draws
//     the same ties for the active island's module. Clicking a neighbour floats it
//     out of the island into its own, hung right under it and tied to that card;
//     the island it came from keeps its module. × closes an island and the ones
//     opened from it, "clear all" closes every one. The wheel zooms everywhere, always.
//  7. Colour means the kind of tie: imports amber (arrow at what is imported),
//     code naming a system violet (arrow at the system), changed together cyan
//     dashed. District hue marks only the district header and its cards' edge.

type Ref = [number, number];
type Kind = 'module' | 'store' | 'host' | 'service' | 'web' | 'local';
type EdgeType = 'imp' | 'ref' | 'work';
interface SNode { ref: Ref; kind: Kind; title: string; sub: string; meta: string; pri: number; born: number; box: number; x: number; y: number }
interface SBox { name: string; hue: number; born: number; outside: boolean; members: number[]; cols: number; x: number; y: number; w: number; h: number }
interface SEdge { a: number; b: number; type: EdgeType; w: number; born: number; dir: number } // dir 1: a -> b, -1: b -> a, 0 none, 2 both
interface Bundle { a: number; b: number; type: EdgeType; ab: number; ba: number; n: number; born: number; top: boolean; pts: Pt[] | null }
interface Pulse { a: number; b: number; t: number; color: string }
interface View { cx: number; cy: number; s: number }
interface FCard { i: number; x: number; y: number; type: EdgeType; out: boolean; inn: boolean; left: boolean; g?: { key: string; box: number; n: number; names: string } } // g: a folded district, i is -1
interface FHead { x: number; y: number; t: string; c: string; sec: boolean }
interface Focus { i: number; me: R; cards: FCard[]; heads: FHead[]; x0: number; y0: number; x1: number; y1: number } // laid out around the module at (0, 0)
// A focus diagram floated out below the map. oy is where it belongs, oyD where it is drawn (it eases there);
// t0 and from drive the drift in: when it started, and the map point the module floated out of.
// parent: the island it was opened from (a neighbour clicked there), hung right under it and tied to that card.
interface Island { id: number; f: Focus; opened: Set<string>; oy: number; oyD: number; t0: number; from: Pt | null; parent: number }

const COL: Record<EdgeType, string> = { imp: '#ffb547', ref: '#b48cff', work: '#5ee6ff' };
const NODE: Record<Kind, { stroke: string; fill: string; label: string; group: string }> = {
  module: { stroke: '', fill: '#0d131f', label: 'Module', group: '' },
  store: { stroke: '#e0a050', fill: '#17120b', label: 'Data store', group: '' },
  host: { stroke: '#3d8fd6', fill: '#0a1624', label: 'Server / site', group: 'Servers & sites' },
  service: { stroke: '#9a6cff', fill: '#130f22', label: 'Service (MCP / tool)', group: 'Services' },
  web: { stroke: '#3fc1b0', fill: '#0a1a1a', label: 'Web research', group: 'Web research' },
  local: { stroke: '#7a8499', fill: '#11141b', label: 'Local folder', group: 'Local folders' },
};
const UI = "'Space Grotesk', system-ui, sans-serif", MONO = "'JetBrains Mono', Consolas, monospace";
// layout, in world units (one unit is a pixel at zoom 1)
const CW = 176, CH = 46, GAP = 14, PAD = 14, HEAD = 36, DGAP = 72, G = 8; // G: routing cell
const TOP: Record<EdgeType, number> = { imp: 10, ref: 6, work: 8 }; // overview connectors per kind
const FOCUS_WORK = 12; // changed-together ties drawn for a focused card
const FOCUS_CARDS = 14; // more ties than this and a hovered card is wired to districts instead of cards
const FOCUS_FOLD = 8; // a focus section longer than this folds its districts
const ISLE_GAP = 200, ISLE_HEAD = 56, ISLE_PAD = 28; // islands: space between them and the map, header and margin
const DRIFT = 1.3; // seconds a module takes to float out to its island
// text tiers by zoom (rule 3)
const FULL = 0.86, TITLE = 0.45;

export interface SchematicHost {
  onPick(r: Ref | null): void;
  onHover(r: Ref | null, x: number, y: number): void;
}

export class Schematic {
  el: HTMLDivElement;
  private canvas: HTMLCanvasElement; private ctx: CanvasRenderingContext2D;
  private nodes: SNode[] = []; private nodeOf = new Map<string, number>();
  private boxes: SBox[] = []; private bandY = 0;
  private edges: SEdge[] = []; private incident: number[][] = [];
  private bundles: Bundle[] = []; private grid: StreetGrid | null = null;
  private view: View = { cx: 0, cy: 0, s: 0.5 };
  private frameRect = { left: 0, top: 0, right: 800, bottom: 600 };
  private show: Record<EdgeType, boolean> = { imp: true, ref: false, work: false }; // overview only: a card shows all its ties
  private hoverFold: FCard | null = null; private hover = -1; private hoverBox = -1; private sel = -1;
  private active = new Map<number, string[]>();
  private pulses: Pulse[] = [];
  private tNow = Infinity;
  private visible = false; private raf = 0; private dirty = true; private fitted = false;
  private legend: HTMLDivElement; private zoomBox: HTMLDivElement;
  private islands: Island[] = []; private activeIs = -1; private hoverIs = -1; private nextId = 1;
  private islandX = 0; private overBottom = 0; // islands hang centred under the map
  private pending: { island: number; from: Pt | null } | null = null; // set around host.onPick: where the click came from
  private hits: { x0: number; y0: number; x1: number; y1: number; fn: () => void }[] = []; // canvas buttons drawn this frame

  constructor(parent: HTMLElement, public city: City, private host: SchematicHost) {
    this.el = h('div', { class: 'schematic' }) as HTMLDivElement;
    this.canvas = h('canvas', {}) as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    const tog = (t: EdgeType, label: string, dash = false) => {
      const b = h('button', { class: 'lg-row' + (this.show[t] ? ' on' : ''), onclick: () => { this.show[t] = !this.show[t]; b.classList.toggle('on', this.show[t]); this.dirty = true; } },
        h('i', { class: 'lg-line' + (dash ? ' dash' : ''), style: { color: COL[t] } }), label);
      return b;
    };
    const shape = (k: Kind) => h('div', { class: 'lg-row static' }, h('i', { class: 'lg-node ' + k }), NODE[k].label);
    this.legend = h('div', { class: 'sch-legend glass' },
      h('div', { class: 'lg-h' }, 'Connections'),
      tog('imp', 'Imports  (→ imported)'), tog('ref', 'Names a system  (→ system)'), tog('work', 'Changed together', true),
      h('div', { class: 'lg-note' }, 'Lines join districts: hover one for all of its ties. Zoom in and click a card to float its connections out below. Scroll to zoom, drag to move.'),
      h('div', { class: 'lg-h' }, 'Cards'),
      shape('module'), shape('store'), shape('host'), shape('service'), shape('web'), shape('local')) as HTMLDivElement;
    this.zoomBox = h('div', { class: 'sch-zoom glass' },
      h('button', { title: 'Zoom in', onclick: () => this.zoomBy(1.4) }, '+'),
      h('button', { title: 'Zoom out', onclick: () => this.zoomBy(1 / 1.4) }, '−'),
      h('button', { title: 'Fit', onclick: () => this.fit() }, '⤢')) as HTMLDivElement;
    this.el.append(this.canvas, this.legend, this.zoomBox);
    this.el.style.display = 'none';
    parent.appendChild(this.el);
    this.build();
    this.bindInput();
    this.ro.observe(this.el);
  }
  private ro = new ResizeObserver(() => this.resize());
  dispose() { this.setVisible(false); this.ro.disconnect(); this.el.remove(); }

  // ------------------------------------------------------------------ model
  private build() {
    const c = this.city;
    // cards
    c.modules.forEach((m, i) => {
      const files = c.files.filter(f => f.m === i), act = files.reduce((s, f) => s + f.w + f.r, 0);
      const dn = c.districts[m.district]?.name ?? '';
      let title = m.title || m.label.split('/').pop() || m.label;
      if (dn && title.endsWith(' · ' + dn)) title = title.slice(0, -3 - dn.length); // the district header already says it
      this.add({ ref: [1, i], kind: m.warehouse ? 'store' : 'module', title, sub: m.id.replace('#wh:', '') || '(root)',
        meta: m.warehouse ? `${m.onDisk || m.files} data files` : `${files.length} files${act ? ` · ${act} AI` : ''}`,
        pri: Math.log2(2 + files.length) + Math.log2(1 + act), born: m.born, box: m.district, x: 0, y: 0 });
    });
    c.externals.forEach((e, i) => this.add({ ref: [3, i], kind: e.type, title: e.label, sub: NODE[e.type].label,
      meta: `${e.n} calls${e.refCount ? ` · in ${e.refCount} files` : ''}`, pri: Math.log2(2 + e.n) + Math.log2(1 + e.refCount),
      born: e.born, box: -1, x: 0, y: 0 }));
    this.incident = this.nodes.map(() => []);

    // ties between cards: an import is an import even when the files also change together
    const dir = new Map<string, number>(); // which way imports go, from the file graph
    for (const [a, b] of c.fileEdges) {
      const ma = c.files[a]?.m, mb = c.files[b]?.m;
      if (ma == null || mb == null || ma === mb) continue;
      const k = Math.min(ma, mb) + '|' + Math.max(ma, mb);
      dir.set(k, (dir.get(k) || 0) | (ma < mb ? 1 : 2));
    }
    for (const l of c.links) {
      const a = this.idx(l.a), b = this.idx(l.b);
      if (a < 0 || b < 0 || a === b) continue;
      const type: EdgeType = l.imp > 0 ? 'imp' : l.ref > 0 ? 'ref' : 'work';
      let d = 0;
      if (type === 'imp' && l.a[0] === 1 && l.b[0] === 1) {
        const bits = dir.get(Math.min(l.a[1], l.b[1]) + '|' + Math.max(l.a[1], l.b[1])) || 0, fwd = l.a[1] < l.b[1] ? 1 : 2;
        d = bits === 3 ? 2 : bits === fwd ? 1 : bits ? -1 : 0;
      } else if (type === 'ref') d = l.b[0] === 3 && l.a[0] !== 3 ? 1 : l.a[0] === 3 && l.b[0] !== 3 ? -1 : 0;
      this.incident[a].push(this.edges.length); this.incident[b].push(this.edges.length);
      this.edges.push({ a, b, type, w: l.w, born: l.born, dir: d });
    }

    // containers: districts, then one group per kind of outside system
    c.districts.forEach(d => this.boxes.push({ name: d.name, hue: d.hue, born: Infinity, outside: false, members: [], cols: 1, x: 0, y: 0, w: 0, h: 0 }));
    const group = new Map<Kind, number>();
    this.nodes.forEach((n, i) => {
      if (n.box < 0) {
        if (!group.has(n.kind)) { group.set(n.kind, this.boxes.length); this.boxes.push({ name: NODE[n.kind].group, hue: 0, born: Infinity, outside: true, members: [], cols: 1, x: 0, y: 0, w: 0, h: 0 }); }
        n.box = group.get(n.kind)!;
      }
      const bx = this.boxes[n.box]; bx.members.push(i); bx.born = Math.min(bx.born, n.born ?? 0);
    });
    this.boxes.forEach(b => b.members.sort((x, y) => +(this.nodes[x].kind === 'store') - +(this.nodes[y].kind === 'store') || this.nodes[y].pri - this.nodes[x].pri));

    this.bundle();
    this.layout();
  }
  private add(n: SNode) { this.nodeOf.set(n.ref[0] + ':' + n.ref[1], this.nodes.length); this.nodes.push(n); }
  private idx(r: Ref | readonly number[]) { return this.nodeOf.get(r[0] + ':' + r[1]) ?? -1; }

  // Card ties summed per pair of containers (rule 4).
  private bundle() {
    const by = new Map<string, Bundle>();
    for (const e of this.edges) {
      let A = this.nodes[e.a].box, B = this.nodes[e.b].box;
      if (A === B) continue;
      let fwd = e.dir === 1 || e.dir === 2, back = e.dir === -1 || e.dir === 2;
      if (A > B) { [A, B] = [B, A]; [fwd, back] = [back, fwd]; }
      const k = e.type + '|' + A + '|' + B;
      let u = by.get(k);
      if (!u) by.set(k, u = { a: A, b: B, type: e.type, ab: 0, ba: 0, n: 0, born: Infinity, top: false, pts: null });
      u.n++; if (fwd) u.ab++; if (back) u.ba++; u.born = Math.min(u.born, e.born ?? 0);
    }
    this.bundles = [...by.values()];
    for (const t of ['imp', 'ref', 'work'] as EdgeType[])
      this.bundles.filter(u => u.type === t).sort((x, y) => y.n - x.n).slice(0, TOP[t]).forEach(u => u.top = u.n >= 3);
  }

  // Rule 1: containers in rows, importers first; outside systems in a band below.
  private layout() {
    const imp = new Map<number, number>(); // per district: imports out minus imports in
    const tied = new Set<number>();
    for (const u of this.bundles) if (u.type === 'imp') {
      imp.set(u.a, (imp.get(u.a) || 0) + u.ab - u.ba); imp.set(u.b, (imp.get(u.b) || 0) + u.ba - u.ab);
      tied.add(u.a); tied.add(u.b);
    }
    for (const b of this.boxes) {
      const n = b.members.length;
      b.cols = n <= 4 ? 1 : n <= 12 ? 2 : 3;
      const rows = Math.ceil(n / b.cols);
      b.w = b.cols * CW + (b.cols - 1) * GAP + 2 * PAD;
      b.h = HEAD + rows * CH + Math.max(0, rows - 1) * GAP + PAD;
    }
    const code = this.boxes.map((_, i) => i).filter(i => !this.boxes[i].outside && this.boxes[i].members.length);
    code.sort((x, y) => +!tied.has(x) - +!tied.has(y) || (imp.get(y) || 0) - (imp.get(x) || 0) || x - y);
    const outside = this.boxes.map((_, i) => i).filter(i => this.boxes[i].outside);
    const area = [...code, ...outside].reduce((s, i) => s + (this.boxes[i].w + DGAP) * (this.boxes[i].h + DGAP), 0);
    const maxW = Math.max(...this.boxes.map(b => b.w), Math.sqrt(area * 1.7));
    let y = 0;
    const rows = (list: number[]) => {
      let row: number[] = [], w = 0;
      const flush = () => {
        if (!row.length) return;
        let x = -w / 2, rh = 0;
        for (const i of row) { const b = this.boxes[i]; b.x = x; b.y = y; x += b.w + DGAP; rh = Math.max(rh, b.h); }
        y += rh + DGAP; row = []; w = 0;
      };
      for (const i of list) {
        const bw = this.boxes[i].w;
        if (row.length && w + DGAP + bw > maxW) flush();
        w += (row.length ? DGAP : 0) + bw; row.push(i);
      }
      flush();
    };
    rows(code);
    this.bandY = y - DGAP / 2 + 6;
    y += DGAP * 0.4;
    rows(outside);
    for (const b of this.boxes) b.members.forEach((m, k) => {
      const n = this.nodes[m];
      n.x = b.x + PAD + (k % b.cols) * (CW + GAP); n.y = b.y + HEAD + Math.floor(k / b.cols) * (CH + GAP);
    });
    const used = this.boxes.filter(b => b.members.length);
    this.overBottom = Math.max(0, ...used.map(b => b.y + b.h));
    this.islandX = used.length ? (Math.min(...used.map(b => b.x)) + Math.max(...used.map(b => b.x + b.w))) / 2 : 0;
  }

  // District connectors are routed through the gutters the first time they are drawn.
  private routeBundle(u: Bundle) {
    if (!this.grid) this.grid = new StreetGrid(this.boxes.map(b => ({ x0: b.x / G, z0: b.y / G, x1: (b.x + b.w) / G, z1: (b.y + b.h) / G })), 1.6, 4);
    const p = this.grid.route(u.a, u.b, { share: 1.4, turn: 3, near: 0.2 }); // overlaps cost more than detours: every line keeps its own lane
    if (!p) { u.pts = []; return; }
    this.grid.lay(p);
    const pts = this.grid.corners(p).map(q => [q[0] * G, q[1] * G] as Pt);
    u.pts = [...port(this.boxes[u.a], pts[0]), ...pts, ...port(this.boxes[u.b], pts[pts.length - 1]).reverse()];
  }

  // ------------------------------------------------------------------ public
  setVisible(on: boolean) {
    this.visible = on;
    this.el.style.display = on ? '' : 'none';
    if (on) {
      this.resize();
      if (!this.fitted) { this.fit(false); this.fitted = true; }
      this.loop();
    } else cancelAnimationFrame(this.raf);
  }
  // The part of the screen not covered by panels, in client coordinates.
  setFrame(r: { left: number; top: number; right: number; bottom: number }) {
    this.frameRect = r;
    const box = this.el.getBoundingClientRect();
    Object.assign(this.legend.style, { right: `${box.right - r.right + 14}px`, bottom: `${box.bottom - r.bottom + 14}px` });
    Object.assign(this.zoomBox.style, { right: `${box.right - r.right + 14}px`, top: `${r.top - box.top + 14}px` });    this.dirty = true;
  }
  // Keep the camera when the city is rebuilt.
  takeView(from: Schematic) {
    this.view = { ...from.view }; this.fitted = from.fitted;
    for (const old of from.islands) { // the same islands, settled, on the rebuilt map
      const i = this.idx(from.nodes[old.f.i].ref);
      if (i >= 0) this.islands.push({ ...old, f: this.buildFocus(i, old.opened), t0: 0, from: null });
    }
    this.activeIs = this.islands.some(x => x.id === from.activeIs) ? from.activeIs : -1;
    this.sel = this.activeIs >= 0 ? this.islands.find(x => x.id === this.activeIs)!.f.i : -1;
    this.nextId = from.nextId;
    this.stack(); for (const x of this.islands) x.oyD = x.oy;
  }
  // A selection floats its module out to an island, or wakes the island it already has.
  // Nothing selected only lets the map go back to its plain look; islands stay until closed.
  setSelected(r: Ref | null) {
    const i = r ? this.idx(r) : -1, p = this.pending;
    this.hover = this.hoverBox = -1; this.hoverFold = null; this.dirty = true;
    if (i < 0) { this.sel = this.activeIs = -1; return; }
    const cur = this.islands.find(x => x.id === this.activeIs);
    if (!p && cur && cur.f.i === i) return;
    this.sel = i;
    // a click inside an island on its own module just wakes it; on a neighbour, floats that one out under it
    const src = p && p.island >= 0 ? this.islands.find(x => x.id === p.island) : undefined;
    if (src && src.f.i === i) { this.activeIs = src.id; return; }
    const have = this.islands.find(x => x.f.i === i);
    if (have) { this.activeIs = have.id; this.glideTo(have, this.visible); return; }
    const n = this.nodes[i];
    const isl: Island = { id: this.nextId++, f: null!, opened: new Set(), oy: 0, oyD: 0, t0: 0, from: null, parent: src ? src.id : -1 };
    if (src) this.islands.splice(this.islands.indexOf(src) + 1, 0, isl); // right under the island it came from
    else this.islands.unshift(isl); // the newest floats nearest the map
    this.drift(isl, i, p?.from ?? [n.x + CW / 2, n.y + CH / 2], true);
  }
  private drift(isl: Island, i: number, from: Pt | null, fresh: boolean) {
    isl.opened = new Set(); isl.f = this.buildFocus(i, isl.opened);
    isl.from = from; isl.t0 = performance.now(); this.activeIs = isl.id;
    this.stack();
    if (fresh) isl.oyD = isl.oy;
    this.glideTo(isl, this.visible);
  }
  // Islands hang one under another below the map; the ones that move ease there (loop()).
  private stack() {
    let y = this.overBottom + ISLE_GAP;
    for (const isl of this.islands) { isl.oy = y - (isl.f.y0 - ISLE_HEAD); y = isl.oy + isl.f.y1 + ISLE_PAD + ISLE_GAP; }
    this.dirty = true;
  }
  private closeIsland(id: number) {
    const gone = new Set([id]); // with the islands opened from it, and theirs
    for (const x of this.islands) if (gone.has(x.parent)) gone.add(x.id);
    this.islands = this.islands.filter(x => !gone.has(x.id));
    if (gone.has(this.activeIs)) { this.activeIs = -1; this.host.onPick(null); }
    this.stack();
  }
  private clearIslands() {
    this.islands = []; this.activeIs = -1;
    this.host.onPick(null);
    this.fit();
  }
  // The camera floats along with the module, to where its island can be read.
  private glideTo(isl: Island, animate: boolean, dur = DRIFT) {
    const F = isl.f, f = this.frameRect, top = F.y0 - ISLE_HEAD;
    const r = { left: f.left + 24, right: f.right - 24, top: f.top + 64, bottom: f.bottom - 24 };
    let s = this.clampS(Math.min((r.right - r.left) / (F.x1 - F.x0 + 2 * ISLE_PAD), (r.bottom - r.top) / (F.y1 - top + ISLE_PAD), 1.15));
    let cx = this.islandX + (F.x0 + F.x1) / 2, cy = isl.oy + (top + F.y1) / 2;
    if (s < FULL) { s = FULL; cx = this.islandX; cy = isl.oy; } // too big to fit: open readable, on the module
    const dx = (r.left + r.right - f.left - f.right) / 2, dy = (r.top + r.bottom - f.top - f.bottom) / 2;
    this.goTo(cx - dx / s, cy - dy / s, s, animate, dur);
  }
  // Places sessions are working on right now, each with the session's colour.
  setActive(list: { tt: number; ti: number; color: string }[]) {
    this.active.clear();
    for (const w of list) {
      const i = w.tt === 0 ? this.idx([1, this.city.files[w.ti]?.m ?? -1]) : this.idx([w.tt, w.ti]);
      if (i < 0) continue;
      const a = this.active.get(i) || []; if (!a.includes(w.color)) a.push(w.color); this.active.set(i, a);
    }
  }
  // A session moved between two places: a light runs between their cards.
  travel(from: Ref, to: Ref, color: string) {
    if (!this.visible) return;
    const a = this.idx(from), b = this.idx(to);
    if (a < 0 || b < 0 || a === b) return;
    if (this.pulses.length > 60) this.pulses.shift();
    this.pulses.push({ a, b, t: 0, color });
  }
  setTime(t: number) { if (t !== this.tNow) { this.tNow = t; this.dirty = true; } }

  fit(animate = true) {
    if (!this.boxes.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of this.boxes) if (b.members.length) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
    // the clear part of the frame: right of it sits the legend, at the top the status pill
    const f = this.frameRect, lw = this.legend.offsetWidth || 230;
    const r = { left: f.left + 24, right: f.right - lw - 36, top: f.top + 64, bottom: f.bottom - 24 };
    const s = this.clampS(Math.min(Math.max(100, r.right - r.left) / (x1 - x0), Math.max(100, r.bottom - r.top) / (y1 - y0 + 30)));
    const dx = (r.left + r.right - f.left - f.right) / 2, dy = (r.top + r.bottom - f.top - f.bottom) / 2;
    this.goTo((x0 + x1) / 2 - dx / s, (y0 + y1) / 2 - 10 - dy / s, s, animate);
  }
  focus(r: Ref) {
    const i = this.idx(r); if (i < 0) return;
    const n = this.nodes[i];
    this.goTo(n.x + CW / 2, n.y + CH / 2, Math.max(this.view.s, 1.1), true);
  }

  // ------------------------------------------------------------------ view
  private anim: { from: View; to: View; t: number; dur: number } | null = null;
  private clampS(s: number) { return Math.min(4, Math.max(0.08, s)); }
  private goTo(cx: number, cy: number, s: number, animate: boolean, dur = 0.6) {
    const to = { cx, cy, s: this.clampS(s) };
    if (!animate) { this.view = to; this.dirty = true; return; }
    this.anim = { from: { ...this.view }, to, t: 0, dur };
  }
  private zoomBy(f: number, sx?: number, sy?: number) {
    const fr = this.frameRect, box = this.canvas.getBoundingClientRect();
    const px = sx ?? (fr.left + fr.right) / 2 - box.left, py = sy ?? (fr.top + fr.bottom) / 2 - box.top;
    const [wx, wy] = this.toWorld(px, py);
    this.anim = null;
    this.view.s = this.clampS(this.view.s * f);
    const [nx, ny] = this.toWorld(px, py);
    this.view.cx += wx - nx; this.view.cy += wy - ny;
    this.dirty = true;
  }
  private origin() { const box = this.canvas.getBoundingClientRect(), f = this.frameRect; return [(f.left + f.right) / 2 - box.left, (f.top + f.bottom) / 2 - box.top]; }
  private o: number[] = [0, 0]; // origin() for the frame being drawn
  private off: Pt = [0, 0]; // where the island being drawn sits: its points are relative to its module
  private sx(x: number) { return (x + this.off[0] - this.view.cx) * this.view.s + this.o[0]; }
  private sy(y: number) { return (y + this.off[1] - this.view.cy) * this.view.s + this.o[1]; }
  private sp(p: Pt): Pt { return [this.sx(p[0]), this.sy(p[1])]; }
  private toWorld(px: number, py: number): Pt { const [ox, oy] = this.origin(); return [(px - ox) / this.view.s + this.view.cx, (py - oy) / this.view.s + this.view.cy]; }

  private resize() {
    const r = this.el.getBoundingClientRect(), d = devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(r.width * d)); this.canvas.height = Math.max(1, Math.round(r.height * d));
    this.canvas.style.width = r.width + 'px'; this.canvas.style.height = r.height + 'px';
    this.dirty = true;
  }

  private bindInput() {
    const cv = this.canvas;
    let drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
    cv.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, cx: this.view.cx, cy: this.view.cy, moved: false }; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', e => {
      const box = cv.getBoundingClientRect();
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if (drag.moved) { this.anim = null; this.view.cx = drag.cx - dx / this.view.s; this.view.cy = drag.cy - dy / this.view.s; this.dirty = true; this.host.onHover(null, 0, 0); return; }
      }
      const px = e.clientX - box.left, py = e.clientY - box.top;
      const [i, bi, is] = this.pick(px, py);
      const fold = i < 0 ? this.pickFold(px, py) : null;
      if (i !== this.hover || bi !== this.hoverBox || fold !== this.hoverFold || is !== this.hoverIs) { this.hover = i; this.hoverBox = bi; this.hoverFold = fold; this.hoverIs = is; this.dirty = true; }
      cv.style.cursor = i >= 0 || fold || this.hitAt(px, py) ? 'pointer' : '';
      this.host.onHover(i >= 0 ? this.nodes[i].ref : null, e.clientX, e.clientY);
    });
    cv.addEventListener('pointerup', e => {
      const box = cv.getBoundingClientRect(), px = e.clientX - box.left, py = e.clientY - box.top;
      if (drag && !drag.moved) {
        this.host.onHover(null, 0, 0); // the tooltip would sit on top of what floats out
        const btn = this.hitAt(px, py), [i, bi, is] = btn ? [-1, -1, -1] : this.pick(px, py);
        const pickFrom = (island: number, from: Pt | null, r: Ref) => { this.pending = { island, from }; try { this.host.onPick(r); } finally { this.pending = null; } };
        if (btn) btn();
        else if (is >= 0) { // inside an island: open a fold, follow a neighbour, or wake the island
          const isl = this.islands.find(x => x.id === is)!, g = i < 0 ? this.pickFold(px, py)?.g : undefined;
          if (g) { isl.opened.add(g.key); isl.f = this.buildFocus(isl.f.i, isl.opened); this.hoverFold = null; this.stack(); }
          else if (i >= 0 && i !== isl.f.i) { const c = isl.f.cards.find(c => c.i === i)!; pickFrom(is, [this.islandX + c.x + CW / 2, isl.oyD + c.y + CH / 2], this.nodes[i].ref); }
          else pickFrom(is, null, this.nodes[isl.f.i].ref);
        }
        else if (i >= 0) { const n = this.nodes[i]; pickFrom(-1, [n.x + CW / 2, n.y + CH / 2], n.ref); }
        else if (bi >= 0 && !this.tier()) this.zoomToBox(bi); // a district block opens into its cards
        else this.host.onPick(null);
      }
      drag = null;
    });
    cv.addEventListener('pointerleave', () => { if (this.hover >= 0 || this.hoverBox >= 0) { this.hover = this.hoverBox = this.hoverIs = -1; this.dirty = true; } this.host.onHover(null, 0, 0); });
    cv.addEventListener('dblclick', e => {
      const box = cv.getBoundingClientRect(), [i, bi, is] = this.pick(e.clientX - box.left, e.clientY - box.top);
      if (i >= 0 || is >= 0) return;
      if (bi >= 0) this.zoomToBox(bi);
      else this.zoomBy(1.6, e.clientX - box.left, e.clientY - box.top);
    });
    // the wheel always zooms, at the cursor; dragging moves the canvas
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const box = cv.getBoundingClientRect(), k = e.deltaMode === 1 ? 16 : 1;
      this.zoomBy(Math.exp(-e.deltaY * k * 0.0025), e.clientX - box.left, e.clientY - box.top);
    }, { passive: false });
  }

  private hitAt(px: number, py: number) { return this.hits.find(r => px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1)?.fn ?? null; }
  // the folded district card under a screen point, in an island
  private pickFold(px: number, py: number) {
    const is = this.pick(px, py)[2], isl = this.islands.find(x => x.id === is);
    if (!isl) return null;
    const [wx, wy] = this.toWorld(px, py), lx = wx - this.islandX, ly = wy - isl.oyD;
    return isl.f.cards.find(c => c.g && lx >= c.x && lx <= c.x + CW && ly >= c.y && ly <= c.y + CH) ?? null;
  }
  private zoomToBox(bi: number) {
    const b = this.boxes[bi], f = this.frameRect;
    this.goTo(b.x + b.w / 2, b.y + b.h / 2, Math.max(FULL, Math.min((f.right - f.left - 300) / b.w, (f.bottom - f.top - 120) / b.h, 1.4)), true);
  }
  private alive(born: number) { return (born ?? 0) <= this.tNow; }
  // Zoom tier (rule 3): 0 districts as blocks, 1 card titles, 2 full cards.
  private tier() { return this.view.s >= FULL ? 2 : this.view.s >= TITLE ? 1 : 0; }
  // [card, container, island] under a screen point; zoomed out the map has no cards to hit
  private pick(px: number, py: number): [number, number, number] {
    this.o = this.origin();
    const [wx, wy] = this.toWorld(px, py), m = 3 / this.view.s;
    for (const isl of this.islands) {
      const F = isl.f, lx = wx - this.islandX, ly = wy - isl.oyD;
      if (lx < F.x0 - ISLE_PAD || lx > F.x1 + ISLE_PAD || ly < F.y0 - ISLE_HEAD || ly > F.y1 + ISLE_PAD) continue;
      const hit = (x: number, y: number, w: number, hh: number) => lx >= x - m && lx <= x + w + m && ly >= y - m && ly <= y + hh + m;
      if (hit(F.me.x, F.me.y, F.me.w, F.me.h)) return [F.i, -1, isl.id];
      const c = F.cards.find(c => !c.g && hit(c.x, c.y, CW, CH));
      return [c ? c.i : -1, -1, isl.id];
    }
    if (this.tier()) for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      if (this.alive(n.born) && wx >= n.x - m && wx <= n.x + CW + m && wy >= n.y - m && wy <= n.y + CH + m) return [i, n.box, -1];
    }
    const bi = this.boxes.findIndex(b => b.members.length && this.alive(b.born) && wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h);
    return [-1, bi, -1];
  }

  // ------------------------------------------------------------------ drawing
  private last = 0;
  private loop = () => {
    if (!this.visible) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now(), dt = Math.min(0.1, (now - (this.last || now)) / 1000); this.last = now;
    if (this.anim) {
      const a = this.anim; a.t = Math.min(1, a.t + dt / a.dur);
      const k = a.dur > 1 ? -(Math.cos(Math.PI * a.t) - 1) / 2 : 1 - Math.pow(1 - a.t, 3), lz = Math.log(a.from.s) + (Math.log(a.to.s) - Math.log(a.from.s)) * k;
      this.view = { cx: a.from.cx + (a.to.cx - a.from.cx) * k, cy: a.from.cy + (a.to.cy - a.from.cy) * k, s: Math.exp(lz) };
      if (a.t >= 1) this.anim = null;
      this.dirty = true;
    }
    for (const p of this.pulses) p.t += dt / 1.1;
    this.pulses = this.pulses.filter(p => p.t < 1);
    if (this.pulses.length || this.active.size) this.dirty = true;
    for (const isl of this.islands) { // islands ease to their place in the stack, and settle after drifting in
      const d = isl.oy - isl.oyD;
      if (Math.abs(d) > 0.5) { isl.oyD += d * Math.min(1, dt * 4); this.dirty = true; } else isl.oyD = isl.oy;
      if (now - isl.t0 < 3000) this.dirty = true;
    }
    if (this.dirty) { this.dirty = false; this.draw(now / 1000); }
  };

  private draw(time: number) {
    const ctx = this.ctx, d = devicePixelRatio || 1, W = this.canvas.width / d, H = this.canvas.height / d, s = this.view.s;
    this.o = this.origin();
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.fillStyle = '#060910'; ctx.fillRect(0, 0, W, H);
    this.off = [0, 0]; this.hits = [];
    this.drawGrid(W, H);
    const inIsles = this.islands.length > 0 && this.view.cy > this.overBottom + ISLE_GAP / 2;
    this.legend.style.display = inIsles ? 'none' : ''; // down among the islands the section titles say what colours mean

    // focus (rule 5): a hovered card, else the module of the island in use (rule 6), which the map
    // shows at any zoom; zoomed out its ties run from its district block. A hovered district shows its own.
    const tier = this.tier(), act = this.activeIs >= 0 ? this.sel : -1;
    const f = tier && this.hover >= 0 && this.hoverIs < 0 ? this.hover : this.hoverBox >= 0 ? -1 : act;
    const fb = f >= 0 ? -1 : this.hoverBox;
    const soft = f >= 0 && f === act; // the island's module: the rest of the map stays readable around it
    const mine: SEdge[] = [], near = new Set<number>();
    if (f >= 0) {
      near.add(f);
      const own = this.incident[f].map(k => this.edges[k]).filter(e => this.alive(e.born) && this.alive(this.nodes[e.a].born) && this.alive(this.nodes[e.b].born));
      const work = own.filter(e => e.type === 'work').sort((x, y) => y.w - x.w).slice(0, FOCUS_WORK);
      for (const e of [...own.filter(e => e.type !== 'work'), ...work]) { mine.push(e); near.add(e.a); near.add(e.b); }
    }
    const nearBox = new Set<number>();
    if (f >= 0) for (const i of near) nearBox.add(this.nodes[i].box);
    const shownBundles = f >= 0 ? [] : this.bundles.filter(u => this.show[u.type] && this.alive(u.born) && this.alive(this.boxes[u.a].born) && this.alive(this.boxes[u.b].born)
      && (fb >= 0 ? u.a === fb || u.b === fb : u.top));
    if (fb >= 0) { nearBox.add(fb); for (const u of shownBundles) { nearBox.add(u.a); nearBox.add(u.b); } }
    const focused = f >= 0 || fb >= 0;

    // band between code and the outside world
    const by = this.sy(this.bandY);
    if (by > -20 && by < H + 20) {
      ctx.strokeStyle = 'rgba(140, 160, 200, 0.16)'; ctx.lineWidth = 1; ctx.setLineDash([2, 6]);
      ctx.beginPath(); ctx.moveTo(0, by); ctx.lineTo(W, by); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = `600 10.5px ${UI}`; ctx.fillStyle = 'rgba(160, 175, 205, 0.55)'; ctx.textBaseline = 'bottom';
      const ox = this.sx(Math.min(...this.boxes.filter(b => b.members.length).map(b => b.x)));
      ctx.fillText(spaced('OUTSIDE SYSTEMS  ↓'), Math.max(12, ox), by - 5);
    }

    // containers
    this.boxes.forEach((b, i) => {
      if (!b.members.length || !this.alive(b.born)) return;
      const x = this.sx(b.x), y = this.sy(b.y), w = b.w * s, hh = b.h * s;
      if (x > W || y > H || x + w < 0 || y + hh < 0) return;
      const dim = focused && !nearBox.has(i), hue = b.outside ? 220 : b.hue;
      ctx.globalAlpha = dim ? (soft ? 0.55 : 0.35) : 1;
      ctx.fillStyle = b.outside ? 'rgba(120, 135, 165, 0.05)' : `hsla(${hue}, 45%, 40%, 0.07)`;
      const lit = i === fb || (!tier && f >= 0 && i === this.nodes[f].box);
      ctx.strokeStyle = lit ? `hsla(${hue}, 80%, 68%, 0.9)` : b.outside ? 'rgba(140, 155, 190, 0.3)' : `hsla(${hue}, 60%, 60%, 0.42)`;
      ctx.lineWidth = lit ? 1.6 : 1;
      const tint = ctx.fillStyle;
      rrect(ctx, x, y, w, hh, 8);
      if (!tier) { ctx.fillStyle = '#0b0f17'; ctx.fill(); ctx.fillStyle = tint; } // a solid block, so connectors pass behind it
      ctx.fill(); ctx.stroke();
      // header: name left, count right
      const ty = tier ? y + Math.min(HEAD * s, 34) / 2 + 1 : y + 13;
      if (w > 40 && hh > 18) {
        ctx.textBaseline = 'middle';
        const cnt = `${b.members.length}`;
        ctx.font = `500 10.5px ${MONO}`; const cw = ctx.measureText(cnt).width;
        ctx.font = `600 12px ${UI}`; ctx.fillStyle = b.outside ? '#aab4cc' : `hsl(${hue}, 80%, 72%)`;
        ctx.fillText(clip(ctx, b.name, w - 26 - cw), x + 9, ty);
        ctx.font = `500 10.5px ${MONO}`; ctx.fillStyle = 'rgba(170, 182, 210, 0.6)'; ctx.textAlign = 'right';
        ctx.fillText(cnt, x + w - 9, ty); ctx.textAlign = 'left';
      }
      // zoomed out: the block lists its main modules instead of drawing cards
      if (!tier) {
        ctx.font = `500 10.5px ${UI}`; ctx.textBaseline = 'middle';
        const room = Math.floor((hh - 30) / 15);
        b.members.filter(m => this.alive(this.nodes[m].born)).forEach((m, k, all) => {
          if (k >= room) return;
          const n = this.nodes[m], more = k === room - 1 && all.length > room, ly = y + 30 + k * 15;
          ctx.fillStyle = more ? 'rgba(150, 160, 185, 0.6)' : this.active.has(m) ? '#ffffff' : '#aeb6c9';
          ctx.fillText(more ? `+ ${all.length - k} more` : clip(ctx, (n.kind === 'store' ? '◫ ' : '') + n.title, w - 18), x + 9, ly);
        });
        const act = [...new Set(b.members.flatMap(m => this.active.get(m) || []))];
        const pulse = 0.5 + 0.5 * Math.sin(time * 4);
        act.forEach((c, j) => { ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.globalAlpha = 0.5 + 0.5 * pulse; const g = 3 + j * 3 + pulse * 2; rrect(ctx, x - g, y - g, w + 2 * g, hh + 2 * g, 10); ctx.stroke(); });
      }
    });
    ctx.globalAlpha = 1;

    // district connectors (rule 4)
    const pills: { x: number; y: number; t: string; c: string }[] = [];
    for (const type of ['work', 'ref', 'imp'] as EdgeType[]) for (const u of shownBundles) {
      if (u.type !== type) continue;
      if (!u.pts) this.routeBundle(u);
      if (!u.pts || u.pts.length < 2) continue;
      const pts = u.pts.map(p => this.sp(p));
      ctx.strokeStyle = COL[type]; ctx.globalAlpha = type === 'work' ? 0.6 : 0.85;
      ctx.lineWidth = Math.min(5, 1.2 + Math.log2(u.n) * 0.8);
      ctx.setLineDash(type === 'work' ? [6, 5] : []);
      ctx.beginPath(); roundedPath(ctx, pts, 10); ctx.stroke(); ctx.setLineDash([]);
      const head = 5 + ctx.lineWidth * 0.8;
      if (u.ab) arrow(ctx, pts[pts.length - 2], pts[pts.length - 1], head);
      if (u.ba) arrow(ctx, pts[1], pts[0], head);
      const m = midLongest(pts);
      pills.push({ x: m[0], y: m[1], t: String(u.n), c: COL[type] });
    }
    ctx.globalAlpha = 1;

    // A focused card's own ties, under the cards, spread along the side they leave from.
    // A card with many ties is wired to the districts they reach; the cards there light up.
    const ties: { to: R; type: EdgeType; out: boolean; inn: boolean; n: number }[] = [];
    const home = f >= 0 ? this.nodes[f].box : -1, hb = home >= 0 ? this.boxes[home] : null;
    if (f >= 0) {
      const group = !tier || mine.length > FOCUS_CARDS, agg = new Map<string, typeof ties[0]>();
      for (const e of mine) {
        const me = e.a === f, on = this.nodes[me ? e.b : e.a];
        const out = me ? e.dir === 1 || e.dir === 2 : e.dir === -1 || e.dir === 2, inn = me ? e.dir === -1 || e.dir === 2 : e.dir === 1 || e.dir === 2;
        if (!tier && on.box === home) continue; // inside its own block: nothing to draw
        if (!group || on.box === home) { ties.push({ to: card(on), type: e.type, out, inn, n: 1 }); continue; }
        const k = e.type + '|' + on.box;
        let t = agg.get(k);
        if (!t) { const bx = this.boxes[on.box]; agg.set(k, t = { to: { x: bx.x, y: bx.y, w: bx.w, h: bx.h }, type: e.type, out: false, inn: false, n: 0 }); }
        t.n++; t.out ||= out; t.inn ||= inn;
      }
      ties.push(...agg.values());
    }
    const from = f >= 0 ? (tier ? card(this.nodes[f]) : { x: hb!.x, y: hb!.y, w: hb!.w, h: hb!.h }) : null;
    const curves = ties.map(t => curve(from!, t.to));
    const sides = new Map<string, number[]>();
    curves.forEach((c, k) => { const key = c[0][0] + ',' + c[0][1]; sides.set(key, [...(sides.get(key) || []), k]); });
    for (const list of sides.values()) {
      if (list.length < 2) continue;
      const c0 = curves[list[0]], horiz = c0[0][1] === c0[1][1]; // leaves sideways: spread up and down the edge
      const step = (horiz ? CH : CW) * 0.8 / list.length;
      list.sort((x, y) => horiz ? curves[x][3][1] - curves[y][3][1] : curves[x][3][0] - curves[y][3][0]); // no crossings at the card
      list.forEach((k, j) => {
        const off = (j - (list.length - 1) / 2) * step, c = curves[k];
        if (horiz) { c[0][1] += off; c[1][1] += off; } else { c[0][0] += off; c[1][0] += off; }
      });
    }
    for (const type of ['work', 'ref', 'imp'] as EdgeType[]) ties.forEach((t, k) => {
      if (t.type !== type) return;
      const [p0, c1, c2, p3] = curves[k].map(p => this.sp(p));
      ctx.strokeStyle = COL[type]; ctx.globalAlpha = type === 'work' ? 0.75 : 0.95;
      ctx.lineWidth = Math.min(4, (type === 'imp' ? 2 : 1.6) + Math.log2(t.n) * 0.5); ctx.setLineDash(type === 'work' ? [5, 4] : []);
      ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], p3[0], p3[1]); ctx.stroke(); ctx.setLineDash([]);
      if (t.out) arrow(ctx, c2, p3, 5);
      if (t.inn) arrow(ctx, c1, p0, 5);
      if (t.n > 1) { const m = bez([p0, c1, c2, p3], 0.5); pills.push({ x: m[0], y: m[1], t: String(t.n), c: COL[type] }); }
    });
    ctx.globalAlpha = 1;

    // cards
    if (tier) this.nodes.forEach((n, i) => {
      if (!this.alive(n.born)) return;
      const x = this.sx(n.x), y = this.sy(n.y), w = CW * s, hh = CH * s;
      if (x > W + 20 || y > H + 20 || x + w < -20 || y + hh < -20) return;
      const dim = focused && (f >= 0 ? !near.has(i) : !nearBox.has(n.box));
      ctx.globalAlpha = dim ? (soft ? 0.4 : 0.22) : 1;
      this.drawCard(n, x, y, w, hh, tier, i === f || i === act);
      const ring = this.active.get(i);
      if (ring) { // someone is working here: a breathing ring in the session's colour
        const pulse = 0.5 + 0.5 * Math.sin(time * 4);
        ring.forEach((c, j) => { ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.globalAlpha = 0.5 + 0.5 * pulse; const g = 3 + j * 3 + pulse * 2; rrect(ctx, x - g, y - g, w + 2 * g, hh + 2 * g, 6); ctx.stroke(); });
      }
    });
    ctx.globalAlpha = 1;

    // traffic: a light runs from the card a session left to the one it reached (zoomed out, block to block)
    for (const p of this.pulses) {
      const A = this.nodes[p.a], B = this.nodes[p.b];
      let c: Pt[];
      if (tier) c = curve(card(A), card(B));
      else {
        if (A.box === B.box) continue;
        const ba = this.boxes[A.box], bb = this.boxes[B.box], pa: Pt = [ba.x + ba.w / 2, ba.y + ba.h / 2], pb: Pt = [bb.x + bb.w / 2, bb.y + bb.h / 2];
        c = [pa, pa, pb, pb];
      }
      const at = bez(c.map(q => this.sp(q)), p.t);
      ctx.fillStyle = p.color; ctx.shadowColor = p.color; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(at[0], at[1], 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }

    // counts on district connectors, never on top of each other
    const taken: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const free = (r: { x0: number; y0: number; x1: number; y1: number }) => !taken.some(o => r.x0 < o.x1 && r.x1 > o.x0 && r.y0 < o.y1 && r.y1 > o.y0) && (taken.push(r), true);
    ctx.font = `600 10.5px ${MONO}`; ctx.textBaseline = 'middle';
    for (const p of pills) {
      const w = ctx.measureText(p.t).width + 10, r = { x0: p.x - w / 2, y0: p.y - 8, x1: p.x + w / 2, y1: p.y + 8 };
      if (!free(r)) continue;
      ctx.fillStyle = '#0a0e17'; rrect(ctx, r.x0, r.y0, w, 16, 8); ctx.fill();
      ctx.strokeStyle = p.c; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = p.c; ctx.textAlign = 'center'; ctx.fillText(p.t, p.x, p.y + 0.5); ctx.textAlign = 'left';
    }

    this.drawIslands(time, W, H, tier, act);
  }

  // ------------------------------------------------------------------ islands (rule 6)
  private drawIslands(time: number, W: number, H: number, tier: number, act: number) {
    if (!this.islands.length) return;
    const ctx = this.ctx, s = this.view.s, now = performance.now();
    const used = this.boxes.filter(b => b.members.length);
    const left = Math.min(...used.map(b => b.x));
    // canvas buttons stay inside the part of the screen the side panels leave clear
    const cb = this.canvas.getBoundingClientRect(), fl = this.frameRect.left - cb.left + 16, fr = this.frameRect.right - cb.left - 16;

    // the water line: what is floating below, and a way to clear it all
    const gy = this.sy(this.overBottom + ISLE_GAP / 2);
    if (gy > -30 && gy < H + 30 && ISLE_GAP * s >= 60) { // too far out and it would sit on the outside-systems band
      ctx.strokeStyle = 'rgba(94, 230, 255, 0.18)'; ctx.lineWidth = 1; ctx.setLineDash([3, 7]);
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = `600 10.5px ${UI}`; ctx.textBaseline = 'bottom'; ctx.fillStyle = 'rgba(160, 200, 220, 0.7)';
      const label = spaced(`EXPLORING  ${this.islands.length}`) + '   ↓', lx = Math.max(fl, Math.min(fr - 260, this.sx(left)));
      ctx.fillText(label, lx, gy - 6);
      // right after the label: the right side is where the legend sits
      const t = 'clear all  ✕', tx = lx + ctx.measureText(label).width + 28, tw = (ctx.font = `600 11.5px ${UI}`, ctx.measureText(t).width);
      ctx.fillStyle = '#c9d1e4'; ctx.fillText(t, tx, gy - 6);
      this.hits.push({ x0: tx - 6, y0: gy - 24, x1: tx + tw + 6, y1: gy, fn: () => this.clearIslands() });
    }

    // a tether from the active island back to where its module sits on the map,
    // or to its card in the island it was opened from
    const a = this.islands.find(x => x.id === this.activeIs);
    const up = a && this.islands.find(x => x.id === a.parent), upc = up?.f.cards.find(c => c.i === a!.f.i);
    if (a && act >= 0) {
      const n = this.nodes[act], b = this.boxes[n.box];
      const p0: Pt = up && upc ? [this.islandX + upc.x + CW / 2, up.oyD + upc.y + CH] : tier ? [n.x + CW / 2, n.y + CH] : [b.x + b.w / 2, b.y + b.h];
      const p3: Pt = [this.islandX + (a.f.x0 + a.f.x1) / 2, a.oyD + a.f.y0 - ISLE_HEAD];
      const k = Math.max(60, (p3[1] - p0[1]) * 0.45), age = Math.min(3, (now - a.t0) / 1000), ph = age * 1.6;
      const amp = Math.min(14, Math.abs(p3[1] - p0[1]) * 0.02);
      ctx.strokeStyle = n.kind === 'module' ? `hsl(${b.hue}, 70%, 65%)` : NODE[n.kind].stroke; ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.8; ctx.setLineDash([3, 5]); ctx.beginPath();
      for (let j = 0; j <= 48; j++) { // a slow wave along the line, still once the drift has settled
        const t = j / 48, q = bez([p0, [p0[0], p0[1] + k], [p3[0], p3[1] - k], p3], t), w = Math.sin(t * Math.PI * 5 + ph) * amp * Math.sin(t * Math.PI);
        const X = this.sx(q[0] + w), Y = this.sy(q[1]);
        if (j) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
      }
      ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    }

    for (const isl of this.islands) this.drawIsland(isl, time, W, H);
    this.off = [0, 0];
    // the card an island was opened from keeps a ring in that island's colour
    for (const isl of this.islands) {
      const up = this.islands.find(x => x.id === isl.parent), c = up?.f.cards.find(c => c.i === isl.f.i);
      if (!up || !c) continue;
      const n = this.nodes[isl.f.i], st = n.kind === 'module' ? `hsl(${this.boxes[n.box].hue}, 60%, 62%)` : NODE[n.kind].stroke;
      ctx.strokeStyle = st; ctx.lineWidth = 1.6; ctx.globalAlpha = isl.id === this.activeIs ? 0.95 : 0.55;
      rrect(ctx, this.sx(this.islandX + c.x) - 4, this.sy(up.oyD + c.y) - 4, CW * s + 8, CH * s + 8, 7); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private buildFocus(f: number, opened: Set<string>): Focus {
    type It = { i: number; out: boolean; inn: boolean; w: number };
    const by: It[] = [], imp: It[] = [], names: It[] = [], namedBy: It[] = [], work: It[] = [];
    for (const k of this.incident[f]) {
      const e = this.edges[k], mine = e.a === f, o = mine ? e.b : e.a;
      if (!this.alive(e.born) || !this.alive(this.nodes[o].born)) continue;
      const out = mine ? e.dir === 1 || e.dir === 2 : e.dir === -1 || e.dir === 2, inn = mine ? e.dir === -1 || e.dir === 2 : e.dir === 1 || e.dir === 2;
      const it = { i: o, out, inn, w: e.w };
      if (e.type === 'imp') (inn && !out ? by : imp).push(it);
      else if (e.type === 'ref') (this.boxes[this.nodes[o].box].outside ? names : namedBy).push(it);
      else work.push(it);
    }
    work.sort((a, b) => b.w - a.w); work.length = Math.min(work.length, FOCUS_WORK);
    type Sec = [string, It[], EdgeType];
    const L: Sec[] = [['Imported by', by, 'imp'], ['Named by', namedBy, 'ref']], Rt: Sec[] = [['Imports', imp, 'imp'], ['Names systems', names, 'ref']];
    (by.length + namedBy.length <= imp.length + names.length ? L : Rt).push(['Changed together', work, 'work']);

    const w = CW + 70, hh = CH * 2 + 24, me: R = { x: -w / 2, y: -hh / 2, w, h: hh };
    const cards: FCard[] = [], heads: FHead[] = [];
    let x0 = me.x, y0 = me.y, x1 = me.x + w, y1 = me.y + hh;
    const order = (i: number) => { const b = this.boxes[this.nodes[i].box]; return b.y * 1e4 + b.x; };
    const place = (secs: Sec[], left: boolean) => {
      // one list of rows (section title, district name, card), cut into columns of even height
      type Row = { h: number; head?: Omit<FHead, 'x' | 'y'>; card?: Omit<FCard, 'x' | 'y'> };
      const rows: Row[] = [];
      for (const [title, items, type] of secs) {
        if (!items.length) continue;
        rows.push({ h: 34, head: { t: `${title.toUpperCase()}  ${items.length}`, c: COL[type], sec: true } });
        items.sort((a, b) => order(a.i) - order(b.i) || this.nodes[b.i].pri - this.nodes[a.i].pri);
        const fold = items.length > FOCUS_FOLD;
        let box = -1;
        for (const it of items) {
          const n = this.nodes[it.i];
          if (n.box === box) continue;
          box = n.box;
          const group = items.filter(o => this.nodes[o.i].box === box), key = title + '|' + box, bx = this.boxes[box];
          if (fold && group.length > 1 && !opened.has(key)) {
            rows.push({ h: CH + 8, card: { i: -1, type, out: group.some(o => o.out), inn: group.some(o => o.inn), left,
              g: { key, box, n: group.length, names: group.slice(0, 3).map(o => this.nodes[o.i].title).join(', ') } } });
            continue;
          }
          rows.push({ h: 22, head: { t: bx.name, c: bx.outside ? '#aab4cc' : `hsl(${bx.hue}, 80%, 72%)`, sec: false } });
          for (const o of group) rows.push({ h: CH + 8, card: { i: o.i, type, out: o.out, inn: o.inn, left } });
        }
      }
      const total = rows.reduce((s, r) => s + r.h, 0), maxH = Math.max((this.frameRect.bottom - this.frameRect.top - 110) / FULL, total / 2); // at most two columns a side
      const cols: Row[][] = [[]]; let ch = 0;
      for (const r of rows) {
        if (ch + r.h > maxH && cols[cols.length - 1].length) { cols.push([]); ch = 0; }
        cols[cols.length - 1].push(r); ch += r.h;
      }
      cols.forEach((col, c) => {
        if (!col.length) return;
        const x = left ? me.x - 130 - CW - c * (CW + 44) : me.x + w + 130 + c * (CW + 44);
        const colH = col.reduce((s, r) => s + r.h, 0);
        let y = -colH / 2;
        for (const r of col) {
          if (r.head) heads.push({ ...r.head, x, y: y + r.h - 8 });
          else if (r.card) cards.push({ ...r.card, x, y });
          y += r.h;
        }
        x0 = Math.min(x0, x); x1 = Math.max(x1, x + CW); y0 = Math.min(y0, -colH / 2); y1 = Math.max(y1, colH / 2);
      });
    };
    place(L, true); place(Rt, false);
    return { i: f, me, cards, heads, x0: x0 - 20, y0: y0 - 20, x1: x1 + 20, y1: y1 + 20 };
  }

  private drawIsland(isl: Island, time: number, W: number, H: number) {
    const ctx = this.ctx, s = this.view.s, F = isl.f, n = this.nodes[F.i];
    const tier = s >= FULL ? 2 : s >= 0.3 ? 1 : 0, mine = this.hoverIs === isl.id;
    const hov = mine && this.hover !== F.i ? this.hover : -1;
    const st = n.kind === 'module' ? `hsl(${this.boxes[n.box].hue}, 60%, 62%)` : NODE[n.kind].stroke;
    const age = (performance.now() - isl.t0) / 1000, p = Math.min(1, age / DRIFT), e = -(Math.cos(Math.PI * p) - 1) / 2;
    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

    // ripples where the module left the water and where it comes to rest
    const ripple = (wx: number, wy: number, t: number) => {
      if (t < 0 || t > 1.8) return;
      for (let k = 0; k < 3; k++) {
        const r = (t - k * 0.2) * 170; if (r <= 0) continue;
        ctx.strokeStyle = st; ctx.globalAlpha = (1 - t / 1.8) * 0.5 * (1 - k * 0.25); ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.ellipse(this.sx(wx), this.sy(wy), r * s, r * s * 0.5, 0, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
    if (isl.from) { this.off = [0, 0]; ripple(isl.from[0], isl.from[1], age); }
    this.off = [this.islandX, isl.oyD];

    // the island itself, off screen or not
    const px0 = F.x0 - ISLE_PAD, py0 = F.y0 - ISLE_HEAD, px1 = F.x1 + ISLE_PAD, py1 = F.y1 + ISLE_PAD;
    const X0 = this.sx(px0), Y0 = this.sy(py0), X1 = this.sx(px1), Y1 = this.sy(py1);
    if (X0 > W || Y0 > H || X1 < 0 || Y1 < 0) { if (age < DRIFT) this.drawMover(isl, st, tier, e, p); return; }
    const on = this.activeIs === isl.id, panelA = isl.from ? clamp01((age - 0.35) / 0.6) : 1;
    ctx.globalAlpha = panelA;
    ctx.fillStyle = 'rgba(12, 17, 28, 0.72)'; ctx.strokeStyle = on ? st : 'rgba(140, 160, 200, 0.25)'; ctx.lineWidth = on ? 1.4 : 1;
    rrect(ctx, X0, Y0, X1 - X0, Y1 - Y0, 14); ctx.fill(); ctx.stroke();
    // header: what this island is, and its close button
    ctx.textBaseline = 'middle'; ctx.font = `600 12px ${UI}`; ctx.fillStyle = on ? '#e7eaf3' : '#9aa3b8';
    const hy = Y0 + Math.min(ISLE_HEAD * s, 40) / 2 + 2;
    ctx.fillText(clip(ctx, `${n.title}  ·  ${this.boxes[n.box].name}`, X1 - X0 - 80), X0 + 16, hy);
    const cb = this.canvas.getBoundingClientRect(), cx = Math.max(X0 + 40, Math.min(X1 - 26, this.frameRect.right - cb.left - 28)), cr = 11; // never under the side panel
    ctx.strokeStyle = '#9aa3b8'; ctx.lineWidth = 1.6; ctx.beginPath();
    ctx.moveTo(cx - 5, hy - 5); ctx.lineTo(cx + 5, hy + 5); ctx.moveTo(cx + 5, hy - 5); ctx.lineTo(cx - 5, hy + 5); ctx.stroke();
    this.hits.push({ x0: cx - cr, y0: hy - cr, x1: cx + cr, y1: hy + cr, fn: () => this.closeIsland(isl.id) });
    ctx.globalAlpha = 1;

    // neighbours rise into place one after another, bobbing as they settle
    const order = [...F.cards].sort((a, b) => +a.left - +b.left || a.y - b.y);
    const rise = new Map<FCard, { a: number; dy: number }>();
    order.forEach((c, k) => {
      if (!isl.from) { rise.set(c, { a: 1, dy: 0 }); return; }
      const t = age - (DRIFT * 0.55 + 0.45 * k / Math.max(1, order.length)), a = clamp01(t / 0.35);
      const bob = t > 0 ? Math.sin(t * 9) * 5 * Math.exp(-t * 3.5) : 0;
      rise.set(c, { a, dy: (1 - (1 - Math.pow(1 - a, 3))) * 26 + bob });
    });

    const me = F.me, pills: { x: number; y: number; t: string; c: string }[] = [];
    // ties: out of the module's side, spread so they never cross at it, into each card's near side
    for (const left of [true, false]) {
      const side = F.cards.filter(c => c.left === left).sort((a, b) => a.y - b.y);
      side.forEach((c, k) => {
        const r = rise.get(c)!; if (!r.a) return;
        const p0: Pt = [left ? me.x : me.x + me.w, me.y + 14 + (me.h - 28) * (k + 0.5) / side.length];
        const p3: Pt = [left ? c.x + CW : c.x, c.y + r.dy + CH / 2], mx = (p0[0] + p3[0]) / 2;
        const [a, b1, b2, d] = [p0, [mx, p0[1]] as Pt, [mx, p3[1]] as Pt, p3].map(q => this.sp(q));
        const hot = c.g ? this.hoverFold === c : hov === c.i;
        ctx.strokeStyle = COL[c.type]; ctx.globalAlpha = r.a * (hov >= 0 && !hot ? 0.25 : c.type === 'work' ? 0.7 : 0.9);
        ctx.lineWidth = hot ? 2.6 : 1.5; ctx.setLineDash(c.type === 'work' ? [5, 4] : []);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.bezierCurveTo(b1[0], b1[1], b2[0], b2[1], d[0], d[1]); ctx.stroke(); ctx.setLineDash([]);
        if (c.out) arrow(ctx, b2, d, hot ? 5.5 : 4.5);
        if (c.inn) arrow(ctx, b1, a, hot ? 5.5 : 4.5);
        if (c.g && r.a === 1) { const m = bez([a, b1, b2, d], 0.75); pills.push({ x: m[0], y: m[1], t: String(c.g.n), c: COL[c.type] }); }
      });
    }
    ctx.globalAlpha = 1;

    // neighbours as full cards
    for (const c of F.cards) {
      const r = rise.get(c)!; if (!r.a) continue;
      const cx = this.sx(c.x), cy = this.sy(c.y + r.dy);
      ctx.globalAlpha = r.a;
      if (c.g) { this.drawFold(c, cx, cy, CW * s, CH * s, tier); continue; }
      this.drawCard(this.nodes[c.i], cx, cy, CW * s, CH * s, tier, hov === c.i);
      const act = this.active.get(c.i);
      if (act) { const pulse = 0.5 + 0.5 * Math.sin(time * 4); act.forEach((col, j) => { ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.globalAlpha = 0.5 + 0.5 * pulse; const g = 3 + j * 3 + pulse * 2; rrect(ctx, cx - g, cy - g, CW * s + 2 * g, CH * s + 2 * g, 6); ctx.stroke(); }); }
    }
    ctx.globalAlpha = 1;
    // counts on folded districts
    ctx.font = `600 10.5px ${MONO}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    for (const q of pills) { const w = ctx.measureText(q.t).width + 10; ctx.fillStyle = '#0a0e17'; rrect(ctx, q.x - w / 2, q.y - 8, w, 16, 8); ctx.fill(); ctx.strokeStyle = q.c; ctx.lineWidth = 1; ctx.stroke(); ctx.fillStyle = q.c; ctx.fillText(q.t, q.x, q.y + 0.5); }
    ctx.textAlign = 'left';
    // section titles and district names above their cards, sized with the rows they sit in
    ctx.textBaseline = 'alphabetic';
    const hs = Math.min(1, s / 0.8);
    ctx.globalAlpha = panelA;
    if (hs * 11 >= 7) for (const hd of F.heads) {
      ctx.font = hd.sec ? `700 ${11 * hs}px ${UI}` : `600 ${10.5 * hs}px ${UI}`; ctx.fillStyle = hd.c;
      ctx.fillText(clip(ctx, hd.sec ? spaced(hd.t) : hd.t, CW * s + (hd.sec ? 80 : 0)), this.sx(hd.x) + (hd.sec ? 0 : 2), this.sy(hd.y));
    }
    if (!F.cards.length) {
      ctx.font = `500 12px ${UI}`; ctx.fillStyle = '#7d869c'; ctx.textAlign = 'center';
      ctx.fillText('No imports, systems or shared changes recorded for this one yet.', this.sx(0), this.sy(me.y + me.h + 28)); ctx.textAlign = 'left';
    }
    ctx.globalAlpha = 1;

    this.drawMover(isl, st, tier, e, p);
    ripple(0, 0, age - DRIFT * 0.85);
    const act = this.active.get(F.i);
    if (act) {
      const m = this.moverRect(isl, e, p), x = this.sx(m.x), y = this.sy(m.y), pulse = 0.5 + 0.5 * Math.sin(time * 4);
      act.forEach((c, j) => { ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.globalAlpha = 0.5 + 0.5 * pulse; const g = 4 + j * 3 + pulse * 2; rrect(ctx, x - g, y - g, m.w * s + 2 * g, m.h * s + 2 * g, 10); ctx.stroke(); });
      ctx.globalAlpha = 1;
    }
  }

  // Where the module card is while it drifts: from the card it left, on a swaying curve,
  // growing to its island size. Island-relative, like everything drawn with off set.
  private moverRect(isl: Island, e: number, p: number): R {
    const me = isl.f.me;
    if (!isl.from || p >= 1) return me;
    const fl: Pt = [isl.from[0] - this.islandX, isl.from[1] - isl.oyD], dx = -fl[0], dy = -fl[1], L = Math.hypot(dx, dy) || 1;
    const sway = Math.sin(p * Math.PI * 2) * (1 - p) * Math.min(90, L * 0.08); // across the path, dying out
    const cx = fl[0] + dx * e - dy / L * sway, cy = fl[1] + dy * e + dx / L * sway + Math.sin(p * Math.PI * 3) * 6 * (1 - p);
    const w = CW + (me.w - CW) * e, hh = CH + (me.h - CH) * e;
    return { x: cx - w / 2, y: cy - hh / 2, w, h: hh };
  }

  private drawMover(isl: Island, st: string, tier: number, e: number, p: number) {
    const ctx = this.ctx, s = this.view.s, n = this.nodes[isl.f.i], m = this.moverRect(isl, e, p);
    const x = this.sx(m.x), y = this.sy(m.y), w = m.w * s, hh = m.h * s;
    ctx.fillStyle = NODE[n.kind].fill; ctx.strokeStyle = st; ctx.lineWidth = 2;
    rrect(ctx, x, y, w, hh, 8); ctx.fill(); ctx.shadowColor = st; ctx.shadowBlur = 18 + (1 - p) * 14; ctx.stroke(); ctx.shadowBlur = 0;
    ctx.fillStyle = st; ctx.fillRect(x + 1, y + 6, 4, Math.max(0, hh - 12));
    if (!tier || hh < 20) return;
    const tx = x + 16, maxW = w - 28, lh = Math.min(1, s * 1.1);
    ctx.textBaseline = 'middle';
    if (p < 1) { ctx.font = `600 ${Math.max(11, 14 * lh)}px ${UI}`; ctx.fillStyle = '#ffffff'; ctx.fillText(clip(ctx, n.title, maxW), tx, y + hh / 2); return; }
    ctx.font = `600 ${9.5 * Math.max(1, lh)}px ${MONO}`; ctx.fillStyle = st; ctx.fillText(clip(ctx, `${NODE[n.kind].label.toUpperCase()} · ${this.boxes[n.box].name}`, maxW), tx, y + hh * 0.2);
    ctx.font = `600 ${Math.max(12, 16 * lh)}px ${UI}`; ctx.fillStyle = '#ffffff'; ctx.fillText(clip(ctx, n.title, maxW), tx, y + hh * 0.42);
    ctx.font = `400 ${Math.max(10, 11 * lh)}px ${MONO}`; ctx.fillStyle = '#8d96ab';
    if (!this.boxes[n.box].outside) ctx.fillText(clip(ctx, n.sub, maxW), tx, y + hh * 0.62);
    ctx.fillStyle = '#b4bccf'; ctx.fillText(clip(ctx, n.meta, maxW), tx, y + hh * 0.8);
  }

  private drawFold(c: FCard, x: number, y: number, w: number, hh: number, tier: number) {
    const ctx = this.ctx, g = c.g!, b = this.boxes[g.box], hot = this.hoverFold === c;
    const st = b.outside ? '#aab4cc' : `hsl(${b.hue}, 60%, 62%)`;
    ctx.fillStyle = '#0d1220'; ctx.strokeStyle = hot ? st : 'rgba(150, 165, 200, 0.4)'; ctx.lineWidth = hot ? 1.8 : 1; ctx.setLineDash([4, 3]);
    rrect(ctx, x, y, w, hh, 5); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = st; ctx.fillRect(x + 0.5, y + 3, 3, hh - 6);
    if (!tier) return;
    const ix = x + 10, maxW = w - 18;
    ctx.textBaseline = 'middle';
    if (tier === 1) { ctx.font = `600 11px ${UI}`; ctx.fillStyle = st; ctx.fillText(clip(ctx, `${b.name} · ${g.n}  ▸`, maxW), ix, y + hh / 2 + 0.5); return; }
    ctx.font = `600 12.5px ${UI}`; ctx.fillStyle = st; ctx.fillText(clip(ctx, `${b.name} · ${g.n} ${b.outside ? 'systems' : 'modules'}  ▸`, maxW), ix, y + hh * 0.34);
    ctx.font = `400 10px ${UI}`; ctx.fillStyle = '#8d96ab'; ctx.fillText(clip(ctx, g.names, maxW), ix, y + hh * 0.7);
  }

  private drawCard(n: SNode, x: number, y: number, w: number, hh: number, tier: number, hot: boolean) {
    const ctx = this.ctx, b = this.boxes[n.box];
    const st = n.kind === 'module' ? `hsl(${b.hue}, 55%, 60%)` : NODE[n.kind].stroke;
    const r = Math.min(5, hh / 4);
    ctx.fillStyle = NODE[n.kind].fill; ctx.strokeStyle = hot ? st : 'rgba(150, 165, 200, 0.22)'; ctx.lineWidth = hot ? 2 : 1;
    rrect(ctx, x, y, w, hh, r); ctx.fill(); ctx.stroke();
    if (hot) { ctx.shadowColor = st; ctx.shadowBlur = 14; ctx.stroke(); ctx.shadowBlur = 0; }
    ctx.fillStyle = st; ctx.fillRect(x + 0.5, y + r * 0.6, Math.max(2, 3 * Math.min(1, this.view.s * 1.5)), hh - r * 1.2); // kind / district colour on the left edge
    if (!tier) return;
    const icon = n.kind !== 'module', ix = x + 8 + (icon ? (tier === 2 ? 20 : 15) : 0), maxW = x + w - 8 - ix;
    if (icon) this.icon(n.kind, x + (tier === 2 ? 17 : 13), y + (tier === 2 ? hh / 2 : hh / 2), st, tier === 2 ? 1 : 0.8);
    ctx.textBaseline = 'middle';
    if (tier === 1) {
      ctx.font = `600 11px ${UI}`; ctx.fillStyle = '#dfe4ef'; ctx.fillText(clip(ctx, n.title, maxW), ix, y + hh / 2 + 0.5);
      return;
    }
    ctx.font = `600 12.5px ${UI}`; ctx.fillStyle = '#e7eaf3'; ctx.fillText(clip(ctx, n.title, maxW), ix, y + hh * 0.34);
    ctx.font = `400 10px ${MONO}`; ctx.fillStyle = '#7d869c';
    const meta = n.meta, mw = Math.min(ctx.measureText(meta).width, maxW * 0.55);
    if (n.box >= 0 && !this.boxes[n.box].outside) ctx.fillText(clip(ctx, n.sub, maxW - mw - 10), ix, y + hh * 0.7); // the path; an outside group already names the kind
    ctx.fillStyle = '#9aa3b8'; ctx.textAlign = 'right'; ctx.fillText(clip(ctx, meta, mw), x + w - 8, y + hh * 0.7); ctx.textAlign = 'left';
  }

  private icon(k: Kind, x: number, y: number, c: string, sc: number) {
    const ctx = this.ctx; ctx.save(); ctx.translate(x, y); ctx.scale(sc, sc);
    ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = 1.2;
    if (k === 'host') { for (let i = -1; i <= 1; i++) { ctx.strokeRect(-5, i * 3.6 - 1.5, 10, 3); ctx.fillRect(2.5, i * 3.6 - 0.5, 1.2, 1.2); } }
    else if (k === 'web') { ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.moveTo(-5, 0); ctx.lineTo(5, 0); ctx.ellipse(0, 0, 2.2, 5, 0, 0, Math.PI * 2); ctx.stroke(); }
    else if (k === 'service') { ctx.beginPath(); ctx.arc(0, 0, 2, 0, Math.PI * 2); for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; ctx.moveTo(Math.cos(a) * 3.2, Math.sin(a) * 3.2); ctx.lineTo(Math.cos(a) * 5.2, Math.sin(a) * 5.2); } ctx.stroke(); }
    else if (k === 'local') { ctx.beginPath(); folderPath(ctx, -5, -4, 10, 8); ctx.stroke(); }
    else if (k === 'store') { ctx.beginPath(); cylinderPath(ctx, -4.5, -5, 9, 10); ctx.stroke(); ctx.beginPath(); ctx.ellipse(0, -3.2, 4.5, 1.8, 0, 0, Math.PI); ctx.stroke(); }
    ctx.restore();
  }

  private drawGrid(W: number, H: number) {
    const ctx = this.ctx, s = this.view.s;
    const [wx0, wy0] = this.toWorld(0, 0), [wx1, wy1] = this.toWorld(W, H);
    const lines = (step: number, color: string) => {
      if (step * s < 10) return;
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath();
      for (let x = Math.ceil(wx0 / step) * step; x <= wx1; x += step) { const px = Math.round(this.sx(x)) + 0.5; ctx.moveTo(px, 0); ctx.lineTo(px, H); }
      for (let y = Math.ceil(wy0 / step) * step; y <= wy1; y += step) { const py = Math.round(this.sy(y)) + 0.5; ctx.moveTo(0, py); ctx.lineTo(W, py); }
      ctx.stroke();
    };
    lines(40, 'rgba(120, 150, 210, 0.03)');
    lines(200, 'rgba(120, 150, 210, 0.05)');
  }
}

// ---------------------------------------------------------------- 2D helpers
interface R { x: number; y: number; w: number; h: number }
const card = (n: SNode): R => ({ x: n.x, y: n.y, w: CW, h: CH });
// A focused tie, side to side (or top to bottom) between two boxes; cards stacked in
// one column are joined by a bracket out of their right edges.
function curve(a: R, b: R): [Pt, Pt, Pt, Pt] {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2, dx = bx - ax, dy = by - ay;
  if (a.w === b.w && Math.abs(dx) < a.w / 2) {
    const k = 34 + Math.abs(dy) * 0.12;
    return [[a.x + a.w, ay], [a.x + a.w + k, ay], [b.x + b.w + k, by], [b.x + b.w, by]];
  }
  if (Math.abs(dx) - (a.w + b.w) / 2 >= Math.abs(dy) - (a.h + b.h) / 2) {
    const sg = Math.sign(dx), p0: Pt = [ax + sg * a.w / 2, ay], p3: Pt = [bx - sg * b.w / 2, by], k = Math.max(30, Math.abs(p3[0] - p0[0]) * 0.45);
    return [p0, [p0[0] + sg * k, ay], [p3[0] - sg * k, by], p3];
  }
  const sg = Math.sign(dy), p0: Pt = [ax, ay + sg * a.h / 2], p3: Pt = [bx, by - sg * b.h / 2], k = Math.max(30, Math.abs(p3[1] - p0[1]) * 0.45);
  return [p0, [ax, p0[1] + sg * k], [bx, p3[1] - sg * k], p3];
}
// Where a connector leaves a container, out of the side facing its first cell, and
// the jog that keeps it at right angles when that cell sits off the container's edge.
function port(b: SBox, p: Pt): Pt[] {
  const cx = Math.min(b.x + b.w, Math.max(b.x, p[0])), cz = Math.min(b.y + b.h, Math.max(b.y, p[1]));
  if (Math.abs(p[0] - cx) >= Math.abs(p[1] - cz)) return cz === p[1] ? [[cx, cz]] : [[cx, cz], [p[0], cz]];
  return cx === p[0] ? [[cx, cz]] : [[cx, cz], [cx, p[1]]];
}
function rrectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) { ctx.beginPath(); rrectPath(ctx, x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2))); }
function folderPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const t = Math.min(h * 0.18, 6);
  ctx.moveTo(x, y + t); ctx.lineTo(x, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y + t); ctx.lineTo(x + w * 0.45, y + t); ctx.lineTo(x + w * 0.38, y); ctx.lineTo(x, y); ctx.closePath();
}
function cylinderPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const e = Math.min(h * 0.18, 8);
  ctx.moveTo(x, y + e); ctx.ellipse(x + w / 2, y + e, w / 2, e, 0, Math.PI, 0); ctx.lineTo(x + w, y + h - e);
  ctx.ellipse(x + w / 2, y + h - e, w / 2, e, 0, 0, Math.PI); ctx.closePath();
}
// An orthogonal polyline with rounded corners.
function roundedPath(ctx: CanvasRenderingContext2D, pts: Pt[], r: number) {
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], [cx, cy] = pts[i + 1];
    const rr = Math.min(r, Math.hypot(bx - ax, by - ay) / 2, Math.hypot(cx - bx, cy - by) / 2);
    ctx.arcTo(bx, by, cx, cy, rr);
  }
  ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
}
function arrow(ctx: CanvasRenderingContext2D, from: Pt, to: Pt, size: number) {
  const dx = to[0] - from[0], dy = to[1] - from[1], l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l;
  ctx.fillStyle = ctx.strokeStyle as string;
  ctx.beginPath(); ctx.moveTo(to[0], to[1]);
  ctx.lineTo(to[0] - ux * size * 2 + uy * size, to[1] - uy * size * 2 - ux * size);
  ctx.lineTo(to[0] - ux * size * 2 - uy * size, to[1] - uy * size * 2 + ux * size);
  ctx.closePath(); ctx.fill();
}
// The middle of a polyline's longest segment: where its label reads best.
function midLongest(pts: Pt[]): Pt {
  let best = 1, bl = -1;
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); if (l > bl) { bl = l; best = i; } }
  return [(pts[best - 1][0] + pts[best][0]) / 2, (pts[best - 1][1] + pts[best][1]) / 2];
}
function bez(p: Pt[], t: number): Pt {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * p[0][0] + b * p[1][0] + c * p[2][0] + d * p[3][0], a * p[0][1] + b * p[1][1] + c * p[2][1] + d * p[3][1]];
}
function clip(ctx: CanvasRenderingContext2D, t: string, max: number) {
  if (max <= 0) return '';
  if (ctx.measureText(t).width <= max) return t;
  let lo = 0, hi = t.length;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ctx.measureText(t.slice(0, m) + '…').width <= max) lo = m; else hi = m - 1; }
  return lo ? t.slice(0, lo) + '…' : '';
}
const spaced = (t: string) => t.split('').join(' ');
