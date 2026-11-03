// Streets: ties between places are routed through the open ground between plots on
// a unit grid, so they run straight, turn at right angles and share a street where
// one already goes the right way. Used for the city's roads and the schematic's
// connectors (with different costs).

export interface Rect { x0: number; z0: number; x1: number; z1: number }
export interface RouteCost { share: number; turn: number; near: number } // step on a used street; per turn; next to a plot
export type Pt = [number, number];

export class StreetGrid {
  readonly S = 1;
  nx: number; nz: number; ox: number; oz: number;
  owner: Int32Array;      // -1 open ground, else the place standing on the cell
  near: Uint8Array;       // open cell touching a plot
  use: Uint16Array;       // per cell: [east edge, south edge] street usage
  private rings: Int32Array[];
  private g: Float32Array; private from: Int32Array; private touched: number[] = [];
  private goal: Uint8Array;

  constructor(public places: Rect[], pad = 0.35, margin = 6) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const p of places) { x0 = Math.min(x0, p.x0); z0 = Math.min(z0, p.z0); x1 = Math.max(x1, p.x1); z1 = Math.max(z1, p.z1); }
    if (!places.length) x0 = z0 = x1 = z1 = 0;
    this.ox = Math.floor(x0) - margin; this.oz = Math.floor(z0) - margin;
    this.nx = Math.ceil(x1 - this.ox) + margin; this.nz = Math.ceil(z1 - this.oz) + margin;
    const N = this.nx * this.nz;
    this.owner = new Int32Array(N).fill(-1);
    this.near = new Uint8Array(N);
    this.use = new Uint16Array(N * 2);
    this.g = new Float32Array(N * 5).fill(Infinity);
    this.from = new Int32Array(N * 5);
    this.goal = new Uint8Array(N);
    places.forEach((p, k) => {
      const [i0, j0, i1, j1] = this.span(p, pad);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.owner[j * this.nx + i] = k;
    });
    // every place gets a ring of open cells to start and end its streets on
    this.rings = places.map((p, k) => {
      const [i0, j0, i1, j1] = this.span(p, pad), out: number[] = [];
      for (let j = j0 - 1; j <= j1 + 1; j++) for (let i = i0 - 1; i <= i1 + 1; i++) {
        if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) continue;
        const c = j * this.nx + i;
        if (this.owner[c] !== -1) continue;
        const side = (i < i0 || i > i1) !== (j < j0 || j > j1); // not a corner
        if (side && this.touches(c, k)) out.push(c);
      }
      return Int32Array.from(out);
    });
    for (let c = 0; c < N; c++) if (this.owner[c] === -1) for (const n of this.nbrs(c)) if (n >= 0 && this.owner[n] !== -1) { this.near[c] = 1; break; }
  }

  // cells whose centre lies inside the padded footprint (at least one)
  private span(p: Rect, pad: number) {
    const ci = (x: number) => (x - this.ox) / this.S - 0.5, cj = (z: number) => (z - this.oz) / this.S - 0.5;
    let i0 = Math.ceil(ci(p.x0 - pad)), i1 = Math.floor(ci(p.x1 + pad)), j0 = Math.ceil(cj(p.z0 - pad)), j1 = Math.floor(cj(p.z1 + pad));
    if (i1 < i0) i0 = i1 = Math.round(ci((p.x0 + p.x1) / 2));
    if (j1 < j0) j0 = j1 = Math.round(cj((p.z0 + p.z1) / 2));
    return [Math.max(0, i0), Math.max(0, j0), Math.min(this.nx - 1, i1), Math.min(this.nz - 1, j1)];
  }
  private touches(c: number, k: number) { return this.nbrs(c).some(n => n >= 0 && this.owner[n] === k); }
  // east, west, south, north (-1 off the grid)
  nbrs(c: number): number[] {
    const i = c % this.nx, j = (c - i) / this.nx;
    return [i + 1 < this.nx ? c + 1 : -1, i > 0 ? c - 1 : -1, j + 1 < this.nz ? c + this.nx : -1, j > 0 ? c - this.nx : -1];
  }
  // the street between c and its neighbour in direction d
  edge(c: number, d: number) { return d === 0 ? c * 2 : d === 1 ? (c - 1) * 2 : d === 2 ? c * 2 + 1 : (c - this.nx) * 2 + 1; }
  center(c: number): Pt { const i = c % this.nx; return [this.ox + (i + 0.5) * this.S, this.oz + ((c - i) / this.nx + 0.5) * this.S]; }

  // Cheapest street from place a to place b, as a list of cells; null if walled in.
  // `laid` keeps to the streets already laid (for vehicles), null if they don't connect.
  route(a: number, b: number, cost: RouteCost, laid = false): number[] | null {
    const A = this.rings[a], B = this.rings[b];
    if (!A?.length || !B?.length || a === b) return null;
    for (const c of B) this.goal[c] = 1;
    const tb = this.places[b];
    const hx = (tb.x0 + tb.x1) / 2, hz = (tb.z0 + tb.z1) / 2, hw = (tb.x1 - tb.x0) / 2 + 1, hh = (tb.z1 - tb.z0) / 2 + 1;
    const lo = Math.min(cost.share, 1);
    const hOf = (c: number) => { const [x, z] = this.center(c); return (Math.max(0, Math.abs(x - hx) - hw) + Math.max(0, Math.abs(z - hz) - hh)) * lo; };
    const heap = new Heap();
    for (const c of A) { const s = c * 5 + 4; this.g[s] = 0; this.from[s] = -1; this.touched.push(s); heap.push(s, hOf(c)); }
    let end = -1;
    while (heap.size) {
      const s = heap.pop(), c = (s / 5) | 0, d0 = s % 5, gs = this.g[s];
      if (this.goal[c]) { end = s; break; }
      const ns = this.nbrs(c);
      for (let d = 0; d < 4; d++) {
        const n = ns[d];
        if (n < 0 || this.owner[n] !== -1) continue;
        if (laid && !this.use[this.edge(c, d)]) continue;
        let w = this.use[this.edge(c, d)] ? cost.share : 1;
        if (d0 !== 4 && d0 !== d) w += cost.turn;
        if (this.near[n]) w += cost.near;
        const t = n * 5 + d, gn = gs + w;
        if (gn < this.g[t]) { if (this.g[t] === Infinity) this.touched.push(t); this.g[t] = gn; this.from[t] = s; heap.push(t, gn + hOf(n)); }
      }
    }
    for (const c of B) this.goal[c] = 0;
    let path: number[] | null = null;
    if (end >= 0) { path = []; for (let s = end; s >= 0; s = this.from[s]) path.push((s / 5) | 0); path.reverse(); }
    for (const s of this.touched) this.g[s] = Infinity;
    this.touched.length = 0;
    return path;
  }

  // Mark a routed path as street, so later routes like to share it.
  lay(path: number[]) { for (let k = 1; k < path.length; k++) this.use[this.edgeBetween(path[k - 1], path[k])]++; }
  edgeBetween(a: number, b: number) { const d = b === a + 1 ? 0 : b === a - 1 ? 1 : b === a + this.nx ? 2 : 3; return this.edge(a, d); }

  // A path's corners in world coordinates.
  corners(path: number[]): Pt[] {
    const out: Pt[] = [];
    for (let k = 0; k < path.length; k++) {
      if (k > 0 && k < path.length - 1 && path[k] - path[k - 1] === path[k + 1] - path[k]) continue;
      out.push(this.center(path[k]));
    }
    return out;
  }
}

class Heap {
  private k: number[] = []; private v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (v[p] <= val) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = k[0], lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      let i = 0; const n = k.length;
      while (true) {
        let c = 2 * i + 1; if (c >= n) break;
        if (c + 1 < n && v[c + 1] < v[c]) c++;
        if (v[c] >= lv) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}
