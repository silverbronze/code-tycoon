import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { City } from '../api';
import type { World } from './world';
import type { Dressing } from './dressing';
import type { Pt } from './route';
import { zoomGate, PEOPLE_GONE, PEOPLE_FULL, CARS_GONE, CARS_FULL } from './roads';
import { ENV } from './env';
import { hash } from './themes';

// The people and vehicles of the city, each standing for something:
//   residents      walk around the blocks of their district; busier blocks, more people
//   commuters      walk the streets between places that import from each other
//   workers        one per action, in the session's colour, carrying their tool (hammer
//                  for a write, clipboard for a read, lens for a search, hard hat for a
//                  command, briefcase for an outside call) into the building
//   inspectors     lab coats sent to the files a test run covered; a green or red mark
//   onlookers      gather where sessions collided
//   delivery vans  drive the import ties; armoured trucks between payments and data
//   police         patrol the security district; sirens when its code is written
//   garbage trucks circle districts with stale uncommitted files, leave on a commit
//   tankers        one per few dollars of spend
//   buses          carry a new sub-agent from its session's place to its first job
//   ambulances     go to where a check failed or a session is stuck in a loop
//   trains         pull in on every commit, a carriage per file
//   planes         take off for outside services; helicopters fly to servers
//   birds          circle over the parks and scatter when a session's drone flies by
type Ref = [number, number];
interface Path { pts: Pt[]; cum: number[]; len: number }
function path(pts: Pt[]): Path {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, cum, len: cum[cum.length - 1] };
}
const at = { x: 0, z: 0, dx: 1, dz: 0 };
function sample(p: Path, s: number) {
  let i = 1; while (i < p.cum.length - 1 && p.cum[i] < s) i++;
  const [ax, az] = p.pts[i - 1], [bx, bz] = p.pts[i], seg = p.cum[i] - p.cum[i - 1] || 1, f = Math.min(1, Math.max(0, (s - p.cum[i - 1]) / seg));
  at.x = ax + (bx - ax) * f; at.z = az + (bz - az) * f; at.dx = (bx - ax) / seg; at.dz = (bz - az) / seg;
  return at;
}
// a polyline moved sideways by d (sidewalks beside a street)
function offset(pts: Pt[], d: number): Pt[] {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
    return [p[0] - dz / l * d, p[1] + dx / l * d] as Pt;
  });
}

interface Walker { p: Path; s: number; v: number; loop: boolean; color: THREE.Color; badge: THREE.Color | null; hold: number; lantern: boolean; seed: number; kind: 'res' | 'com' | 'work' | 'insp' | 'crowd'; face?: number; mark?: THREE.Color; key?: string; plate?: number[] }
type VType = 'van' | 'armored' | 'police' | 'garbage' | 'tanker' | 'bus' | 'ambulance';
interface Car { type: VType; p: Path; s: number; v: number; loop: boolean; color: THREE.Color; siren: number; hold: number; key?: string; leave?: boolean }
interface Flyer { heli: boolean; curve: THREE.CatmullRomCurve3; s: number; dur: number; hover: number; color: THREE.Color }
interface Train { x: number; v: number; cars: number; stop: number; stopped: boolean }
interface Bird { th: number; r: number; y: number; v: number; ph: number }
interface Flock { cx: number; cz: number; tx: number; tz: number; birds: Bird[]; calm: number }

const TOOL: Record<string, string> = { write: '#ff9f43', read: '#e8eef7', search: '#5ee6ff', touch: '#9fb0c8', cmd: '#ffd23f', remote: '#b48cff', skill: '#b48cff' };
const MAXW = 700, MAXC = 160, MAXF = 16, MAXT = 3, TCARS = 14;
const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z);
function merge(...g: THREE.BufferGeometry[]) {
  return mergeGeometries(g.map(x => { const n = x.index ? x.toNonIndexed() : x; for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal') n.deleteAttribute(k); return n; }))!;
}
const inst = (geo: THREE.BufferGeometry, mat: THREE.Material, n: number, shadow = false) => {
  const m = new THREE.InstancedMesh(geo, mat, n); m.count = 0; m.frustumCulled = false; m.castShadow = shadow;
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); return m;
};
const lit = (color = '#ffffff', glow = 0.15) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.2, emissive: color, emissiveIntensity: glow });
const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), S = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0), C = new THREE.Color();

