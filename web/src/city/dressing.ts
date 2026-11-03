import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { City } from '../api';
import type { World } from './world';
import type { Pt } from './route';
import { ENV } from './env';
import { hash, type Style } from './themes';

// Street furniture and landmarks: what stands on the ground around the buildings.
// Each district gets the props of its style along its edge (storage tanks for the
// data district, a wall and watchtowers for security, pylons for infrastructure...),
// sized by its traits where it has them (a tank per table, a flag per payment
// provider, a statue per media folder). Holes in a block, where files were deleted
// or never stood, become small parks. Around the city: lamps along the streets, a
// river behind it, an airfield (outside systems), a railway (commits) and a statue
// per hundred commits on the plaza. Rebuilt whenever places move.

type Kit = Record<string, { geo: THREE.BufferGeometry; mat: THREE.Material; shadow?: boolean }>;
const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z);
const cyl = (r0: number, r1: number, h: number, x = 0, y = 0, z = 0, seg = 10) => new THREE.CylinderGeometry(r0, r1, h, seg).translate(x, y + h / 2, z);
function merge(...g: THREE.BufferGeometry[]) {
  return mergeGeometries(g.map(x => { const n = x.index ? x.toNonIndexed() : x; for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal') n.deleteAttribute(k); return n; }))!;
}
const std = (color: string, glow = 0.06, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.15, emissive: color, emissiveIntensity: glow, ...extra });

function kit(): Kit {
  const lean = (w: number, h: number) => { const s = new THREE.Shape(); s.moveTo(-0.5, 0); s.lineTo(0.5, 0); s.lineTo(0, h); s.closePath(); return new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: false }).rotateY(Math.PI / 2).translate(-w / 2, 0, 0); };
  const hyper = new THREE.LatheGeometry(Array.from({ length: 9 }, (_, i) => { const y = i / 8; return new THREE.Vector2(0.55 - Math.sin(y * Math.PI) * 0.18 - y * 0.08, y * 1.6); }), 16);
  return {
    tree: { geo: merge(cyl(0.04, 0.05, 0.22), new THREE.ConeGeometry(0.2, 0.5, 7).translate(0, 0.45, 0)), mat: std('#2f6a3c', 0.08), shadow: true },
    roundTree: { geo: merge(cyl(0.04, 0.05, 0.2), new THREE.IcosahedronGeometry(0.2, 0).translate(0, 0.36, 0)), mat: std('#3d7a35', 0.08), shadow: true },
    grass: { geo: box(0.92, 0.02, 0.92), mat: std('#1f4a29', 0.12) },
    bench: { geo: merge(box(0.34, 0.03, 0.1, 0, 0.1), box(0.34, 0.1, 0.02, 0, 0.13, -0.05), box(0.03, 0.1, 0.08, -0.14), box(0.03, 0.1, 0.08, 0.14)), mat: std('#6b5136') },
    pole: { geo: merge(cyl(0.018, 0.025, 0.85), box(0.2, 0.02, 0.02, 0.09, 0.84)), mat: std('#4a5262') },
    lampHead: { geo: box(0.08, 0.04, 0.06, 0.18, 0.8), mat: new THREE.MeshBasicMaterial({ color: '#ffcf7a' }) },
    tank: { geo: merge(cyl(0.42, 0.42, 1, 0, 0, 0, 16), new THREE.SphereGeometry(0.42, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 1, 0)), mat: std('#aeb6c2', 0.08, { metalness: 0.6, roughness: 0.35 }), shadow: true },
    wall: { geo: merge(box(1.02, 0.42, 0.16), ...[-0.38, -0.12, 0.12, 0.38].map(x => box(0.14, 0.1, 0.16, x, 0.42))), mat: std('#6d6a66', 0.05), shadow: true },
    tower: { geo: merge(box(0.5, 1.7, 0.5), box(0.7, 0.14, 0.7, 0, 1.7), ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, z]) => box(0.14, 0.16, 0.14, x * 0.28, 1.84, z * 0.28))), mat: std('#625f5b', 0.05), shadow: true },
    flagPole: { geo: cyl(0.015, 0.02, 1.3), mat: std('#c9ced8', 0.1) },
    flag: { geo: box(0.36, 0.22, 0.015, 0.19, 1.05), mat: std('#ffffff', 0.35, { side: THREE.DoubleSide }) },
    silo: { geo: merge(cyl(0.32, 0.32, 1.3, 0, 0, 0, 12), new THREE.ConeGeometry(0.34, 0.3, 12).translate(0, 1.45, 0)), mat: std('#8f7f6a', 0.06), shadow: true },
    conveyor: { geo: merge(box(1, 0.06, 0.22, 0, 0.32), box(0.04, 0.32, 0.04, -0.4), box(0.04, 0.32, 0.04, 0.4)), mat: std('#3d434e', 0.1) },
    pylon: { geo: merge(new THREE.CylinderGeometry(0.03, 0.2, 2.2, 4).translate(0, 1.1, 0), box(0.8, 0.04, 0.04, 0, 1.85), box(0.6, 0.04, 0.04, 0, 1.55)), mat: std('#8a93a3', 0.08), shadow: true },
    cooling: { geo: hyper, mat: std('#b9bcc2', 0.06, { side: THREE.DoubleSide }), shadow: true },
    track: { geo: new THREE.TorusGeometry(0.75, 0.07, 6, 28).rotateX(Math.PI / 2).scale(1.3, 1, 0.8).translate(0, 0.05, 0), mat: std('#3b9a6a', 0.3) },
    mast: { geo: merge(new THREE.CylinderGeometry(0.04, 0.22, 4.2, 4).translate(0, 2.1, 0), box(0.5, 0.05, 0.5, 0, 1.6), box(0.36, 0.05, 0.36, 0, 2.8)), mat: std('#c14a3f', 0.1), shadow: true },
    blinker: { geo: new THREE.SphereGeometry(0.09, 8, 6).translate(0, 4.25, 0), mat: new THREE.MeshBasicMaterial({ color: '#ff3b3b' }) },
    pedestal: { geo: merge(box(0.4, 0.3, 0.4), box(0.3, 0.06, 0.3, 0, 0.3)), mat: std('#8d8a83', 0.05) },
    figure: { geo: merge(cyl(0.06, 0.09, 0.42, 0, 0.36), new THREE.SphereGeometry(0.07, 10, 8).translate(0, 0.86, 0), box(0.3, 0.05, 0.05, 0, 0.66)), mat: std('#b08d57', 0.12, { metalness: 0.7, roughness: 0.35 }), shadow: true },
    clock: { geo: merge(box(0.8, 3.1, 0.8), new THREE.ConeGeometry(0.62, 0.8, 4).rotateY(Math.PI / 4).translate(0, 3.5, 0)), mat: std('#6a5240', 0.05), shadow: true },
    clockFace: { geo: merge(new THREE.CylinderGeometry(0.26, 0.26, 0.82, 18).rotateX(Math.PI / 2).translate(0, 2.65, 0), new THREE.CylinderGeometry(0.26, 0.26, 0.82, 18).rotateZ(Math.PI / 2).translate(0, 2.65, 0)), mat: new THREE.MeshBasicMaterial({ color: '#ffe7b0' }) },
    crate: { geo: box(0.3, 0.26, 0.3), mat: std('#8a6a3d', 0.05) },
    shed: { geo: merge(box(0.7, 0.45, 0.5), lean(0.74, 0.22).translate(0, 0.45, 0)), mat: std('#596069', 0.05), shadow: true },
    dish: { geo: merge(cyl(0.05, 0.08, 0.6), new THREE.SphereGeometry(0.55, 16, 8, 0, Math.PI * 2, 0, Math.PI / 3).rotateX(Math.PI * 0.8).translate(0, 0.85, 0)), mat: std('#e3e8ef', 0.1, { side: THREE.DoubleSide }), shadow: true },
    gantry: { geo: merge(box(0.1, 2, 0.1, -0.7, 0, -0.3), box(0.1, 2, 0.1, -0.7, 0, 0.3), box(0.1, 2, 0.1, 0.7, 0, -0.3), box(0.1, 2, 0.1, 0.7, 0, 0.3), box(1.7, 0.16, 0.7, 0, 2), box(0.24, 0.2, 0.3, 0.2, 1.8)), mat: std('#e2662a', 0.15), shadow: true },
    container: { geo: box(0.62, 0.28, 0.28), mat: std('#ffffff', 0.08), shadow: true },
    fountain: { geo: merge(cyl(0.55, 0.6, 0.14, 0, 0, 0, 20), cyl(0.08, 0.1, 0.5, 0, 0, 0, 8), cyl(0.25, 0.25, 0.04, 0, 0.42, 0, 14)), mat: std('#9aa1ad', 0.06) },
    water: { geo: cyl(0.5, 0.5, 0.02, 0, 0.13, 0, 20), mat: new THREE.MeshBasicMaterial({ color: '#3fb6d9' }) },
    fence: { geo: merge(box(1, 0.04, 0.03, 0, 0.18), box(1, 0.04, 0.03, 0, 0.08), box(0.03, 0.22, 0.03, -0.48), box(0.03, 0.22, 0.03, 0.48)), mat: std('#d8d2c4', 0.05) },
    rail: { geo: merge(box(1, 0.03, 0.05, 0, 0, -0.18), box(1, 0.03, 0.05, 0, 0, 0.18), ...[-0.35, 0, 0.35].map(x => box(0.1, 0.02, 0.56, x))), mat: std('#6b6f78', 0.08) },
    platform: { geo: merge(box(1, 0.2, 0.7), box(1, 0.05, 0.8, 0, 0.9), box(0.06, 0.7, 0.06, 0, 0.2, -0.3)), mat: std('#4e5564', 0.08) },
    runway: { geo: box(1, 0.02, 1), mat: std('#1c2029', 0.05) },
    runwayLine: { geo: box(0.12, 0.01, 0.6, 0, 0.02), mat: new THREE.MeshBasicMaterial({ color: '#d9dde6' }) },
    hangar: { geo: new THREE.CylinderGeometry(1, 1, 3, 16, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateY(Math.PI / 2).translate(0, 0, 0), mat: std('#7d8696', 0.06, { side: THREE.DoubleSide }), shadow: true },
    helipad: { geo: merge(cyl(0.6, 0.6, 0.04, 0, 0, 0, 20)), mat: std('#2c3340', 0.1) },
    // the country around the city (white materials: each one is tinted per instance)
    pine: { geo: merge(cyl(0.035, 0.045, 0.2), new THREE.ConeGeometry(0.22, 0.42, 7).translate(0, 0.38, 0), new THREE.ConeGeometry(0.16, 0.34, 7).translate(0, 0.6, 0)), mat: std('#ffffff', 0.03, { roughness: 0.9, metalness: 0 }), shadow: true },
    oak: { geo: merge(cyl(0.04, 0.05, 0.22), new THREE.IcosahedronGeometry(0.24, 0).scale(1, 0.85, 1).translate(0, 0.42, 0)), mat: std('#ffffff', 0.03, { roughness: 0.9, metalness: 0, flatShading: true }), shadow: true },
    bush: { geo: new THREE.IcosahedronGeometry(0.14, 0).scale(1.3, 0.75, 1).translate(0, 0.08, 0), mat: std('#ffffff', 0.03, { roughness: 0.95, metalness: 0, flatShading: true }), shadow: true },
    flower: { geo: box(0.05, 0.05, 0.05), mat: std('#ffffff', 0.2, { roughness: 0.8, metalness: 0 }) },
    sheep: { geo: merge(box(0.2, 0.11, 0.12, 0, 0.05), box(0.02, 0.05, 0.02, -0.06), box(0.02, 0.05, 0.02, 0.06)), mat: std('#f2f0ea', 0.05, { roughness: 1, metalness: 0 }), shadow: true },
    sheepHead: { geo: box(0.06, 0.06, 0.06, 0.12, 0.1), mat: std('#2b2a28', 0.02, { roughness: 1, metalness: 0 }) },
  };
}

