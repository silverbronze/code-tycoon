import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { City } from '../api';
import { ENV } from './env';
import { hash } from './themes';

// Follies: rides and oddities on the open ground inside the districts. They stand
// for nothing in the code; they are there because a district box is mostly empty
// lot between its blocks. Each district's free ground (no block, store or street)
// is rasterised on a unit grid and the largest clear rectangle gets a ride, again
// and again while there is room, then a swing set or a popcorn cart fills a smaller gap.
// Every one moves on its own and does something when clicked (poke()). Rebuilt
// whenever places move, shown with their district in a replay.

const UP = new THREE.Vector3(0, 1, 0);
const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z);
const cyl = (r0: number, r1: number, h: number, x = 0, y = 0, z = 0, seg = 10) => new THREE.CylinderGeometry(r0, r1, h, seg).translate(x, y + h / 2, z);
const ball = (r: number, x = 0, y = 0, z = 0, seg = 10) => new THREE.SphereGeometry(r, seg, Math.max(4, Math.round(seg * 0.7))).translate(x, y, z);
// a round bar from a to b
function strut(a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 5) {
  const v = b.clone().sub(a), L = v.length();
  return new THREE.CylinderGeometry(r, r, L, seg).translate(0, L / 2, 0).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, v.normalize())).translate(a.x, a.y, a.z);
}
// one geometry from parts; colored parts keep a per-vertex colour (materials with vertexColors)
function merge(parts: (THREE.BufferGeometry | [THREE.BufferGeometry, string])[]) {
  const colored = parts.some(p => Array.isArray(p));
  return mergeGeometries(parts.map(p => {
    const [g, col] = Array.isArray(p) ? p : [p, '#ffffff'];
    const n = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal') n.deleteAttribute(k);
    if (colored) { const c = new THREE.Color(col), a = new Float32Array(n.attributes.position.count * 3); for (let i = 0; i < a.length; i += 3) c.toArray(a, i); n.setAttribute('color', new THREE.BufferAttribute(a, 3)); }
    return n;
  }))!;
}
// colours a geometry face by face, by where the face's centre is
function facets(g: THREE.BufferGeometry, colorAt: (x: number, y: number, z: number) => THREE.Color) {
  const geo = g.index ? g.toNonIndexed() : g, P = geo.attributes.position;
  const col = new Float32Array(P.count * 3);
  for (let i = 0; i < P.count; i += 3) {
    const c = colorAt((P.getX(i) + P.getX(i + 1) + P.getX(i + 2)) / 3, (P.getY(i) + P.getY(i + 1) + P.getY(i + 2)) / 3, (P.getZ(i) + P.getZ(i + 1) + P.getZ(i + 2)) / 3);
    for (let k = 0; k < 3; k++) c.toArray(col, (i + k) * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}
// ... in alternating stripes around its axis
function stripes(g: THREE.BufferGeometry, n: number, a: string, b: string) {
  const ca = new THREE.Color(a), cb = new THREE.Color(b);
  return facets(g, (x, _y, z) => Math.floor(((Math.atan2(z, x) + Math.PI) / (Math.PI * 2)) * n) % 2 ? cb : ca);
}
// A closed track centred on (0, 0): two straights along x joined by half circles.
// at(u) puts the point u along it and its heading into p and t.
function stadium(w: number, d: number) {
  const r = d / 2, L = Math.max(0, w - d), P = 2 * L + 2 * Math.PI * r;
  const at = (u: number, p: THREE.Vector3, t: THREE.Vector3) => {
    u = ((u % P) + P) % P;
    if (u < L) { p.set(-L / 2 + u, 0, r); t.set(1, 0, 0); return; }
    u -= L;
    if (u < Math.PI * r) { const a = u / r; p.set(L / 2 + Math.sin(a) * r, 0, Math.cos(a) * r); t.set(Math.cos(a), 0, -Math.sin(a)); return; }
    u -= Math.PI * r;
    if (u < L) { p.set(L / 2 - u, 0, -r); t.set(-1, 0, 0); return; }
    const a = (u - L) / r; p.set(-L / 2 - Math.sin(a) * r, 0, -Math.cos(a) * r); t.set(-Math.cos(a), 0, Math.sin(a));
  };
  return { P, at };
}
// a flat band along a track, hw to each side of the line `off` beside it
function ribbon(S: ReturnType<typeof stadium>, hw: number, y: number, off = 0, n = 120) {
  const pos: number[] = [], p = new THREE.Vector3(), t = new THREE.Vector3(), side: number[][] = [];
  for (let i = 0; i <= n; i++) {
    S.at((i / n) * S.P, p, t);
    const nx = -t.z, nz = t.x;
    side.push([p.x + nx * (off + hw), p.z + nz * (off + hw), p.x + nx * (off - hw), p.z + nz * (off - hw)]);
  }
  for (let i = 0; i < n; i++) {
    const [ax, az, bx, bz] = side[i], [cx, cz, dx, dz] = side[i + 1];
    pos.push(ax, y, az, cx, y, cz, bx, y, bz, bx, y, bz, cx, y, cz, dx, y, dz);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  return g;
}
const heading = (t: THREE.Vector3) => Math.atan2(-t.z, t.x);

// Materials are shared by every folly of every city (never disposed).
const mats = new Map<string, THREE.Material>();
function paint(color: string, o: { metal?: number; rough?: number; vc?: boolean } = {}) {
  const key = `${color}|${o.metal ?? 0.1}|${o.rough ?? 0.6}|${!!o.vc}`;
  let m = mats.get(key);
  if (!m) {
    const s = new THREE.MeshStandardMaterial({ color, metalness: o.metal ?? 0.1, roughness: o.rough ?? 0.6, vertexColors: !!o.vc, emissive: color, emissiveIntensity: 0.05 });
    mats.set(key, m = s);
  }
  return m;
}
// light bulbs: dim by day, bright at night (frame())
const BULB_COLS = ['#ffd27a', '#ff6b6b', '#7fe3ff', '#9dff8a'].map(c => new THREE.Color(c));
const BULBS = BULB_COLS.map(c => new THREE.MeshBasicMaterial({ color: c.clone() }));
const WATER = new THREE.MeshBasicMaterial({ color: '#3fb6d9' });
const WATER_C = new THREE.Color('#3fb6d9');
const GLASS = new THREE.MeshStandardMaterial({ color: '#dff4ff', transparent: true, opacity: 0.35, roughness: 0.1, depthWrite: false });
const STEAM = new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: 0.6, roughness: 1, depthWrite: false });

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, shadow = true) {
  const m = new THREE.Mesh(geo, mat); m.castShadow = shadow; m.receiveShadow = true; return m;
}
function inst(geo: THREE.BufferGeometry, mat: THREE.Material, n: number) {
  const m = new THREE.InstancedMesh(geo, mat, n); m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; return m;
}
const smooth = (x: number) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), P3 = new THREE.Vector3(), S3 = new THREE.Vector3(1, 1, 1), E = new THREE.Euler();
function setAt(I: THREE.InstancedMesh, i: number, x: number, y: number, z: number, ry = 0, s = 1, rx = 0, rz = 0) {
  I.setMatrixAt(i, M4.compose(P3.set(x, y, z), Q.setFromEuler(E.set(rx, ry, rz, 'YXZ')), S3.setScalar(s)));
}

// What a maker returns: the model (centred on its footprint, long side along x), how
// tall it stands (for picking), and what it does on its own and when clicked.
interface Made { name: string; hint: string; g: THREE.Group; top: number; tick(dt: number, t: number): void; poke(): void }
interface Ride extends Made { born: number; box: THREE.Box3 }
type Maker = (w: number, d: number, s: number) => Made;

// ---- The Event Loop: a ferris wheel
const ferris: Maker = (w, _d, s) => {
  const R = Math.min(2.5, Math.max(1.4, (w - 1) / 2)), hub = R + 0.55, N = 12, g = new THREE.Group();
  const legs: THREE.BufferGeometry[] = [box(R * 1.4, 0.12, 1.3)];
  for (const z of [-0.42, 0.42]) for (const x of [-1, 1]) legs.push(strut(new THREE.Vector3(x * R * 0.6, 0.1, z), new THREE.Vector3(0, hub, z * 0.7), 0.06));
  g.add(mesh(merge(legs), paint('#e9ecef', { metal: 0.4 })));
  const rotor = new THREE.Group(); rotor.position.y = hub; g.add(rotor);
  const parts: THREE.BufferGeometry[] = [new THREE.CylinderGeometry(0.1, 0.1, 0.7, 8).rotateX(Math.PI / 2)];
  const bulbs: THREE.BufferGeometry[] = [];
  for (const z of [-0.22, 0.22]) {
    parts.push(new THREE.TorusGeometry(R, 0.045, 5, 48).translate(0, 0, z), new THREE.TorusGeometry(R * 0.55, 0.03, 4, 32).translate(0, 0, z));
    for (let k = 0; k < N; k++) { const a = (k / N) * Math.PI * 2; parts.push(strut(new THREE.Vector3(0, 0, z * 0.5), new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, z), 0.025, 4)); }
    for (let k = 0; k < N * 2; k++) { const a = ((k + 0.5) / (N * 2)) * Math.PI * 2; bulbs.push(box(0.08, 0.08, 0.08, Math.cos(a) * (R + 0.06), Math.sin(a) * (R + 0.06) - 0.04, z)); }
  }
  rotor.add(mesh(merge(parts), paint(s < 0.5 ? '#d6453d' : '#2f6fd6', { metal: 0.3 })), mesh(merge(bulbs), BULBS[0], false));
  const cabins = inst(merge([box(0.05, 0.3, 0.05, 0, -0.3), box(0.36, 0.28, 0.32, 0, -0.62), box(0.42, 0.05, 0.38, 0, -0.36)]), paint('#ffffff'), N);
  for (let k = 0; k < N; k++) cabins.setColorAt(k, new THREE.Color().setHSL(k / N, 0.65, 0.55));
  g.add(cabins);
  let ang = s * 6, boost = 0;
  return {
    name: 'The Event Loop', hint: 'ferris wheel · goes round and round · click to spin it up', g, top: hub + R + 0.3,
    tick(dt) {
      boost *= Math.exp(-dt * 0.45); ang += (0.18 + boost) * dt;
      rotor.rotation.z = ang;
      for (let k = 0; k < N; k++) { const a = ang + (k / N) * Math.PI * 2; setAt(cabins, k, Math.cos(a) * R, hub + Math.sin(a) * R + 0.02, 0, 0, 1, 0, Math.sin(ang * 3 + k) * boost * 0.12); }
      cabins.instanceMatrix.needsUpdate = true;
    },
    poke() { boost = Math.min(4, boost + 2.4); },
  };
};

// ---- Round Robin: a carousel
const carousel: Maker = (w, d, s) => {
  const r = Math.min(2.2, Math.min(w, d) / 2 - 0.3), N = 8, g = new THREE.Group();
  g.add(mesh(merge([cyl(r + 0.12, r + 0.2, 0.16, 0, 0, 0, 24), cyl(0.5, 0.6, 0.06, r + 0.3, 0, 0, 8)]), paint('#b9b3a8')));
  const spin = new THREE.Group(); g.add(spin);
  const roofGeo = stripes(new THREE.ConeGeometry(r + 0.2, 0.75, 16).translate(0, 1.85, 0), 16, s < 0.5 ? '#e5484d' : '#3e7bfa', '#fff7e6');
  const poles: THREE.BufferGeometry[] = [cyl(0.2, 0.22, 1.5, 0, 0.16, 0, 12), cyl(r + 0.2, r + 0.2, 0.14, 0, 1.36, 0, 24)];
  for (let k = 0; k < N; k++) { const a = (k / N) * Math.PI * 2; poles.push(cyl(0.025, 0.025, 1.2, Math.cos(a) * r * 0.72, 0.18, Math.sin(a) * r * 0.72, 5)); }
  const bulbs: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 24; k++) { const a = (k / 24) * Math.PI * 2; bulbs.push(box(0.07, 0.07, 0.07, Math.cos(a) * (r + 0.23), 1.39, Math.sin(a) * (r + 0.23))); }
  spin.add(mesh(cyl(r, r, 0.06, 0, 0.16, 0, 24), paint('#c79a62')), mesh(roofGeo, paint('#ffffff', { vc: true })), mesh(merge(poles), paint('#e8d38a', { metal: 0.6, rough: 0.35 })), mesh(merge(bulbs), BULBS[0], false));
  const horses = inst(merge([box(0.38, 0.14, 0.12, 0, -0.07), box(0.1, 0.2, 0.1, 0.17, 0), box(0.16, 0.08, 0.09, 0.24, 0.13), box(0.04, 0.16, 0.04, -0.13, -0.22), box(0.04, 0.16, 0.04, 0.13, -0.22), box(0.08, 0.04, 0.04, -0.22, -0.02)]), paint('#ffffff'), N);
  for (let k = 0; k < N; k++) horses.setColorAt(k, new THREE.Color().setHSL(hash(k + s * 9), 0.45, 0.8));
  spin.add(horses);
  let boost = 0;
  return {
    name: 'Round Robin', hint: 'carousel · everyone gets a turn · click to speed it up', g, top: 2.3,
    tick(dt, t) {
      boost *= Math.exp(-dt * 0.4);
      spin.rotation.y -= (0.5 + boost) * dt;
      for (let k = 0; k < N; k++) { const a = (k / N) * Math.PI * 2; setAt(horses, k, Math.cos(a) * r * 0.72, 0.72 + Math.sin(t * (2 + boost) + k * 1.7) * 0.14, Math.sin(a) * r * 0.72, -a - Math.PI / 2); }
      horses.instanceMatrix.needsUpdate = true;
    },
    poke() { boost = Math.min(5, boost + 2.5); },
  };
};

