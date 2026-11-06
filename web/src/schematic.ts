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
//
// Lines are drawn by the rules of metro diagrams (Beck's Underground map and its heirs,
// as collected in Ovenden's "Transit Maps of the World"):
//  8. Distance means nothing, only who is tied to whom. Lines are taut: straight runs,
//     few turns, a short jog becomes one 45° diagonal, every bend has the same radius.
//     No wiggles that show a corner nobody needs to know about.
//  9. Every line has the same weight; a count is never drawn as width. The overview prints no
//     numbers along its lines; a hovered district or card writes its counts beside them.
//     Each line has a dark casing, so two lines crossing or running side by side never
//     merge into one thick one. A line starts at a station (●) and ends in a slim arrow on its
//     last straight run, square onto a side of what it reaches, never at a corner.
// 10. The busiest district is the centre of the map, its row ordered outwards by weight;
//     every other row is ordered under the districts it is tied to, so lines run short and
//     rarely cross. Districts with no ties go to the edges.
// 11. Room goes where the lines are: gutters widen with the lines they carry and stay
//     narrow at the quiet edges.
// 12. Hovered and island ties are lines too, not loose curves: straight out of the card,
//     one diagonal, straight in. In an island each tie keeps its own lane, ordered so no
//     two cross.

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

const COL: Record<EdgeType, string> = { imp: '#d98a1c', ref: '#8a5cf0', work: '#1798bd' };
const NODE: Record<Kind, { stroke: string; fill: string; label: string; group: string }> = {
  module: { stroke: '', fill: '#ffffff', label: 'Module', group: '' },
  store: { stroke: '#c98a2e', fill: '#fdf7ee', label: 'Data store', group: '' },
  host: { stroke: '#2f7cc4', fill: '#eff5fc', label: 'Server / site', group: 'Servers & sites' },
  service: { stroke: '#7f55e0', fill: '#f5f1fd', label: 'Service (MCP / tool)', group: 'Services' },
  web: { stroke: '#2a9e8f', fill: '#eef8f6', label: 'Web research', group: 'Web research' },
  local: { stroke: '#8a8f99', fill: '#f4f4f5', label: 'Local folder', group: 'Local folders' },
};
const UI = "'Space Grotesk', system-ui, sans-serif", MONO = "'JetBrains Mono', Consolas, monospace";
// layout, in world units (one unit is a pixel at zoom 1)
const CW = 176, CH = 46, GAP = 14, PAD = 14, HEAD = 36, DGAP = 72, G = 18; // G: routing cell, one lane (wide enough that lines side by side read as two)
const DGAP_MIN = 100, LANES_X = 6, LANES_Y = 8; // gutters: the narrowest, and how many extra lanes they may grow by (rule 11)
const JOG = 6 * G; // a jog this short between two straight runs becomes a 45° diagonal (rule 8)
const BG = '#f7f7f5';
const REACH = 130; // islands: from the module's side to its neighbours
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
  private segs: [Pt, Pt][] = []; // runs of the lines drawn so far this frame (screen px): a later line hops over them

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
      h('div', { class: 'lg-note' }, 'Lines join districts: hover one for all of its ties and how many there are. Zoom in and click a card to float its connections out below. Scroll to zoom, drag to move.'),
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
  // Rules 10-11: the order inside each row, and gutters as wide as their traffic.
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
    const rowsOf = (list: number[]) => {
      const out: number[][] = []; let row: number[] = [], w = 0;
      for (const i of list) {
        const bw = this.boxes[i].w;
        if (row.length && w + DGAP + bw > maxW) { out.push(row); row = []; w = 0; }
        w += (row.length ? DGAP : 0) + bw; row.push(i);
      }
      if (row.length) out.push(row);
      return out;
    };
    const codeRows = rowsOf(code), rows = [...codeRows, ...rowsOf(outside)];
    const rowOf = new Map<number, number>();
    rows.forEach((r, k) => r.forEach(i => rowOf.set(i, k)));

    // how strongly containers are tied, and how many drawn lines leave each one
    const WT: Record<EdgeType, number> = { imp: 1, ref: 0.6, work: 0.3 };
    const tie = new Map<number, Map<number, number>>(), lanes = new Map<number, number>();
    for (const u of this.bundles) {
      const w = WT[u.type] * Math.log2(1 + u.n);
      for (const [p, q] of [[u.a, u.b], [u.b, u.a]]) { let m = tie.get(p); if (!m) tie.set(p, m = new Map()); m.set(q, (m.get(q) || 0) + w); }
      if (u.top) for (const p of [u.a, u.b]) lanes.set(p, (lanes.get(p) || 0) + 1);
    }
    const deg = (i: number) => { let s = 0; for (const w of tie.get(i)?.values() ?? []) s += w; return s; };
    const gapX = (i: number, j: number) => DGAP_MIN + G * Math.min(LANES_X, Math.ceil(((lanes.get(i) || 0) + (lanes.get(j) || 0)) / 2));
    const pack = (row: number[]) => {
      let x = -row.reduce((s, i, k) => s + this.boxes[i].w + (k ? gapX(row[k - 1], i) : 0), 0) / 2;
      row.forEach((i, k) => { if (k) x += gapX(row[k - 1], i); this.boxes[i].x = x; x += this.boxes[i].w; });
    };
    const mid = (i: number) => this.boxes[i].x + this.boxes[i].w / 2;
    const outwards = (list: number[]) => { // heaviest in the middle, lighter ones alternating out to both sides
      const out: number[] = [];
      [...list].sort((x, y) => deg(y) - deg(x)).forEach((i, k) => k % 2 ? out.unshift(i) : out.push(i));
      return out;
    };
    // a row sorted by where the districts it is tied to stand; untied ones out to the edges
    const placed = new Set<number>();
    const order = (k: number, all: boolean) => {
      const at = new Map<number, number>(), loose: number[] = [];
      for (const i of rows[k]) {
        let s = 0, w = 0;
        for (const [j, t] of tie.get(i) ?? []) if (rowOf.get(j) !== k && (all || placed.has(j))) { s += t * mid(j); w += t; }
        if (w) at.set(i, s / w); else loose.push(i);
      }
      const sorted = rows[k].filter(i => at.has(i)).sort((x, y) => at.get(x)! - at.get(y)!);
      rows[k] = [...loose.filter((_, n) => n % 2), ...sorted, ...loose.filter((_, n) => !(n % 2))];
      pack(rows[k]); rows[k].forEach(i => placed.add(i));
    };
    if (rows.length) {
      const hub = code.reduce((b, i) => b < 0 || deg(i) > deg(b) ? i : b, -1), hr = hub >= 0 ? rowOf.get(hub)! : 0;
      rows[hr] = outwards(rows[hr]); pack(rows[hr]); rows[hr].forEach(i => placed.add(i));
      const near = rows.map((_, k) => k).filter(k => k !== hr && k < codeRows.length).sort((a, b) => Math.abs(a - hr) - Math.abs(b - hr) || a - b);
      for (const k of near) order(k, false);
      for (let k = codeRows.length; k < rows.length; k++) order(k, false);
      for (let pass = 0; pass < 2; pass++) rows.forEach((_, k) => { if (k !== hr) order(k, true); });
    }

    // rows top to bottom, each gutter as wide as the lines crossing it
    const gapY = (k: number) => DGAP_MIN + G * Math.min(LANES_Y, this.bundles.filter(u => {
      if (!u.top) return false;
      const ra = rowOf.get(u.a) ?? 0, rb = rowOf.get(u.b) ?? 0;
      return Math.min(ra, rb) <= k && k < Math.max(ra, rb) || ra === k && rb === k;
    }).length);
    let y = 0;
    rows.forEach((row, k) => {
      if (k === codeRows.length) { this.bandY = y - (k ? gapY(k - 1) : DGAP) / 2 + 6; y += DGAP * 0.4; }
      row.forEach(i => this.boxes[i].y = y);
      y += Math.max(...row.map(i => this.boxes[i].h)) + gapY(k);
    });
    if (rows.length === codeRows.length) this.bandY = y - (rows.length ? gapY(rows.length - 1) : DGAP) / 2 + 6;
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
    if (!this.grid) this.grid = new StreetGrid(this.boxes.map(b => ({ x0: b.x / G, z0: b.y / G, x1: (b.x + b.w) / G, z1: (b.y + b.h) / G })), 2, 4, 60 / G); // lanes keep two cells off a block, room to leave it straight, bend and land an arrow; ends face a side, inset() from corners
    // overlaps cost more than detours, so every line keeps its own lane; turns cost more still, so lines stay taut (rule 8)
    const p = this.grid.route(u.a, u.b, { share: 1.4, turn: 6, near: 0.2, mid: 3, ends: 8 }); // mid: along the middle of a gutter, clear of the blocks; ends: two arrows never land side by side
    if (!p) { u.pts = []; return; }
    const pts = this.grid.corners(p).map(q => [q[0] * G, q[1] * G] as Pt);
    const grid = collinear([...port(this.boxes[u.a], pts[0]), ...pts, ...port(this.boxes[u.b], pts[pts.length - 1]).reverse()]);
    // the simplest line that is clear wins over the street the grid found (rule 8)
    const best = taut(this.boxes[u.a], this.boxes[u.b], grid).find(c => this.clear(c, u.a, u.b));
    if (best) { u.pts = best; this.layWorld(best); }
    else {
      this.grid.lay(p);
      const ends = enter(enter(this.unjog(this.unjog(grid, u.b).reverse(), u.a), this.boxes[u.a]).reverse(), this.boxes[u.b]);
      u.pts = diagonals(collinear(ends), this.solid([u.a, u.b]));
    }
    for (let k = 1; k < u.pts.length; k++) this.laid.push([u.pts[k - 1], u.pts[k]]);
  }
  private laid: [Pt, Pt][] = []; // every segment of the connectors drawn so far
  // A small jog just before a line reaches container `to`: slide its station along the side instead, so the
  // line runs in straight (rule 8: no corner nobody needs to know about).
  private unjog(pts: Pt[], to: number): Pt[] {
    const n = pts.length; if (n < 4) return pts;
    const [a, b, c, d] = pts.slice(n - 4), B = this.boxes[to];
    const ax: number = a[1] === b[1] && c[1] === d[1] && b[0] === c[0] ? 0 : a[0] === b[0] && c[0] === d[0] && b[1] === c[1] ? 1 : -1;
    if (ax < 0) return pts;
    const ay = 1 - ax, jog = Math.abs(c[ay] - b[ay]), lo = ay ? B.y : B.x, hi = ay ? B.y + B.h : B.x + B.w;
    if (jog > 1.5 * G || b[ay] < lo + 14 || b[ay] > hi - 14) return pts;
    const e: Pt = [d[0], d[1]]; e[ay] = b[ay];
    return [...pts.slice(0, n - 3), e];
  }
  // Containers a line must keep out of: a margin round each, the two it joins only their inside.
  private solid(own: number[] = []): R[] {
    return this.boxes.flatMap((b, i) => !b.members.length ? [] : own.includes(i) ? [{ x: b.x + 1, y: b.y + 1, w: b.w - 2, h: b.h - 2 }] : [{ x: b.x - G, y: b.y - G, w: b.w + 2 * G, h: b.h + 2 * G }]);
  }
  // A line through no container and along no lane another line already runs in.
  private clear(pts: Pt[], a: number, b: number) {
    const rects = this.solid([a, b]);
    for (let k = 1; k < pts.length; k++) {
      const p = pts[k - 1], q = pts[k];
      if (rects.some(r => segHits(p, q, r)) || this.laid.some(([s, t]) => sameLane(p, q, s, t))) return false;
    }
    return true;
  }
  // Mark a line drawn off the grid as street, so later routes keep to their own lanes.
  private layWorld(pts: Pt[]) {
    const g = this.grid!;
    const cell = (x: number, y: number) => { const i = Math.floor(x / G - g.ox), j = Math.floor(y / G - g.oz); return i >= 0 && j >= 0 && i < g.nx && j < g.nz ? j * g.nx + i : -1; };
    for (let k = 1; k < pts.length; k++) {
      const p = pts[k - 1], q = pts[k], n = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / G * 2);
      let prev = -1;
      for (let t = 0; t <= n; t++) {
        const c = cell(p[0] + (q[0] - p[0]) * t / n, p[1] + (q[1] - p[1]) * t / n);
        if (c < 0 || c === prev) continue;
        if (prev >= 0 && g.nbrs(prev).includes(c)) g.use[g.edgeBetween(prev, c)]++;
        prev = c;
      }
    }
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
  // Switching layers keeps a place where it was on screen (cityview setLayer): where a card's
  // middle is on the map, the card nearest a point, and the camera moved to put a card at one.
  // All in client coordinates.
  screenOf(r: Ref): Pt | null {
    const i = this.idx(r); if (i < 0) return null;
    const n = this.nodes[i], box = this.canvas.getBoundingClientRect(), [ox, oy] = this.origin();
    return [(n.x + CW / 2 - this.view.cx) * this.view.s + ox + box.left, (n.y + CH / 2 - this.view.cy) * this.view.s + oy + box.top];
  }
  refAt(x: number, y: number): Ref | null {
    const box = this.canvas.getBoundingClientRect(), [wx, wy] = this.toWorld(x - box.left, y - box.top);
    let best = -1, d = Infinity;
    this.nodes.forEach((n, i) => { const e = Math.hypot(n.x + CW / 2 - wx, n.y + CH / 2 - wy); if (this.alive(n.born) && e < d) { d = e; best = i; } });
    return best >= 0 ? this.nodes[best].ref : null;
  }
  pin(r: Ref, x: number, y: number) {
    const i = this.idx(r); if (i < 0) return;
    if (!this.fitted) { this.fit(false); this.fitted = true; }
    const n = this.nodes[i], box = this.canvas.getBoundingClientRect(), [ox, oy] = this.origin();
    this.anim = null;
    this.view = { cx: n.x + CW / 2 - (x - box.left - ox) / this.view.s, cy: n.y + CH / 2 - (y - box.top - oy) / this.view.s, s: this.view.s };
    this.dirty = true;
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
      let [i, bi, is] = this.pick(px, py);
      // zoomed out from a hovered card: it stays hovered while the pointer stays on its district's block
      if (i < 0 && is < 0 && !this.tier() && this.hover >= 0 && this.hoverIs < 0 && bi === this.nodes[this.hover].box) i = this.hover;
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
    ctx.fillStyle = '#f7f7f5'; ctx.fillRect(0, 0, W, H);
    this.off = [0, 0]; this.hits = []; this.segs = [];
    this.drawGrid(W, H);
    const inIsles = this.islands.length > 0 && this.view.cy > this.overBottom + ISLE_GAP / 2;
    this.legend.style.display = inIsles ? 'none' : ''; // down among the islands the section titles say what colours mean

    // focus (rule 5): a hovered card, else the module of the island in use (rule 6), which the map
    // shows at any zoom; zoomed out its ties run from its district block. A hovered district shows its own.
    const tier = this.tier(), act = this.activeIs >= 0 ? this.sel : -1;
    // A card hovered when zooming out stays the focus: its block lists it, picked out, and its ties run from the block.
    const f = this.hover >= 0 && this.hoverIs < 0 ? this.hover : this.hoverBox >= 0 ? -1 : act;
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
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)'; ctx.lineWidth = 1; ctx.setLineDash([2, 6]);
      ctx.beginPath(); ctx.moveTo(0, by); ctx.lineTo(W, by); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = `600 10.5px ${UI}`; ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'; ctx.textBaseline = 'bottom';
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
      ctx.fillStyle = b.outside ? 'rgba(0, 0, 0, 0.03)' : `hsla(${hue}, 60%, 50%, 0.07)`;
      const lit = i === fb || (!tier && f >= 0 && i === this.nodes[f].box);
      ctx.strokeStyle = lit ? `hsla(${hue}, 70%, 40%, 0.9)` : b.outside ? 'rgba(0, 0, 0, 0.2)' : `hsla(${hue}, 55%, 45%, 0.45)`;
      ctx.lineWidth = lit ? 1.6 : 1;
      const tint = ctx.fillStyle;
      rrect(ctx, x, y, w, hh, 8);
      if (!tier) { ctx.fillStyle = '#f7f7f5'; ctx.fill(); ctx.fillStyle = tint; } // a solid block, so connectors pass behind it
      ctx.fill(); ctx.stroke();
      // header: name left, count right
      const ty = tier ? y + Math.min(HEAD * s, 34) / 2 + 1 : y + 13;
      if (w > 40 && hh > 18) {
        ctx.textBaseline = 'middle';
        const cnt = `${b.members.length}`;
        ctx.font = `500 10.5px ${MONO}`; const cw = ctx.measureText(cnt).width;
        ctx.font = `600 12px ${UI}`; ctx.fillStyle = b.outside ? '#6b6f78' : `hsl(${hue}, 65%, 33%)`;
        ctx.fillText(clip(ctx, b.name, w - 26 - cw), x + 9, ty);
        ctx.font = `500 10.5px ${MONO}`; ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'; ctx.textAlign = 'right';
        ctx.fillText(cnt, x + w - 9, ty); ctx.textAlign = 'left';
      }
      // zoomed out: the block lists its main modules instead of drawing cards
      if (!tier) {
        ctx.font = `500 10.5px ${UI}`; ctx.textBaseline = 'middle';
        const room = Math.floor((hh - 30) / 15);
        const list = b.members.filter(m => this.alive(this.nodes[m].born)), shown = list.length > room ? room - 1 : room;
        const fk = list.indexOf(f);
        if (fk >= shown && shown > 0) { list.splice(fk, 1); list.splice(shown - 1, 0, f); } // the focus is never under "+ more"
        list.forEach((m, k, all) => {
          if (k >= room) return;
          const n = this.nodes[m], more = k === room - 1 && all.length > room, ly = y + 30 + k * 15;
          const left = `+ ${all.length - k} more`, t = more
            ? (ctx.measureText(left).width <= w - 18 ? left : clip(ctx, `+${all.length - k}`, w - 18)) // a narrow block keeps "+N" inside its frame
            : clip(ctx, (n.kind === 'store' ? '◫ ' : '') + n.title, w - 22);
          if (m === f && !more) { // picked out like the card it was
            ctx.font = `600 10.5px ${UI}`;
            ctx.fillStyle = '#111111'; rrect(ctx, x + 5, ly - 7, Math.min(w - 10, ctx.measureText(t).width + 8), 14, 4); ctx.fill();
            ctx.fillStyle = '#ffffff'; ctx.fillText(t, x + 9, ly); ctx.font = `500 10.5px ${UI}`;
            return;
          }
          ctx.fillStyle = more ? 'rgba(0, 0, 0, 0.4)' : this.active.has(m) ? '#111111' : '#444444';
          ctx.fillText(t, x + 9, ly);
        });
        const act = [...new Set(b.members.flatMap(m => this.active.get(m) || []))];
        const pulse = 0.5 + 0.5 * Math.sin(time * 4);
        act.forEach((c, j) => { ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.globalAlpha = 0.5 + 0.5 * pulse; const g = 3 + j * 3 + pulse * 2; rrect(ctx, x - g, y - g, w + 2 * g, hh + 2 * g, 10); ctx.stroke(); });
      }
    });
    ctx.globalAlpha = 1;

    // district connectors (rules 4, 8, 9): one weight for all, thin enough zoomed out that neighbouring lanes stay apart
    // Counts are not printed along the lines of the overview (rule 9): only the lines of a hovered district or card carry them.
    const pills: { at: Run[]; t: string; c: string }[] = [];
    const lw = Math.min(3, Math.max(1.4, 12 * s * 0.4));
    for (const type of ['work', 'ref', 'imp'] as EdgeType[]) for (const u of shownBundles) {
      if (u.type !== type) continue;
      if (!u.pts) this.routeBundle(u);
      if (!u.pts || u.pts.length < 2) continue;
      const pts = u.pts.map(p => this.sp(p)), e = pts.length - 1;
      ctx.globalAlpha = type === 'work' ? 0.7 : 0.95;
      this.metroLine(pts, COL[type], lw, type === 'work' ? [6, 5] : null, Math.min(14, Math.max(5, 1.6 * G * s)), !!u.ab, !!u.ba);
      if (!u.ab) station(ctx, pts[e], COL[type], lw + 1.5);
      if (!u.ba) station(ctx, pts[0], COL[type], lw + 1.5);
      if (fb >= 0) pills.push({ at: mids(pts), t: String(u.n), c: COL[type] });
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
      const pts = octo(curves[k]).map(p => this.sp(p));
      ctx.globalAlpha = type === 'work' ? 0.75 : 0.95;
      this.metroLine(pts, COL[type], type === 'imp' ? 2.2 : 1.8, type === 'work' ? [5, 4] : null, 8, t.out, t.inn);
      if (t.n > 1) pills.push({ at: mids(pts), t: String(t.n), c: COL[type] });
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

    // counts on the focused lines: set beside the line like a station name, not on it, never on top of each other
    const taken: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const free = (r: { x0: number; y0: number; x1: number; y1: number }) => !taken.some(o => r.x0 < o.x1 && r.x1 > o.x0 && r.y0 < o.y1 && r.y1 > o.y0) && (taken.push(r), true);
    ctx.font = `600 10.5px ${MONO}`; ctx.textBaseline = 'middle';
    for (const p of pills) { // on the longest straight run that has room, else the next one
      const w = ctx.measureText(p.t).width, hh = 12;
      const spot = p.at.flatMap(r => { // above a level run, right of an upright one, else the other side
        const lvl = Math.abs(r.d[0]) >= Math.abs(r.d[1]), g = 4 + lw;
        return lvl ? [[r.m[0], r.m[1] - g - hh / 2], [r.m[0], r.m[1] + g + hh / 2]] as Pt[] : [[r.m[0] + g + w / 2, r.m[1]], [r.m[0] - g - w / 2, r.m[1]]] as Pt[];
      }).find(m => free({ x0: m[0] - w / 2 - 2, y0: m[1] - hh / 2, x1: m[0] + w / 2 + 2, y1: m[1] + hh / 2 }));
      if (!spot) continue;
      ctx.textAlign = 'center'; ctx.lineJoin = 'round';
      ctx.strokeStyle = BG; ctx.lineWidth = 4; ctx.strokeText(p.t, spot[0], spot[1] + 0.5);
      ctx.fillStyle = p.c; ctx.fillText(p.t, spot[0], spot[1] + 0.5);
      ctx.textAlign = 'left'; ctx.lineJoin = 'miter';
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
      ctx.strokeStyle = 'rgba(23, 152, 189, 0.3)'; ctx.lineWidth = 1; ctx.setLineDash([3, 7]);
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = `600 10.5px ${UI}`; ctx.textBaseline = 'bottom'; ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      const label = spaced(`EXPLORING  ${this.islands.length}`) + '   ↓', lx = Math.max(fl, Math.min(fr - 260, this.sx(left)));
      ctx.fillText(label, lx, gy - 6);
      // right after the label: the right side is where the legend sits
      const t = 'clear all  ✕', tx = lx + ctx.measureText(label).width + 28, tw = (ctx.font = `600 11.5px ${UI}`, ctx.measureText(t).width);
      ctx.fillStyle = '#333333'; ctx.fillText(t, tx, gy - 6);
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
      ctx.strokeStyle = n.kind === 'module' ? `hsl(${b.hue}, 60%, 42%)` : NODE[n.kind].stroke; ctx.globalAlpha = 0.85;
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
      const n = this.nodes[isl.f.i], st = n.kind === 'module' ? `hsl(${this.boxes[n.box].hue}, 55%, 42%)` : NODE[n.kind].stroke;
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
          rows.push({ h: 22, head: { t: bx.name, c: bx.outside ? '#6b6f78' : `hsl(${bx.hue}, 65%, 33%)`, sec: false } });
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
        const x = left ? me.x - REACH - CW - c * (CW + 44) : me.x + w + REACH + c * (CW + 44);
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
    const st = n.kind === 'module' ? `hsl(${this.boxes[n.box].hue}, 55%, 42%)` : NODE[n.kind].stroke;
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
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'; ctx.strokeStyle = on ? st : 'rgba(0, 0, 0, 0.2)'; ctx.lineWidth = on ? 1.4 : 1;
    rrect(ctx, X0, Y0, X1 - X0, Y1 - Y0, 14); ctx.fill(); ctx.stroke();
    // header: what this island is, and its close button
    ctx.textBaseline = 'middle'; ctx.font = `600 12px ${UI}`; ctx.fillStyle = on ? '#111111' : '#5c5c5c';
    const hy = Y0 + Math.min(ISLE_HEAD * s, 40) / 2 + 2;
    ctx.fillText(clip(ctx, `${n.title}  ·  ${this.boxes[n.box].name}`, X1 - X0 - 80), X0 + 16, hy);
    const cb = this.canvas.getBoundingClientRect(), cx = Math.max(X0 + 40, Math.min(X1 - 26, this.frameRect.right - cb.left - 28)), cr = 11; // never under the side panel
    ctx.strokeStyle = '#5c5c5c'; ctx.lineWidth = 1.6; ctx.beginPath();
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
    // ties (rule 12): out of the module's side, spread so they never cross at it, each down its own lane into
    // its card's near side. Of two ties going down the higher takes the lane farther out, going up the lower
    // does: then no two ever cross. The ones going up and the ones going down never overlap, so they share lanes.
    for (const left of [true, false]) {
      const side = F.cards.filter(c => c.left === left).sort((a, b) => a.y - b.y), sg = left ? -1 : 1, x0 = left ? me.x : me.x + me.w;
      const ends = side.map((c, k) => ({ c, r: rise.get(c)!, p0: [x0, me.y + 14 + (me.h - 28) * (k + 0.5) / side.length] as Pt, p3: [left ? c.x + CW : c.x, c.y + rise.get(c)!.dy + CH / 2] as Pt }));
      const down = ends.filter(e => e.p3[1] > e.p0[1] + 0.5), up = ends.filter(e => e.p3[1] < e.p0[1] - 0.5).reverse();
      const n = Math.max(down.length, up.length), step = Math.min(12, (REACH - 32) / Math.max(1, n)), lane = new Map<typeof ends[0], number>();
      const first = 16 + (REACH - 32 - (n - 1) * step) / 2;
      for (const list of [down, up]) list.forEach((e, k) => lane.set(e, x0 + sg * (first + (n - 1 - k) * step)));
      for (const e of ends) {
        const { c, r, p0, p3 } = e; if (!r.a) continue;
        const lx = lane.get(e), pts = (lx == null ? [p0, p3] : [p0, [lx, p0[1]], [lx, p3[1]], p3] as Pt[]).map(q => this.sp(q)), z = pts.length - 1;
        const hot = c.g ? this.hoverFold === c : hov === c.i;
        ctx.globalAlpha = r.a * (hov >= 0 && !hot ? 0.25 : c.type === 'work' ? 0.7 : 0.9);
        this.metroLine(pts, COL[c.type], hot ? 2.6 : 1.6, c.type === 'work' ? [5, 4] : null, 8, c.out, c.inn);
        if (c.g && r.a === 1) pills.push({ x: (pts[z - 1][0] + pts[z][0]) / 2, y: pts[z][1], t: String(c.g.n), c: COL[c.type] });
      }
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
    for (const q of pills) { const w = ctx.measureText(q.t).width + 10; ctx.fillStyle = '#ffffff'; rrect(ctx, q.x - w / 2, q.y - 8, w, 16, 8); ctx.fill(); ctx.strokeStyle = q.c; ctx.lineWidth = 1; ctx.stroke(); ctx.fillStyle = q.c; ctx.fillText(q.t, q.x, q.y + 0.5); }
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
      ctx.font = `500 12px ${UI}`; ctx.fillStyle = '#8c8c8c'; ctx.textAlign = 'center';
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
    if (p < 1) { ctx.font = `600 ${Math.max(11, 14 * lh)}px ${UI}`; ctx.fillStyle = '#111111'; ctx.fillText(clip(ctx, n.title, maxW), tx, y + hh / 2); return; }
    ctx.font = `600 ${9.5 * Math.max(1, lh)}px ${MONO}`; ctx.fillStyle = st; ctx.fillText(clip(ctx, `${NODE[n.kind].label.toUpperCase()} · ${this.boxes[n.box].name}`, maxW), tx, y + hh * 0.2);
    ctx.font = `600 ${Math.max(12, 16 * lh)}px ${UI}`; ctx.fillStyle = '#111111'; ctx.fillText(clip(ctx, n.title, maxW), tx, y + hh * 0.42);
    ctx.font = `400 ${Math.max(10, 11 * lh)}px ${MONO}`; ctx.fillStyle = '#7a7a7a';
    if (!this.boxes[n.box].outside) ctx.fillText(clip(ctx, n.sub, maxW), tx, y + hh * 0.62);
    ctx.fillStyle = '#555555'; ctx.fillText(clip(ctx, n.meta, maxW), tx, y + hh * 0.8);
  }

  private drawFold(c: FCard, x: number, y: number, w: number, hh: number, tier: number) {
    const ctx = this.ctx, g = c.g!, b = this.boxes[g.box], hot = this.hoverFold === c;
    const st = b.outside ? '#6b6f78' : `hsl(${b.hue}, 55%, 42%)`;
    ctx.fillStyle = '#ffffff'; ctx.strokeStyle = hot ? st : 'rgba(0, 0, 0, 0.3)'; ctx.lineWidth = hot ? 1.8 : 1; ctx.setLineDash([4, 3]);
    rrect(ctx, x, y, w, hh, 5); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = st; ctx.fillRect(x + 0.5, y + 3, 3, hh - 6);
    if (!tier) return;
    const ix = x + 10, maxW = w - 18;
    ctx.textBaseline = 'middle';
    if (tier === 1) { ctx.font = `600 11px ${UI}`; ctx.fillStyle = st; ctx.fillText(clip(ctx, `${b.name} · ${g.n}  ▸`, maxW), ix, y + hh / 2 + 0.5); return; }
    ctx.font = `600 12.5px ${UI}`; ctx.fillStyle = st; ctx.fillText(clip(ctx, `${b.name} · ${g.n} ${b.outside ? 'systems' : 'modules'}  ▸`, maxW), ix, y + hh * 0.34);
    ctx.font = `400 10px ${UI}`; ctx.fillStyle = '#7a7a7a'; ctx.fillText(clip(ctx, g.names, maxW), ix, y + hh * 0.7);
  }

  private drawCard(n: SNode, x: number, y: number, w: number, hh: number, tier: number, hot: boolean) {
    const ctx = this.ctx, b = this.boxes[n.box];
    const st = n.kind === 'module' ? `hsl(${b.hue}, 55%, 42%)` : NODE[n.kind].stroke;
    const r = Math.min(5, hh / 4);
    ctx.fillStyle = NODE[n.kind].fill; ctx.strokeStyle = hot ? st : 'rgba(0, 0, 0, 0.18)'; ctx.lineWidth = hot ? 2 : 1;
    rrect(ctx, x, y, w, hh, r); ctx.fill(); ctx.stroke();
    if (hot) { ctx.shadowColor = st; ctx.shadowBlur = 14; ctx.stroke(); ctx.shadowBlur = 0; }
    ctx.fillStyle = st; ctx.fillRect(x + 0.5, y + r * 0.6, Math.max(2, 3 * Math.min(1, this.view.s * 1.5)), hh - r * 1.2); // kind / district colour on the left edge
    if (!tier) return;
    const icon = n.kind !== 'module', ix = x + 8 + (icon ? (tier === 2 ? 20 : 15) : 0), maxW = x + w - 8 - ix;
    if (icon) this.icon(n.kind, x + (tier === 2 ? 17 : 13), y + (tier === 2 ? hh / 2 : hh / 2), st, tier === 2 ? 1 : 0.8);
    ctx.textBaseline = 'middle';
    if (tier === 1) {
      ctx.font = `600 11px ${UI}`; ctx.fillStyle = '#222222'; ctx.fillText(clip(ctx, n.title, maxW), ix, y + hh / 2 + 0.5);
      return;
    }
    ctx.font = `600 12.5px ${UI}`; ctx.fillStyle = '#111111'; ctx.fillText(clip(ctx, n.title, maxW), ix, y + hh * 0.34);
    ctx.font = `400 10px ${MONO}`; ctx.fillStyle = '#8c8c8c';
    const meta = n.meta, mw = Math.min(ctx.measureText(meta).width, maxW * 0.55);
    if (n.box >= 0 && !this.boxes[n.box].outside) ctx.fillText(clip(ctx, n.sub, maxW - mw - 10), ix, y + hh * 0.7); // the path; an outside group already names the kind
    ctx.fillStyle = '#5c5c5c'; ctx.textAlign = 'right'; ctx.fillText(clip(ctx, meta, mw), x + w - 8, y + hh * 0.7); ctx.textAlign = 'left';
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

  // A line on the diagram (rule 9): a dark casing first, so a line crossing or running beside another stays two lines.
  // With arrowheads the line stops at the head's base, and the head sits on the last straight run, never on a bend.
  private metroLine(pts: Pt[], color: string, lw: number, dash: number[] | null, r = 10, out = false, inn = false) {
    const ctx = this.ctx, e = pts.length - 1;
    const len = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);
    const head = (a: Pt, b: Pt) => Math.min(headLen(lw), Math.max(len(a, b) - 3, headLen(lw) * 0.8)); // a stunted head reads as a nick in the line
    const hOut = out ? head(pts[e - 1], pts[e]) : 0, hIn = inn ? head(pts[1], pts[0]) : 0;
    const line = pts.map(p => [p[0], p[1]] as Pt);
    if (hOut) line[e] = back(pts[e - 1], pts[e], hOut * 0.7);
    if (hIn) line[0] = back(pts[1], pts[0], hIn * 0.7);
    // Where it crosses a line drawn before it, it hops over in a small arc, so the two never read as one junction.
    // No hop near its ends or bends (the station, the arrowhead and the rounded corner keep their shape).
    const hr = Math.max(6, lw * 2 + 3), hops: number[][] = [];
    for (let i = 0; i < e; i++) {
      const a = line[i], b = line[i + 1], L = len(a, b);
      const lo = (i === 0 ? 4 : r) + hr + 2, hi = L - (i === e - 1 ? 4 : r) - hr - 2, ds: number[] = [];
      if (hi > lo) for (const [c, d] of this.segs) { const t = crossAt(a, b, c, d); if (t != null && t * L >= lo && t * L <= hi) ds.push(t * L); }
      ds.sort((x, y) => x - y);
      const kept: number[] = [];
      for (const dd of ds) if (!kept.length || dd - kept[kept.length - 1] >= 2 * hr + 3) kept.push(dd); // lines close together share one hop
      hops.push(kept);
    }
    ctx.beginPath(); roundedPath(ctx, line, r, hOut, hIn, hops, hr);
    ctx.strokeStyle = BG; ctx.lineWidth = lw + 3; ctx.stroke();
    ctx.setLineDash(dash ?? []); ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.stroke(); ctx.setLineDash([]);
    if (hOut) arrow(ctx, pts[e - 1], pts[e], hOut, lw, color);
    if (hIn) arrow(ctx, pts[1], pts[0], hIn, lw, color);
    for (let i = 0; i < e; i++) this.segs.push([line[i], line[i + 1]]);
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
    lines(40, 'rgba(0, 0, 0, 0.035)');
    lines(200, 'rgba(0, 0, 0, 0.06)');
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
// How far a line keeps from the corners of a container side this long: enough to read as clear of the corner zoomed out.
const inset = (side: number) => Math.max(14, Math.min(60, side * 0.12));
// Where a connector leaves a container, out of the side facing its first cell, clear of the corners, and
// the turn that keeps it at right angles when that cell sits off the side (past a corner, it turns in square).
function port(b: SBox, p: Pt): Pt[] {
  const ox = Math.max(b.x - p[0], p[0] - b.x - b.w, 0), oz = Math.max(b.y - p[1], p[1] - b.y - b.h, 0);
  if (oz >= ox) { // top or bottom
    const M = inset(b.w), x = Math.min(b.x + b.w - M, Math.max(b.x + M, p[0])), side = p[1] < b.y + b.h / 2 ? b.y : b.y + b.h;
    return x === p[0] ? [[x, side]] : [[x, side], [x, p[1]]];
  }
  const M = inset(b.h), z = Math.min(b.y + b.h - M, Math.max(b.y + M, p[1])), side = p[0] < b.x + b.w / 2 ? b.x : b.x + b.w;
  return z === p[1] ? [[side, z]] : [[side, z], [p[0], z]];
}
// The last run of a line must arrive square onto a side of container `b`, clear of its corners, so its arrow
// or station points into the container. A run that ends at a corner, or passes alongside, turns in instead.
function enter(pts: Pt[], b: SBox): Pt[] {
  const n = pts.length; if (n < 2) return pts;
  const p = pts[n - 1], q = pts[n - 2];
  if (q[1] !== p[1] && q[0] !== p[0]) return pts;
  const ax = q[1] === p[1] ? 0 : 1, ay = 1 - ax; // the axis the run goes along
  const lo = [b.x, b.y], hi = [b.x + b.w, b.y + b.h], M = inset(ay ? b.h : b.w), N = inset(ax ? b.h : b.w);
  if (p[ay] >= lo[ay] + M && p[ay] <= hi[ay] - M) { // faces a side: land right on it
    const e: Pt = [p[0], p[1]]; e[ax] = q[ax] < lo[ax] ? lo[ax] : q[ax] > hi[ax] ? hi[ax] : p[ax];
    return [...pts.slice(0, n - 1), e];
  }
  const side = p[ay] < (lo[ay] + hi[ay]) / 2 ? lo[ay] : hi[ay], gap = Math.abs(side - p[ay]);
  if (gap < 8 || (p[ay] > lo[ay] && p[ay] < hi[ay])) return pts; // no room to turn in
  const sg = Math.sign(p[ax] - q[ax]), near = sg > 0 ? lo[ax] + N + G : hi[ax] - N - G;
  let at = sg > 0 ? Math.max(q[ax], near) : Math.min(q[ax], near);
  at = Math.min(hi[ax] - N, Math.max(lo[ax] + N, at));
  const c: Pt = [0, 0], e: Pt = [0, 0]; c[ax] = at; c[ay] = p[ay]; e[ax] = at; e[ay] = side;
  return [...pts.slice(0, n - 1), c, e];
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
// Where run a→b crosses run c→d, as a fraction along a→b; null if they don't cross squarely enough to hop
// (parallel, glancing, or touching at either end of c→d, e.g. two lines leaving the same station).
function crossAt(a: Pt, b: Pt, c: Pt, d: Pt): number | null {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1], den = rx * sy - ry * sx;
  const lr = Math.hypot(rx, ry), ls = Math.hypot(sx, sy);
  if (!lr || !ls || Math.abs(den) < 0.3 * lr * ls) return null;
  const qx = c[0] - a[0], qy = c[1] - a[1], t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
  if (t <= 0 || t >= 1 || u * ls < 3 || u * ls > ls - 3) return null;
  return t;
}
// An orthogonal polyline with rounded corners. keepEnd/keepStart: room an arrowhead needs on the last/first
// run, so the bend before it finishes first. hops[i]: distances along run i where it arcs (radius hr) over
// another line, always bulging up the screen (left on a vertical run).
function roundedPath(ctx: CanvasRenderingContext2D, pts: Pt[], r: number, keepEnd = 0, keepStart = 0, hops: number[][] = [], hr = 0) {
  ctx.moveTo(pts[0][0], pts[0][1]);
  const n = pts.length;
  const jump = (i: number) => {
    const ds = hops[i]; if (!ds?.length) return;
    const [ax, ay] = pts[i], L = Math.hypot(pts[i + 1][0] - ax, pts[i + 1][1] - ay), ux = (pts[i + 1][0] - ax) / L, uy = (pts[i + 1][1] - ay) / L;
    // a clockwise arc from behind the crossing to past it bulges to (uy, -ux); go anticlockwise when that points down/right
    const th = Math.atan2(uy, ux), up = ux > 1e-6 || (Math.abs(ux) <= 1e-6 && uy < 0);
    for (const d of ds) {
      const cx = ax + ux * d, cy = ay + uy * d;
      ctx.lineTo(cx - ux * hr, cy - uy * hr);
      ctx.arc(cx, cy, hr, th + Math.PI, th, !up);
    }
  };
  for (let i = 1; i < n - 1; i++) {
    jump(i - 1);
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], [cx, cy] = pts[i + 1];
    const l0 = Math.hypot(bx - ax, by - ay) - (i === 1 ? keepStart * 0.3 : 0), l1 = Math.hypot(cx - bx, cy - by) - (i === n - 2 ? keepEnd * 0.3 : 0);
    ctx.arcTo(bx, by, cx, cy, Math.max(0, Math.min(r, l0 / 2, l1 / 2)));
  }
  jump(n - 2);
  ctx.lineTo(pts[n - 1][0], pts[n - 1][1]);
}
// The point `d` back from `to` towards `from`.
function back(from: Pt, to: Pt, d: number): Pt {
  const l = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
  return [to[0] - (to[0] - from[0]) * d / l, to[1] - (to[1] - from[1]) * d / l];
}
// How long an arrowhead is on a line of width lw: in proportion, as on a printed diagram.
const headLen = (lw: number) => 5 + lw * 2.2;
// A slim arrowhead with a notched back, its tip on `to`, cased like the line so two heads side by side stay apart.
function arrow(ctx: CanvasRenderingContext2D, from: Pt, to: Pt, len: number, lw: number, color: string) {
  const dx = to[0] - from[0], dy = to[1] - from[1], l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l;
  const hw = Math.max(lw * 1.5, len * 0.42), bx = to[0] - ux * len, by = to[1] - uy * len, nx = to[0] - ux * len * 0.72, ny = to[1] - uy * len * 0.72;
  ctx.beginPath(); ctx.moveTo(to[0], to[1]);
  ctx.lineTo(bx + uy * hw, by - ux * hw); ctx.lineTo(nx, ny); ctx.lineTo(bx - uy * hw, by + ux * hw); ctx.closePath();
  ctx.lineJoin = 'round'; ctx.strokeStyle = BG; ctx.lineWidth = 2.5; ctx.stroke(); ctx.lineJoin = 'miter';
  ctx.fillStyle = color; ctx.fill();
}
// The station a line starts from (rule 9): a ring in the line's colour with a light centre.
function station(ctx: CanvasRenderingContext2D, p: Pt, color: string, r: number) {
  ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.lineWidth = Math.max(1.2, r * 0.5); ctx.strokeStyle = color; ctx.stroke();
}
// The middles of a polyline's straight runs and which way they go, longest first: where its label reads best.
interface Run { m: Pt; d: Pt }
function mids(pts: Pt[]): Run[] {
  const runs = pts.slice(1).map((p, i) => ({ m: [(pts[i][0] + p[0]) / 2, (pts[i][1] + p[1]) / 2] as Pt, d: [p[0] - pts[i][0], p[1] - pts[i][1]] as Pt, l: Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]) }));
  runs.sort((a, b) => b.l - a.l);
  return runs.filter((r, k) => !k || r.l >= 28);
}
// Rule 8: a short jog between two straight runs going the same way becomes one 45° diagonal,
// where the diagonal clears every container and leaves the runs at either end some length.
function diagonals(pts: Pt[], solid: R[]): Pt[] {
  const out = pts.map(p => [p[0], p[1]] as Pt);
  for (let i = 1; i + 2 < out.length; i++) {
    const a = out[i - 1], b = out[i], c = out[i + 1], d = out[i + 2];
    const ax: number = a[1] === b[1] && c[1] === d[1] && b[0] === c[0] ? 0 : a[0] === b[0] && c[0] === d[0] && b[1] === c[1] ? 1 : -1; // the axis the runs go along
    if (ax < 0) continue;
    const ay = 1 - ax, jog = Math.abs(c[ay] - b[ay]), half = jog / 2, sg = Math.sign(b[ax] - a[ax]);
    if (!jog || jog > JOG || !sg || sg !== Math.sign(d[ax] - c[ax])) continue; // a Z, not a U
    const stub = (k: number) => k === 0 || k === out.length - 1 ? 8 : 0; // out of a container, a line starts straight
    if (Math.abs(b[ax] - a[ax]) < half + stub(i - 1) || Math.abs(d[ax] - c[ax]) < half + stub(i + 2)) continue;
    const nb: Pt = [b[0], b[1]], nc: Pt = [c[0], c[1]];
    nb[ax] -= sg * half; nc[ax] += sg * half;
    if (solid.some(r => segHits(nb, nc, r))) continue;
    out[i] = nb; out[i + 1] = nc; i++;
  }
  return out;
}
// Drop repeated points and points in the middle of a straight run.
function collinear(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    if (out.length && out[out.length - 1][0] === p[0] && out[out.length - 1][1] === p[1]) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2], b = out[out.length - 1];
      if ((b[0] - a[0]) * (p[1] - b[1]) === (b[1] - a[1]) * (p[0] - b[0])) out.pop();
    }
    out.push(p);
  }
  return out;
}
// The simplest lines between two containers, simplest first (rule 8): straight across facing sides, then
// straight out, one 45° diagonal, straight in; then, keeping the ports of the grid's route, one right-angle turn.
function taut(a: SBox, b: SBox, route: Pt[]): Pt[][] {
  const out: Pt[][] = []; // ports keep inset() from a container's corners
  for (const ax of [1, 0]) { // 1: one container above the other, 0: side by side
    const ay = 1 - ax, lo = (r: SBox) => ax ? r.y : r.x, hi = (r: SBox) => ax ? r.y + r.h : r.x + r.w;
    const xlo = (r: SBox) => (ax ? r.x : r.y) + inset(ax ? r.w : r.h), xhi = (r: SBox) => (ax ? r.x + r.w : r.y + r.h) - inset(ax ? r.w : r.h);
    const [f, t] = hi(a) <= lo(b) ? [a, b] : hi(b) <= lo(a) ? [b, a] : [null, null];
    if (!f || !t) continue;
    const gap = lo(t) - hi(f), flip = f !== a;
    const at = (along: number, across: number): Pt => { const p: Pt = [0, 0]; p[ax] = along; p[ay] = across; return p; };
    const line = (pts: Pt[]) => out.push(flip ? pts.reverse() : pts);
    // straight: anywhere both containers face each other, from the middle of that stretch outwards
    // (a lane short of that, still straight down the middle: a little nearer a corner beats a nick in the line)
    const s0 = Math.max(xlo(f), xlo(t)), s1 = Math.min(xhi(f), xhi(t));
    if (s0 <= s1 + G) for (const d of [0, 1, -1, 2, -2, 3, -3]) {
      const c = (s0 + s1) / 2 + d * G;
      if (c >= Math.min(s0, s1) && c <= Math.max(s0, s1) || !d) line([at(hi(f), c), at(lo(t), c)]);
    }
    // straight, one diagonal, straight: from the nearest ends of the two sides
    const cf = Math.min(xhi(f), Math.max(xlo(f), (xlo(t) + xhi(t)) / 2)), ct = Math.min(xhi(t), Math.max(xlo(t), (xlo(f) + xhi(f)) / 2));
    for (const d of [0, 1, -1, 2, -2]) {
      const pf = Math.min(xhi(f), Math.max(xlo(f), cf + d * G)), pt = Math.min(xhi(t), Math.max(xlo(t), ct + d * G)), across = Math.abs(pt - pf);
      if (across < G || across > gap - 40) continue; // a shorter jog is a nick, not a diagonal; each end leaves straight for a while
      const run = (gap - across) / 2;
      line([at(hi(f), pf), at(hi(f) + run, pf), at(lo(t) - run, pt), at(lo(t), pt)]);
    }
  }
  // one turn, out of the grid route's first port and into its last
  const p0 = route[0], pn = route[route.length - 1], q0 = route[1], qn = route[route.length - 2];
  if (q0 && qn) {
    const ax0 = p0[1] === q0[1] ? 0 : 1, axn = pn[1] === qn[1] ? 0 : 1;
    if (ax0 !== axn) {
      const c: Pt = [0, 0]; c[ax0] = pn[ax0]; c[axn] = p0[axn];
      if (Math.sign(c[ax0] - p0[ax0]) === Math.sign(q0[ax0] - p0[ax0]) && Math.sign(pn[axn] - c[axn]) === Math.sign(pn[axn] - qn[axn])) out.push([p0, c, pn]);
    }
  }
  return out;
}
// Do two segments run in the same lane (parallel, less than half a lane apart, overlapping)?
function sameLane(p: Pt, q: Pt, s: Pt, t: Pt) {
  const dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy), ex = t[0] - s[0], ey = t[1] - s[1], E = Math.hypot(ex, ey);
  if (!L || !E) return false;
  const ux = dx / L, uy = dy / L;
  if (Math.abs(ux * ey - uy * ex) > 0.01 * E) return false;
  if (Math.abs((s[0] - p[0]) * uy - (s[1] - p[1]) * ux) > G / 2) return false;
  const a0 = (s[0] - p[0]) * ux + (s[1] - p[1]) * uy, a1 = (t[0] - p[0]) * ux + (t[1] - p[1]) * uy;
  return Math.min(Math.max(a0, a1), L) - Math.max(Math.min(a0, a1), 0) > 2;
}
// Does the segment p-q pass through the rectangle (Liang-Barsky)?
function segHits(p: Pt, q: Pt, r: R) {
  let t0 = 0, t1 = 1;
  const dx = q[0] - p[0], dy = q[1] - p[1];
  for (const [pp, qq] of [[-dx, p[0] - r.x], [dx, r.x + r.w - p[0]], [-dy, p[1] - r.y], [dy, r.y + r.h - p[1]]]) {
    if (pp === 0) { if (qq < 0) return false; continue; }
    const t = qq / pp;
    if (pp < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}
// A focused tie drawn as a metro line (rule 12): straight out of the card, one 45° diagonal, straight in.
// When the cards are farther apart across than along, the diagonals frame a straight middle run.
// Cards stacked in one column keep their bracket out of the right edges, squared off.
function octo([p0, c1, c2, p3]: [Pt, Pt, Pt, Pt]): Pt[] {
  const ax = c1[1] === p0[1] ? 0 : 1, ay = 1 - ax;
  const mv = (p: Pt, da: number, db: number): Pt => { const q: Pt = [p[0], p[1]]; q[ax] += da; q[ay] += db; return q; };
  const sg = Math.sign(c1[ax] - p0[ax]) || 1;
  if (sg !== (Math.sign(p3[ax] - c2[ax]) || 1)) { // the bracket
    const far = sg > 0 ? Math.max(c1[ax], c2[ax]) : Math.min(c1[ax], c2[ax]);
    return [p0, mv(p0, far - p0[ax], 0), mv(p3, far - p3[ax], 0), p3];
  }
  const along = Math.abs(p3[ax] - p0[ax]), across = Math.abs(p3[ay] - p0[ay]), sa = Math.sign(p3[ay] - p0[ay]);
  const stub = Math.min(14, along / 4);
  if (across <= along - 2 * stub) {
    const run = (along - across) / 2, q1 = mv(p0, sg * run, 0);
    return [p0, q1, mv(q1, sg * across, sa * across), p3];
  }
  const d = Math.max(0, (along - 2 * stub) / 2), q1 = mv(p0, sg * stub, 0), q4 = mv(p3, -sg * stub, 0);
  return [p0, q1, mv(q1, sg * d, sa * d), mv(q4, -sg * d, -sa * d), q4, p3];
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
