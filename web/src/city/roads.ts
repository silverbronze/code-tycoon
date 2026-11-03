import * as THREE from 'three';
import type { City } from '../api';
import { StreetGrid, type Pt } from './route';
import { ENV } from './env';

// Small things (people, cars, birds) must never show before the buildings around them
// can be told apart: they grow in from nothing between `gone` and `full` (viewSize).
export const PEOPLE_GONE = 60, PEOPLE_FULL = 45;
export const CARS_GONE = 100, CARS_FULL = 80;
export const zoomGate = (zoom: number, gone: number, full: number) =>
  Math.min(1, Math.max(0, (gone - zoom) / (gone - full)));

// Roads: the strongest ties between places, routed as streets through the open
// ground (route.ts). Every piece is a flat quad of asphalt with curbs, edge lines and
// a centre line (double amber on main streets); junction patches sit where streets
// meet or turn. aRoad = (along, across, length, half width), aKind 0 street, 1 main
// street, 2 junction. Each vertex carries its piece's birth (seconds since the city
// began), so a replay lays a street only once a tie that uses it exists.
function roadMaterial(uT: { value: number }, uTime: { value: number }) {
  const m = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.92, metalness: 0.05 });
  m.onBeforeCompile = sh => {
    sh.uniforms.uT = uT; sh.uniforms.uTime = uTime; sh.uniforms.uNight = ENV.night;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aBorn; attribute vec4 aRoad; attribute float aKind; attribute float aGlow; attribute vec3 aCol; uniform float uT;
        varying vec4 vRoad; varying float vKind; varying float vGlow; varying vec3 vCol;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vRoad = aRoad; vKind = aKind; vGlow = aGlow; vCol = aCol;
        if (aBorn > uT) transformed = vec3(0.0);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime; uniform float uNight; varying vec4 vRoad; varying float vKind; varying float vGlow; varying vec3 vCol;
        // a line of half width w around d == 0 that fades out instead of shimmering when thinner than a pixel
        float line(float d, float w) { float f = max(fwidth(d), 1e-4); return clamp((w - abs(d)) / f + 0.5, 0.0, 1.0) * clamp(w * 2.5 / f, 0.0, 1.0); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float ac = abs(vRoad.y), hw = vRoad.w;
        float curb = vKind < 1.5 ? smoothstep(hw - 0.1, hw - 0.07, ac) : 0.0;
        float edgeL = 0.0, paint = 0.0;
        if (vKind < 1.5) {
          float ends = step(0.35, vRoad.x) * step(vRoad.x, vRoad.z - 0.35);
          edgeL = line(ac - (hw - 0.17), 0.02);
          paint = ends * (vKind > 0.5 ? max(line(vRoad.y - 0.055, 0.02), line(vRoad.y + 0.055, 0.02))
                                      : line(vRoad.y, 0.022) * step(fract(vRoad.x * 1.1), 0.5));
        }
        // dark asphalt with glowing lines at night; grey asphalt with painted lines by day
        diffuseColor.rgb = mix(mix(vec3(0.2, 0.2, 0.21), vec3(0.42, 0.42, 0.43), curb), mix(vec3(0.085, 0.09, 0.105), vec3(0.2, 0.21, 0.24), curb), uNight);
        float day = 1.0 - uNight;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85), edgeL * 0.7 * day);
        diffuseColor.rgb = mix(diffuseColor.rgb, vKind > 0.5 ? vec3(0.95, 0.62, 0.12) : vec3(0.9), paint * day);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(0.5, 0.53, 0.6) * edgeL * 0.22 * uNight;
        totalEmissiveRadiance += (vKind > 0.5 ? vec3(1.0, 0.7, 0.25) : vec3(0.8, 0.8, 0.76)) * paint * 0.5 * uNight;
        // traffic: the session's colour washes along the street
        float flow = 0.5 + 0.5 * sin(vRoad.x * 2.4 - uTime * 7.0);
        totalEmissiveRadiance += vCol * vGlow * (0.16 + 0.4 * flow) * (1.0 - curb * 0.6);`);
  };
  return m;
}

export type Ref = [number, number];
export const refKey = (r: Ref) => r[0] + ':' + r[1];
// A car on its way along a street (session traffic).
interface Car { pts: Pt[]; cum: number[]; s: number; v: number; color: THREE.Color }
const MAX_CARS = 160;
const Y = 0.07, PATCH_Y = 0.074;
const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpP = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);

// Cost of laying a street: sharing a street is cheap, so ties bundle into avenues.
export const ROAD_COST = { share: 0.35, turn: 0.6, near: 0.15 };

export class Roads {
  group = new THREE.Group();
  grid: StreetGrid;
  places: Ref[] = []; placeIdx = new Map<string, number>();
  linkPts = new Map<number, Pt[]>();          // road link -> its street, plot to plot
  private pairs = new Map<string, number>();  // "a|b" -> road link
  private linkQuads = new Map<number, number[]>();
  private glow: Float32Array; private hold: Float32Array; private shown: Float32Array;
  private glowAttr: THREE.BufferAttribute; private colAttr: THREE.BufferAttribute;
  private cars: Car[] = []; private carMesh: THREE.InstancedMesh;
  traffic = true;

  // rects: every place's plot (by plate), t0: the city's start (ms)
  constructor(public city: City, private rects: { ref: Ref; x: number; z: number; w: number; h: number }[], t0: number, uT: { value: number }, uTime: { value: number }) {
    rects.forEach((r, k) => { this.places.push(r.ref); this.placeIdx.set(refKey(r.ref), k); });
    this.grid = new StreetGrid(rects.map(r => ({ x0: r.x, z0: r.z, x1: r.x + r.w, z1: r.z + r.h })));
    const G = this.grid, nx = G.nx;

    // route the strongest ties first, so they lay the avenues the rest join
    const order = city.links.map((l, k) => ({ l, k })).filter(x => x.l.road).sort((a, b) => b.l.w - a.l.w);
    const paths = new Map<number, number[]>();
    const edgeBorn = new Float64Array(G.use.length).fill(Infinity);
    for (const { l, k } of order) {
      const a = this.placeIdx.get(refKey(l.a as Ref)), b = this.placeIdx.get(refKey(l.b as Ref));
      if (a == null || b == null) continue;
      const p = G.route(a, b, ROAD_COST);
      if (!p) continue;
      G.lay(p); paths.set(k, p);
      const born = ((l.born ?? t0) - t0) / 1000;
      for (let i = 1; i < p.length; i++) { const e = G.edgeBetween(p[i - 1], p[i]); edgeBorn[e] = Math.min(edgeBorn[e], born); }
      this.pairs.set(refKey(l.a as Ref) + '|' + refKey(l.b as Ref), k);
      this.pairs.set(refKey(l.b as Ref) + '|' + refKey(l.a as Ref), k);
    }

    // street pieces: straight runs of grid edges, split at junctions, turns and
    // wherever the street's class or birth changes
    const hwOf = (u: number) => u >= 6 ? 0.6 : u >= 3 ? 0.5 : 0.42;
    const deg = (c: number) => { let d = 0; for (let k = 0; k < 4; k++) { const n = G.nbrs(c)[k]; if (n >= 0 && G.use[G.edge(c, k)]) d++; } return d; };
    const straight = (c: number) => { const u = (k: number) => G.nbrs(c)[k] >= 0 && G.use[G.edge(c, k)] > 0; return deg(c) === 2 && ((u(0) && u(1)) || (u(2) && u(3))); };
    const pos: number[] = [], road: number[] = [], kind: number[] = [], born: number[] = [], idx: number[] = [];
    const quadOfEdge = new Int32Array(G.use.length).fill(-1), patchOfCell = new Map<number, number>();
    let q = 0;
    const quad = (ax: number, az: number, bx: number, bz: number, hw: number, k: number, br: number, y: number) => {
      const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 1, nx_ = -dz / len * hw, nz_ = dx / len * hw;
      pos.push(ax + nx_, y, az + nz_, ax - nx_, y, az - nz_, bx + nx_, y, bz + nz_, bx - nx_, y, bz - nz_);
      road.push(0, hw, len, hw, 0, -hw, len, hw, len, hw, len, hw, len, -hw, len, hw);
      kind.push(k, k, k, k); born.push(br, br, br, br);
      const o = q * 4; idx.push(o, o + 2, o + 1, o + 1, o + 2, o + 3);
      return q++;
    };
    for (const horiz of [true, false]) {
      const dir = horiz ? 0 : 2, step = horiz ? 1 : nx;
      for (let c = 0; c < G.owner.length; c++) {
        const e = G.edge(c, dir);
        if (G.nbrs(c)[dir] < 0 || !G.use[e] || quadOfEdge[e] >= 0) continue;
        // walk the run
        const run = [e]; let end = c + step;
        const cls = hwOf(G.use[e]), br = edgeBorn[e];
        while (straight(end) && G.nbrs(end)[dir] >= 0) {
          const e2 = G.edge(end, dir);
          if (!G.use[e2] || hwOf(G.use[e2]) !== cls || edgeBorn[e2] !== br) break;
          run.push(e2); end += step;
        }
        const [ax, az] = G.center(c), [bx, bz] = G.center(end);
        const k = quad(ax, az, bx, bz, cls, cls >= 0.6 ? 1 : 0, br, Y);
        for (const x of run) quadOfEdge[x] = k;
      }
    }
    // junctions, turns and dead ends get a plain square of asphalt
    for (let c = 0; c < G.owner.length; c++) {
      if (G.owner[c] !== -1 || !deg(c) || straight(c)) continue;
      let hw = 0, br = Infinity;
      for (let k = 0; k < 4; k++) if (G.nbrs(c)[k] >= 0 && G.use[G.edge(c, k)]) { const e = G.edge(c, k); hw = Math.max(hw, hwOf(G.use[e])); br = Math.min(br, edgeBorn[e]); }
      const [x, z] = G.center(c);
      patchOfCell.set(c, quad(x - hw, z, x + hw, z, hw, 2, br, PATCH_Y));
    }
    // driveways: where a street ends at a plot, it runs on under the plate
    const drive = new Set<string>();
    for (const [k, p] of paths) {
      const l = city.links[k], ends: [number, number][] = [[p[0], this.placeIdx.get(refKey(l.a as Ref))!], [p[p.length - 1], this.placeIdx.get(refKey(l.b as Ref))!]];
      const pts = G.corners(p);
      const quads = new Set<number>();
      for (let i = 1; i < p.length; i++) quads.add(quadOfEdge[G.edgeBetween(p[i - 1], p[i])]);
      for (const c of p) { const pq = patchOfCell.get(c); if (pq != null) quads.add(pq); }
      ends.forEach(([c, place], j) => {
        const d = G.nbrs(c).findIndex(n => n >= 0 && G.owner[n] === place);
        if (d < 0) return;
        const [x, z] = G.center(c), [px, pz] = G.center(G.nbrs(c)[d]);
        if (j === 0) pts.unshift([px, pz]); else pts.push([px, pz]);
        if (drive.has(c + ':' + d)) return;
        drive.add(c + ':' + d);
        quads.add(quad(x, z, px, pz, 0.36, 0, edgeBorn[G.edgeBetween(p[j ? p.length - 2 : 0], p[j ? p.length - 1 : 1])] ?? 0, Y - 0.004));
      });
      this.linkPts.set(k, pts);
      this.linkQuads.set(k, [...quads].filter(x => x >= 0));
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(Array.from({ length: q * 4 }, () => [0, 1, 0]).flat(), 3));
    g.setAttribute('aRoad', new THREE.Float32BufferAttribute(road, 4));
    g.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1));
    g.setAttribute('aBorn', new THREE.Float32BufferAttribute(born, 1));
    this.glowAttr = new THREE.BufferAttribute(new Float32Array(q * 4), 1).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(q * 12).fill(1), 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aGlow', this.glowAttr); g.setAttribute('aCol', this.colAttr);
    g.setIndex(idx);
    const mesh = new THREE.Mesh(g, roadMaterial(uT, uTime));
    mesh.receiveShadow = true; mesh.frustumCulled = false;
    this.glow = new Float32Array(q); this.hold = new Float32Array(q); this.shown = new Float32Array(q);

    // cars: a small glowing body with a brighter cab, in the session's colour
    this.carMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.16, 0.24).translate(0, 0.1, 0), new THREE.MeshBasicMaterial({ color: '#ffffff' }), MAX_CARS);
    this.carMesh.count = 0; this.carMesh.frustumCulled = false;
    this.group.add(mesh, this.carMesh);
  }

  private paint(quads: number[], c: THREE.Color) {
    for (const k of quads) for (let j = 0; j < 4; j++) this.colAttr.setXYZ(k * 4 + j, c.r, c.g, c.b);
    this.colAttr.needsUpdate = true;
  }

  // A session went from one place to another: light its street and send a car.
  travel(from: Ref, to: Ref, color: THREE.Color) {
    const k = this.pairs.get(refKey(from) + '|' + refKey(to));
    if (k == null) return false;
    const quads = this.linkQuads.get(k)!;
    for (const q of quads) this.glow[q] = 1;
    this.paint(quads, color);
    if (this.traffic) {
      let pts = this.linkPts.get(k)!;
      if (refKey(this.city.links[k].a as Ref) !== refKey(from)) pts = [...pts].reverse();
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      if (this.cars.length >= MAX_CARS) this.cars.shift();
      this.cars.push({ pts, cum, s: 0, v: Math.max(7, cum[cum.length - 1] / 2.2), color: color.clone().multiplyScalar(0.9) });
    }
    return true;
  }

  // Hold the streets of a selected place lit, each in the colour of its tie.
  select(list: { k: number; color: THREE.Color }[]) {
    this.hold.fill(0);
    for (const { k, color } of list) { const qs = this.linkQuads.get(k); if (!qs) continue; for (const q of qs) this.hold[q] = 0.75; this.paint(qs, color); }
  }
  hasRoad(k: number) { return this.linkQuads.has(k); }

  // Open ground at (x, z) with no street on it: somewhere a prop can stand.
  free(x: number, z: number) {
    const G = this.grid, i = Math.floor((x - G.ox) / G.S), j = Math.floor((z - G.oz) / G.S);
    if (i < 0 || j < 0 || i >= G.nx || j >= G.nz) return true;
    const c = j * G.nx + i;
    if (G.owner[c] !== -1) return false;
    const ns = G.nbrs(c);
    for (let d = 0; d < 4; d++) if (ns[d] >= 0 && G.use[G.edge(c, d)]) return false;
    return true;
  }

  // A drivable way from one place to another for the city's own vehicles (buses,
  // ambulances): the laid street if the two are tied, else a way over the laid
  // streets (null if they don't connect). Routes are cached until the roads are rebuilt.
  private routes = new Map<string, Pt[] | null>();
  routeBetween(from: Ref, to: Ref): Pt[] | null {
    const key = refKey(from) + '|' + refKey(to);
    if (this.routes.has(key)) return this.routes.get(key)!;
    let pts: Pt[] | null = null;
    const k = this.pairs.get(key);
    if (k != null) { pts = this.linkPts.get(k)!; if (refKey(this.city.links[k].a as Ref) !== refKey(from)) pts = [...pts].reverse(); }
    else {
      const a = this.placeIdx.get(refKey(from)), b = this.placeIdx.get(refKey(to));
      const p = a != null && b != null && a !== b ? this.grid.route(a, b, ROAD_COST, true) : null;
      if (p && p.length > 1) pts = this.grid.corners(p);
    }
    this.routes.set(key, pts);
    return pts;
  }

  // The loop a district's patrol drives: place to nearest place of the district over
  // the streets, then home; where a street leaves a place from another side than the
  // last came in, the car cuts through under its plate. When no two of its places
  // connect, it drives out to a place tied to it and back. Null when none is on a street.
  patrol(refs: Ref[]): Pt[] | null {
    const ins = refs.filter(r => this.placeIdx.has(refKey(r))).slice(0, 12);
    for (const home of ins) { const loop = this.tour(home, ins.filter(r => r !== home)); if (loop) return loop; }
    for (const home of ins) for (const key of this.pairs.keys()) if (key.startsWith(refKey(home) + '|')) {
      const loop = this.tour(home, [key.split('|')[1].split(':').map(Number) as Ref]); if (loop) return loop;
    }
    return null;
  }
  private tour(home: Ref, left: Ref[]): Pt[] | null {
    const mid = (r: Ref): Pt => { const x = this.rects[this.placeIdx.get(refKey(r))!]; return [x.x + x.w / 2, x.z + x.h / 2]; };
    left = [...left];
    const out: Pt[] = [], join = (at: Ref, leg: Pt[]) => {
      const l = out[out.length - 1];
      const gap = l ? Math.hypot(l[0] - leg[0][0], l[1] - leg[0][1]) : 1;
      if (l && gap > 0.05) out.push(mid(at));
      out.push(...(gap > 0.05 ? leg : leg.slice(1)));
    };
    let at = home;
    while (left.length) {
      const [ax, az] = mid(at);
      left.sort((p, q) => { const [px, pz] = mid(p), [qx, qz] = mid(q); return Math.hypot(px - ax, pz - az) - Math.hypot(qx - ax, qz - az); });
      const k = left.findIndex(r => this.routeBetween(at, r)); if (k < 0) break;
      const next = left.splice(k, 1)[0];
      join(at, this.routeBetween(at, next)!); at = next;
    }
    if (!out.length) return null;
    const back = this.routeBetween(at, home);
    if (back) { join(at, back); join(home, [out[0]]); }
    else out.push(...[...out].reverse().slice(1));
    return out;
  }

  clear() { this.glow.fill(0); this.cars.length = 0; }

  frame(dt: number, zoom: number) {
    let dirty = false;
    for (let k = 0; k < this.glow.length; k++) {
      const g = this.glow[k];
      if (g > 0) this.glow[k] = g < 0.01 ? 0 : g * Math.exp(-dt * 1.2);
      const v = Math.max(this.glow[k], this.hold[k]);
      if (v === this.shown[k]) continue;
      this.shown[k] = v; dirty = true;
      for (let j = 0; j < 4; j++) this.glowAttr.setX(k * 4 + j, v);
    }
    if (dirty) this.glowAttr.needsUpdate = true;
    // cars drive on the right; they only appear once single buildings are readable
    const cs = zoomGate(zoom, CARS_GONE, CARS_FULL) * Math.min(1.5, Math.max(1, Math.sqrt(zoom / 45)));
    let n = 0;
    this.cars = this.cars.filter(c => (c.s += c.v * dt) < c.cum[c.cum.length - 1]);
    if (cs > 0) for (const c of this.cars) {
      let i = 1; while (i < c.cum.length - 1 && c.cum[i] < c.s) i++;
      const [ax, az] = c.pts[i - 1], [bx, bz] = c.pts[i], seg = c.cum[i] - c.cum[i - 1] || 1, f = (c.s - c.cum[i - 1]) / seg;
      const dx = (bx - ax) / seg, dz = (bz - az) / seg;
      tmpP.set(ax + (bx - ax) * f - dz * 0.2, Y, az + (bz - az) * f + dx * 0.2);
      tmpQ.setFromAxisAngle(UP, Math.atan2(-dz, dx));
      tmpM.compose(tmpP, tmpQ, tmpS.setScalar(cs));
      this.carMesh.setMatrixAt(n, tmpM); this.carMesh.setColorAt(n, c.color); n++;
    }
    this.carMesh.count = n;
    if (n) { this.carMesh.instanceMatrix.needsUpdate = true; if (this.carMesh.instanceColor) this.carMesh.instanceColor.needsUpdate = true; }
  }
}