export class Life {
  group = new THREE.Group();
  enabled = true;
  drones: () => Iterable<{ pos: THREE.Vector3 }> = () => [];
  private walkers: Walker[] = []; private cars: Car[] = []; private flyers: Flyer[] = []; private trains: Train[] = [];
  private flocks: Flock[] = [];
  private people: THREE.InstancedMesh; private badges: THREE.InstancedMesh; private lanterns: THREE.InstancedMesh; private umbrellas: THREE.InstancedMesh;
  private marks: THREE.InstancedMesh;
  private vmesh = {} as Record<VType, THREE.InstancedMesh>;
  private heads: THREE.InstancedMesh; private sirens: THREE.InstancedMesh;
  private planes: THREE.InstancedMesh; private helis: THREE.InstancedMesh; private rotors: THREE.InstancedMesh;
  private loco: THREE.InstancedMesh; private wagons: THREE.InstancedMesh;
  private birdMesh: THREE.InstancedMesh;
  private imports: { k: number; w: number; a: Ref; b: Ref }[] = [];
  private vanClock = 0; private rate = 0; private acts = 0;
  private lastPlace = new Map<string, Ref>(); private agents = new Set<string>();
  private flown = new Map<number, number>();
  private litterD = new Set<number>(); private crowdKeys = new Set<string>();
  private patrols: (Pt[] | null)[] = []; // per district, the street loop its police and garbage trucks drive

  constructor(private world: World, private dress: Dressing, private city: City) {
    const person = merge(new THREE.CylinderGeometry(0.035, 0.05, 0.17, 6).translate(0, 0.085, 0), new THREE.SphereGeometry(0.04, 8, 6).translate(0, 0.21, 0));
    this.people = inst(person, lit('#ffffff', 0.55), MAXW, true);
    this.badges = inst(box(0.07, 0.06, 0.05, 0.06, 0.12), new THREE.MeshBasicMaterial({ color: '#ffffff' }), MAXW);
    this.lanterns = inst(new THREE.SphereGeometry(0.03, 6, 5).translate(-0.06, 0.13, 0), new THREE.MeshBasicMaterial({ color: '#ffc66b' }), MAXW);
    this.umbrellas = inst(new THREE.ConeGeometry(0.13, 0.06, 8).translate(0, 0.3, 0), lit('#3b4f7a', 0.2), MAXW);
    this.marks = inst(new THREE.OctahedronGeometry(0.07, 0).translate(0, 0.42, 0), new THREE.MeshBasicMaterial({ color: '#ffffff' }), 64);
    const wheelBase = (l: number) => box(l, 0.04, 0.2, 0, 0.02, 0);
    const geos: Record<VType, THREE.BufferGeometry> = {
      van: merge(wheelBase(0.46), box(0.32, 0.2, 0.22, -0.06, 0.05), box(0.12, 0.14, 0.22, 0.17, 0.05)),
      armored: merge(wheelBase(0.5), box(0.5, 0.2, 0.24, 0, 0.05), box(0.14, 0.04, 0.1, 0.05, 0.25)),
      police: merge(wheelBase(0.44), box(0.44, 0.1, 0.22, 0, 0.05), box(0.22, 0.08, 0.2, -0.02, 0.15)),
      garbage: merge(wheelBase(0.56), box(0.38, 0.24, 0.26, -0.08, 0.05), box(0.14, 0.17, 0.24, 0.2, 0.05)),
      tanker: merge(wheelBase(0.62), new THREE.CylinderGeometry(0.11, 0.11, 0.44, 10).rotateZ(Math.PI / 2).translate(-0.07, 0.17, 0), box(0.14, 0.17, 0.22, 0.22, 0.05)),
      bus: merge(wheelBase(0.82), box(0.82, 0.24, 0.26, 0, 0.05)),
      ambulance: merge(wheelBase(0.5), box(0.36, 0.24, 0.24, -0.06, 0.05), box(0.14, 0.17, 0.24, 0.18, 0.05)),
    };
    for (const k of Object.keys(geos) as VType[]) { this.vmesh[k] = inst(geos[k], lit('#ffffff', 0.2), MAXC, true); this.group.add(this.vmesh[k]); }
    this.heads = inst(merge(box(0.03, 0.03, 0.05, 0, 0.1, 0.06), box(0.03, 0.03, 0.05, 0, 0.1, -0.06)), new THREE.MeshBasicMaterial({ color: '#fff4d0' }), MAXC);
    this.sirens = inst(box(0.07, 0.04, 0.16), new THREE.MeshBasicMaterial({ color: '#ffffff' }), MAXC);
    this.planes = inst(merge(new THREE.CylinderGeometry(0.07, 0.05, 0.9, 8).rotateZ(Math.PI / 2), box(0.22, 0.02, 1.0, 0.02, -0.01), box(0.12, 0.02, 0.36, -0.38, 0), box(0.12, 0.18, 0.02, -0.4, 0)), lit('#e9edf5', 0.35), MAXF);
    this.helis = inst(merge(new THREE.SphereGeometry(0.16, 10, 8).scale(1.4, 0.9, 1), new THREE.CylinderGeometry(0.03, 0.02, 0.45, 6).rotateZ(Math.PI / 2).translate(-0.35, 0.03, 0), box(0.02, 0.12, 0.02, 0, 0.12)), lit('#d9473f', 0.3), MAXF);
    this.rotors = inst(box(0.9, 0.01, 0.05, 0, 0.24), new THREE.MeshBasicMaterial({ color: '#bfc6d2' }), MAXF);
    this.loco = inst(merge(box(1.1, 0.32, 0.36, 0, 0.05), box(0.3, 0.12, 0.3, -0.25, 0.37)), lit('#2f6fb0', 0.3), MAXT, true);
    this.wagons = inst(box(1.0, 0.3, 0.34, 0, 0.05), lit('#ffffff', 0.18), MAXT * TCARS, true);
    this.birdMesh = inst(merge(box(0.18, 0.012, 0.05, 0.07, 0, 0).rotateZ(0.3), box(0.18, 0.012, 0.05, -0.07, 0, 0).rotateZ(-0.3), box(0.04, 0.03, 0.12)), new THREE.MeshBasicMaterial({ color: '#1a1d24' }), 60);
    this.group.add(this.people, this.badges, this.lanterns, this.umbrellas, this.marks, this.heads, this.sirens, this.planes, this.helis, this.rotors, this.loco, this.wagons, this.birdMesh);
    this.rebuild();
  }

