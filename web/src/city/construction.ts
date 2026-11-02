import * as THREE from 'three';

// Building sites: while a building goes up, or a file is being written, a tower
// crane, an excavator and a dump truck work beside it, inside a scaffold. They
// show while single file buildings do, and grow as the camera pulls back so
// they stay readable (the crane always clears the roof).
const SHOW_BELOW = 115; // viewSize; above it the city shows module blocks
const TRUE_SIZE = 20;   // viewSize at which the machines are drawn to scale
const MAX_SITES = 24;

const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

// one shared set of parts for every site
function parts() {
  const mat = (color: string, glow = 0.35) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.25, emissive: color, emissiveIntensity: glow });
  return {
    yellow: mat('#f2b41d'), orange: mat('#e2662a'), dark: mat('#2a2e38', 0.05), steel: mat('#8b93a3', 0.12), concrete: mat('#5b6070', 0.08),
    glass: new THREE.MeshStandardMaterial({ color: '#203040', emissive: '#7fd0ff', emissiveIntensity: 0.6, roughness: 0.2 }),
    lamp: new THREE.MeshBasicMaterial({ color: '#ffab3a' }),
    scaffoldMat: new THREE.LineBasicMaterial({ color: '#ffb547', transparent: true, opacity: 0.55 }),
    mast: box(0.07, 1, 0.07, 0, 0.5, 0), pad: box(0.24, 0.05, 0.24, 0, 0.025, 0),
    jib: box(1.5, 0.05, 0.05, 0.75, 0, 0), counterJib: box(0.5, 0.06, 0.07, -0.25, 0, 0), weight: box(0.14, 0.12, 0.11, -0.44, -0.07, 0),
    apex: box(0.04, 0.22, 0.04, 0, 0.11, 0), craneCab: box(0.09, 0.08, 0.09, 0.05, -0.06, 0.07),
    trolley: box(0.08, 0.03, 0.06, 0, -0.035, 0), cable: box(0.012, 1, 0.012, 0, -0.5, 0), load: box(0.32, 0.05, 0.07),
    tracks: box(0.3, 0.07, 0.24, 0, 0.035, 0), body: box(0.22, 0.12, 0.18, -0.02, 0.13, 0), digCab: box(0.09, 0.1, 0.08, 0.05, 0.24, 0.05),
    boom: box(0.32, 0.045, 0.05, 0.16, 0, 0), stick: box(0.22, 0.04, 0.04, 0.11, 0, 0), bucket: box(0.07, 0.07, 0.08, 0.02, -0.03, 0),
    chassis: box(0.3, 0.04, 0.12, 0, 0.06, 0), truckCab: box(0.09, 0.1, 0.12, 0.1, 0.13, 0), bed: box(0.19, 0.09, 0.13, 0.095, 0.045, 0), // hinged at its rear end
    wheel: new THREE.CylinderGeometry(0.035, 0.035, 0.025, 10).rotateX(Math.PI / 2), light: new THREE.SphereGeometry(0.035, 8, 6),
    scaffold: scaffoldGeo(),
  };
}

// a unit cage: corner and mid-face poles, a ring every quarter of the height
function scaffoldGeo() {
  const p: number[] = [];
  const seg = (a: number[], b: number[]) => p.push(...a, ...b);
  for (const [x, z] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [0, -0.5], [0.5, 0], [0, 0.5], [-0.5, 0]]) seg([x, 0, z], [x, 1, z]);
  for (let y = 0.25; y <= 1; y += 0.25) {
    const c = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
    for (let k = 0; k < 4; k++) seg([c[k][0], y, c[k][1]], [c[(k + 1) % 4][0], y, c[(k + 1) % 4][1]]);
  }
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
}