// ---- The Stack Overflow: a roller coaster, its train runs on gravity past the lift hill
const coaster: Maker = (w, d, s) => {
  const g = new THREE.Group(), hw = w / 2 - 0.6, hd = d / 2 - 0.6, H = Math.min(3.4, 1.6 + Math.min(w, d) * 0.22);
  const prof = [0.06, 0.3, 0.62, 1, 0.95, 0.1, 0.48, 0.18, 0.55, 0.28, 0.08, 0.42, 0.66, 0.25, 0.05, 0.04];
  const ctrl = prof.map((p, k) => {
    const a = (k / prof.length) * Math.PI * 2 + s, c = Math.cos(a), sn = Math.sin(a);
    return new THREE.Vector3(hw * Math.sign(c) * Math.abs(c) ** 0.55, 0.35 + p * H, hd * Math.sign(sn) * Math.abs(sn) ** 0.55);
  });
  const curve = new THREE.CatmullRomCurve3(ctrl, true, 'centripetal'), L = curve.getLength(), M = 360;
  const pt: THREE.Vector3[] = [], tg: THREE.Vector3[] = [];
  for (let i = 0; i < M; i++) { pt.push(curve.getPointAt(i / M)); tg.push(curve.getTangentAt(i / M)); }
  const side = (i: number) => new THREE.Vector3().crossVectors(tg[i], UP).normalize();
  const rail = (off: number, dy: number) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pt.map((p, i) => p.clone().addScaledVector(side(i), off).add(new THREE.Vector3(0, dy, 0))), true), M, 0.035, 4, true);
  g.add(mesh(merge([rail(0.11, 0), rail(-0.11, 0), rail(0, -0.1)]), paint(s < 0.5 ? '#e5484d' : '#f5a524', { metal: 0.4, rough: 0.4 })));
  const legs: THREE.BufferGeometry[] = [];
  for (let i = 0; i < M; i += 9) if (pt[i].y > 0.3) legs.push(cyl(0.035, 0.045, pt[i].y - 0.1, pt[i].x, 0, pt[i].z, 5));
  legs.push(box(1.4, 0.3, 0.7, pt[M - 4].x, 0, pt[M - 4].z + (pt[M - 4].z > 0 ? 0.6 : -0.6)), box(1.5, 0.06, 0.8, pt[M - 4].x, 0.9, pt[M - 4].z + (pt[M - 4].z > 0 ? 0.6 : -0.6)));
  g.add(mesh(merge(legs), paint('#eef0f2', { metal: 0.3 })));
  const CARS = 4, cars = inst(merge([box(0.4, 0.16, 0.3, 0, 0.04), box(0.05, 0.16, 0.3, -0.18, 0.16), ball(0.045, 0.06, 0.26, 0.07, 6), ball(0.045, 0.06, 0.26, -0.07, 6)]), paint('#ffffff'), CARS);
  for (let k = 0; k < CARS; k++) cars.setColorAt(k, new THREE.Color().setHSL(k % 2 ? 0.13 : 0.6, 0.85, 0.5));
  g.add(cars);
  const top = Math.max(...pt.map(p => p.y));
  const at = (u: number, v: THREE.Vector3, t: THREE.Vector3) => { // u: arc length
    const f = (((u / L) % 1) + 1) % 1 * M, i = Math.floor(f) % M, j = (i + 1) % M, a = f - Math.floor(f);
    v.lerpVectors(pt[i], pt[j], a); t.lerpVectors(tg[i], tg[j], a).normalize();
  };
  const pv = new THREE.Vector3(), tv = new THREE.Vector3(), sd = new THREE.Vector3(), up = new THREE.Vector3(), B = new THREE.Matrix4();
  let u = 0, boost = 1;
  return {
    name: 'The Stack Overflow', hint: 'roller coaster · it only goes deeper · click to boost the train', g, top: top + 0.4,
    tick(dt) {
      at(u, pv, tv);
      boost = 1 + (boost - 1) * Math.exp(-dt * 0.35);
      const v = Math.max(tv.y > 0.08 ? 0.9 : 0.6, Math.sqrt(2 * 3.2 * Math.max(0, top + 0.12 - pv.y))) * boost;
      u += v * dt;
      for (let k = 0; k < CARS; k++) {
        at(u - k * 0.36, pv, tv);
        sd.crossVectors(tv, UP).normalize(); up.crossVectors(sd, tv);
        B.makeBasis(tv, up, sd).setPosition(pv.x, pv.y + 0.03, pv.z);
        cars.setMatrixAt(k, B);
      }
      cars.instanceMatrix.needsUpdate = true;
    },
    poke() { boost = Math.min(4, boost + 1.6); },
  };
};

// ---- Hard Reset: a drop tower. Climbs, waits, drops, rests.
const dropTower: Maker = (_w, _d, s) => {
  const g = new THREE.Group(), H = 5.4 + s * 1.6, y0 = 0.3;
  g.add(mesh(merge([cyl(0.75, 0.85, 0.15, 0, 0, 0, 16), box(0.3, H, 0.3, 0, 0.1), cyl(0.36, 0.26, 0.32, 0, H + 0.1, 0, 10)]), paint('#dde1e6', { metal: 0.35 })));
  const lights: THREE.BufferGeometry[] = [];
  for (let y = 0.6; y < H; y += 0.45) for (const [x, z] of [[0.16, 0], [-0.16, 0], [0, 0.16], [0, -0.16]]) lights.push(box(0.04, 0.12, 0.04, x, y, z));
  g.add(mesh(merge(lights), BULBS[1], false), mesh(ball(0.1, 0, H + 0.5, 0, 8), BULBS[1], false));
  const seats: THREE.BufferGeometry[] = [new THREE.TorusGeometry(0.42, 0.1, 6, 20).rotateX(Math.PI / 2).translate(0, 0.12, 0)];
  for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; seats.push(box(0.16, 0.24, 0.12, Math.cos(a) * 0.58, 0, Math.sin(a) * 0.58)); }
  const car = mesh(merge(seats), paint(s < 0.5 ? '#f5c518' : '#8e5cf0', { metal: 0.3 })); g.add(car);
  let st = 0, tau = s * 3, y = y0, v = 0;
  const climb = 7, hold = 1.6, peak = H - 0.7;
  return {
    name: 'Hard Reset', hint: 'drop tower · all the way up, then back to zero · click to drop it', g, top: H + 0.7,
    tick(dt, t) {
      tau += dt;
      if (st === 0) { y = y0; if (tau > 4) { st = 1; tau = 0; } }
      else if (st === 1) { y = y0 + (peak - y0) * smooth(tau / climb); if (tau >= climb) { st = 2; tau = 0; } }
      else if (st === 2) { y = peak + Math.sin(t * 40) * 0.015; if (tau >= hold) { st = 3; v = 0; } }
      else { v = y > y0 + 1.4 ? v + 15 * dt : Math.max(0.5, v * Math.exp(-dt * 9)); y -= v * dt; if (y <= y0) { y = y0; st = 0; tau = 0; } }
      car.position.y = y; car.rotation.y += dt * (st === 1 ? 0.25 : 0.05);
    },
    poke() { if (st === 0) { st = 1; tau = 0; } else if (st === 1) { st = 2; tau = hold - 0.25; } else if (st === 2) tau = hold; },
  };
};

// ---- Callback Maze: a hedge maze someone keeps walking; click grows a new one
function rng(seed: number) { let a = Math.floor(seed * 2 ** 31) | 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const maze: Maker = (w, d, s) => {
  const C = 0.7, nx = Math.min(13, Math.floor((w - 0.5) / C)), nz = Math.min(13, Math.floor((d - 0.5) / C)), g = new THREE.Group();
  const cx = (i: number) => (i - (nx - 1) / 2) * C, cz = (j: number) => (j - (nz - 1) / 2) * C;
  const max = 2 * nx * nz + nx + nz + 4;
  const hedge = inst(box(1, 1, 1), paint('#3d7a3a', { rough: 0.95, metal: 0 }), max);
  g.add(hedge, mesh(merge([box(0.5, 0.06, 0.5, cx(nx - 1) + C, 0, cz(nz - 1)), cyl(0.06, 0.12, 0.3, cx(nx - 1) + C, 0.06, cz(nz - 1), 8), ball(0.12, cx(nx - 1) + C, 0.45, cz(nz - 1), 10)]), paint('#d9b44a', { metal: 0.8, rough: 0.3 })));
  const walker = mesh(merge([[cyl(0.05, 0.07, 0.2), '#d64545'], [ball(0.055, 0, 0.27, 0, 8), '#f1c9a5']]), paint('#ffffff', { vc: true }));
  g.add(walker);
  type W = [number, number, boolean]; // x, z, along x
  let walls: W[] = [], path: THREE.Vector3[] = [], seed = s, grow = 1, u = 0;
  const lay = () => {
    const R = rng(seed), east = new Uint8Array(nx * nz).fill(1), south = new Uint8Array(nx * nz).fill(1), seen = new Uint8Array(nx * nz);
    const st = [0]; seen[0] = 1;
    while (st.length) { // depth-first carving
      const c = st[st.length - 1], i = c % nx, j = (c / nx) | 0;
      const n = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).map(([a, b]) => [i + a, j + b, a, b]).filter(([x, z]) => x >= 0 && z >= 0 && x < nx && z < nz && !seen[z * nx + x]);
      if (!n.length) { st.pop(); continue; }
      const [x, z, a, b] = n[Math.floor(R() * n.length)], k = z * nx + x;
      if (a === 1) east[c] = 0; else if (a === -1) east[k] = 0; else if (b === 1) south[c] = 0; else south[k] = 0;
      seen[k] = 1; st.push(k);
    }
    walls = [];
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (j === 0) walls.push([cx(i), cz(j) - C / 2, true]);
      if (i === 0 && j !== 0) walls.push([cx(i) - C / 2, cz(j), false]);
      if (east[c] && !(i === nx - 1 && j === nz - 1)) walls.push([cx(i) + C / 2, cz(j), false]);
      if (south[c]) walls.push([cx(i), cz(j) + C / 2, true]);
    }
    // the way through, breadth first
    const prev = new Int32Array(nx * nz).fill(-1), q = [0]; prev[0] = 0;
    while (q.length) {
      const c = q.shift()!, i = c % nx, j = (c / nx) | 0;
      const nb: number[] = [];
      if (i < nx - 1 && !east[c]) nb.push(c + 1); if (i > 0 && !east[c - 1]) nb.push(c - 1);
      if (j < nz - 1 && !south[c]) nb.push(c + nx); if (j > 0 && !south[c - nx]) nb.push(c - nx);
      for (const k of nb) if (prev[k] < 0) { prev[k] = c; q.push(k); }
    }
    const cells: number[] = []; for (let c = nx * nz - 1; ; c = prev[c]) { cells.unshift(c); if (c === 0) break; }
    path = [new THREE.Vector3(cx(0) - C, 0, cz(0)), ...cells.map(c => new THREE.Vector3(cx(c % nx), 0, cz((c / nx) | 0))), new THREE.Vector3(cx(nx - 1) + C * 0.75, 0, cz(nz - 1))];
    hedge.count = walls.length; grow = 0; u = 0;
  };
  lay();
  const pv = new THREE.Vector3();
  return {
    name: 'Callback Maze', hint: 'hedge maze · one way in, one way out · click to grow a new one', g, top: 0.6,
    tick(dt) {
      if (grow < 1) {
        grow = Math.min(1, grow + dt * 1.2);
        walls.forEach(([x, z, ax], k) => hedge.setMatrixAt(k, M4.compose(P3.set(x, 0, z), Q.identity(), S3.set(ax ? C + 0.12 : 0.14, 0.48 * smooth((grow - hash(k + seed) * 0.4) / 0.6) + 0.001, ax ? 0.14 : C + 0.12))));
        hedge.instanceMatrix.needsUpdate = true;
      }
      u += dt * 1.6;
      const n = path.length - 1, f = u % (n + 2); // a short rest at the trophy
      const i = Math.min(n - 1, Math.floor(Math.min(f, n - 0.001))), a = Math.min(1, Math.min(f, n) - i);
      pv.lerpVectors(path[i], path[i + 1], a);
      walker.position.set(pv.x, Math.abs(Math.sin(u * 9)) * 0.03, pv.z);
      walker.rotation.y = Math.atan2(-(path[i + 1].z - path[i].z), path[i + 1].x - path[i].x);
    },
    poke() { seed = hash(seed * 91 + 7); lay(); },
  };
};