  // Standing populations from the city as it is laid out now (after a move, too).
  rebuild() {
    const c = this.city, W = this.world, now = Date.now();
    this.walkers = this.walkers.filter(w => w.kind === 'work' || w.kind === 'insp');
    this.cars = this.cars.filter(v => v.type !== 'police' && v.type !== 'garbage');
    // residents: a loop round each block, more people where files were touched lately
    const recent = new Float32Array(c.modules.length);
    for (const f of c.files) if (f.last && now - f.last < 7 * 864e5) recent[f.m]++;
    let n = 0;
    c.modules.forEach((m, mi) => {
      if (n > 380) return;
      const loop = path([[m.x - 0.15, m.z - 0.15], [m.x + m.w + 0.15, m.z - 0.15], [m.x + m.w + 0.15, m.z + m.h + 0.15], [m.x - 0.15, m.z + m.h + 0.15], [m.x - 0.15, m.z - 0.15]]);
      const k = Math.min(5, (m.files ? 1 : 0) + Math.round(Math.sqrt(recent[mi])));
      const hue = c.districts[m.district].hue / 360;
      for (let j = 0; j < k; j++, n++) {
        const seed = hash(mi * 13.1 + j);
        this.walkers.push({ p: loop, s: seed * loop.len, v: (0.25 + seed * 0.3) * (seed > 0.5 ? 1 : -1), loop: true, color: new THREE.Color().setHSL(hue + (seed - 0.5) * 0.12, 0.45, 0.55 + seed * 0.2),
          badge: null, hold: 0, lantern: seed < 0.35, seed, kind: 'res' });
      }
    });
    // commuters along the import ties, on both sidewalks
    this.imports = [];
    c.links.forEach((l, k) => { if (l.imp > 0 && W.roads.hasRoad(k)) this.imports.push({ k, w: Math.log2(1 + l.imp), a: l.a as Ref, b: l.b as Ref }); });
    for (const { k, w } of this.imports.slice(0, 80)) {
      const pts = W.roads.linkPts.get(k); if (!pts) continue;
      for (let j = 0; j < Math.min(3, Math.ceil(w)); j++) {
        const seed = hash(k * 3.3 + j), side = j % 2 ? 0.55 : -0.55, p = path(offset(seed > 0.5 ? pts : [...pts].reverse(), side));
        this.walkers.push({ p, s: seed * p.len, v: 0.45 + seed * 0.25, loop: true, color: new THREE.Color().setHSL(seed, 0.35, 0.62), badge: null, hold: 0, lantern: seed < 0.3, seed, kind: 'com' });
      }
    }
    // police patrol the security districts, on their streets
    this.patrols = c.districts.map(d => d.members.length ? W.roads.patrol(d.members as Ref[]) : null);
    c.districts.forEach((d, di) => {
      const loop = this.patrols[di];
      if (W.styles[di] !== 'fortress' || !loop) return;
      this.cars.push({ type: 'police', p: path(loop), s: 0, v: 1.6, loop: true, color: new THREE.Color('#e9eef7'), siren: 0, hold: 0, key: 'd' + di });
    });
    this.setLitter([...this.litterD]);
    // flocks over the parks (or over district centres when there are none)
    const spots = this.dress.parks.length ? this.dress.parks : c.districts.map(d => ({ x: d.x + d.w / 2, z: d.z + d.h / 2 }));
    this.flocks = Array.from({ length: Math.min(4, spots.length) }, (_, k) => {
      const s = spots[Math.floor(hash(k * 5.5) * spots.length)];
      return { cx: s.x, cz: s.z, tx: s.x, tz: s.z, calm: 0, birds: Array.from({ length: 9 }, (_, j) => ({ th: j * 0.7, r: 1.2 + hash(j + k) * 1.8, y: 3 + hash(j * 2 + k) * 2, v: 0.5 + hash(j * 3 + k) * 0.6, ph: j })) };
    });
  }

