import * as THREE from 'three';
import type { City, CityLook, Cosmetic } from '../api';
import type { World } from './world';

// The city's look follows its health (smog for spend, lit streets for shipping,
// litter by stale uncommitted files, run-down buildings for churn, cones where
// sessions collided), and milestones unlock cosmetics: a name sign, a landmark
// spire (golden at 1,000 commits), fireworks on commits and an aurora.
// Cosmetics never touch the score. Everything here is owned by one World.
const GRAVITY = 9;
type Burst = { pts: THREE.Points; vel: Float32Array; age: number; life: number };

export class Mood {
  group = new THREE.Group();
  private bounds: { x0: number; x1: number; z0: number; z1: number; cx: number; cz: number; span: number };
  private smog: THREE.Mesh;
  private litter: THREE.InstancedMesh; private cones: THREE.InstancedMesh;
  private sign: THREE.Group; private signLabel: HTMLDivElement | null = null;
  private spire: THREE.Group; private spireMat: THREE.MeshStandardMaterial; private spireTip: THREE.MeshBasicMaterial;
  private aurora: THREE.Group | null = null;
  private bursts: Burst[] = [];
  private on = new Set<string>();
  private look: CityLook | null = null;
  private base = { bloom: 0, exposure: 0 };
  private offFrame: () => void;
  enabled = true;

  constructor(private world: World, private city: City, private fileIndex: Map<string, number>) {
    const c = city;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const m of c.modules) { x0 = Math.min(x0, m.x); x1 = Math.max(x1, m.x + m.w); z0 = Math.min(z0, m.z); z1 = Math.max(z1, m.z + m.h); }
    for (const e of c.externals) { x0 = Math.min(x0, e.x - e.w / 2); x1 = Math.max(x1, e.x + e.w / 2); z0 = Math.min(z0, e.z - e.h / 2); z1 = Math.max(z1, e.z + e.h / 2); }
    if (!Number.isFinite(x0)) { x0 = z0 = -10; x1 = z1 = 10; }
    this.bounds = { x0, x1, z0, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, span: Math.max(20, x1 - x0, z1 - z0) };
    const B = this.bounds;