// ---- Rubber Duck Pond: explain your bug to the ducks
const duckGeo = () => merge([[ball(0.12, 0, 0.07, 0).scale(1.3, 0.8, 1), '#ffd23f'], [ball(0.075, 0.09, 0.19, 0), '#ffd23f'], [box(0.07, 0.025, 0.06, 0.18, 0.165), '#ff8a1f'], [ball(0.015, 0.14, 0.215, 0.045, 5), '#1b1b1b'], [ball(0.015, 0.14, 0.215, -0.045, 5), '#1b1b1b']]);
const pond: Maker = (w, d, s) => {
  const g = new THREE.Group(), rx = w / 2 - 0.45, rz = d / 2 - 0.45;
  g.add(mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2).scale(rx, 1, rz).translate(0, 0.03, 0), WATER, false));
  const rim: THREE.BufferGeometry[] = [];
  const nR = Math.round((rx + rz) * 5);
  for (let k = 0; k < nR; k++) { const a = (k / nR) * Math.PI * 2, h = hash(k * 3.3 + s); rim.push(new THREE.IcosahedronGeometry(0.13 + h * 0.07, 0).scale(1.2, 0.6, 1).translate(Math.cos(a) * (rx + 0.05), 0.04, Math.sin(a) * (rz + 0.05))); }
  for (let k = 0; k < 5; k++) { const a = hash(k + s * 7) * 6.28; for (let r = 0; r < 4; r++) rim.push(cyl(0.012, 0.018, 0.35 + hash(k * 5 + r) * 0.3, Math.cos(a) * (rx - 0.15) + (r - 1.5) * 0.06, 0, Math.sin(a) * (rz - 0.15) + hash(r + k) * 0.08, 4)); }
  g.add(mesh(merge(rim), paint('#8d9196', { rough: 0.9 })));
  const n = 4 + Math.floor(s * 4), geo = duckGeo(), mat = paint('#ffffff', { vc: true }), ducks = inst(geo, mat, n);
  const lanes = Array.from({ length: n }, (_, k) => ({ f: 0.3 + hash(k * 1.7 + s) * 0.55, w: (0.25 + hash(k * 2.9) * 0.35) * (k % 2 ? -1 : 1), ph: hash(k * 4.1 + s) * 6.28 }));
  g.add(ducks);
  const big = Math.min(rx, rz) > 1.7 ? mesh(geo, mat) : null;
  if (big) { big.scale.setScalar(3.4); g.add(big); }
  const ripple = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false }));
  ripple.position.y = 0.05; g.add(ripple);
  let hop = 9, speed = 1;
  return {
    name: 'Rubber Duck Pond', hint: 'explain your bug to the ducks · click to make a splash', g, top: big ? 1 : 0.4,
    tick(dt, t) {
      hop += dt; speed = 1 + (speed - 1) * Math.exp(-dt * 0.6);
      lanes.forEach((l, k) => {
        l.ph += l.w * dt * speed / l.f;
        const x = Math.cos(l.ph) * rx * l.f, z = Math.sin(l.ph) * rz * l.f, sg = Math.sign(l.w);
        const tx = -Math.sin(l.ph) * rx * sg, tz = Math.cos(l.ph) * rz * sg, hk = hop - k * 0.07;
        setAt(ducks, k, x, 0.02 + Math.sin(t * 3 + k) * 0.012 + (hk > 0 && hk < 0.55 ? Math.sin((hk / 0.55) * Math.PI) * 0.35 : 0), z, Math.atan2(-tz, tx) + (hk > 0 && hk < 0.55 ? (hk / 0.55) * Math.PI * 2 : 0));
      });
      ducks.instanceMatrix.needsUpdate = true;
      if (big) { big.rotation.y = Math.sin(t * 0.3 + s * 6) * 0.6; big.position.y = Math.sin(t * 0.9) * 0.03 + (hop < 0.6 ? Math.sin((hop / 0.6) * Math.PI) * 0.3 : 0); }
      const m = ripple.material as THREE.MeshBasicMaterial;
      if (hop < 1.6) { const k = hop / 1.6; ripple.scale.set(0.2 + k * rx, 1, 0.2 + k * rz); m.opacity = 0.7 * (1 - k); } else m.opacity = 0;
    },
    poke() { hop = 0; speed = 3.5; },
  };
};

// ---- The Cloud: a hot air balloon on a tether; click lets it fly a round
const balloon: Maker = (_w, _d, s) => {
  const g = new THREE.Group();
  g.add(mesh(merge([cyl(0.62, 0.62, 0.04, 0, 0, 0, 20), cyl(0.04, 0.04, 0.22, 0, 0.04, 0, 5)]), paint('#6b6f78')));
  const craft = new THREE.Group(); g.add(craft);
  const pal = [['#e5484d', '#fff7e6'], ['#3e7bfa', '#f5c518'], ['#2fa36b', '#ffffff'], ['#8e5cf0', '#ff9f43']][Math.floor(s * 4)];
  const env = stripes(new THREE.LatheGeometry([[0.1, 0], [0.28, 0.22], [0.5, 0.52], [0.64, 0.84], [0.63, 1.1], [0.5, 1.34], [0.28, 1.5], [0.001, 1.56]].map(([r, y]) => new THREE.Vector2(r, y)), 16).translate(0, 0.62, 0), 16, pal[0], pal[1]);
  const ropes: THREE.BufferGeometry[] = [];
  for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) ropes.push(strut(new THREE.Vector3(x * 0.11, 0.2, z * 0.11), new THREE.Vector3(x * 0.08, 0.64, z * 0.08), 0.008, 3));
  craft.add(mesh(env, paint('#ffffff', { vc: true, rough: 0.8 })), mesh(merge([box(0.26, 0.2, 0.26), ...ropes]), paint('#8a6a3d')));
  const flame = mesh(new THREE.ConeGeometry(0.06, 0.2, 6).translate(0, 0.38, 0), new THREE.MeshBasicMaterial({ color: '#ffb347' }), false);
  craft.add(flame);
  const tether = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: '#555b66' }));
  g.add(tether);
  let fly = -1;
  const T = 18;
  return {
    name: 'The Cloud', hint: 'hot air balloon · somebody else\'s basket · click to let it fly', g, top: 4.4,
    tick(dt, t) {
      let x = Math.sin(t * 0.4 + s * 5) * 0.12, z = Math.cos(t * 0.33) * 0.1, y = 2.1 + Math.sin(t * 0.8 + s * 3) * 0.15, burn = 0.3;
      if (fly >= 0) {
        fly += dt;
        const k = fly / T, up = Math.sin(Math.PI * Math.min(1, k)) ** 0.7;
        y += up * 11; x += Math.sin(k * Math.PI * 2) * 6 * up; z += Math.sin(k * Math.PI) * 3;
        burn = k < 0.45 ? 1 : 0.2;
        if (fly >= T) fly = -1;
      }
      craft.position.set(x, y, z); craft.rotation.y += dt * 0.15;
      flame.scale.setScalar(0.6 + burn * (0.7 + Math.sin(t * 23) * 0.3));
      tether.visible = fly < 0;
      const p = tether.geometry.attributes.position as THREE.BufferAttribute;
      p.setXYZ(0, 0, 0.26, 0); p.setXYZ(1, x, y, z); p.needsUpdate = true;
    },
    poke() { if (fly < 0) fly = 0; },
  };
};

// ---- Undefined Flying Object: one per city, over a crop circle, with a sheep
const ufo: Maker = (w, _d, s) => {
  const g = new THREE.Group(), R = Math.min(2.3, w / 2 - 0.2);
  const rings: THREE.BufferGeometry[] = [new THREE.RingGeometry(R * 0.86, R, 64), new THREE.RingGeometry(R * 0.5, R * 0.58, 48), new THREE.CircleGeometry(R * 0.2, 32)];
  for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; rings.push(new THREE.CircleGeometry(R * 0.12, 20).translate(Math.cos(a) * R * 0.72, Math.sin(a) * R * 0.72, 0)); }
  g.add(mesh(merge(rings.map(r => r.rotateX(-Math.PI / 2).translate(0, 0.025, 0))), paint('#a99b72', { rough: 1 }), false));
  const craft = new THREE.Group(); g.add(craft);
  const saucer = new THREE.LatheGeometry([[0.001, -0.16], [0.45, -0.13], [0.95, -0.02], [1, 0], [0.9, 0.05], [0.45, 0.12], [0.001, 0.14]].map(([r, y]) => new THREE.Vector2(r, y)), 24);
  const lights: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2; lights.push(ball(0.05, Math.cos(a) * 0.93, 0, Math.sin(a) * 0.93, 6)); }
  const dome = mesh(new THREE.SphereGeometry(0.38, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.1, 0), new THREE.MeshStandardMaterial({ color: '#9be7ff', emissive: '#4fc3f7', emissiveIntensity: 0.4, transparent: true, opacity: 0.55, roughness: 0.1 }), false);
  const alien = mesh(merge([[ball(0.1, 0, 0.22, 0, 10), '#58d36b'], [ball(0.03, 0.08, 0.26, 0.04, 5), '#111111'], [ball(0.03, 0.08, 0.26, -0.04, 5), '#111111'], [cyl(0.008, 0.008, 0.1, 0, 0.3, 0, 3), '#58d36b']]), paint('#ffffff', { vc: true }));
  craft.add(mesh(saucer, paint('#c8ccd4', { metal: 0.8, rough: 0.25 })), mesh(merge(lights), BULBS[3], false), dome, alien);
  const beamMat = new THREE.MeshBasicMaterial({ color: '#c9ffd9', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 1.05, 1, 24, 1, true).translate(0, -0.5, 0), beamMat); g.add(beam);
  const sheep = mesh(merge([[box(0.3, 0.17, 0.18, 0, 0.07), '#f2f0ea'], [box(0.09, 0.09, 0.09, 0.18, 0.15), '#2b2a28'], ...[[-0.1, -0.06], [-0.1, 0.06], [0.1, -0.06], [0.1, 0.06]].map(([x, z]) => [box(0.03, 0.08, 0.03, x, 0, z), '#2b2a28'] as [THREE.BufferGeometry, string])]), paint('#ffffff', { vc: true }));
  g.add(sheep);
  let tau = -1; const HOV = 3.3;
  return {
    name: 'Undefined Flying Object', hint: 'typeof ufo === "undefined" · click it', g, top: HOV + 0.6,
    tick(dt, t) {
      let y = HOV + Math.sin(t * 1.3) * 0.15, x = 0, z = 0, b = 0, sy = 0, show = true;
      sheep.rotation.y += dt * 0.2;
      if (tau >= 0) {
        tau += dt;
        const k = tau;
        if (k < 0.6) b = k / 0.6;                                  // beam on
        else if (k < 3) { b = 1; sy = smooth((k - 0.6) / 2.4) * (HOV - 0.2); sheep.rotation.y += dt * 4; } // up it goes
        else if (k < 4.4) { show = false; b = 1 - (k - 3) / 0.4; const f = smooth((k - 3) / 1.4); y += f * 40; x = f * 18; } // and away
        else if (k < 8) { show = false; y = 60; }
        else if (k < 10) { show = false; const f = 1 - smooth((k - 8) / 2); y += f * 40; x = -f * 18; } // back from the other side
        else if (k < 10.5) { show = false; b = (k - 10) / 0.5; }
        else if (k < 12.5) { b = 1; sy = (1 - smooth((k - 10.5) / 2)) * (HOV - 0.2); sheep.rotation.y -= dt * 4; } // returned, slightly confused
        else if (k < 13) b = 1 - (k - 12.5) / 0.5;
        else tau = -1;
      }
      craft.position.set(x, y, z); craft.rotation.y += dt * (1.2 + b * 3); craft.rotation.z = Math.sin(t * 0.9 + s) * 0.06;
      beam.position.set(x, y - 0.1, z); beam.scale.set(1, y - 0.1, 1); beamMat.opacity = b * 0.35;
      beam.visible = b > 0.01; sheep.visible = show; sheep.position.y = sy;
    },
    poke() { if (tau < 0) tau = 0; },
  };
};