  // ---- events --------------------------------------------------------------------
  // An action by a session (or one of its sub-agents).
  act(sid: string, agent: string | null, kind: string, tt: number, ti: number, color: THREE.Color) {
    if (!this.enabled) return;
    this.acts++;
    const W = this.world, c = this.city, place = W.placeOf(tt, ti);
    // a new sub-agent rides the bus from where its session is to its first job
    if (agent && place && !this.agents.has(agent)) {
      this.agents.add(agent);
      const from = this.lastPlace.get(sid);
      if (from && (from[0] !== place[0] || from[1] !== place[1])) this.drive('bus', from, place, color.clone().multiplyScalar(0.9));
    }
    if (place && !agent) this.lastPlace.set(sid, place);
    // police sirens when security code is written
    if (kind === 'write' && tt === 0) {
      const di = c.modules[c.files[ti].m].district;
      for (const v of this.cars) if (v.key === 'd' + di) { v.siren = 6; }
    }
    // planes and helicopters to the outside systems
    if (tt === 3) this.fly(ti, color);
    // a worker walks in with the tool
    if (tt === 0 && TOOL[kind] && this.walkers.length < MAXW) {
      const f = c.files[ti], m = c.modules[f.m];
      const from = this.edgePoint(m, f.x, f.z), dx = from[0] - f.x, dz = from[1] - f.z, l = Math.hypot(dx, dz) || 1;
      const door: Pt = [f.x + dx / l * 0.42, f.z + dz / l * 0.42];
      this.walkers.push({ p: path([from, door]), s: 0, v: 1.1, loop: false, color: color.clone(), badge: new THREE.Color(TOOL[kind]), hold: 0.6, lantern: false, seed: Math.random(), kind: 'work', plate: [m.x, m.z, m.x + m.w, m.z + m.h] });
    }
  }

  // A test run finished: inspectors walk to the files it covered and leave a mark.
  inspect(ok: boolean, files: number[]) {
    const c = this.city;
    for (const fi of files.slice(0, 8)) {
      const f = c.files[fi]; if (!f) continue;
      const m = c.modules[f.m], from = this.edgePoint(m, f.x, f.z);
      this.walkers.push({ p: path([from, [f.x + 0.4, f.z + 0.4]]), s: 0, v: 0.9, loop: false, color: new THREE.Color('#f4f6fa'), badge: new THREE.Color('#9ad1ff'),
        hold: 4, lantern: false, seed: Math.random(), kind: 'insp', mark: new THREE.Color(ok ? '#3ddc84' : '#ff4d5e'), plate: [m.x, m.z, m.x + m.w, m.z + m.h] });
    }
  }