class Batch {
  private items = new Map<string, { m: THREE.Matrix4[]; c: (THREE.Color | null)[]; born: number[] }>();
  add(kind: string, x: number, y: number, z: number, s: number | [number, number, number] = 1, ry = 0, color: THREE.Color | null = null, born = 0) {
    let it = this.items.get(kind); if (!it) this.items.set(kind, it = { m: [], c: [], born: [] });
    const sc = typeof s === 'number' ? new THREE.Vector3(s, s, s) : new THREE.Vector3(...s);
    it.m.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(UP, ry), sc));
    it.c.push(color); it.born.push(born);
  }
  build(K: Kit, group: THREE.Group) {
    const out = new Map<string, { mesh: THREE.InstancedMesh; m: THREE.Matrix4[]; born: number[] }>();
    for (const [kind, it] of this.items) {
      const k = K[kind];
      const mesh = new THREE.InstancedMesh(k.geo, k.mat, it.m.length);
      mesh.castShadow = !!k.shadow; mesh.receiveShadow = true; mesh.frustumCulled = false;
      it.m.forEach((m, i) => { mesh.setMatrixAt(i, m); if (it.c[i]) mesh.setColorAt(i, it.c[i]!); });
      if (it.c.some(c => c)) it.c.forEach((c, i) => { if (!c) mesh.setColorAt(i, WHITE); });
      group.add(mesh);
      out.set(kind, { mesh, m: it.m, born: it.born });
    }
    return out;
  }
}
const UP = new THREE.Vector3(0, 1, 0), WHITE = new THREE.Color('#ffffff'), ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const PLATE = 0.3; // plates stand this high