// ---- small ones, for the gaps left over
const swings: Maker = (w, _d, s) => {
  const g = new THREE.Group(), X = Math.min(0.9, w / 2 - 0.4);
  const frame: THREE.BufferGeometry[] = [cyl(0.03, 0.03, X * 2 + 0.1).rotateZ(Math.PI / 2).translate(0, 1.3, 0)];
  for (const x of [-X, X]) for (const z of [-0.4, 0.4]) frame.push(strut(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, 1.32, 0), 0.03));
  g.add(mesh(merge(frame), paint(s < 0.5 ? '#2f6fd6' : '#d64545', { metal: 0.4 })));
  const seats = [-X / 2, X / 2].map(x => {
    const p = new THREE.Group(); p.position.set(x, 1.28, 0);
    p.add(mesh(merge([box(0.012, 0.95, 0.012, -0.09, -0.95), box(0.012, 0.95, 0.012, 0.09, -0.95), box(0.24, 0.03, 0.12, 0, -0.97)]), paint('#3a3a3a')));
    g.add(p); return p;
  });
  let amp = 0.25;
  return {
    name: 'Swing (legacy)', hint: 'swing set · still in production · click to push', g, top: 1.4,
    tick(dt, t) { amp = 0.25 + (amp - 0.25) * Math.exp(-dt * 0.25); seats.forEach((p, k) => { p.rotation.x = Math.sin(t * 2.6 + k * Math.PI + s * 9) * amp; }); },
    poke() { amp = Math.min(1.1, amp + 0.45); },
  };
};

// ---- Merge Conflict: bumper cars
const bumper: Maker = (w, d) => {
  const g = new THREE.Group(), hx = w / 2 - 0.35, hz = d / 2 - 0.35;
  const frame: THREE.BufferGeometry[] = [], bulbs: THREE.BufferGeometry[] = [];
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) frame.push(cyl(0.05, 0.05, 1.5, x * (hx + 0.1), 0, z * (hz + 0.1), 6));
  for (const z of [-1, 1]) frame.push(box(hx * 2 + 0.3, 0.06, 0.06, 0, 1.5, z * (hz + 0.1)), box(hx * 2 + 0.2, 0.16, 0.05, 0, 0.06, z * (hz + 0.05)));
  for (const x of [-1, 1]) frame.push(box(0.06, 0.06, hz * 2 + 0.3, x * (hx + 0.1), 1.5, 0), box(0.05, 0.16, hz * 2 + 0.2, x * (hx + 0.05), 0.06, 0));
  for (let x = -hx; x <= hx; x += 0.35) for (const z of [-1, 1]) bulbs.push(box(0.06, 0.06, 0.06, x, 1.44, z * (hz + 0.1)));
  g.add(mesh(box(hx * 2 + 0.2, 0.06, hz * 2 + 0.2), paint('#3a3f4a', { metal: 0.3, rough: 0.4 })), mesh(merge(frame), paint('#f5c518', { metal: 0.4 })), mesh(merge(bulbs), BULBS[1], false));
  const N = 6, cars = inst(merge([[box(0.42, 0.12, 0.3, 0, 0.03), '#ffffff'], [new THREE.TorusGeometry(0.2, 0.05, 5, 16).rotateX(Math.PI / 2).scale(1.15, 1, 0.85).translate(0, 0.07, 0), '#2a2a2a'],
    [box(0.12, 0.16, 0.22, -0.1, 0.12), '#ffffff'], [cyl(0.012, 0.012, 1.3, -0.16, 0.1, 0, 4), '#9a9a9a'], [ball(0.065, 0.04, 0.27, 0, 6), '#ffffff']]), paint('#ffffff', { vc: true }), N);
  const cs = Array.from({ length: N }, (_, k) => { const a = (k / N) * 6.28; cars.setColorAt(k, new THREE.Color().setHSL(k / N, 0.75, 0.55)); return { x: Math.cos(a) * hx * 0.5, z: Math.sin(a) * hz * 0.5, vx: Math.cos(a + 2), vz: Math.sin(a + 2), h: 0, spin: 0 }; });
  g.add(cars);
  let boost = 1;
  return {
    name: 'Merge Conflict', hint: 'bumper cars · everyone edits the same line · click to make them collide', g, top: 1.6,
    tick(dt) {
      boost = 1 + (boost - 1) * Math.exp(-dt * 0.5);
      for (const c of cs) {
        c.x += c.vx * dt; c.z += c.vz * dt;
        if (Math.abs(c.x) > hx - 0.25) { c.x = Math.sign(c.x) * (hx - 0.25); c.vx = -Math.sign(c.x) * Math.abs(c.vx); c.spin += 3; }
        if (Math.abs(c.z) > hz - 0.25) { c.z = Math.sign(c.z) * (hz - 0.25); c.vz = -Math.sign(c.z) * Math.abs(c.vz); c.spin += 3; }
      }
      for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
        const a = cs[i], b = cs[j], dx = b.x - a.x, dz = b.z - a.z, dist = Math.hypot(dx, dz);
        if (dist > 0.44 || dist < 1e-4) continue;
        const nx = dx / dist, nz = dz / dist, push = (0.44 - dist) / 2;
        a.x -= nx * push; a.z -= nz * push; b.x += nx * push; b.z += nz * push;
        const va = a.vx * nx + a.vz * nz, vb = b.vx * nx + b.vz * nz; // trade the speed along the hit
        a.vx += (vb - va) * nx; a.vz += (vb - va) * nz; b.vx += (va - vb) * nx; b.vz += (va - vb) * nz;
        a.spin += 6; b.spin -= 6;
      }
      cs.forEach((c, k) => {
        const sp = Math.hypot(c.vx, c.vz) || 1, want = 0.7 * boost, f = 1 + (want / sp - 1) * Math.min(1, dt * 1.5);
        c.vx *= f; c.vz *= f;
        let da = Math.atan2(-c.vz, c.vx) - c.h; da = Math.atan2(Math.sin(da), Math.cos(da));
        c.h += da * Math.min(1, dt * 4) + c.spin * dt; c.spin *= Math.exp(-dt * 3);
        setAt(cars, k, c.x, 0, c.z, c.h);
      });
      cars.instanceMatrix.needsUpdate = true;
    },
    poke() { boost = 3; for (const c of cs) { const a = Math.atan2(-c.z, -c.x) + (Math.random() - 0.5) * 0.6; c.vx = Math.cos(a) * 2; c.vz = Math.sin(a) * 2; } },
  };
};

// ---- Race Condition: go-karts, whoever gets there first
const karts: Maker = (w, d, s) => {
  const g = new THREE.Group(), tw = 0.9, S = stadium(w - 0.7 - tw, d - 0.7 - tw), p = new THREE.Vector3(), t = new THREE.Vector3();
  g.add(mesh(ribbon(S, tw / 2, 0.02), paint('#2d3038', { rough: 0.8 }), false));
  const kerb: [THREE.BufferGeometry, string][] = [];
  for (let k = 0, n = Math.floor(S.P / 0.3); k < n; k++) for (const o of [tw / 2 + 0.05, -tw / 2 - 0.05]) {
    S.at((k / n) * S.P, p, t);
    kerb.push([box(0.3, 0.03, 0.1).rotateY(heading(t)).translate(p.x - t.z * o, 0, p.z + t.x * o), k % 2 ? '#e5484d' : '#ffffff']);
  }
  S.at(0, p, t);
  kerb.push([box(0.12, 0.035, tw, p.x, 0, p.z), '#ffffff']);
  for (const [x, z] of [[-1, -1], [1, 1]]) kerb.push([cyl(0.14, 0.14, 0.24, x * (w / 2 - 0.3), 0, z * (d / 2 - 0.3), 8), '#1f1f1f']);
  g.add(mesh(merge(kerb), paint('#ffffff', { vc: true }), false));
  const N = 4, ks = inst(merge([[box(0.32, 0.07, 0.18, 0, 0.04), '#ffffff'], [box(0.08, 0.05, 0.2, 0.15, 0.05), '#ffffff'], [ball(0.05, -0.03, 0.17, 0, 6), '#ffffff'],
    ...[[-0.1, 1], [-0.1, -1], [0.1, 1], [0.1, -1]].map(([x, z]) => [cyl(0.04, 0.04, 0.04, x, 0.04, z * 0.1, 8).rotateX(Math.PI / 2).translate(0, 0.04, 0), '#1f1f1f'] as [THREE.BufferGeometry, string])]), paint('#ffffff', { vc: true }), N);
  const kk = Array.from({ length: N }, (_, k) => { ks.setColorAt(k, new THREE.Color().setHSL(hash(k * 3.1 + s), 0.8, 0.5)); return { u: -k * 0.5, v: 1.4 + hash(k + s) * 0.3, lane: k % 2 ? 0.2 : -0.2, boost: 1 }; });
  g.add(ks);
  return {
    name: 'Race Condition', hint: 'go-kart track · the order is never the same twice · click to wave the green flag', g, top: 0.4,
    tick(dt, tt) {
      kk.forEach((k, i) => {
        k.boost = 1 + (k.boost - 1) * Math.exp(-dt * 0.4);
        k.u += k.v * k.boost * (1 + 0.18 * Math.sin(tt * 0.6 + i * 2.3)) * dt;
        S.at(k.u, p, t);
        setAt(ks, i, p.x - t.z * k.lane, 0, p.z + t.x * k.lane, heading(t));
      });
      ks.instanceMatrix.needsUpdate = true;
    },
    poke() { for (const k of kk) k.boost = 1.5 + Math.random() * 1.8; },
  };
};