    // smog: a brown haze layer over the rooftops, thicker as spend per landed task climbs
    this.smog = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0 + 40, z1 - z0 + 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: '#8a7448', transparent: true, opacity: 0, depthWrite: false }));
    this.smog.position.set(B.cx, 4.5, B.cz); this.smog.renderOrder = 5;

    // litter around stale uncommitted files, traffic cones where sessions collided
    this.litter = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 0.12, 0.2), new THREE.MeshStandardMaterial({ color: '#b9a27c', roughness: 1 }), 600);
    this.cones = new THREE.InstancedMesh(new THREE.ConeGeometry(0.11, 0.34, 8).translate(0, 0.17, 0),
      new THREE.MeshStandardMaterial({ color: '#ff7a1f', emissive: '#ff5a00', emissiveIntensity: 0.6, roughness: 0.6 }), 300);
    this.litter.count = this.cones.count = 0;
    this.litter.frustumCulled = this.cones.frustumCulled = false;

    // the city name sign and the landmark spire stand on a plaza south of the city
    this.sign = new THREE.Group();
    const signW = Math.min(16, Math.max(8, c.project.name.length * 0.9));
    const board = new THREE.Mesh(new THREE.BoxGeometry(signW, 1.5, 0.2), new THREE.MeshStandardMaterial({ color: '#141b2c', emissive: '#2c4a7a', emissiveIntensity: 0.5 }));
    board.position.y = 2.1;
    const postGeo = new THREE.BoxGeometry(0.2, 2.1, 0.2).translate(0, 1.05, 0), postMat = new THREE.MeshStandardMaterial({ color: '#3a4458' });
    const p1 = new THREE.Mesh(postGeo, postMat), p2 = new THREE.Mesh(postGeo, postMat);
    p1.position.x = -signW / 2 + 0.6; p2.position.x = signW / 2 - 0.6;
    const trim = new THREE.Mesh(new THREE.BoxGeometry(signW + 0.2, 0.08, 0.24), new THREE.MeshBasicMaterial({ color: '#5ee6ff' }));
    trim.position.y = 2.9;
    this.sign.add(board, p1, p2, trim);
    this.sign.position.set(B.cx, 0, z1 + 5);
    this.sign.visible = false;

    this.spire = new THREE.Group();
    this.spireMat = new THREE.MeshStandardMaterial({ color: '#8fa3c8', emissive: '#1d2a44', metalness: 0.6, roughness: 0.35 });
    this.spireTip = new THREE.MeshBasicMaterial({ color: '#7fe0ff' });
    const plinth = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.6, 0.6, 8).translate(0, 0.3, 0), new THREE.MeshStandardMaterial({ color: '#232b3c' }));
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 1.2, 11, 8).translate(0, 6.1, 0), this.spireMat);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.5, 2.2, 8).translate(0, 12.7, 0), this.spireMat);
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.55, 16, 12), this.spireTip); orb.position.y = 14.1;
    this.spire.add(plinth, shaft, cap, orb);
    this.spire.position.set(B.cx + signW / 2 + 6, 0, z1 + 6);
    this.spire.visible = false;

    this.group.add(this.smog, this.litter, this.cones, this.sign, this.spire);
    world.group.add(this.group);
    this.base = { bloom: world.stage.bloom.strength, exposure: world.stage.renderer.toneMappingExposure };
    this.offFrame = world.stage.onFrame(this.frame);
  }

  // Health look: smog and street light over the whole city, props on single files.
  setLook(look: CityLook | null) {
    this.look = look;
    const L = this.enabled ? look : null;
    (this.smog.material as THREE.MeshBasicMaterial).opacity = L ? 0.3 * L.smog : 0;
    this.smog.visible = !!L && L.smog > 0.02;
    const st = this.world.stage, light = L ? L.light : 0.5;
    st.bloom.strength = this.base.bloom * (0.8 + 0.4 * light);
    st.renderer.toneMappingExposure = this.base.exposure * (0.9 + 0.18 * light);
    const idx = (list: string[]) => (L ? list : []).map(p => this.fileIndex.get(p.toLowerCase())).filter((i): i is number => i != null);
    this.world.setDecay(idx(L?.rundown || []));
    this.scatter(this.litter, idx(L?.litter || []), 3, 0.5, (k, m) => m.makeRotationY(k * 1.7));
    this.scatter(this.cones, idx(L?.cones || []), 3, 0.55, () => {});
  }
  setEnabled(on: boolean) { this.enabled = on; this.setLook(this.look); }

  private scatter(I: THREE.InstancedMesh, files: number[], per: number, r: number, turn: (k: number, m: THREE.Matrix4) => void) {
    const m = new THREE.Matrix4(), t = new THREE.Matrix4();
    let k = 0;
    for (const i of files) {
      const f = this.city.files[i];
      for (let j = 0; j < per && k < I.instanceMatrix.count; j++, k++) {
        const a = (i * 2.399 + j * 2.1) % (Math.PI * 2);
        turn(k, m);
        t.makeTranslation(f.x + Math.cos(a) * r, 0.3, f.z + Math.sin(a) * r);
        I.setMatrixAt(k, t.multiply(m));
      }
    }
    I.count = k;
    I.instanceMatrix.needsUpdate = true;
  }

  // Cosmetics that are unlocked and switched on.
  setCosmetics(list: Cosmetic[]) {
    this.on = new Set(list.filter(c => c.unlocked && c.on).map(c => c.key));
    this.sign.visible = this.on.has('sign');
    if (this.sign.visible && !this.signLabel) {
      this.signLabel = this.world.addLabel(this.city.project.name, new THREE.Vector3(this.sign.position.x, 2.15, this.sign.position.z + 0.2), 'lb-sign', 0, 1e9, 4, 0).el;
    }
    this.signLabel?.classList.toggle('off', !this.sign.visible);
    this.spire.visible = this.on.has('landmark') || this.on.has('gold');
    const gold = this.on.has('gold');
    this.spireMat.color.set(gold ? '#d9a93f' : '#8fa3c8'); this.spireMat.emissive.set(gold ? '#6a4a0c' : '#1d2a44');
    this.spireTip.color.set(gold ? '#ffd27a' : '#7fe0ff');
    if (this.on.has('aurora') && !this.aurora) this.makeAurora(); else if (!this.on.has('aurora') && this.aurora) { this.group.remove(this.aurora); this.aurora = null; }
  }
  has(key: string) { return this.on.has(key); }

  // A few bursts over the city (a commit landed, a milestone unlocked).
  celebrate(n = 3) {
    if (!this.on.has('fireworks')) return;
    for (let i = 0; i < n; i++) setTimeout(() => this.burst(), i * 380 + Math.random() * 200);
  }
  private burst() {
    const B = this.bounds, n = 90;
    const pos = new Float32Array(n * 3), vel = new Float32Array(n * 3), col = new Float32Array(n * 3);
    const at = new THREE.Vector3(B.x0 + Math.random() * (B.x1 - B.x0), B.span * (0.1 + Math.random() * 0.06), B.z0 + Math.random() * (B.z1 - B.z0));
    const hue = Math.random(), c = new THREE.Color(), speed = B.span * 0.05;
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u), v = speed * (0.7 + Math.random() * 0.3);
      pos.set([at.x, at.y, at.z], i * 3); vel.set([Math.cos(a) * s * v, u * v, Math.sin(a) * s * v], i * 3);
      c.setHSL((hue + Math.random() * 0.08) % 1, 1, 0.65); col.set([c.r, c.g, c.b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const pts = new THREE.Points(g, new THREE.PointsMaterial({ size: 3.5, sizeAttenuation: false, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    pts.frustumCulled = false;
    this.group.add(pts);
    this.bursts.push({ pts, vel, age: 0, life: 2.2 });
  }

  // ribbons of light that always face the camera, hung high over the far side of the city
  private makeAurora() {
    const B = this.bounds, tex = (() => {
      const cv = document.createElement('canvas'); cv.width = 4; cv.height = 64;
      const x = cv.getContext('2d')!, gr = x.createLinearGradient(0, 0, 0, 64);
      gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.55, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = gr; x.fillRect(0, 0, 4, 64);
      return new THREE.CanvasTexture(cv);
    })();
    this.aurora = new THREE.Group();
    ['#3dffb0', '#7d6bff', '#3fd0ff'].forEach((col, i) => {
      const geo = new THREE.PlaneGeometry(B.span * 1.4, B.span * 0.12, 48, 1);
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: col, map: tex, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      m.userData = { phase: i * 2.1, y: B.span * (0.32 + i * 0.05), base: geo.attributes.position.array.slice() };
      this.aurora!.add(m);
    });
    this.group.add(this.aurora);
  }

  private frame = (dt: number, t: number) => {
    const filesShown = this.world.lod === 'files';
    this.litter.visible = this.cones.visible = filesShown;
    for (let k = this.bursts.length - 1; k >= 0; k--) {
      const b = this.bursts[k]; b.age += dt;
      const pa = b.pts.geometry.attributes.position as THREE.BufferAttribute, p = pa.array as Float32Array;
      for (let i = 0; i < b.vel.length; i += 3) {
        b.vel[i + 1] -= GRAVITY * dt * (this.bounds.span / 120);
        b.vel[i] *= 1 - dt * 0.8; b.vel[i + 2] *= 1 - dt * 0.8;
        p[i] += b.vel[i] * dt; p[i + 1] += b.vel[i + 1] * dt; p[i + 2] += b.vel[i + 2] * dt;
      }
      pa.needsUpdate = true;
      (b.pts.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - b.age / b.life);
      if (b.age >= b.life) { this.group.remove(b.pts); b.pts.geometry.dispose(); (b.pts.material as THREE.Material).dispose(); this.bursts.splice(k, 1); }
    }
    if (this.aurora) {
      const cam = this.world.stage.camera, B = this.bounds;
      for (const m of this.aurora.children as THREE.Mesh[]) {
        const u = m.userData, pa = m.geometry.attributes.position as THREE.BufferAttribute, p = pa.array as Float32Array;
        for (let i = 0; i < p.length; i += 3) p[i + 1] = u.base[i + 1] + Math.sin(u.base[i] / B.span * 7 + t * 0.4 + u.phase) * B.span * 0.03;
        pa.needsUpdate = true;
        m.quaternion.copy(cam.quaternion);
        // hung over the far side of the city from wherever the camera looks
        const back = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion); back.y = 0; back.normalize();
        m.position.set(B.cx + back.x * B.span * 0.45, u.y, B.cz + back.z * B.span * 0.45);
        (m.material as THREE.MeshBasicMaterial).opacity = 0.16 + 0.08 * Math.sin(t * 0.5 + u.phase);
      }
    }
  };

  dispose() {
    this.offFrame();
    const st = this.world.stage;
    st.bloom.strength = this.base.bloom; st.renderer.toneMappingExposure = this.base.exposure;
    this.world.group.remove(this.group);
    this.group.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose?.(); const mat = m.material as THREE.Material | THREE.Material[]; if (Array.isArray(mat)) mat.forEach(x => x.dispose()); else mat?.dispose?.(); });
  }
}