// A loop just outside a district's plots, on its own ground.
export function ringOf(d: { x: number; z: number; w: number; h: number }, off: number): Pt[] {
  const x0 = d.x - off, z0 = d.z - off, x1 = d.x + d.w + off, z1 = d.z + d.h + off;
  return [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]];
}
// Points every `step` along a polyline, with the direction there.
function along(pts: Pt[], step: number, phase = 0.5) {
  const out: { x: number; z: number; dx: number; dz: number; corner: boolean }[] = [];
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i], len = Math.hypot(bx - ax, bz - az); if (len < 1e-3) continue;
    const dx = (bx - ax) / len, dz = (bz - az) / len, n = Math.max(1, Math.floor(len / step));
    for (let k = 0; k < n; k++) { const s = (k + phase) * len / n; out.push({ x: ax + dx * s, z: az + dz * s, dx, dz, corner: false }); }
    out.push({ x: bx, z: bz, dx, dz, corner: true });
  }
  return out;
}

export class Dressing {
  group = new THREE.Group();
  bounds = { x0: -10, x1: 10, z0: -10, z1: 10, cx: 0, cz: 0, span: 20 };
  airport = { x: 0, z: 0, len: 14 };      // runway start (planes roll toward -z)
  helipad = { x: 0, z: 0 };
  rail = { z: 0, x0: 0, x1: 0, station: 0 }; // the railway along the front of the city
  parks: { x: number; z: number }[] = [];  // trees birds settle over
  ticker: { x: number; y: number; z: number } | null = null; // the commit ticker's billboard
  private K = kit();
  private built = new Map<string, { mesh: THREE.InstancedMesh; m: THREE.Matrix4[]; born: number[] }>();
  private beams: { mesh: THREE.Mesh; ph: number }[] = [];
  private statues: THREE.InstancedMesh; private statueFig: THREE.InstancedMesh;
  private river: THREE.Mesh | null = null;
  private tShown = -1;
  private uTime = { value: 0 };