// ---- Semaphore: a toy train that stops at a red signal
const train: Maker = (w, d) => {
  const g = new THREE.Group(), S = stadium(w - 1.1, d - 1.1), p = new THREE.Vector3(), t = new THREE.Vector3();
  const sl: THREE.BufferGeometry[] = [];
  for (let u = 0; u < S.P; u += 0.25) { S.at(u, p, t); sl.push(box(0.08, 0.03, 0.42).rotateY(heading(t)).translate(p.x, 0, p.z)); }
  g.add(mesh(merge(sl), paint('#6b4a2b', { rough: 0.9 }), false), mesh(merge([ribbon(S, 0.025, 0.05, 0.14), ribbon(S, 0.025, 0.05, -0.14)]), paint('#9aa1ad', { metal: 0.7 }), false));
  S.at(0, p, t);
  const sx = p.x - t.z * 0.45, sz = p.z + t.x * 0.45;
  g.add(mesh(merge([cyl(0.03, 0.03, 1.1, sx, 0, sz, 6), box(0.14, 0.32, 0.1, sx, 1.0, sz)]), paint('#2b2b2b')));
  const red = new THREE.MeshBasicMaterial({ color: '#ff3b3b' }), green = new THREE.MeshBasicMaterial({ color: '#3bff6b' });
  const tz = Math.sign(t.x) || 1;
  g.add(mesh(ball(0.045, sx, 1.24, sz + 0.05 * tz, 8), red, false), mesh(ball(0.045, sx, 1.1, sz + 0.05 * tz, 8), green, false));
  const engine = mesh(merge([[box(0.22, 0.24, 0.26, -0.12, 0.08), '#2f6fd6'], [cyl(0.1, 0.1, 0.3, 0, 0, 0, 10).rotateZ(Math.PI / 2).translate(0.1, 0.2, 0), '#1f1f22'],
    [cyl(0.04, 0.05, 0.14, 0.2, 0.28, 0, 6), '#1f1f22'], [box(0.5, 0.06, 0.26, 0, 0.06), '#d64545']]), paint('#ffffff', { vc: true }));
  g.add(engine);
  const W = 3, wagons = inst(merge([box(0.38, 0.16, 0.24, 0, 0.08), box(0.42, 0.04, 0.26, 0, 0.06)]), paint('#ffffff'), W);
  for (let k = 0; k < W; k++) wagons.setColorAt(k, new THREE.Color().setHSL(0.1 + k * 0.25, 0.75, 0.55));
  const puffs = inst(new THREE.IcosahedronGeometry(0.07, 0), STEAM, 6);
  g.add(wagons, puffs);
  let u = S.P * 0.5, v = 1.2, go = true, timer = 0, held = 0;
  return {
    name: 'Semaphore', hint: 'toy train · waits for the signal · click to flip it', g, top: 1.3,
    tick(dt, tt) {
      timer += dt; held -= dt;
      if (held <= 0) { const want = timer % 16 > 12 ? false : true; go = want; }
      red.color.set(go ? '#3a1414' : '#ff3b3b'); green.color.set(go ? '#3bff6b' : '#143a1d');
      const ahead = (((0 - u) % S.P) + S.P) % S.P;
      const target = go || ahead > 1.6 ? 1.2 : Math.max(0, ahead - 0.35) * 1.1;
      v += (target - v) * Math.min(1, dt * 2.5); u += v * dt;
      S.at(u, p, t); engine.position.set(p.x, 0.04, p.z); engine.rotation.y = heading(t);
      for (let k = 0; k < W; k++) { S.at(u - 0.55 - k * 0.46, p, t); setAt(wagons, k, p.x, 0.04, p.z, heading(t)); }
      wagons.instanceMatrix.needsUpdate = true;
      for (let k = 0; k < 6; k++) { // smoke while it runs
        const a = (tt * 0.8 + k / 6) % 1, cx = engine.position.x + Math.cos(engine.rotation.y) * 0.2, cz = engine.position.z - Math.sin(engine.rotation.y) * 0.2;
        setAt(puffs, k, cx, 0.4 + a * 0.9, cz, k, v > 0.2 ? (0.4 + a * 1.4) * Math.min(1, v) : 0.001);
      }
      puffs.instanceMatrix.needsUpdate = true;
    },
    poke() { go = !go; held = 8; },
  };
};

// ---- Garbage Collector: a truck doing its round, picking up after everyone
const gc: Maker = (w, d) => {
  const g = new THREE.Group(), S = stadium(w - 1.3, d - 1.3), p = new THREE.Vector3(), t = new THREE.Vector3();
  g.add(mesh(ribbon(S, 0.3, 0.02), paint('#7d838d', { rough: 0.9 }), false));
  g.add(mesh(merge([[box(0.5, 0.4, 0.34, -0.35, 0), '#2fa36b'], [box(0.54, 0.04, 0.38, -0.35, 0.4), '#1f6b46'], [box(0.5, 0.4, 0.34, 0.35, 0), '#3e7bfa'], [box(0.54, 0.04, 0.38, 0.35, 0.4), '#2a55ad']]), paint('#ffffff', { vc: true })));
  const truck = new THREE.Group(); g.add(truck);
  truck.add(mesh(merge([[box(0.2, 0.22, 0.26, 0.2, 0.06), '#ffffff'], [box(0.42, 0.28, 0.28, -0.1, 0.06), '#2fa36b'], [box(0.06, 0.08, 0.27, 0.31, 0.16), '#7fb7d9'],
    ...[[-0.2, 1], [-0.2, -1], [0.2, 1], [0.2, -1]].map(([x, z]) => [cyl(0.06, 0.06, 0.04, 0, 0, 0, 8).rotateX(Math.PI / 2).translate(x, 0.06, z * 0.14), '#1f1f1f'] as [THREE.BufferGeometry, string])]), paint('#ffffff', { vc: true })));
  const beacon = mesh(box(0.06, 0.05, 0.06, 0.2, 0.3), new THREE.MeshBasicMaterial({ color: '#ffb347' }), false); truck.add(beacon);
  const N = 18, junk = inst(box(0.07, 0.05, 0.05), paint('#ffffff'), N);
  const items = Array.from({ length: N }, (_, k) => { junk.setColorAt(k, new THREE.Color().setHSL(hash(k * 7.7), 0.6, 0.55)); return { u: hash(k * 3.3) * S.P, off: (hash(k * 5.1) - 0.5) * 0.4, alive: true }; });
  g.add(junk);
  let u = 0, boost = 1, spawn = 0;
  return {
    name: 'Garbage Collector', hint: 'garbage truck · frees what nobody points to · click for a full collection', g, top: 0.6,
    tick(dt, tt) {
      boost = 1 + (boost - 1) * Math.exp(-dt * 0.2);
      u += 0.7 * boost * dt;
      S.at(u, p, t); truck.position.set(p.x, 0.02, p.z); truck.rotation.y = heading(t);
      (beacon.material as THREE.MeshBasicMaterial).color.setScalar(Math.sin(tt * (boost > 1.3 ? 14 : 4)) > 0 ? 1 : 0.3).multiply(new THREE.Color('#ffb347'));
      const here = ((u % S.P) + S.P) % S.P;
      spawn += dt;
      items.forEach((it, k) => {
        if (it.alive && Math.abs(it.u - here) < 0.25) it.alive = false;
        if (!it.alive && spawn > 1.4 && Math.abs(it.u - here) > 1.5) { it.alive = true; it.u = (here + 1.5 + Math.random() * (S.P - 3)) % S.P; spawn = 0; } // freshly allocated
        S.at(it.u, p, t);
        setAt(junk, k, p.x - t.z * it.off, 0.02, p.z + t.x * it.off, k, it.alive ? 1 : 0.001);
      });
      junk.instanceMatrix.needsUpdate = true;
    },
    poke() { boost = 3.5; },
  };
};

// ---- Retry with Backoff: a bouncy castle; each try waits twice as long as the last
const bouncy: Maker = (_w, _d, s) => {
  const g = new THREE.Group(), castle = new THREE.Group(); g.add(castle);
  const [a, b] = s < 0.5 ? ['#e5484d', '#f5c518'] : ['#3e7bfa', '#ff9f43'];
  const parts: [THREE.BufferGeometry, string][] = [[box(2, 0.3, 2), a]];
  for (const z of [-1, 1]) parts.push([box(2, 0.6, 0.15, 0, 0.3, z * 0.93), b]);
  for (const x of [-1, 1]) parts.push([box(0.15, 0.6, 2, x * 0.93, 0.3), b]);
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) parts.push([cyl(0.22, 0.22, 1.1, x * 0.9, 0, z * 0.9, 10), a], [new THREE.ConeGeometry(0.26, 0.4, 10).translate(x * 0.9, 1.3, z * 0.9), b]);
  castle.add(mesh(merge(parts), paint('#ffffff', { vc: true, rough: 0.5 })));
  const kid = mesh(merge([[cyl(0.07, 0.09, 0.26), '#3e7bfa'], [ball(0.08, 0, 0.34, 0, 8), '#f1c9a5']]), paint('#ffffff', { vc: true })); g.add(kid);
  const tries = [0, 0.8, 1.8, 3.2, 5.4]; // jump 0.6s, then wait 0.2, 0.4, 0.8, 1.6
  let tau = 99;
  return {
    name: 'Retry with Backoff', hint: 'bouncy castle · waits twice as long after every try · click to retry', g, top: 1.5,
    tick(dt, t) {
      tau += dt;
      let y = Math.abs(Math.sin(t * 3.2)) * 0.25;
      if (tau < 6) { const k = tries.filter(s0 => tau >= s0).length - 1, f = (tau - tries[k]) / 0.6; y = f < 1 ? Math.sin(f * Math.PI) * (1.5 - k * 0.2) : 0; }
      kid.position.y = 0.3 + y;
      castle.scale.y = 1 - (y < 0.05 ? 0.06 : 0) + Math.sin(t * 7) * 0.015;
    },
    poke() { if (tau > 6) tau = 0; },
  };
};

// ---- Fork Bomb: fireworks whose sparks keep splitting in two
const fireworks: Maker = () => {
  const g = new THREE.Group(), MAX = 800;
  const tubes: THREE.BufferGeometry[] = [box(0.8, 0.3, 0.6)];
  for (let k = 0; k < 5; k++) tubes.push(cyl(0.06, 0.07, 0.45, -0.28 + k * 0.14, 0.3, (k % 2 - 0.5) * 0.2, 8));
  g.add(mesh(merge(tubes), paint('#5a4632')));
  // sparks are tiny meshes, not THREE.Points: under the orthographic city camera a point's size is in pixels
  const sparks = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.06, 0), new THREE.MeshBasicMaterial({ toneMapped: false, fog: false }), MAX);
  sparks.frustumCulled = false; sparks.count = 0; sparks.setColorAt(0, new THREE.Color()); g.add(sparks);
  const sc = new THREE.Color();
  type Pt = { x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number; gen: number; c: THREE.Color; rocket?: boolean };
  let ps: Pt[] = [], auto = 4, queue: number[] = [];
  const launch = () => ps.push({ x: (Math.random() - 0.5) * 0.4, y: 0.6, z: (Math.random() - 0.5) * 0.2, vx: (Math.random() - 0.5) * 0.6, vy: 7, vz: (Math.random() - 0.5) * 0.6, age: 0, gen: 0, c: new THREE.Color('#fff4d6'), rocket: true });
  const spray = (o: Pt, n: number, sp: number, c: THREE.Color, gen: number) => {
    for (let k = 0; k < n && ps.length < MAX; k++) {
      const a = Math.random() * 6.28, e = Math.acos(Math.random() * 2 - 1), v = sp * (0.7 + Math.random() * 0.3);
      ps.push({ x: o.x, y: o.y, z: o.z, vx: o.vx * 0.5 + Math.sin(e) * Math.cos(a) * v, vy: o.vy * 0.5 + Math.cos(e) * v, vz: o.vz * 0.5 + Math.sin(e) * Math.sin(a) * v, age: 0, gen, c });
    }
  };
  return {
    name: 'Fork Bomb', hint: 'fireworks · every spark forks in two · click to launch', g, top: 1,
    tick(dt) {
      auto -= dt; if (auto < 0) { auto = 7 + Math.random() * 6; launch(); }
      queue = queue.filter(q => q > 0 || (launch(), false)).map(q => q - dt);
      const next: Pt[] = [];
      for (const p of ps) {
        p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.vy -= (p.rocket ? 4 : 1.3) * dt;
        if (!p.rocket) { const f = Math.exp(-dt * 1.2); p.vx *= f; p.vz *= f; }
        if (p.rocket) { if (p.vy < 1.2) { spray(p, 20, 2, new THREE.Color().setHSL(Math.random(), 1, 0.5), 0); continue; } }
        else if (p.gen < 2 && p.age > 0.6) { spray(p, 2, 0.9, p.c.clone().offsetHSL(0.12, 0, 0), p.gen + 1); continue; } // fork()
        else if (p.age > 1.3 || p.y < 0) continue;
        next.push(p);
      }
      ps = next.slice(0, MAX);
      ps.forEach((p, i) => {
        const f = p.rocket ? 1 : Math.max(0, 1 - p.age / (p.gen < 2 ? 0.9 : 1.3));
        setAt(sparks, i, p.x, p.y, p.z, p.age * 9, p.rocket ? 1.4 : 0.5 + f * 0.8);
        sparks.setColorAt(i, sc.copy(p.c).multiplyScalar(0.4 + 0.8 * f));
      });
      sparks.count = ps.length;
      sparks.instanceMatrix.needsUpdate = true; sparks.instanceColor!.needsUpdate = true;
    },
    poke() { queue.push(0, 0.35, 0.7); },
  };
};

