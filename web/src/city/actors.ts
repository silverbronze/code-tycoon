import * as THREE from 'three';
import type { Stage } from './scene';
import type { World, Target } from './world';

export function sessionColor(i: number) {
  return new THREE.Color().setHSL(((i * 137.508 + 190) % 360) / 360, 0.85, 0.62);
}
export function colorCss(c: THREE.Color) { return '#' + c.getHexString(); }

// ---- particles -----------------------------------------------------------------
const MAXP = 5000;
class Particles {
  pos = new Float32Array(MAXP * 3); vel = new Float32Array(MAXP * 3); col = new Float32Array(MAXP * 3);
  life = new Float32Array(MAXP); max = new Float32Array(MAXP); size = new Float32Array(MAXP); grav = new Float32Array(MAXP);
  alpha = new Float32Array(MAXP);
  geo = new THREE.BufferGeometry(); points: THREE.Points; next = 0;
  constructor(scene: THREE.Scene) {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uScale: { value: 1 } },
      vertexShader: `attribute float size; attribute float alpha; attribute vec3 color; varying vec3 vC; varying float vA; uniform float uScale;
        void main(){ vC = color; vA = alpha; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv; gl_PointSize = size * uScale; }`,
      fragmentShader: `varying vec3 vC; varying float vA;
        void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d); if (r > 0.5) discard; float a = smoothstep(0.5, 0.0, r); gl_FragColor = vec4(vC * a * vA * 1.6, a * vA); }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }
  emit(p: THREE.Vector3, v: THREE.Vector3, c: THREE.Color, life: number, size: number, grav = 0) {
    const i = this.next; this.next = (this.next + 1) % MAXP;
    this.pos.set([p.x, p.y, p.z], i * 3); this.vel.set([v.x, v.y, v.z], i * 3); this.col.set([c.r, c.g, c.b], i * 3);
    this.life[i] = life; this.max[i] = life; this.size[i] = size; this.grav[i] = grav;
  }
  update(dt: number, zoom: number) {
    (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = 60 / zoom * (devicePixelRatio || 1);
    for (let i = 0; i < MAXP; i++) {
      if (this.life[i] <= 0) { if (this.alpha[i]) this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      const k = i * 3;
      this.vel[k + 1] -= this.grav[i] * dt;
      this.pos[k] += this.vel[k] * dt; this.pos[k + 1] += this.vel[k + 1] * dt; this.pos[k + 2] += this.vel[k + 2] * dt;
      this.alpha[i] = Math.max(0, this.life[i] / this.max[i]);
    }
    for (const n of ['position', 'color', 'size', 'alpha']) (this.geo.getAttribute(n) as THREE.BufferAttribute).needsUpdate = true;
  }
}

// ---- transient meshes (beams, rings, packets) --------------------------------------
interface Fx { obj: THREE.Mesh; life: number; max: number; kind: 'beam' | 'ring' | 'packet'; from?: THREE.Vector3; to?: THREE.Vector3; mid?: THREE.Vector3 }

interface Drone {
  id: string; color: THREE.Color; group: THREE.Group; core: THREE.Mesh; halo: THREE.Sprite;
  pos: THREE.Vector3; from: THREE.Vector3; to: THREE.Vector3; t: number; dur: number;
  trail: THREE.Line; trailPts: Float32Array; trailHead: number; trailTimer: number;
  phase: number; fade: number; fadeTo: number; parent: Drone | null; tether: THREE.Line | null;
  needs: boolean; column: THREE.Mesh | null; lastAct: number; pendingFx: (() => void) | null; children: Map<string, Drone>;
  at: [number, number] | null; // the place it is working on
  anchor: THREE.Vector2;       // that place's x/z when the drone headed there; a dragged place takes the drone along
  live: boolean | null;        // live session state says "working"; null = unknown (replay)
}

const WORK_RECENT = 20e3; // with no live state, a place counts as worked on this long after the last action

const TRAIL = 28;
const haloTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!; const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();

export class Actors {
  drones = new Map<string, Drone>();
  parts: Particles;
  fx: Fx[] = [];
  group = new THREE.Group();
  private beamGeo = new THREE.CylinderGeometry(0.06, 0.32, 1, 10, 1, true).translate(0, 0.5, 0);
  private ringGeo = new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2);
  private packetGeo = new THREE.SphereGeometry(0.22, 10, 8);
  private colGeo = new THREE.CylinderGeometry(0.35, 0.35, 60, 16, 1, true).translate(0, 30, 0);
  private coreGeo = new THREE.OctahedronGeometry(0.42, 0);
  private subGeo = new THREE.TetrahedronGeometry(0.26, 0);

  constructor(public stage: Stage, public world: World) {
    stage.scene.add(this.group);
    this.parts = new Particles(stage.scene);
    stage.onFrame(this.frame);
  }

  private make(id: string, color: THREE.Color, parent: Drone | null): Drone {
    const group = new THREE.Group();
    const core = new THREE.Mesh(parent ? this.subGeo : this.coreGeo, new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(parent ? 1.6 : 2.2) }));
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.85 }));
    halo.scale.setScalar(parent ? 1.4 : 2.6);
    group.add(core, halo);
    const trailPts = new Float32Array(TRAIL * 3);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(trailPts, 3).setUsage(THREE.DynamicDrawUsage));
    const tc = new Float32Array(TRAIL * 3);
    for (let i = 0; i < TRAIL; i++) { const k = 1 - i / TRAIL; tc.set([color.r * k * k, color.g * k * k, color.b * k * k], i * 3); }
    tg.setAttribute('color', new THREE.BufferAttribute(tc, 3));
    const trail = new THREE.Line(tg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    trail.frustumCulled = false;
    let tether: THREE.Line | null = null;
    if (parent) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      tether = new THREE.Line(g, new THREE.LineDashedMaterial({ color, dashSize: 0.3, gapSize: 0.25, transparent: true, opacity: 0.55 }));
      tether.frustumCulled = false;
      this.group.add(tether);
    }
    this.group.add(group, trail);
    const start = parent ? parent.pos.clone() : new THREE.Vector3(0, 40, 0);
    for (let i = 0; i < TRAIL; i++) trailPts.set([start.x, start.y, start.z], i * 3);
    group.position.copy(start);
    return { id, color, group, core, halo, pos: start.clone(), from: start.clone(), to: start.clone(), t: 1, dur: 1,
      trail, trailPts, trailHead: 0, trailTimer: 0, phase: Math.random() * 6.28, fade: 0, fadeTo: 1, parent, tether,
      needs: false, column: null, lastAct: performance.now(), pendingFx: null, children: new Map(), at: null, anchor: new THREE.Vector2(), live: null };
  }

  drone(id: string, color: THREE.Color, agentKey: string | null = null): Drone {
    let d = this.drones.get(id);
    if (!d) { d = this.make(id, color, null); this.drones.set(id, d); }
    d.fadeTo = 1;
    if (!agentKey) return d;
    let c = d.children.get(agentKey);
    if (!c) { c = this.make(id + '/' + agentKey, color.clone().offsetHSL(0, -0.1, 0.12), d); d.children.set(agentKey, c); }
    c.fadeTo = 1;
    return c;
  }

  // A session's colour changed (distinct colours go to the sessions in view).
  recolor(sid: string, color: THREE.Color) {
    const d = this.drones.get(sid); if (!d) return;
    const paint = (x: Drone, c: THREE.Color, sub: boolean) => {
      x.color = c;
      (x.core.material as THREE.MeshBasicMaterial).color.copy(c).multiplyScalar(sub ? 1.6 : 2.2);
      (x.halo.material as THREE.SpriteMaterial).color.copy(c);
      const tc = x.trail.geometry.getAttribute('color') as THREE.BufferAttribute;
      for (let i = 0; i < TRAIL; i++) { const k = 1 - i / TRAIL; tc.setXYZ(i, c.r * k * k, c.g * k * k, c.b * k * k); }
      tc.needsUpdate = true;
      if (x.tether) (x.tether.material as THREE.LineDashedMaterial).color.copy(c);
    };
    paint(d, color, false);
    for (const c of d.children.values()) paint(c, color.clone().offsetHSL(0, -0.1, 0.12), true);
  }

  // An action by a session (or one of its subagents) at a place.
  act(sid: string, color: THREE.Color, agentKey: string | null, kind: string, tt: number, ti: number, quick: boolean, fx = true) {
    const d = this.drone(sid, color, agentKey);
    d.lastAct = performance.now();
    const tgt = tt >= 0 ? this.world.position(tt, ti) : null;
    if (tgt) { d.at = [tt, ti]; d.anchor.set(tgt.x, tgt.z); }
    const pulse =(s: number, c = d.color) => { if (tt >= 0) this.world.pulse(tt, ti, c, s); };
    if (tgt) {
      const hover = new THREE.Vector3(tgt.x + (agentKey ? 0.6 : 0), tgt.y + (agentKey ? 1.2 : 1.8), tgt.z + (agentKey ? 0.4 : 0));
      const remote = tt === 3;
      d.from.copy(d.pos); d.to.copy(hover); d.t = 0;
      d.dur = quick ? 0.12 : Math.min(1.1, 0.35 + d.pos.distanceTo(hover) * 0.012);
      if (remote && fx && !quick) {
        // send a data packet from where the drone was to the tower
        this.packet(d.pos.clone(), new THREE.Vector3(tgt.x, tgt.y, tgt.z), d.color);
      }
    }
    if (!fx) { pulse(kind === 'write' ? 0.3 : 0.1); return; }
    if (quick) { // fast replay: many events per frame, keep each one small
      if (kind === 'write') { pulse(0.45); this.sparks(tgt ? new THREE.Vector3(tgt.x, tgt.y, tgt.z) : d.pos.clone(), d.color, 4); }
      else if (kind !== 'cmd') pulse(0.15);
      return;
    }
    const run = () => {
      const at = tgt ? new THREE.Vector3(tgt.x, tgt.y, tgt.z) : d.pos.clone();
      switch (kind) {
        case 'write': pulse(1.2, new THREE.Color('#ffd9a0').lerp(d.color, 0.35)); this.sparks(at, d.color, quick ? 6 : 22); if (tt === 0) this.world.growOnWrite(ti); break;
        case 'read': case 'search': case 'touch': pulse(0.55); if (tgt) this.beam(d.to.clone(), at, d.color); break;
        case 'cmd': this.smoke(d.to.clone()); break;
        case 'remote': case 'skill': pulse(0.9); this.ring(at, d.color, 1.2); break;
        case 'spawn': this.ring(d.to.clone(), d.color, 2.2); break;
        case 'prompt': this.ring(new THREE.Vector3(d.to.x, Math.max(0.5, d.to.y - 1.8), d.to.z), d.color, 3.5); break;
        case 'ask': this.ring(d.to.clone(), new THREE.Color('#ff5470'), 2.4); break;
      }
    };
    if (quick || d.t >= 1 || !tgt) run(); else d.pendingFx = run;
  }

  setNeeds(sid: string, on: boolean) {
    const d = this.drones.get(sid); if (!d || d.needs === on) return;
    d.needs = on;
    if (on && !d.column) {
      d.column = new THREE.Mesh(this.colGeo, new THREE.MeshBasicMaterial({ color: '#ff3b5c', transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      this.group.add(d.column);
    }
    if (!on && d.column) { this.group.remove(d.column); d.column = null; }
  }

  setLive(sid: string, working: boolean) { const d = this.drones.get(sid); if (d) d.live = working; }

  // replay seek: put a drone somewhere immediately
  place(sid: string, color: THREE.Color, tt: number, ti: number) {
    const d = this.drone(sid, color);
    const tgt = this.world.position(tt, ti);
    if (!tgt) return;
    d.at = [tt, ti]; d.anchor.set(tgt.x, tgt.z);
    d.pos.set(tgt.x, tgt.y + 1.8, tgt.z); d.from.copy(d.pos); d.to.copy(d.pos); d.t = 1;
    for (let i = 0; i < TRAIL; i++) d.trailPts.set([d.pos.x, d.pos.y, d.pos.z], i * 3);
  }
  retire(sid: string) { const d = this.drones.get(sid); if (d) { d.fadeTo = 0; for (const c of d.children.values()) c.fadeTo = 0; } }
  retireAgent(sid: string, agentKey: string) { const c = this.drones.get(sid)?.children.get(agentKey); if (c) c.fadeTo = 0; }
  clear() { for (const id of [...this.drones.keys()]) this.remove(id); }
  private remove(id: string) {
    const d = this.drones.get(id); if (!d) return;
    for (const c of d.children.values()) this.disposeDrone(c);
    this.disposeDrone(d); this.drones.delete(id);
  }
  private disposeDrone(d: Drone) { this.group.remove(d.group, d.trail); if (d.tether) this.group.remove(d.tether); if (d.column) this.group.remove(d.column); }

  sparks(at: THREE.Vector3, c: THREE.Color, n: number) {
    const hot = new THREE.Color('#fff1d6');
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 1.5 + Math.random() * 3.5;
      this.parts.emit(at, new THREE.Vector3(Math.cos(a) * s * 0.6, 2.5 + Math.random() * 4, Math.sin(a) * s * 0.6), i % 3 ? c : hot, 0.6 + Math.random() * 0.6, 3 + Math.random() * 4, 9);
    }
  }
  smoke(at: THREE.Vector3) {
    const g = new THREE.Color('#5c6680');
    for (let i = 0; i < 6; i++) this.parts.emit(at.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.6, 0, (Math.random() - 0.5) * 0.6)),
      new THREE.Vector3((Math.random() - 0.5) * 0.4, 0.9 + Math.random() * 0.6, (Math.random() - 0.5) * 0.4), g, 1.4 + Math.random(), 9 + Math.random() * 7, -0.2);
  }
  beam(from: THREE.Vector3, to: THREE.Vector3, c: THREE.Color) {
    const m = new THREE.Mesh(this.beamGeo, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    const len = Math.max(0.3, from.distanceTo(to));
    m.position.copy(from);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
    m.scale.set(1, len, 1);
    this.group.add(m); this.fx.push({ obj: m, life: 0.7, max: 0.7, kind: 'beam' });
  }
  ring(at: THREE.Vector3, c: THREE.Color, size: number) {
    const m = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    m.position.copy(at); m.userData.size = size;
    this.group.add(m); this.fx.push({ obj: m, life: 1.1, max: 1.1, kind: 'ring' });
  }
  packet(from: THREE.Vector3, to: THREE.Vector3, c: THREE.Color) {
    const m = new THREE.Mesh(this.packetGeo, new THREE.MeshBasicMaterial({ color: c.clone().multiplyScalar(2.5) }));
    const mid = from.clone().add(to).multiplyScalar(0.5); mid.y = Math.max(from.y, to.y) + 4 + from.distanceTo(to) * 0.15;
    this.group.add(m); this.fx.push({ obj: m, life: 0.9, max: 0.9, kind: 'packet', from, to, mid });
  }

  private frame = (dt: number, t: number) => {
    const now = performance.now();
    const working: { tt: number; ti: number; color: THREE.Color }[] = [];
    const busy = (d: Drone, live: boolean | null) => d.at && d.fade > 0.5 && !d.needs && (live ?? now - d.lastAct < WORK_RECENT);
    for (const d of this.drones.values()) {
      if (busy(d, d.live)) working.push({ tt: d.at![0], ti: d.at![1], color: d.color });
      // subagents finish on their own, so they go by their latest action even in a live session
      for (const c of d.children.values()) if (d.live !== false && busy(c, null)) working.push({ tt: c.at![0], ti: c.at![1], color: c.color });
    }
    this.world.setWorking(working);
    for (const [id, d] of this.drones) {
      this.step(d, dt, t);
      for (const [k, c] of d.children) {
        this.step(c, dt, t);
        if (c.tether) {
          const p = c.tether.geometry.getAttribute('position') as THREE.BufferAttribute;
          p.setXYZ(0, d.group.position.x, d.group.position.y, d.group.position.z); p.setXYZ(1, c.group.position.x, c.group.position.y, c.group.position.z);
          p.needsUpdate = true; c.tether.computeLineDistances();
          (c.tether.material as THREE.LineDashedMaterial).opacity = 0.55 * c.fade;
        }
        if (c.fadeTo === 0 && c.fade < 0.01) { this.disposeDrone(c); d.children.delete(k); }
      }
      if (d.column) {
        d.column.position.set(d.group.position.x, 0, d.group.position.z);
        (d.column.material as THREE.MeshBasicMaterial).opacity = 0.12 + 0.18 * (0.5 + 0.5 * Math.sin(t * 5));
        if (Math.sin(t * 5) > 0.97) this.ring(new THREE.Vector3(d.pos.x, 0.4, d.pos.z), new THREE.Color('#ff3b5c'), 3);
      }
      if (d.fadeTo === 0 && d.fade < 0.01) this.remove(id);
      void now;
    }
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      f.life -= dt;
      const k = Math.max(0, f.life / f.max);
      const mat = f.obj.material as THREE.MeshBasicMaterial;
      if (f.kind === 'beam') mat.opacity = 0.7 * k;
      else if (f.kind === 'ring') { const s = (1 - k) * f.obj.userData.size + 0.3; f.obj.scale.setScalar(s); mat.opacity = 0.9 * k * k; }
      else if (f.kind === 'packet') {
        const u = 1 - k;
        const a = f.from!, b = f.mid!, c = f.to!;
        f.obj.position.set((1 - u) * (1 - u) * a.x + 2 * (1 - u) * u * b.x + u * u * c.x, (1 - u) * (1 - u) * a.y + 2 * (1 - u) * u * b.y + u * u * c.y, (1 - u) * (1 - u) * a.z + 2 * (1 - u) * u * b.z + u * u * c.z);
        if (Math.random() < 0.6) this.parts.emit(f.obj.position, new THREE.Vector3(), mat.color.clone().multiplyScalar(0.4), 0.4, 3);
      }
      if (f.life <= 0) { this.group.remove(f.obj); mat.dispose(); this.fx.splice(i, 1); }
    }
    this.parts.update(dt, this.stage.viewSize);
  };

  private step(d: Drone, dt: number, t: number) {
    d.fade += (d.fadeTo - d.fade) * Math.min(1, dt * 3);
    // the place was dragged: go with it (the trail shows the hop)
    const p = d.at && this.world.position(d.at[0], d.at[1]);
    if (p && (p.x !== d.anchor.x || p.z !== d.anchor.y)) {
      const dx = p.x - d.anchor.x, dz = p.z - d.anchor.y;
      for (const v of [d.pos, d.from, d.to]) { v.x += dx; v.z += dz; }
      d.anchor.set(p.x, p.z);
    }
    if (d.t < 1) {
      d.t = Math.min(1, d.t + dt / d.dur);
      const e = d.t < 0.5 ? 4 * d.t ** 3 : 1 - (-2 * d.t + 2) ** 3 / 2;
      const lift = Math.sin(d.t * Math.PI) * Math.min(6, d.from.distanceTo(d.to) * 0.18);
      d.pos.lerpVectors(d.from, d.to, e); d.pos.y += lift;
      if (d.t >= 1 && d.pendingFx) { const f = d.pendingFx; d.pendingFx = null; f(); }
    }
    const bob = Math.sin(t * 2.2 + d.phase) * 0.18;
    d.group.position.set(d.pos.x, d.pos.y + bob, d.pos.z);
    d.core.rotation.y += dt * 1.8; d.core.rotation.x = Math.sin(t + d.phase) * 0.3;
    // keep drones readable when zoomed out, without the halos flooding the frame
    d.group.scale.setScalar(Math.max(0.001, d.fade) * Math.max(1, Math.sqrt(this.stage.viewSize / 40)));
    (d.halo.material as THREE.SpriteMaterial).opacity = 0.55 * d.fade;
    // trail: shift in a new point every ~16ms
    d.trailTimer += dt;
    if (d.trailTimer > 0.016) {
      d.trailTimer = 0;
      d.trailPts.copyWithin(3, 0, (TRAIL - 1) * 3);
      d.trailPts[0] = d.group.position.x; d.trailPts[1] = d.group.position.y; d.trailPts[2] = d.group.position.z;
      (d.trail.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    }
    (d.trail.material as THREE.LineBasicMaterial).opacity = d.fade;
  }

  // Screen positions of drones, for name tags.
  screenPositions() {
    const out: { id: string; x: number; y: number; visible: boolean }[] = [];
    const o = { x: 0, y: 0, visible: false };
    for (const [id, d] of this.drones) { if (d.fade < 0.3) continue; this.stage.project(d.group.position, o); out.push({ id, ...o }); }
    return out;
  }
  focusPos(sid: string): Target | null { const d = this.drones.get(sid); return d ? { x: d.pos.x, y: d.pos.y, z: d.pos.z } : null; }
}

export type { Target };