  constructor(private world: World, private city: City) {
    this.statues = new THREE.InstancedMesh(this.K.pedestal.geo, this.K.pedestal.mat, 40);
    this.statueFig = new THREE.InstancedMesh(this.K.figure.geo, std('#c9a24a', 0.25, { metalness: 0.8, roughness: 0.3 }), 40);
    this.statues.count = this.statueFig.count = 0;
    this.build();
  }

  build() {
    for (const o of [...this.group.children]) { this.group.remove(o); if (o instanceof THREE.InstancedMesh && o !== this.statues && o !== this.statueFig) o.dispose(); }
    this.beams = []; this.parks = [];
    const c = this.city, W = this.world, roads = W.roads, B = new Batch();
    const free = (x: number, z: number, r = 0) => roads.free(x, z) && (!r || [[r, 0], [-r, 0], [0, r], [0, -r]].every(([a, b]) => roads.free(x + a, z + b)));

    // bounds of everything that stands
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const m of c.modules) { x0 = Math.min(x0, m.x); x1 = Math.max(x1, m.x + m.w); z0 = Math.min(z0, m.z); z1 = Math.max(z1, m.z + m.h); }
    for (const e of c.externals) { x0 = Math.min(x0, e.x - e.w / 2); x1 = Math.max(x1, e.x + e.w / 2); z0 = Math.min(z0, e.z - e.h / 2); z1 = Math.max(z1, e.z + e.h / 2); }
    if (!Number.isFinite(x0)) { x0 = z0 = -10; x1 = z1 = 10; }
    const Bd = this.bounds = { x0, x1, z0, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, span: Math.max(20, x1 - x0, z1 - z0) };