// ---- Binary Tree: every branch splits in two; click to rebalance (new colours)
const binaryTree: Maker = (_w, _d, s) => {
  const g = new THREE.Group(), tree = new THREE.Group(); g.add(tree);
  const wood: THREE.BufferGeometry[] = [], leaves: THREE.Vector3[] = [];
  const grow = (a: THREE.Vector3, dir: THREE.Vector3, len: number, depth: number, rot: number) => {
    const b = a.clone().addScaledVector(dir, len);
    wood.push(strut(a, b, 0.02 + depth * 0.022, 5));
    if (!depth) { leaves.push(b); return; }
    const axis = new THREE.Vector3(Math.cos(rot), 0, Math.sin(rot)).cross(dir).normalize();
    for (const sd of [-1, 1]) grow(b, dir.clone().applyAxisAngle(axis, sd * 0.5).normalize(), len * 0.74, depth - 1, rot + Math.PI / 2);
  };
  grow(new THREE.Vector3(), UP.clone(), 1, 6, s * 6);
  tree.add(mesh(merge(wood), paint('#6b4a2b', { rough: 0.9 })));
  const L = inst(new THREE.IcosahedronGeometry(0.17, 0), paint('#ffffff', { rough: 0.9 }), leaves.length);
  leaves.forEach((p, k) => setAt(L, k, p.x, p.y, p.z, k, 0.8 + hash(k) * 0.5));
  tree.add(L);
  const PAL = [[0.3, 0.55, 0.4], [0.92, 0.6, 0.78], [0.07, 0.8, 0.55], [0.55, 0.5, 0.6]];
  let pal = -1, shake = 0;
  const paint_ = () => { pal = (pal + 1) % PAL.length; const [h, sa, l] = PAL[pal]; leaves.forEach((_, k) => L.setColorAt(k, new THREE.Color().setHSL(h + (hash(k * 2.3) - 0.5) * 0.06, sa, l - hash(k) * 0.12))); L.instanceColor!.needsUpdate = true; };
  paint_();
  return {
    name: 'Binary Tree', hint: 'two branches per branch, all the way up · click to rebalance', g, top: 3.4,
    tick(dt, t) { shake *= Math.exp(-dt * 1.5); tree.rotation.z = Math.sin(t * (0.8 + shake * 8)) * (0.015 + shake * 0.08); tree.rotation.x = Math.cos(t * 0.6) * 0.01; },
    poke() { shake = 1; paint_(); },
  };
};

// ---- Easter Egg: the obvious one. Cracks open on a click.
const easterEgg: Maker = (_w, _d, s) => {
  const g = new THREE.Group(), egg = new THREE.Group(); g.add(egg);
  const C = [['#f29ab2', '#7fd3f7', '#f5d76e'], ['#b07fd8', '#9bde7e', '#ffb37a']][s < 0.5 ? 0 : 1].map(c => new THREE.Color(c));
  const band = (y: number) => C[Math.floor((y + 1.2) * 4) % 3];
  const R = 0.62, cut = 0.56 * Math.PI, cy = R * 1.3 + 0.1;
  g.add(mesh(new THREE.TorusGeometry(0.55, 0.14, 6, 18).rotateX(Math.PI / 2).translate(0, 0.1, 0), paint('#8a6a3d', { rough: 1 })));
  const shell = (t0: number, tl: number) => facets(new THREE.SphereGeometry(R, 24, 16, 0, Math.PI * 2, t0, tl).scale(1, 1.3, 1), (_x, y) => band(y));
  egg.add(mesh(shell(cut, Math.PI - cut).translate(0, cy, 0), paint('#ffffff', { vc: true })));
  const hy = Math.cos(cut) * R * 1.3 + cy, hx = -Math.sin(cut) * R;
  const lid = new THREE.Group(); lid.position.set(hx, hy, 0); egg.add(lid);
  lid.add(mesh(shell(0, cut).translate(-hx, cy - hy, 0), paint('#ffffff', { vc: true })));
  const chick = mesh(merge([[ball(0.2, 0, 0, 0, 12), '#ffd23f'], [ball(0.14, 0.05, 0.25, 0, 10), '#ffd23f'], [new THREE.ConeGeometry(0.04, 0.1, 6).rotateZ(-Math.PI / 2).translate(0.22, 0.25, 0), '#ff8a1f'],
    [ball(0.022, 0.16, 0.3, 0.06, 5), '#1b1b1b'], [ball(0.022, 0.16, 0.3, -0.06, 5), '#1b1b1b']]), paint('#ffffff', { vc: true }));
  chick.position.y = cy - 0.3; egg.add(chick);
  let tau = 99;
  return {
    name: 'Easter Egg', hint: 'you found it · click to see what is inside', g, top: 2,
    tick(dt, t) {
      tau += dt;
      const open = tau < 1 ? smooth((tau - 0.4) / 0.6) : tau < 4.5 ? 1 : 1 - smooth((tau - 4.5) / 0.8);
      egg.rotation.z = tau < 0.4 ? Math.sin(tau * 60) * 0.06 : Math.sin(t * 2.3) * 0.03 * Math.max(0, Math.sin(t * 0.4));
      lid.rotation.z = -open * 1.9; lid.position.y = hy + open * 0.15;
      chick.position.y = cy - 0.3 + open * 0.75; chick.rotation.y = open * Math.sin(t * 3) * 0.8;
    },
    poke() { if (tau > 5.3) tau = 0; },
  };
};

// ---- Kernel Panic: a popcorn cart
const popcorn: Maker = () => {
  const g = new THREE.Group();
  g.add(mesh(merge([[box(0.7, 0.45, 0.45, 0, 0.12), '#d64545'], [box(0.74, 0.06, 0.49, 0, 1.12), '#d64545'], [stripes(new THREE.ConeGeometry(0.5, 0.25, 4).rotateY(Math.PI / 4).translate(0, 1.3, 0), 4, '#d64545', '#ffffff'), '#ffffff'],
    ...[[-0.25, 1], [-0.25, -1], [0.25, 1], [0.25, -1]].map(([x, z]) => [cyl(0.02, 0.02, 0.55, x, 0.57, z * 0.18, 4), '#d9b44a'] as [THREE.BufferGeometry, string]),
    [cyl(0.12, 0.12, 0.04, 0, 0, 0, 12).rotateX(Math.PI / 2).translate(-0.2, 0.12, 0.25), '#1f1f1f'], [cyl(0.12, 0.12, 0.04, 0, 0, 0, 12).rotateX(Math.PI / 2).translate(-0.2, 0.12, -0.25), '#1f1f1f']]), paint('#ffffff', { vc: true })));
  g.add(mesh(box(0.66, 0.55, 0.41, 0, 0.57), GLASS, false));
  const N = 36, K = inst(new THREE.IcosahedronGeometry(0.035, 0), paint('#ffffff', { rough: 1 }), N);
  const ks = Array.from({ length: N }, (_, k) => { K.setColorAt(k, new THREE.Color().setHSL(0.13, 0.6, 0.85 + hash(k) * 0.1)); return { hx: (hash(k * 1.3) - 0.5) * 0.55, hz: (hash(k * 2.7) - 0.5) * 0.35, hy: 0.6 + hash(k * 4.1) * 0.12, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }; });
  g.add(K);
  let tau = 99;
  return {
    name: 'Kernel Panic', hint: 'popcorn cart · it was only a matter of time · click to pop', g, top: 1.5,
    tick(dt, t) {
      tau += dt;
      ks.forEach((k, i) => {
        if (tau < 5) { k.x += k.vx * dt; k.y += k.vy * dt; k.z += k.vz * dt; k.vy -= 6 * dt; if (k.y < 0.02) { k.y = 0.02; k.vx *= 0.3; k.vz *= 0.3; k.vy = Math.abs(k.vy) * 0.3; } }
        else { k.x = k.hx; k.z = k.hz; k.y = k.hy + Math.max(0, Math.sin(t * 7 + i * 1.7)) * 0.08; }
        setAt(K, i, k.x, k.y, k.z, i);
      });
      K.instanceMatrix.needsUpdate = true;
    },
    poke() { tau = 0; for (const k of ks) { const a = Math.random() * 6.28; k.x = k.hx; k.y = 1.1; k.z = k.hz; k.vx = Math.cos(a) * (0.6 + Math.random()); k.vz = Math.sin(a) * (0.6 + Math.random()); k.vy = 2 + Math.random() * 2; } },
  };
};

// ---- Call Stack: click pushes a frame; past the limit it all comes down
const callStack: Maker = () => {
  const g = new THREE.Group(), MAXN = 12, H = 0.16;
  const B = inst(box(0.7, H, 0.45), paint('#ffffff'), MAXN);
  for (let k = 0; k < MAXN; k++) B.setColorAt(k, new THREE.Color().setHSL(0.6 - k * 0.05, 0.6, 0.6));
  g.add(B);
  const fb = Array.from({ length: MAXN }, (_, k) => ({ x: (hash(k * 3.7) - 0.5) * 0.08, y: k * H, z: 0, r: (hash(k) - 0.5) * 0.15, vx: 0, vy: 0, rz: 0, spin: 0 }));
  let n = 3, drop = 1, fall = -1;
  return {
    name: 'Call Stack', hint: 'one frame per click · mind the limit', g, top: 2,
    tick(dt) {
      if (fall >= 0) {
        fall += dt;
        fb.forEach(f => { f.vy -= 9 * dt; f.x += f.vx * dt; f.y += f.vy * dt; f.rz += f.spin * dt; if (f.y < 0) { f.y = 0; f.vy = 0; f.vx *= 0.5; f.spin = 0; } });
        if (fall > 3) { fall = -1; n = 3; fb.forEach((f, k) => { f.x = (hash(k * 3.7) - 0.5) * 0.08; f.y = k * H; f.rz = 0; }); }
      } else drop = Math.min(1, drop + dt * 2.5);
      for (let k = 0; k < MAXN; k++) {
        const f = fb[k], show = k < n;
        const y = fall >= 0 ? f.y : k === n - 1 ? (k * H) + (1 - drop * drop) * 1.5 : k * H;
        setAt(B, k, f.x, y, f.z, f.r, show ? 1 : 0.001, 0, fall >= 0 ? f.rz : 0);
      }
      B.instanceMatrix.needsUpdate = true;
      if (fall < 0 && n === MAXN && drop >= 1) { fall = 0; fb.forEach((f, k) => { f.y = k * H; f.vx = (Math.random() - 0.5) * 3 * (k / MAXN); f.vy = Math.random(); f.spin = (Math.random() - 0.5) * 8; }); } // overflow
    },
    poke() { if (fall < 0 && drop >= 1 && n < MAXN) { n++; drop = 0; } },
  };
};

// ---- Ping / Pong: table tennis, rallying forever
const pingPong: Maker = () => {
  const g = new THREE.Group();
  g.add(mesh(merge([[box(1.6, 0.05, 0.86, 0, 0.45), '#2f7d5b'], [box(1.6, 0.052, 0.02, 0, 0.45), '#ffffff'], [box(0.02, 0.1, 0.92, 0, 0.5), '#eeeeee'],
    ...[[-0.7, -0.38], [-0.7, 0.38], [0.7, -0.38], [0.7, 0.38]].map(([x, z]) => [box(0.04, 0.45, 0.04, x, 0, z), '#333333'] as [THREE.BufferGeometry, string])]), paint('#ffffff', { vc: true })));
  const pad = () => { const m = mesh(merge([[cyl(0.1, 0.1, 0.02, 0, 0, 0, 12).rotateZ(Math.PI / 2), '#d64545'], [box(0.03, 0.1, 0.03, 0, -0.14), '#8a6a3d']]), paint('#ffffff', { vc: true })); g.add(m); return m; };
  const L = pad(), R = pad(), ballM = mesh(ball(0.035, 0, 0, 0, 8), paint('#ffffff'), false); g.add(ballM);
  let ph = 0, speed = 1;
  return {
    name: 'Ping / Pong', hint: 'table tennis · round trip time: low · click to rally faster', g, top: 0.9,
    tick(dt) {
      speed = 1 + (speed - 1) * Math.exp(-dt * 0.3); ph += dt * 0.9 * speed;
      const f = ph % 1, dir = Math.floor(ph) % 2 ? -1 : 1, x = dir * (-0.85 + f * 1.7), z = Math.sin(ph * 1.7) * 0.28;
      ballM.position.set(x, 0.5 + 0.28 * Math.sin(Math.PI * (f < 0.62 ? f / 0.62 : (f - 0.62) / 0.38)) * (f < 0.62 ? 1 : 0.6), z);
      const zl = dir > 0 ? Math.sin(Math.floor(ph) * 1.7) * 0.28 : z, zr = dir < 0 ? Math.sin(Math.floor(ph) * 1.7) * 0.28 : z;
      L.position.set(-0.95, 0.65, zl); R.position.set(0.95, 0.65, zr);
      L.rotation.z = dir > 0 ? Math.max(0, 1 - f * 4) * 0.6 : 0; R.rotation.z = dir < 0 ? -Math.max(0, 1 - f * 4) * 0.6 : 0;
    },
    poke() { speed = Math.min(4, speed + 1.2); },
  };
};