  // Onlookers around the files where sessions collided.
  setCrowds(files: number[]) {
    const keys = new Set(files.map(String));
    this.walkers = this.walkers.filter(w => w.kind !== 'crowd' || keys.has(w.key!));
    for (const fi of files) {
      if (this.crowdKeys.has(String(fi)) && this.walkers.some(w => w.key === String(fi))) continue;
      const f = this.city.files[fi]; if (!f) continue;
      for (let j = 0; j < 6; j++) {
        const a = j / 6 * Math.PI * 2 + fi, x = f.x + Math.cos(a) * 0.7, z = f.z + Math.sin(a) * 0.7;
        this.walkers.push({ p: path([[x, z], [x + 0.001, z]]), s: 0, v: 0, loop: false, color: new THREE.Color().setHSL(hash(fi + j), 0.4, 0.6), badge: null, hold: Infinity,
          lantern: j % 3 === 0, seed: hash(fi * 7 + j), kind: 'crowd', face: Math.atan2(Math.sin(a), -Math.cos(a)), key: String(fi), plate: [this.city.modules[f.m].x, this.city.modules[f.m].z, this.city.modules[f.m].x + this.city.modules[f.m].w, this.city.modules[f.m].z + this.city.modules[f.m].h] });
      }
    }
    this.crowdKeys = keys;
  }

  // Garbage trucks circle the districts holding these stale files.
  setLitter(districts: number[]) {
    this.litterD = new Set(districts);
    this.cars = this.cars.filter(v => v.type !== 'garbage' || this.litterD.has(+v.key!.slice(1)));
    for (const di of this.litterD) {
      if (this.cars.some(v => v.type === 'garbage' && v.key === 'g' + di) || !this.patrols[di]) continue;
      this.cars.push({ type: 'garbage', p: path([...this.patrols[di]!].reverse()), s: 0, v: 1.0, loop: true, color: new THREE.Color('#3f8f4f'), siren: 0, hold: 0, key: 'g' + di });
    }
  }

  // A commit: a train pulls in, the garbage trucks head off.
  commit(files: number) {
    if (!this.enabled) return;
    if (this.trains.length < MAXT) this.trains.push({ x: this.dress.rail.x0, v: 9, cars: Math.max(1, Math.min(TCARS, files)), stop: 3, stopped: false });
    for (const v of this.cars) if (v.type === 'garbage') { v.loop = false; v.leave = true; v.s = Math.min(v.s, v.p.len - 0.01); }
  }

  // Spend crossed another few dollars: a tanker crosses the city.
  tanker() {
    if (!this.enabled) return;
    let best: Pt[] | null = null, bl = 0;
    for (const pts of this.world.roads.linkPts.values()) { const l = path(pts).len; if (l > bl) { bl = l; best = pts; } }
    if (best) this.cars.push({ type: 'tanker', p: path(Math.random() < 0.5 ? best : [...best].reverse()), s: 0, v: 2.2, loop: false, color: new THREE.Color('#d8dde6'), siren: 0, hold: 0 });
  }

  // Something went wrong at a place: an ambulance comes from the place nearest the airfield.
  emergency(to: Ref) {
    if (!this.enabled) return;
    const W = this.world, A = this.dress.airport;
    let best: Ref | null = null, bd = Infinity;
    for (const r of W.roads.places) { const p = W.center(r); const d = Math.hypot(p.x - A.x, p.z - A.z); if (d < bd && (r[0] !== to[0] || r[1] !== to[1])) { bd = d; best = r; } }
    if (best) this.drive('ambulance', best, to, new THREE.Color('#f4f6fa'), 8, 4);
  }

  private drive(type: VType, from: Ref, to: Ref, color: THREE.Color, siren = 0, hold = 0.8) {
    if (this.cars.length >= MAXC) return;
    const pts = this.world.roads.routeBetween(from, to); if (!pts || pts.length < 2) return;
    this.cars.push({ type, p: path(pts), s: 0, v: type === 'ambulance' ? 3.4 : 2.4, loop: false, color, siren, hold });
  }