interface Site {
  key: string; height: () => number; at: () => [number, number]; hw: number; hd: number; s: number; rx: number; rz: number; crane: THREE.Group; digger: THREE.Group; life: number; age: number; seed: number;
  g: THREE.Group; mast: THREE.Mesh; top: THREE.Group; trolley: THREE.Group; cable: THREE.Mesh; hook: THREE.Group;
  body: THREE.Group; boom: THREE.Group; stick: THREE.Group; truck: THREE.Group; bed: THREE.Mesh; scaffold: THREE.LineSegments; lamps: THREE.Mesh[];
}

export class Construction {
  group = new THREE.Group();
  private P = parts();
  private sites = new Map<string, Site>();

  // Start (or keep going) work at a building. at() is its current centre (it can be
  // dragged), w/d its footprint, height() its current visible height above the plate.
  start(key: string, at: () => [number, number], w: number, d: number, height: () => number, seconds: number, near: THREE.Vector3, viewSize: number) {
    const old = this.sites.get(key);
    if (old) { old.life = Math.max(old.life, old.age + seconds); return; }
    // only near where the camera looks: far-off sites would just take slots
    const [x, z] = at();
    if (Math.hypot(x - near.x, z - near.z) > Math.max(viewSize, 45) * 1.1) return;
    if (this.sites.size >= MAX_SITES) {
      let worst: Site | null = null;
      for (const s of this.sites.values()) if (!worst || s.life - s.age < worst.life - worst.age) worst = s;
      if (worst) this.remove(worst);
    }
    this.sites.set(key, this.build(key, at, w, d, height, seconds));
  }

  private build(key: string, at: () => [number, number], w: number, d: number, height: () => number, life: number): Site {
    const P = this.P, m = (geo: THREE.BufferGeometry, mat: THREE.Material) => new THREE.Mesh(geo, mat);
    const s = THREE.MathUtils.clamp(Math.max(w, d) / 1.2, 1, 2.2);
    const [x, z] = at();
    const g = new THREE.Group(); g.position.set(x, 0.3, z);

    // tower crane on the back corner, jib swinging over the building
    const crane = new THREE.Group(); 
    const mast = m(P.mast, P.yellow);
    const top = new THREE.Group();
    const trolley = new THREE.Group();
    const cable = m(P.cable, P.dark);
    const hook = new THREE.Group(); hook.add(m(P.load, P.steel));
    trolley.add(m(P.trolley, P.dark), cable, hook);
    const lampTop = m(P.light, P.lamp); lampTop.position.set(0, 0.24, 0);
    top.add(m(P.jib, P.yellow), m(P.counterJib, P.yellow), m(P.weight, P.concrete), m(P.apex, P.yellow), m(P.craneCab, P.glass), trolley, lampTop);
    crane.add(m(P.pad, P.concrete), mast, top);

    // excavator on the left side, digging toward the building
    const digger = new THREE.Group(); 
    const body = new THREE.Group(); body.add(m(P.body, P.yellow), m(P.digCab, P.glass));
    const boom = new THREE.Group(); boom.position.set(0.08, 0.17, 0);
    const stick = new THREE.Group(); stick.position.set(0.32, 0, 0);
    const bucket = m(P.bucket, P.dark); bucket.position.set(0.22, 0, 0);
    stick.add(m(P.stick, P.yellow), bucket); boom.add(m(P.boom, P.yellow), stick); body.add(boom);
    digger.add(m(P.tracks, P.dark), body);

    // dump truck shuttling along the front
    const truck = new THREE.Group(); 
    const bed = m(P.bed, P.orange); bed.position.set(-0.19, 0.08, 0);
    const lampTruck = m(P.light, P.lamp); lampTruck.position.set(0.1, 0.2, 0); lampTruck.scale.setScalar(0.7);
    truck.add(m(P.chassis, P.dark), m(P.truckCab, P.yellow), bed, lampTruck);
    for (const [wx, wz] of [[0.1, 0.065], [0.1, -0.065], [-0.09, 0.065], [-0.09, -0.065]]) { const wh = m(P.wheel, P.dark); wh.position.set(wx, 0.035, wz); truck.add(wh); }

    const scaffold = new THREE.LineSegments(P.scaffold, P.scaffoldMat);
    g.add(crane, digger, truck, scaffold);
    this.group.add(g);
    return { key, height, at, hw: w / 2, hd: d / 2, s, rx: 0, rz: 0, crane, digger, life, age: 0, seed: Math.random() * 6.28, g, mast, top, trolley, cable, hook, body, boom, stick, truck, bed, scaffold, lamps: [lampTop, lampTruck] };
  }