// ---- Cron Job: a cuckoo clock that keeps real time and calls out every 15 seconds
const cuckoo: Maker = () => {
  const g = new THREE.Group();
  g.add(mesh(merge([[cyl(0.04, 0.05, 0.9, 0, 0, 0, 6), '#6b4a2b'], [box(0.5, 0.55, 0.26, 0, 0.9), '#8a5a33'], [box(0.36, 0.04, 0.34, -0.13, 1.5).rotateZ(0), '#5a3a20'],
    [box(0.4, 0.04, 0.34, 0, 0, 0).rotateZ(0.6).translate(-0.12, 1.55, 0), '#5a3a20'], [box(0.4, 0.04, 0.34, 0, 0, 0).rotateZ(-0.6).translate(0.12, 1.55, 0), '#5a3a20'],
    [cyl(0.15, 0.15, 0.02, 0, 0, 0, 20).rotateX(Math.PI / 2).translate(0, 1.08, 0.135), '#f4efe2'], [box(0.12, 0.12, 0.02, 0, 1.3, 0.13), '#2a1a0e'],
    [cyl(0.015, 0.015, 0.3, -0.08, 0.6, 0.1, 4), '#d9b44a'], [cyl(0.04, 0.05, 0.1, -0.08, 0.5, 0.1, 6), '#d9b44a'], [cyl(0.015, 0.015, 0.22, 0.08, 0.68, 0.1, 4), '#d9b44a'], [cyl(0.04, 0.05, 0.1, 0.08, 0.58, 0.1, 6), '#d9b44a']]),
  paint('#ffffff', { vc: true })));
  const hand = (len: number, wd: number) => { const m = mesh(box(wd, len, 0.01, 0, 0, 0), paint('#1b1b1b'), false); m.position.set(0, 1.08, 0.15); g.add(m); return m; };
  const hh = hand(0.09, 0.025), mm = hand(0.13, 0.016);
  const bird = mesh(merge([[ball(0.05, 0, 0, 0, 8), '#ffd23f'], [new THREE.ConeGeometry(0.02, 0.05, 5).rotateX(Math.PI / 2).translate(0, 0, 0.06), '#ff8a1f']]), paint('#ffffff', { vc: true }), false);
  bird.position.set(0, 1.3, 0.05); g.add(bird);
  let tau = 99, last = Math.floor(Date.now() / 15000);
  return {
    name: 'Cron Job', hint: '*/15 * * * * * · cuckoo clock · click to run it now', g, top: 1.7,
    tick(dt) {
      const now = new Date(), m = now.getMinutes() + now.getSeconds() / 60, h = (now.getHours() % 12) + m / 60;
      hh.rotation.z = -(h / 12) * Math.PI * 2; mm.rotation.z = -(m / 60) * Math.PI * 2;
      const slot = Math.floor(now.getTime() / 15000); if (slot !== last) { last = slot; tau = 0; }
      tau += dt;
      const out = tau < 1.6 ? Math.sin(Math.min(1, tau / 0.3) * Math.PI / 2) * (tau > 1.3 ? (1.6 - tau) / 0.3 : 1) : 0;
      bird.position.z = 0.05 + out * 0.22; bird.rotation.x = out * Math.sin(tau * 20) * 0.3;
    },
    poke() { if (tau > 1.6) tau = 0; },
  };
};

// ---- 404: a pedestal whose statue is not found (most of the time)
const notFound: Maker = () => {
  const g = new THREE.Group();
  g.add(mesh(merge([[box(0.7, 0.5, 0.7), '#a7a29a'], [box(0.8, 0.08, 0.8, 0, 0.5), '#8d8a83'], [box(0.36, 0.14, 0.02, 0, 0.18, 0.36), '#2b2b2b']]), paint('#ffffff', { vc: true })));
  const statue = mesh(merge([cyl(0.08, 0.12, 0.55, 0, 0, 0), ball(0.1, 0, 0.68, 0, 10), box(0.45, 0.07, 0.07, 0, 0.42), box(0.07, 0.3, 0.07, 0.2, 0.42).rotateZ(0)]), paint('#d9b44a', { metal: 0.8, rough: 0.3 }));
  statue.position.y = 0.58; g.add(statue);
  let tau = 99;
  return {
    name: '404: Statue Not Found', hint: 'nothing to see here · click anyway', g, top: 1.5,
    tick(dt) {
      tau += dt;
      const s = tau < 0.5 ? smooth(tau / 0.5) : tau < 2.8 ? 1 : 1 - smooth((tau - 2.8) / 0.4);
      statue.scale.setScalar(Math.max(0.001, s)); statue.rotation.y = tau * 2; statue.visible = s > 0.002;
    },
    poke() { if (tau > 3.2) tau = 0; },
  };
};

// ---- Hello, World: a globe on a stand
const globe: Maker = (_w, _d, s) => {
  const g = new THREE.Group(), tilt = new THREE.Group(); tilt.position.y = 1.15; tilt.rotation.z = 0.41; g.add(tilt);
  g.add(mesh(merge([cyl(0.45, 0.55, 0.12, 0, 0, 0, 16), cyl(0.05, 0.07, 0.35, 0, 0.12, 0, 8)]), paint('#8a6a3d')));
  tilt.add(mesh(new THREE.TorusGeometry(0.78, 0.025, 4, 32, Math.PI).rotateZ(-Math.PI / 2), paint('#d9b44a', { metal: 0.8, rough: 0.3 })));
  const sea = new THREE.Color('#2f6fd6'), land = new THREE.Color('#5fae5a'), ice = new THREE.Color('#f4f6f8'), r = 0.7;
  const earth = mesh(facets(new THREE.SphereGeometry(r, 36, 22), (x, y, z) => {
    const nx = x / r, ny = y / r, nz = z / r;
    if (Math.abs(ny) > 0.86) return ice;
    const n = Math.sin(nx * 3.1 + s * 6) * Math.sin(ny * 2.7 + 0.4) + 0.8 * Math.sin(nz * 3.3 - 0.9 + s) + 0.35 * Math.sin((nx + nz) * 6);
    return n > 0.35 ? land : sea;
  }), paint('#ffffff', { vc: true, rough: 0.5 }));
  tilt.add(earth);
  let boost = 0;
  return {
    name: 'Hello, World', hint: 'globe · everyone\'s first program · click to spin it', g, top: 2,
    tick(dt) { boost *= Math.exp(-dt * 0.5); earth.rotation.y += (0.25 + boost) * dt; },
    poke() { boost = Math.min(14, boost + 6); },
  };
};

// ---- Infinite Loop: a chrome knot that never ends
const knot: Maker = () => {
  const g = new THREE.Group();
  g.add(mesh(merge([box(1.1, 0.5, 1.1), box(1.25, 0.08, 1.25, 0, 0.5)]), paint('#3a3f4a', { rough: 0.5 })), mesh(new THREE.RingGeometry(0.42, 0.5, 32).rotateX(-Math.PI / 2).translate(0, 0.59, 0), BULBS[2], false));
  const k = mesh(new THREE.TorusKnotGeometry(0.5, 0.12, 140, 12, 2, 3), paint('#dfe4ea', { metal: 0.95, rough: 0.18 }));
  g.add(k);
  let boost = 0, a = 0;
  return {
    name: 'Infinite Loop', hint: 'while (true) { } · click to go round faster', g, top: 2.4,
    tick(dt, t) { boost *= Math.exp(-dt * 0.4); a += (0.4 + boost) * dt; k.rotation.set(a * 0.7, a, 0); k.position.y = 1.45 + Math.sin(t * 1.2) * 0.08; },
    poke() { boost = Math.min(10, boost + 4); },
  };
};

// ---- Load Balancer: a seesaw that never settles
const seesaw: Maker = (_w, _d, s) => {
  const g = new THREE.Group(), plank = new THREE.Group(); plank.position.y = 0.32; g.add(plank);
  g.add(mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.3, 3).rotateX(Math.PI / 2).rotateZ(Math.PI / 2).translate(0, 0.14, 0), paint('#d64545')));
  plank.add(mesh(merge([box(2.2, 0.05, 0.24, 0, 0), box(0.04, 0.2, 0.2, -0.8, 0), box(0.04, 0.2, 0.2, 0.8, 0)]), paint(s < 0.5 ? '#f5c518' : '#3e7bfa')));
  const kid = (x: number, c: string) => { const m = mesh(merge([[cyl(0.06, 0.08, 0.22), c], [ball(0.07, 0, 0.3, 0, 8), '#f1c9a5']]), paint('#ffffff', { vc: true })); m.position.set(x, 0.05, 0); plank.add(m); return m; };
  const a = kid(-0.95, '#2fa36b'), b = kid(0.95, '#8e5cf0');
  let amp = 0.2;
  return {
    name: 'Load Balancer', hint: 'seesaw · never quite even · click to push', g, top: 1.2,
    tick(dt, t) {
      amp = 0.2 + (amp - 0.2) * Math.exp(-dt * 0.3);
      const ang = Math.sin(t * 1.7) * amp; plank.rotation.z = ang;
      a.position.y = 0.05 + Math.max(0, -Math.cos(t * 1.7)) * (amp - 0.2) * 0.8; b.position.y = 0.05 + Math.max(0, Math.cos(t * 1.7)) * (amp - 0.2) * 0.8;
    },
    poke() { amp = Math.min(0.4, amp + 0.12); },
  };
};

// ---- Hot Reload: a geyser that goes off on every change (and now and then by itself)
const geyser: Maker = () => {
  const g = new THREE.Group();
  g.add(mesh(new THREE.ConeGeometry(1.1, 0.5, 9).translate(0, 0.25, 0), paint('#8d8478', { rough: 1 })));
  g.add(mesh(new THREE.CircleGeometry(0.3, 16).rotateX(-Math.PI / 2).translate(0, 0.38, 0), paint('#2b2622'), false));
  const pool = mesh(new THREE.RingGeometry(1.05, 1.35, 32).rotateX(-Math.PI / 2).translate(0, 0.03, 0), WATER, false); g.add(pool);
  const colMat = new THREE.MeshBasicMaterial({ color: '#dff4ff', transparent: true, opacity: 0.75, depthWrite: false });
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.22, 1, 10, 1, true).translate(0, 0.5, 0), colMat); column.position.y = 0.38; g.add(column);
  const N = 12, puffs = inst(new THREE.IcosahedronGeometry(0.2, 1), STEAM, N); g.add(puffs);
  let tau = 99, auto = 8;
  return {
    name: 'Hot Reload', hint: 'geyser · goes off on every save · click to save', g, top: 1.2,
    tick(dt, t) {
      tau += dt; auto -= dt; if (auto < 0) { auto = 22 + Math.random() * 10; tau = 0; }
      const e = tau < 3 ? Math.sin(Math.PI * tau / 3) ** 0.6 : 0;
      column.scale.set(1 + e * 0.5, 0.001 + e * 4.2, 1 + e * 0.5); column.visible = e > 0.01;
      for (let k = 0; k < N; k++) {
        const a = (t * (0.25 + e * 0.6) + k / N) % 1, ang = k * 2.4;
        setAt(puffs, k, Math.cos(ang) * a * (0.3 + e * 0.6), 0.4 + a * (1.2 + e * 3.5), Math.sin(ang) * a * (0.3 + e * 0.6), k, (0.3 + a * 1.2) * (1 - a * 0.6) * (0.5 + e));
      }
      puffs.instanceMatrix.needsUpdate = true;
    },
    poke() { if (tau > 2.5) tau = 0; },
  };
};