  private fly(ti: number, color: THREE.Color) {
    const now = performance.now();
    if ((this.flown.get(ti) ?? 0) > now - 4000 || this.flyers.length >= MAXF) return;
    this.flown.set(ti, now);
    const e = this.city.externals[ti], tgt = this.world.position(3, ti); if (!e || !tgt) return;
    const A = this.dress.airport, H = this.dress.helipad;
    if (e.type === 'host') {
      const top = tgt.y + 1.4;
      this.flyers.push({ heli: true, color, s: 0, dur: 0, hover: 2.5, curve: new THREE.CatmullRomCurve3([new THREE.Vector3(H.x, 0.1, H.z), new THREE.Vector3(H.x, 3, H.z),
        new THREE.Vector3((H.x + tgt.x) / 2, 6, (H.z + tgt.z) / 2), new THREE.Vector3(tgt.x, top + 1.5, tgt.z), new THREE.Vector3(tgt.x, top, tgt.z)]) });
    } else {
      const lift = new THREE.Vector3(A.x, 3.5, A.z - A.len - 3), over = new THREE.Vector3(tgt.x, 7, tgt.z);
      const away = over.clone().add(over.clone().sub(lift).setY(0).normalize().multiplyScalar(30)).setY(16);
      this.flyers.push({ heli: false, color, s: 0, dur: 0, hover: 0, curve: new THREE.CatmullRomCurve3([new THREE.Vector3(A.x, 0.15, A.z), new THREE.Vector3(A.x, 0.2, A.z - A.len * 0.7), lift, over, away]) });
    }
  }

  // The point on a block's sidewalk nearest a spot inside it.
  private edgePoint(m: City['modules'][number], x: number, z: number): Pt {
    const x0 = m.x - 0.15, x1 = m.x + m.w + 0.15, z0 = m.z - 0.15, z1 = m.z + m.h + 0.15;
    const d = [x - x0, x1 - x, z - z0, z1 - z], k = d.indexOf(Math.min(...d));
    return k === 0 ? [x0, z] : k === 1 ? [x1, z] : k === 2 ? [x, z0] : [x, z1];
  }

  // ---- frame -----------------------------------------------------------------------
  frame(dt: number, t: number, zoom: number) {
    this.group.visible = this.enabled;
    if (!this.enabled) return;
    const night = ENV.night.value, rain = ENV.rain.value;
    // traffic follows the pace of work: acts per second, smoothed
    this.rate += (this.acts / Math.max(dt, 1e-3) - this.rate) * Math.min(1, dt * 0.5); this.acts = 0;
    this.vanClock -= dt * (0.35 + Math.min(2.5, this.rate * 0.4));
    if (this.vanClock <= 0 && this.imports.length) {
      this.vanClock = 1;
      const tot = this.imports.reduce((s, x) => s + x.w, 0); let r = Math.random() * tot;
      const pick = this.imports.find(x => (r -= x.w) <= 0) || this.imports[0];
      const pts = this.world.roads.linkPts.get(pick.k);
      if (pts && this.cars.length < MAXC) {
        const W = this.world, st = (ref: Ref) => ref[0] === 1 ? W.styles[this.city.modules[ref[1]].district] : W.styles[this.city.externals[ref[1]].district];
        const sa = st(pick.a), sb = st(pick.b), armored = (sa === 'bank' && sb === 'vault') || (sa === 'vault' && sb === 'bank');
        const fwd = Math.random() < 0.5, src = fwd ? pick.a : pick.b, d = this.city.districts[src[0] === 1 ? this.city.modules[src[1]].district : this.city.externals[src[1]].district];
        this.cars.push({ type: armored ? 'armored' : 'van', p: path(fwd ? pts : [...pts].reverse()), s: 0, v: 2 + Math.random(), loop: false,
          color: armored ? new THREE.Color('#5d6470') : new THREE.Color().setHSL((d?.hue ?? 200) / 360, 0.55, 0.55), siren: 0, hold: 0 });
      }
    }
    // people: only once single buildings are readable, growing in rather than popping
    const ps = zoomGate(zoom, PEOPLE_GONE, PEOPLE_FULL) * Math.min(2, Math.max(1.2, Math.sqrt(zoom / 10))); // readable figures, not to scale
    const showPeople = ps > 0;
    let np = 0, nb = 0, nl = 0, nu = 0, nm = 0;
    this.walkers = this.walkers.filter(w => {
      if (w.loop) w.s = ((w.s + w.v * dt) % w.p.len + w.p.len) % w.p.len;
      else if (w.s < w.p.len) w.s = Math.min(w.p.len, w.s + w.v * dt);
      else if ((w.hold -= dt) <= 0) return false;
      if (!showPeople || np >= MAXW) return true;
      const a = sample(w.p, w.s), bob = Math.abs(Math.sin(t * 9 + w.seed * 20)) * 0.02 * (w.v ? 1 : 0.3);
      const face = w.face ?? Math.atan2(-a.dz * Math.sign(w.v || 1), a.dx * Math.sign(w.v || 1));
      const pl = w.plate, up = pl && a.x > pl[0] && a.x < pl[2] && a.z > pl[1] && a.z < pl[3] ? 0.3 : w.kind === 'com' ? 0.07 : 0;
      M.compose(P.set(a.x, bob + up, a.z), Q.setFromAxisAngle(UP, face), S.setScalar(ps));
      this.people.setMatrixAt(np, M); this.people.setColorAt(np, w.color); np++;
      if (w.badge) { this.badges.setMatrixAt(nb, M); this.badges.setColorAt(nb, w.badge); nb++; }
      if (w.lantern && night > 0.4) { this.lanterns.setMatrixAt(nl++, M); }
      if (rain > 0.3 && w.seed < 0.7) { this.umbrellas.setMatrixAt(nu, M); this.umbrellas.setColorAt(nu, C.setHSL(w.seed * 1.4, 0.55, 0.45)); nu++; }
      if (w.mark && w.s >= w.p.len && nm < 64) { M.compose(P.set(a.x, up + 0.1 + Math.sin(t * 4) * 0.04, a.z), Q.setFromAxisAngle(UP, t * 2), S.setScalar(ps * 1.6)); this.marks.setMatrixAt(nm, M); this.marks.setColorAt(nm, w.mark); nm++; }
      return true;
    });
    this.people.count = np; this.badges.count = nb; this.lanterns.count = nl; this.umbrellas.count = nu; this.marks.count = nm;
    (this.lanterns.material as THREE.MeshBasicMaterial).color.setRGB(1, 0.78, 0.42).multiplyScalar(0.6 + night);
    for (const m of [this.people, this.badges, this.lanterns, this.umbrellas, this.marks]) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }

    // vehicles drive on the right
    const cs = zoomGate(zoom, CARS_GONE, CARS_FULL) * Math.min(1.5, Math.max(1, Math.sqrt(zoom / 45)));
    const counts = {} as Record<VType, number>; for (const k in this.vmesh) counts[k as VType] = 0;
    let nh = 0, ns = 0;
    this.cars = this.cars.filter(v => {
      if (v.loop) v.s = (v.s + v.v * (v.siren > 0 ? 1.8 : 1) * dt) % v.p.len;
      else if (v.s < v.p.len) v.s = Math.min(v.p.len, v.s + v.v * dt);
      else if ((v.hold -= dt) <= 0) return false;
      if (v.siren > 0) v.siren -= dt;
      if (!cs) return true;
      const a = sample(v.p, v.s), k = counts[v.type]++;
      M.compose(P.set(a.x - a.dz * 0.2, 0.07, a.z + a.dx * 0.2), Q.setFromAxisAngle(UP, Math.atan2(-a.dz, a.dx)), S.setScalar(cs));
      this.vmesh[v.type].setMatrixAt(k, M); this.vmesh[v.type].setColorAt(k, v.color);
      if (nh < MAXC) { const hm = M.clone().multiply(new THREE.Matrix4().makeTranslation(v.type === 'bus' ? 0.41 : 0.26, 0, 0)); this.heads.setMatrixAt(nh++, hm); }
      if ((v.siren > 0 || v.type === 'ambulance') && ns < MAXC) {
        const top = M.clone().multiply(new THREE.Matrix4().makeTranslation(0, v.type === 'police' ? 0.23 : 0.29, 0));
        this.sirens.setMatrixAt(ns, top); this.sirens.setColorAt(ns, (Math.floor(t * 6) & 1) ? C.setRGB(2, 0.15, 0.15) : C.setRGB(0.2, 0.4, 2.2)); ns++;
      }
      return true;
    });
    for (const k in this.vmesh) { const m = this.vmesh[k as VType]; m.count = counts[k as VType]; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
    this.heads.count = nh; this.heads.instanceMatrix.needsUpdate = true;
    (this.heads.material as THREE.MeshBasicMaterial).color.setRGB(1, 0.95, 0.8).multiplyScalar(0.15 + night * 1.4);
    this.sirens.count = ns; this.sirens.instanceMatrix.needsUpdate = true; if (this.sirens.instanceColor) this.sirens.instanceColor.needsUpdate = true;

    // planes and helicopters
    const fs = Math.max(1, Math.sqrt(zoom / 40));
    let npl = 0, nhe = 0;
    this.flyers = this.flyers.filter(f => {
      const len = f.curve.getLength(), speed = f.heli ? 4 : 7;
      if (f.s < 1) f.s = Math.min(1, f.s + dt * speed / len);
      else if ((f.hover -= dt) <= 0) return false;
      const p = f.curve.getPointAt(f.s), tan = f.curve.getTangentAt(Math.min(0.999, f.s));
      Q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), tan.clone().setY(f.heli ? 0 : tan.y).normalize());
      M.compose(p, Q, S.setScalar(fs));
      if (f.heli) { this.helis.setMatrixAt(nhe, M); const r = M.clone().multiply(new THREE.Matrix4().makeRotationY(t * 25)); this.rotors.setMatrixAt(nhe, r); nhe++; }
      else { this.planes.setMatrixAt(npl, M); this.planes.setColorAt(npl, C.copy(f.color).lerp(new THREE.Color('#ffffff'), 0.6)); npl++; }
      return true;
    });
    this.planes.count = npl; this.helis.count = this.rotors.count = nhe;
    for (const m of [this.planes, this.helis, this.rotors]) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }

    // trains: in from the west, a stop at the station, out to the east
    const R = this.dress.rail; let nlo = 0, nw = 0;
    this.trains = this.trains.filter(tr => {
      const atStation = R.station + 0.6;
      if (!tr.stopped && tr.x < atStation && tr.x + tr.v * dt >= atStation) { tr.x = atStation; tr.stopped = true; }
      else if (tr.stopped && tr.stop > 0) tr.stop -= dt;
      else tr.x += tr.v * dt;
      if (tr.x - tr.cars * 1.08 > R.x1) return false;
      M.compose(P.set(tr.x, 0.03, R.z), Q.identity(), S.setScalar(1)); this.loco.setMatrixAt(nlo++, M);
      for (let k = 0; k < tr.cars; k++) {
        M.compose(P.set(tr.x - 1.12 - k * 1.06, 0.03, R.z), Q.identity(), S.setScalar(1));
        this.wagons.setMatrixAt(nw, M); this.wagons.setColorAt(nw, C.setHSL(hash(k + tr.cars) * 0.15 + 0.05, 0.5, 0.45)); nw++;
      }
      return true;
    });
    this.loco.count = nlo; this.wagons.count = nw;
    for (const m of [this.loco, this.wagons]) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }

    // birds: circle, and take off for another park when a drone comes close
    let nbird = 0;
    const bs = zoomGate(zoom, CARS_GONE, CARS_FULL) * Math.min(1.5, Math.max(1, Math.sqrt(zoom / 40)));
    for (const f of this.flocks) {
      for (const d of this.drones()) if (Math.hypot(d.pos.x - f.cx, d.pos.z - f.cz) < 5 && f.calm <= 0) {
        const s = this.dress.parks.length ? this.dress.parks[Math.floor(Math.random() * this.dress.parks.length)] : { x: f.cx + 8, z: f.cz };
        f.tx = s.x; f.tz = s.z; f.calm = 6;
      }
      f.calm -= dt;
      const k = Math.min(1, dt * (f.calm > 3 ? 1.2 : 0.4)); f.cx += (f.tx - f.cx) * k; f.cz += (f.tz - f.cz) * k;
      const flee = f.calm > 3 ? 2 : 1;
      for (const b of f.birds) {
        b.th += dt * b.v * flee;
        const flap = 0.6 + 0.4 * Math.sin(t * 14 + b.ph);
        M.compose(P.set(f.cx + Math.cos(b.th) * b.r, b.y + Math.sin(t + b.ph) * 0.2 + (flee - 1) * 1.5, f.cz + Math.sin(b.th) * b.r), Q.setFromAxisAngle(UP, -b.th), S.set(bs, bs * flap, bs));
        this.birdMesh.setMatrixAt(nbird++, M);
      }
    }
    this.birdMesh.count = nbird; this.birdMesh.instanceMatrix.needsUpdate = true;
    (this.birdMesh.material as THREE.MeshBasicMaterial).color.setRGB(0.1, 0.11, 0.14).lerp(C.setRGB(0.55, 0.6, 0.7), night * 0.5);
  }

  clear() { this.walkers = this.walkers.filter(w => w.kind !== 'work' && w.kind !== 'insp'); this.cars = this.cars.filter(v => v.loop); this.flyers = []; this.trains = []; this.lastPlace.clear(); }

  dispose() { this.group.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose?.(); (m.material as THREE.Material)?.dispose?.(); }); }
}