  private remove(s: Site) { this.group.remove(s.g); this.sites.delete(s.key); }
  clear() { for (const s of [...this.sites.values()]) this.remove(s); }

  update(dt: number, t: number, viewSize: number) {
    const show = viewSize < SHOW_BELOW;
    const grow = Math.max(1, Math.pow(viewSize / TRUE_SIZE, 0.75));
    for (const s of [...this.sites.values()]) {
      s.age += dt;
      if (s.age >= s.life) { this.remove(s); continue; }
      const open = Math.min(1, s.age / 0.5) * Math.min(1, (s.life - s.age) / 0.6); // unfold, then pack up
      const ease = 1 - (1 - open) ** 3;
      s.g.visible = show;
      if (!show) continue;
      const k = s.s * grow;
      const [x, z] = s.at(); s.g.position.x = x; s.g.position.z = z; // follows a dragged building
      s.g.scale.setScalar(k * ease);
      // footprint half-size in site units; machines stand just outside it
      s.rx = s.hw / k; s.rz = s.hd / k;
      s.crane.position.set(s.rx + 0.22, 0, -s.rz - 0.22);
      s.digger.position.set(-s.rx - 0.32, 0, s.rz * 0.2);
      s.truck.position.z = s.rz + 0.24;
      const ph = t + s.seed;
      const bh = Math.max(0.05, s.height() / k);

      // crane: mast clears the roof, jib sweeps over the building, the load goes up and down
      const mastH = bh + 0.9;
      s.mast.scale.y = mastH;
      s.top.position.y = mastH;
      s.top.rotation.y = -Math.PI * 0.75 + Math.sin(ph * 0.45) * 0.9;
      s.trolley.position.x = 0.45 + 0.9 * (0.5 + 0.5 * Math.sin(ph * 0.8));
      const drop = 0.25 + (mastH - 0.45) * (0.5 + 0.5 * Math.sin(ph * 1.2 + 1));
      s.cable.scale.y = drop; s.hook.position.y = -drop - 0.03;
      s.hook.rotation.y = Math.sin(ph * 0.7) * 0.6;

      // excavator: swing, dig, lift
      s.body.rotation.y = Math.sin(ph * 0.6) * 0.8;
      s.boom.rotation.z = 0.35 + 0.3 * Math.sin(ph * 1.5);
      s.stick.rotation.z = -1.5 + 0.55 * Math.sin(ph * 1.5 + 1.1);

      // truck: drive along the front, stop at each end, tip the bed at one of them
      const cyc = (ph * 0.22) % 2, leg = cyc < 1 ? cyc : 2 - cyc;
      const u = THREE.MathUtils.smoothstep(Math.min(1, leg * 1.4), 0, 1);
      s.truck.position.x = -s.rx + 0.05 + u * (2 * s.rx + 0.2);
      s.truck.rotation.y = cyc < 1 ? 0 : Math.PI;
      s.bed.rotation.z = leg > 0.86 && cyc < 1 ? 0.6 * Math.sin((leg - 0.86) / 0.14 * Math.PI) : 0;

      // the scaffold wraps the building as it grows
      s.scaffold.scale.set(2 * s.rx + 0.12, bh + 0.08, 2 * s.rz + 0.12);
      const blink = Math.sin(ph * 6) > 0.2;
      for (const l of s.lamps) l.visible = blink;
    }
  }
}