// ---- It's a Feature: a giant ladybug wandering its lawn
const ladybug: Maker = (w, d, s) => {
  const g = new THREE.Group(), bug = new THREE.Group(); g.add(bug);
  const red = new THREE.Color('#d6281f'), black = new THREE.Color('#151515');
  const spots = Array.from({ length: 7 }, (_, k) => new THREE.Vector3(Math.cos(k * 2.4 + s) * 0.6, 0.7, Math.sin(k * 2.4 + s) * 0.55).normalize());
  bug.add(mesh(facets(new THREE.SphereGeometry(0.55, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), (x, y, z) => {
    const n = new THREE.Vector3(x, y, z).normalize();
    return Math.abs(z) < 0.03 && x < 0.3 || spots.some(p => p.distanceTo(n) < 0.24) ? black : red;
  }).scale(1.25, 0.75, 1).translate(0, 0.18, 0), paint('#ffffff', { vc: true, rough: 0.3, metal: 0.1 })));
  const legs: THREE.BufferGeometry[] = [ball(0.24, 0.66, 0.22, 0, 12), strut(new THREE.Vector3(0.8, 0.35, 0.08), new THREE.Vector3(1.05, 0.6, 0.2), 0.015, 4), strut(new THREE.Vector3(0.8, 0.35, -0.08), new THREE.Vector3(1.05, 0.6, -0.2), 0.015, 4)];
  for (const x of [-0.35, 0, 0.35]) for (const z of [-1, 1]) legs.push(strut(new THREE.Vector3(x, 0.2, z * 0.4), new THREE.Vector3(x * 1.2, 0, z * 0.75), 0.025, 4));
  bug.add(mesh(merge(legs), paint('#151515')));
  const hx = w / 2 - 0.9, hz = d / 2 - 0.9;
  let x = 0, z = 0, h = s * 6, tx = 0, tz = 0, fly = -1, fx = 0, fz = 0;
  const target = () => { tx = (Math.random() * 2 - 1) * hx; tz = (Math.random() * 2 - 1) * hz; };
  target();
  return {
    name: 'It\'s a Feature', hint: 'giant ladybug · definitely not a bug · click to shoo it', g, top: 1,
    tick(dt, t) {
      if (fly >= 0) {
        fly += dt; const f = Math.min(1, fly / 1.4);
        x = fx + (tx - fx) * smooth(f); z = fz + (tz - fz) * smooth(f); bug.position.y = Math.sin(f * Math.PI) * 1.4; h += dt * 6;
        if (f >= 1) { fly = -1; target(); }
      } else {
        const dx = tx - x, dz = tz - z, dist = Math.hypot(dx, dz);
        if (dist < 0.1) target();
        let da = Math.atan2(-dz, dx) - h; da = Math.atan2(Math.sin(da), Math.cos(da));
        h += da * Math.min(1, dt * 1.5);
        const sp = Math.abs(da) < 0.6 ? 0.3 : 0.05;
        x += Math.cos(h) * sp * dt; z -= Math.sin(h) * sp * dt;
        bug.position.y = Math.abs(Math.sin(t * 9)) * 0.015;
      }
      bug.position.x = x; bug.position.z = z; bug.rotation.y = h;
    },
    poke() { if (fly < 0) { fly = 0; fx = x; fz = z; tx = -Math.sign(x || 1) * hx * Math.random(); tz = -Math.sign(z || 1) * hz * Math.random(); } },
  };
};

// What fits where: the smallest footprint (long x short side) a maker needs and the
// one it takes out of a gap of the given size. Each one stands once per city.
type Kind = { k: string; min: [number, number]; size: (l: number, s: number) => [number, number]; make: Maker };
const fixed = (l: number, s: number) => () => [l, s] as [number, number];
const KINDS: Kind[] = [
  { k: 'coaster', min: [7, 5], size: (l, s) => [Math.min(l, 12), Math.min(s, 8)], make: coaster },
  { k: 'maze', min: [6, 6], size: (_l, s) => [Math.min(s, 9.6), Math.min(s, 9.6)], make: maze },
  { k: 'karts', min: [6, 4], size: (l, s) => [Math.min(l, 9), Math.min(s, 5)], make: karts },
  { k: 'ufo', min: [5, 5], size: fixed(5, 5), make: ufo },
  { k: 'train', min: [5, 4], size: (l, s) => [Math.min(l, 7), Math.min(s, 4.5)], make: train },
  { k: 'bumper', min: [5, 4], size: (l, s) => [Math.min(l, 6), Math.min(s, 4.5)], make: bumper },
  { k: 'gc', min: [5, 4], size: (l, s) => [Math.min(l, 6.5), Math.min(s, 4.5)], make: gc },
  { k: 'ferris', min: [5, 3], size: l => [Math.min(l, 6.5), 3], make: ferris },
  { k: 'pond', min: [4, 4], size: (l, s) => [Math.min(l, 7), Math.min(s, 5.5)], make: pond },
  { k: 'carousel', min: [4, 4], size: (_l, s) => [Math.min(s, 5), Math.min(s, 5)], make: carousel },
  { k: 'tree', min: [4, 4], size: fixed(4, 4), make: binaryTree },
  { k: 'ladybug', min: [4, 4], size: (l, s) => [Math.min(l, 5), Math.min(s, 4.5)], make: ladybug },
  { k: 'drop', min: [3, 3], size: fixed(3, 3), make: dropTower },
  { k: 'balloon', min: [3, 3], size: fixed(3, 3), make: balloon },
  { k: 'bouncy', min: [3, 3], size: fixed(3, 3), make: bouncy },
  { k: 'fireworks', min: [3, 3], size: fixed(3, 3), make: fireworks },
  { k: 'egg', min: [3, 3], size: fixed(3, 3), make: easterEgg },
  { k: 'globe', min: [3, 3], size: fixed(3, 3), make: globe },
  { k: 'knot', min: [3, 3], size: fixed(3, 3), make: knot },
  { k: 'geyser', min: [3, 3], size: fixed(3, 3), make: geyser },
  { k: 'swings', min: [3, 2], size: fixed(3, 2), make: swings },
  { k: 'pingpong', min: [3, 2], size: fixed(3, 2), make: pingPong },
  { k: 'seesaw', min: [3, 2], size: fixed(3, 2), make: seesaw },
  { k: 'popcorn', min: [2, 2], size: fixed(2, 2), make: popcorn },
  { k: 'stack', min: [2, 2], size: fixed(2, 2), make: callStack },
  { k: 'cuckoo', min: [2, 2], size: fixed(2, 2), make: cuckoo },
  { k: 'notfound', min: [2, 2], size: fixed(2, 2), make: notFound },
];

// The largest clear rectangle on a grid (1 = taken), scored so a long thin strip
// does not beat a squarer gap.
function largestRect(g: Uint8Array, W: number, H: number) {
  const hgt = new Int32Array(W + 1);
  let best: { x: number; z: number; w: number; h: number } | null = null, bestScore = 0;
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) hgt[x] = g[z * W + x] ? 0 : hgt[x] + 1;
    const st: number[] = [];
    for (let x = 0; x <= W; x++) {
      const h = x < W ? hgt[x] : 0;
      while (st.length && hgt[st[st.length - 1]] >= h) {
        const top = st.pop()!, hh = hgt[top], left = st.length ? st[st.length - 1] + 1 : 0, ww = x - left;
        const lo = Math.min(ww, hh), score = lo * Math.min(Math.max(ww, hh), lo * 2);
        if (hh && score > bestScore) { bestScore = score; best = { x: left, z: z - hh + 1, w: ww, h: hh }; }
      }
      st.push(x);
    }
  }
  return best;
}

export class Follies {
  group = new THREE.Group();
  rides: Ride[] = [];
  private tShown = Infinity;

  constructor(private city: City) {}

  // free(x, z): open ground with no street on it (Roads.free)
  build(free: (x: number, z: number) => boolean) {
    for (const o of [...this.group.children]) { this.group.remove(o); o.traverse(m => (m as THREE.Mesh).geometry?.dispose()); }
    this.rides = [];
    const c = this.city, lots: { d: typeof c.districts[number]; di: number; g: Uint8Array; W: number; H: number; open: number; left: number }[] = [];
    c.districts.forEach((d, di) => {
      if (!d.members.length) return;
      const W = Math.floor(d.w), H = Math.floor(d.h);
      if (W < 2 || H < 2) return;
      const g = new Uint8Array(W * H);
      const take = (x0: number, z0: number, x1: number, z1: number) => { // world rect -> cells it touches
        for (let j = Math.max(0, Math.floor(z0 - d.z)); j < Math.min(H, Math.ceil(z1 - d.z)); j++)
          for (let i = Math.max(0, Math.floor(x0 - d.x)); i < Math.min(W, Math.ceil(x1 - d.x)); i++) g[j * W + i] = 1;
      };
      for (const m of c.modules) take(m.x - 0.6, m.z - 0.6, m.x + m.w + 0.6, m.z + m.h + 0.6);
      for (const e of c.externals) take(e.x - e.w / 2 - 1, e.z - e.h / 2 - 1, e.x + e.w / 2 + 1, e.z + e.h / 2 + 1);
      let open = 0;
      for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        if (g[j * W + i]) continue;
        const x = d.x + i + 0.5, z = d.z + j + 0.5;
        if (![[0, 0], [-0.45, -0.45], [0.45, -0.45], [-0.45, 0.45], [0.45, 0.45]].every(([a, b]) => free(x + a, z + b))) g[j * W + i] = 1; else open++;
      }
      // bigger districts may take more; a little room is left so they never fill up
      if (open >= 4) lots.push({ d, di, g, W, H, open, left: Math.max(1, Math.min(8, Math.floor(open / 30))) });
    });
    // Every kind stands once. Districts take turns, roomiest first, so the follies
    // spread over the city; each turn the district's largest gap gets the largest
    // kind still unplaced that fits it.
    lots.sort((a, b) => b.open - a.open);
    const left = new Map(KINDS.map((k, i) => [k.k, { k, o: hash(i * 7.1 + c.project.w * 0.37) }]));
    for (let round = 0; round < 8 && left.size; round++) for (const L of lots) {
      if (L.left <= 0 || !left.size) continue;
      const { d, di, g, W, H } = L, r = largestRect(g, W, H);
      if (!r) { L.left = 0; continue; }
      const long = Math.max(r.w, r.h), short = Math.min(r.w, r.h);
      const pick = [...left.values()].filter(({ k }) => long >= k.min[0] && short >= k.min[1])
        .sort((a, b) => b.k.min[0] * b.k.min[1] - a.k.min[0] * a.k.min[1] || a.o - b.o)[0]?.k;
      if (!pick) { L.left = 0; continue; }
      left.delete(pick.k); L.left--;
      const [fl, fs] = pick.size(long, short), turn = r.h > r.w;
      const ww = turn ? fs : fl, wd = turn ? fl : fs;
      const cx = d.x + r.x + r.w / 2, cz = d.z + r.z + r.h / 2;
      for (let j = Math.max(0, Math.floor(cz - wd / 2 - 1 - d.z)); j < Math.min(H, Math.ceil(cz + wd / 2 + 1 - d.z)); j++)
        for (let i = Math.max(0, Math.floor(cx - ww / 2 - 1 - d.x)); i < Math.min(W, Math.ceil(cx + ww / 2 + 1 - d.x)); i++) g[j * W + i] = 1;
      const made = pick.make(fl, fs, hash(di * 17.3 + round * 3.1 + d.x * 0.7));
      made.g.position.set(cx, 0, cz); made.g.rotation.y = turn ? Math.PI / 2 : 0;
      const box = new THREE.Box3(new THREE.Vector3(cx - ww / 2, 0, cz - wd / 2), new THREE.Vector3(cx + ww / 2, made.top, cz + wd / 2));
      this.rides.push({ ...made, born: d.born, box });
      this.group.add(made.g);
    }
    this.tShown = Infinity;
  }

  // Follies appear with their district (replay).
  setTime(t: number) {
    if (t === this.tShown) return;
    this.tShown = t;
    for (const r of this.rides) r.g.visible = r.born <= t;
  }

  frame(dt: number, t: number) {
    const night = ENV.night.value, k = 0.45 + 1.05 * night;
    BULBS.forEach((m, i) => m.color.copy(BULB_COLS[i]).multiplyScalar(k * (0.9 + 0.1 * Math.sin(t * 5 + i * 2))));
    WATER.color.copy(WATER_C).multiplyScalar(0.62 + 0.14 * Math.sin(t * 2) - 0.3 * night);
    dt = Math.min(dt, 0.1);
    for (const r of this.rides) if (r.g.visible) r.tick(dt, t);
  }

  // The nearest folly a ray passes through, and how far along.
  hit(ray: THREE.Ray) {
    let best: { i: number; dist: number } | null = null;
    const p = new THREE.Vector3();
    this.rides.forEach((r, i) => {
      if (!r.g.visible || !ray.intersectBox(r.box, p)) return;
      const dist = p.distanceTo(ray.origin);
      if (!best || dist < best.dist) best = { i, dist };
    });
    return best as { i: number; dist: number } | null;
  }
}