    // ---- districts
    c.districts.forEach((d, di) => {
      if (!d.members.length) return;
      const st = W.styles[di], born = d.born, hue = d.hue / 360;
      const pts = along(ringOf(d, 0.62), 1.3).filter(p => free(p.x, p.z));
      const prop = (k: string) => d.props.find(p => p.k === k);
      const count = (k: string) => { const p = prop(k); return p ? p.total ?? p.v.length : 0; };
      const nMods = d.members.filter(m => m[0] === 1).length;
      const add = (k: string, p: { x: number; z: number; dx: number; dz: number }, s: number | [number, number, number] = 1, col: THREE.Color | null = null) =>
        B.add(k, p.x, PLATE * 0, p.z, s, Math.atan2(-p.dz, p.dx), col, born);
      // the landmark: at the first free corner with room around it
      const corners = along(ringOf(d, 1.1), 1e9, 0).filter(p => p.corner && free(p.x, p.z, 0.7));
      const mark = corners[(di * 3) % Math.max(1, corners.length)] || null;
      const lamp = (p: typeof pts[number]) => { add('pole', p); add('lampHead', p); };
      const seq: Record<Style, (p: typeof pts[number], k: number) => void> = {
        shops: (p, k) => k % 3 === 0 ? lamp(p) : k % 3 === 1 ? add('roundTree', p) : add('bench', p),
        vault: (p, k) => k < Math.min(10, 2 + count('Tables')) ? add('tank', p, [0.8, 0.6 + Math.min(1.4, Math.log2(1 + count('Migrations')) * 0.25), 0.8]) : k % 3 === 0 ? lamp(p) : undefined,
        fortress: (p, k) => k % 4 === 0 ? lamp(p) : undefined,
        bank: (p, k) => { const prov = prop('Providers')?.v || []; const n = Math.max(2, prov.length); if (k < n) { add('flagPole', p); add('flag', p, 1, new THREE.Color().setHSL(hash((prov[k]?.t.length ?? k) * 3.7 + k), 0.75, 0.55)); } else if (k % 3 === 0) lamp(p); },
        factory: (p, k) => k % 4 === 0 ? add('silo', p) : k % 4 === 1 ? add('conveyor', p, [1.2, 1, 1]) : k % 4 === 2 ? lamp(p) : add('crate', p),
        power: (p, k) => k % 2 === 0 ? add('pylon', p) : undefined,
        lab: (p, k) => k % 3 === 0 ? lamp(p) : k % 3 === 1 ? add('tree', p) : undefined,
        media: (p, k) => k % 3 === 0 ? lamp(p) : k % 3 === 1 ? add('roundTree', p) : undefined,
        gallery: (p, k) => k < Math.min(10, Math.max(2, nMods)) ? (add('pedestal', p), B.add('figure', p.x, 0, p.z, 1, k, null, born)) : k % 3 === 0 ? lamp(p) : add('roundTree', p),
        library: (p, k) => k % 3 === 0 ? lamp(p) : k % 3 === 1 ? add('roundTree', p) : add('bench', p),
        workshop: (p, k) => k % 4 === 0 ? add('shed', p) : k % 4 === 1 ? (add('crate', p), B.add('crate', p.x + 0.1, 0.26, p.z + 0.05, 0.85, 0.4, null, born)) : k % 4 === 2 ? lamp(p) : undefined,
        offices: (p, k) => k % 2 === 0 ? lamp(p) : add('tree', p),
        campus: (p, k) => k % 3 === 0 ? lamp(p) : add('tree', p),
        port: (p, k) => k % 3 === 2 ? lamp(p) : (add('container', p, 1, new THREE.Color().setHSL(hash(k + di), 0.6, 0.45)), k % 2 ? B.add('container', p.x, 0.28, p.z, 1, Math.atan2(-p.dz, p.dx), new THREE.Color().setHSL(hash(k * 3 + di), 0.6, 0.45), born) : 0),
        civic: (p, k) => k % 3 === 0 ? (add('flagPole', p), add('flag', p, 1, new THREE.Color().setHSL(hue, 0.7, 0.5))) : k % 3 === 1 ? lamp(p) : add('roundTree', p),
        homes: (p, k) => k % 3 === 2 ? add('fence', p) : add(k % 2 ? 'roundTree' : 'tree', p),
      };
      pts.forEach((p, k) => seq[st](p, k));
      // walls: security keeps its ground walled in, with gaps where streets come through
      if (st === 'fortress') {
        for (const p of along(ringOf(d, 0.95), 1.0)) if (free(p.x, p.z)) add('wall', p);
        for (const p of along(ringOf(d, 0.95), 1e9, 0).filter(p => p.corner)) if (free(p.x, p.z)) {
          add('tower', p);
          const beam = new THREE.Mesh(new THREE.ConeGeometry(0.9, 6, 16, 1, true).translate(0, -3, 0).rotateX(-Math.PI / 2.6),
            new THREE.MeshBasicMaterial({ color: '#fff3c4', transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
          beam.position.set(p.x, 2.05, p.z); beam.userData.born = born;
          this.group.add(beam); this.beams.push({ mesh: beam, ph: hash(p.x + p.z) * 6.28 });
        }
      }
      if (st === 'power') { // power lines between the pylons
        const py = pts.filter((_, k) => k % 2 === 0), line: number[] = [];
        for (let k = 1; k < py.length; k++) if (Math.hypot(py[k].x - py[k - 1].x, py[k].z - py[k - 1].z) < 3.2) line.push(py[k - 1].x, 1.85, py[k - 1].z, py[k].x, 1.85, py[k].z);
        if (line.length) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(line, 3)); const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#7fa6c9', transparent: true, opacity: 0.5 })); l.userData.born = born; this.group.add(l); }
      }
      if (mark) {
        const big: Partial<Record<Style, () => void>> = {
          vault: () => B.add('tank', mark.x, 0, mark.z, [1.5, 1.4, 1.5], 0, null, born),
          bank: () => B.add('fountain', mark.x, 0, mark.z, 1, 0, null, born),
          factory: () => { B.add('silo', mark.x, 0, mark.z, [1.4, 1.6, 1.4], 0, null, born); B.add('silo', mark.x + 0.6, 0, mark.z + 0.5, 1, 0, null, born); },
          power: () => B.add('cooling', mark.x, 0, mark.z, 1.2, 0, null, born),
          lab: () => B.add('track', mark.x, 0, mark.z, 1, 0, null, born),
          media: () => { B.add('mast', mark.x, 0, mark.z, 1, 0, null, born); B.add('blinker', mark.x, 0, mark.z, 1, 0, null, born); },
          library: () => { B.add('clock', mark.x, 0, mark.z, 1, 0, null, born); B.add('clockFace', mark.x, 0, mark.z, 1, 0, null, born); },
          workshop: () => B.add('shed', mark.x, 0, mark.z, 1.6, 0.3, null, born),
          offices: () => B.add('fountain', mark.x, 0, mark.z, 1, 0, null, born),
          campus: () => B.add('dish', mark.x, 0, mark.z, 1.6, 0.8, null, born),
          port: () => B.add('gantry', mark.x, 0, mark.z, 1, Math.atan2(-mark.dz, mark.dx), null, born),
          civic: () => B.add('fountain', mark.x, 0, mark.z, 1.2, 0, null, born),
          shops: () => B.add('fountain', mark.x, 0, mark.z, 0.9, 0, null, born),
          gallery: () => { B.add('pedestal', mark.x, 0, mark.z, 1.8, 0, null, born); B.add('figure', mark.x, -0.12, mark.z, 2.2, 0.5, null, born); },
          homes: () => B.add('roundTree', mark.x, 0, mark.z, 2, 0, null, born),
          fortress: () => B.add('tower', mark.x, 0, mark.z, [1.2, 1.4, 1.2], 0, null, born),
        };
        big[st]?.();
        if (st === 'bank' || st === 'offices' || st === 'civic' || st === 'shops') B.add('water', mark.x, 0, mark.z, st === 'civic' ? 1.2 : st === 'shops' ? 0.9 : 1, 0, null, born);
      }
    });

    // ---- parks: holes in a block (a deleted file's lot, or one never filled)
    const lots = c.modules.map(() => new Set<number>());
    for (const f of c.files) lots[f.m].add(f.lot);
    c.modules.forEach((m, mi) => {
      if (m.warehouse || !m.cols) return;
      const used = lots[mi];
      const born = m.born;
      for (let lot = 0; lot < m.cols * m.rows; lot++) {
        if (used.has(lot)) continue;
        const x = m.x + 0.5 + (lot % m.cols) + 0.5, z = m.z + 0.5 + Math.floor(lot / m.cols) + 0.5, s = hash(x * 3.1 + z * 7.7);
        B.add('grass', x, PLATE, z, 1, 0, null, born);
        B.add(s < 0.5 ? 'roundTree' : 'tree', x + (s - 0.5) * 0.4, PLATE + 0.02, z - 0.15, 0.9 + s * 0.4, s * 6, new THREE.Color().setHSL(0.27 + s * 0.08, 0.5, 0.32 + s * 0.1), born);
        if (s > 0.6) B.add('bench', x, PLATE + 0.02, z + 0.3, 1, 0, null, born);
        this.parks.push({ x, z });
      }
    });

    // ---- lamps along the streets
    let lamps = 0;
    for (const pts of roads.linkPts.values()) {
      for (const p of along(pts, 2.6)) {
        if (p.corner || lamps > 900) continue;
        const side = (Math.round(p.x * 7 + p.z * 13) & 1) ? 1 : -1, x = p.x - p.dz * 0.72 * side, z = p.z + p.dx * 0.72 * side;
        if (!free(x, z)) continue;
        B.add('pole', x, 0, z, 1, Math.atan2(-p.dx * side, -p.dz * side) + Math.PI / 2); B.add('lampHead', x, 0, z, 1, Math.atan2(-p.dx * side, -p.dz * side) + Math.PI / 2);
        lamps++;
      }
    }

    // ---- around the city: river behind, railway in front, airfield to the side
    const L = Bd.span + 70;
    if (!this.river) {
      const mat = new THREE.MeshStandardMaterial({ color: '#0b2236', roughness: 0.25, metalness: 0.5, emissive: '#0c3550', emissiveIntensity: 0.4 });
      mat.onBeforeCompile = sh => {
        sh.uniforms.uTime = this.uTime;
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vW;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vW; uniform float uTime;')
          .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
            float w = sin(vW.x * 1.3 + uTime * 1.1) * sin(vW.z * 2.1 - uTime * 0.7) + sin((vW.x + vW.z) * 0.6 + uTime * 0.5);
            totalEmissiveRadiance += vec3(0.25, 0.55, 0.75) * smoothstep(1.2, 1.9, w) * 0.5;`);
      };
      this.river = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat);
      this.river.receiveShadow = true;
    }
    this.river.scale.set(L, 1, 6); this.river.position.set(Bd.cx, 0.01, z0 - 11);
    this.group.add(this.river);
    for (const p of along([[Bd.cx - L / 2, z0 - 7.6], [Bd.cx + L / 2, z0 - 7.6]], 2.2)) B.add('roundTree', p.x, 0, p.z, 1.1, p.x);

    this.rail = { z: z1 + 12, x0: Bd.cx - L / 2, x1: Bd.cx + L / 2, station: Bd.cx - 4 };
    for (let x = this.rail.x0; x < this.rail.x1; x += 1) B.add('rail', x + 0.5, 0, this.rail.z);
    for (let k = -3; k <= 3; k++) B.add('platform', this.rail.station + k, 0, this.rail.z - 0.75);

    this.airport = { x: x1 + 10, z: Bd.cz + Math.min(14, Bd.span * 0.3), len: Math.min(28, Bd.span * 0.6) };
    const A = this.airport;
    B.add('runway', A.x, 0, A.z - A.len / 2, [2.2, 1, A.len + 2]);
    for (let s = 1; s < A.len; s += 1.6) B.add('runwayLine', A.x, 0, A.z - s);
    B.add('hangar', A.x + 3.4, 0, A.z - 2, [1.2, 1, 1]);
    this.helipad = { x: A.x + 3.4, z: A.z - A.len + 2 };
    B.add('helipad', this.helipad.x, 0, this.helipad.z);

    // ---- the country around: woods, lone trees and hedges, meadows with flowers and flocks.
    // A slow noise decides what grows where, so it comes in groves and clearings; nothing
    // grows on a district's ground, a street, the plaza, the river, the railway or the airfield.
    const ex = 2.2, plaza = { x0: Bd.cx - 30, x1: Bd.cx + 22, z0: z1 + 1.5, z1: z1 + 10.5 };
    const taken = (x: number, z: number) =>
      c.districts.some(d => d.members.length && x > d.x - ex && x < d.x + d.w + ex && z > d.z - ex && z < d.z + d.h + ex) ||
      c.externals.some(e => Math.abs(x - e.x) < e.w / 2 + 1.5 && Math.abs(z - e.z) < e.h / 2 + 1.5) ||
      (z > z0 - 14.6 && z < z0 - 7.1) || Math.abs(z - this.rail.z) < 2 ||
      (x > A.x - 2.6 && x < A.x + 5.6 && z > A.z - A.len - 3.2 && z < A.z + 2.6) ||
      (x > plaza.x0 && x < plaza.x1 && z > plaza.z0 && z < plaza.z1) || !free(x, z, 0.5);
    const wild = (x: number, z: number) => 0.5 + 0.28 * Math.sin(x * 0.11 + 1.7) * Math.sin(z * 0.13 - 0.4) + 0.22 * Math.sin((x + z) * 0.071 + 3.1) * Math.sin((x - z) * 0.093);
    const green = (s: number, dark = 0) => new THREE.Color().setHSL(0.24 + s * 0.09, 0.42 + s * 0.15, 0.3 + s * 0.12 - dark);
    const FLOWERS = ['#e8505b', '#f2c94c', '#ffffff', '#b07fd8', '#f29ab2'].map(h => new THREE.Color(h));
    const R = 34, G = 1.15;
    let flocks = 0, trees = 0;
    for (let gx = x0 - R; gx < x1 + R; gx += G) for (let gz = z0 - R; gz < z1 + R; gz += G) {
      const s = hash(gx * 12.9898 + gz * 78.233), s2 = hash(gx * 3.17 - gz * 9.71);
      const x = gx + (s - 0.5) * G * 0.9, z = gz + (s2 - 0.5) * G * 0.9;
      if (taken(x, z)) continue;
      const w = wild(x, z);
      if (w > 0.57 && trees < 3200) {                           // woods: dense, pines and oaks mixed
        const pine = s2 < 0.35 + (w - 0.57) * 1.5;
        B.add(pine ? 'pine' : 'oak', x, 0, z, 0.85 + s * 0.7, s * 6.28, green(s, pine ? 0.08 : 0));
        if (w > 0.64 && s2 > 0.4) { B.add(s > 0.5 ? 'pine' : 'oak', x + 0.5, 0, z + 0.35, 0.8 + s2 * 0.6, s2 * 9, green(s2, 0.05)); trees++; } // thick inside
        else if (s > 0.55) B.add('bush', x + 0.45, 0, z - 0.3, 0.8 + s2 * 0.6, s2 * 6.28, green(s2, 0.04));
        trees++;
        if ((trees & 31) === 0) this.parks.push({ x, z });  // birds settle in the woods too
      } else if (w > 0.45) {                                  // edges: a lone tree, a hedge
        if (s < 0.14) { B.add('oak', x, 0, z, 1 + s2 * 0.6, s * 40, green(s2)); trees++; }
        else if (s < 0.3) B.add('bush', x, 0, z, 0.9 + s2 * 0.5, s * 40, green(s2, 0.03));
      } else if (w < 0.36) {                                  // meadows: flowers, now and then a flock
        if (s < 0.22) for (let k = 0; k < 3; k++)
          B.add('flower', x + (hash(s * 91 + k) - 0.5) * 0.8, 0, z + (hash(s2 * 57 + k) - 0.5) * 0.8, 0.7 + hash(s + k) * 0.6, 0, FLOWERS[Math.floor(hash(s2 + k * 7) * FLOWERS.length)]);
        else if (s > 0.995 && flocks < 6) {
          flocks++;
          for (let k = 0; k < 6 + Math.floor(s2 * 5); k++) {
            const a = hash(s * 13 + k) * 6.28, r = 0.3 + hash(s2 * 17 + k) * 1.6, sx = x + Math.cos(a) * r, sz = z + Math.sin(a) * r, ry = hash(k * 3.3 + s) * 6.28;
            if (taken(sx, sz)) continue;
            B.add('sheep', sx, 0, sz, 1, ry); B.add('sheepHead', sx, 0, sz, 1, ry);
          }
        }
      }
    }

    this.built = B.build(this.K, this.group);
    this.group.add(this.statues, this.statueFig);
    this.tShown = -1;

    // where the commit ticker hangs: the tallest media building, else the tallest building
    const F = W.files;
    let best = -1, bestMedia = -1;
    for (let i = 0; i < F.count; i++) {
      if (best < 0 || F.hTo[i] > F.hTo[best]) best = i;
      if (W.styles[c.modules[c.files[i].m].district] === 'media' && (bestMedia < 0 || F.hTo[i] > F.hTo[bestMedia])) bestMedia = i;
    }
    const tk = bestMedia >= 0 ? bestMedia : best;
    this.ticker = tk >= 0 ? { x: F.pos[tk * 3], y: F.hTo[tk] + 1.4, z: F.pos[tk * 3 + 2] } : null;
  }

  // A statue on the plaza for every hundred commits.
  setStatues(commits: number) {
    const n = Math.min(40, Math.floor(commits / 100)), B = this.bounds;
    const signW = Math.min(16, Math.max(8, this.city.project.name.length * 0.9));
    for (let k = 0; k < n; k++) {
      const x = B.cx - signW / 2 - 2 - (k % 10) * 1.5, z = B.z1 + 5 + Math.floor(k / 10) * 1.6;
      M.compose(P.set(x, 0, z), Q.identity(), S.setScalar(1)); this.statues.setMatrixAt(k, M);
      M.compose(P.set(x, 0, z), Q.setFromAxisAngle(UP, k * 0.7), S.setScalar(1)); this.statueFig.setMatrixAt(k, M);
    }
    this.statues.count = this.statueFig.count = n;
    this.statues.instanceMatrix.needsUpdate = this.statueFig.instanceMatrix.needsUpdate = true;
  }

  // Props of a district appear with it (replay).
  setTime(t: number) {
    if (Math.abs(t - this.tShown) < 1000) return;
    this.tShown = t;
    for (const { mesh, m, born } of this.built.values()) {
      let any = false;
      for (let i = 0; i < m.length; i++) { const on = born[i] <= t; mesh.setMatrixAt(i, on ? m[i] : ZERO); any = true; }
      if (any) mesh.instanceMatrix.needsUpdate = true;
    }
    for (const o of this.group.children) if (o.userData.born != null) o.visible = o.userData.born <= t;
  }

  frame(dt: number, t: number) {
    this.uTime.value = t;
    const night = ENV.night.value;
    const head = this.built.get('lampHead'); if (head) (head.mesh.material as THREE.MeshBasicMaterial).color.setRGB(1, 0.81, 0.48).multiplyScalar(0.18 + 1.1 * night);
    const face = this.built.get('clockFace'); if (face) (face.mesh.material as THREE.MeshBasicMaterial).color.setRGB(1, 0.9, 0.69).multiplyScalar(0.35 + 0.9 * night);
    const bl = this.built.get('blinker'); if (bl) (bl.mesh.material as THREE.MeshBasicMaterial).color.setRGB(1, 0.2, 0.2).multiplyScalar(Math.sin(t * 3) > 0.3 ? 1.6 : 0.15);
    const wa = this.built.get('water'); if (wa) (wa.mesh.material as THREE.MeshBasicMaterial).color.setRGB(0.25, 0.71, 0.85).multiplyScalar(0.55 + 0.25 * Math.sin(t * 2.2));
    for (const b of this.beams) {
      b.mesh.rotation.y = b.ph + t * 0.6;
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = 0.03 + 0.12 * night;
    }
  }
}
const M = new THREE.Matrix4(), P = new THREE.Vector3(), Q = new THREE.Quaternion(), S = new THREE.Vector3();
