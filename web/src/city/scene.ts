import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import gsap from 'gsap';

export type FrameFn = (dt: number, t: number) => void;

export const DEFAULT_AZIMUTH = Math.PI / 4;
export const DEFAULT_ELEVATION = Math.atan(1 / Math.SQRT2) * 1.08;
const MIN_ELEVATION = THREE.MathUtils.degToRad(8);
const MAX_ELEVATION = THREE.MathUtils.degToRad(88);
const TAU = Math.PI * 2;

// Isometric stage: orthographic camera orbiting a ground target. Input moves a goal
// view and the camera eases toward it every frame, so pans glide, zooms settle and
// orbits keep a little momentum. Right-drag (or Alt+drag) orbits a full 360° and tilts.
export class Stage {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.OrthographicCamera;
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  target = new THREE.Vector3();
  azimuth = DEFAULT_AZIMUTH;
  elevation = DEFAULT_ELEVATION;
  private size = 60;
  // where the camera is heading; tweens and input write here
  goal = { x: 0, z: 0, viewSize: 60, azimuth: DEFAULT_AZIMUTH, elevation: DEFAULT_ELEVATION };
  // the view "Reset view" returns to
  home = { x: 0, z: 0, viewSize: 60 };
  private panVel = new THREE.Vector2();
  private orbitVel = new THREE.Vector2();
  private zoomAnchor: { sx: number; sy: number; p: THREE.Vector3 } | null = null;
  private dragging = false;
  private lastZoom = NaN;
  private frames: FrameFn[] = [];
  private last = performance.now();
  private raf = 0;
  private ro: ResizeObserver;
  readonly el: HTMLElement;
  fps = 60;
  hidden = false; // another layer is showing: frames still run, nothing is drawn
  onZoom: ((z: number) => void) | null = null;
  // the camera angle changed; atDefault is true when it is (heading back to) the default angle
  onView: ((azimuth: number, elevation: number, atDefault: boolean) => void) | null = null;
  // A left-drag that starts on something movable moves it instead of panning.
  grab: ((x: number, y: number) => ((x: number, y: number, end: boolean) => void) | null) | null = null;

  // Setting viewSize jumps there; flyTo and the wheel ease.
  get viewSize() { return this.size; }
  set viewSize(v: number) { this.size = this.goal.viewSize = v; this.zoomAnchor = null; }

  constructor(el: HTMLElement) {
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    el.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color('#05070d');
    this.scene.fog = new THREE.Fog('#05070d', 260, 520);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 2000);

    const hemi = new THREE.HemisphereLight('#6d7fb8', '#0b0d14', 0.55);
    const moon = new THREE.DirectionalLight('#9fb6ee', 0.75);
    moon.position.set(-60, 120, 40);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    moon.shadow.bias = -0.0006;
    this.scene.add(hemi, moon, moon.target);
    (this as any).moon = moon;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.95, 0.55, 0.62);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
    this.resize();
    this.bindControls();
    this.loop();
  }

  fitShadow(w: number, h: number) {
    const moon = (this as any).moon as THREE.DirectionalLight;
    const s = Math.max(w, h) * 0.75 + 20;
    Object.assign(moon.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 600 });
    moon.shadow.camera.updateProjectionMatrix();
  }

  onFrame(fn: FrameFn) { this.frames.push(fn); return () => { this.frames = this.frames.filter(f => f !== fn); }; }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w / 2, h / 2);
    this.updateCamera();
  }

  updateCamera() {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    const a = w / h, v = this.size;
    Object.assign(this.camera, { left: -v * a / 2, right: v * a / 2, top: v / 2, bottom: -v / 2 });
    const d = 300;
    this.camera.position.set(
      this.target.x + d * Math.cos(this.elevation) * Math.cos(this.azimuth),
      this.target.y + d * Math.sin(this.elevation),
      this.target.z + d * Math.cos(this.elevation) * Math.sin(this.azimuth));
    this.camera.lookAt(this.target);
    this.camera.updateProjectionMatrix();
    // haze only past the back of the view: a fixed fog paled the far half of the city
    const fog = this.scene.fog as THREE.Fog | null;
    if (fog) { fog.near = d + v * 0.45; fog.far = d + v * 1.6; }
    if (v !== this.lastZoom) { this.lastZoom = v; this.onZoom?.(v); }
    this.onView?.(this.azimuth, this.elevation, this.atDefaultAngle());
  }

  atDefaultAngle() {
    const da = this.goal.azimuth - DEFAULT_AZIMUTH;
    return Math.abs(Math.atan2(Math.sin(da), Math.cos(da))) < 0.01 && Math.abs(this.goal.elevation - DEFAULT_ELEVATION) < 0.01;
  }

  private stopMotion() {
    gsap.killTweensOf(this.goal);
    this.panVel.set(0, 0); this.orbitVel.set(0, 0); this.zoomAnchor = null;
  }

  // Quarter turns, snapped to the default angle's quarters so Q/E square the city up after a free orbit.
  rotate(steps: number) {
    gsap.killTweensOf(this.goal, 'azimuth');
    this.orbitVel.set(0, 0);
    const q = Math.PI / 2, n = (this.goal.azimuth - DEFAULT_AZIMUTH) / q;
    const k = steps > 0 ? Math.floor(n + 1e-3) + steps : Math.ceil(n - 1e-3) + steps;
    gsap.to(this.goal, { azimuth: DEFAULT_AZIMUTH + k * q, duration: 0.6, ease: 'power3.inOut' });
  }

  flyTo(x: number, z: number, viewSize?: number, duration = 1.1) {
    gsap.killTweensOf(this.goal, 'x,z,viewSize');
    this.panVel.set(0, 0); this.zoomAnchor = null;
    gsap.to(this.goal, { x, z, duration, ease: 'power3.inOut' });
    if (viewSize) gsap.to(this.goal, { viewSize, duration, ease: 'power3.inOut' });
  }

  // Jump, at the current zoom and angle, so ground point p shows at a screen point (client coordinates).
  pin(p: THREE.Vector3, clientX: number, clientY: number) {
    this.stopMotion();
    Object.assign(this.goal, { x: this.target.x, z: this.target.z, viewSize: this.size, azimuth: this.azimuth, elevation: this.elevation });
    this.updateCamera();
    const g = this.groundAt(clientX, clientY, p.y);
    if (!g) return;
    this.target.x = this.goal.x += p.x - g.x; this.target.z = this.goal.z += p.z - g.z;
    this.updateCamera();
  }

  // Back to the default angle with the whole city in view, turning the short way round.
  resetView(duration = 1.1) {
    this.stopMotion();
    const turns = Math.round((this.goal.azimuth - DEFAULT_AZIMUTH) / TAU);
    gsap.to(this.goal, {
      x: this.home.x, z: this.home.z, viewSize: this.home.viewSize,
      azimuth: DEFAULT_AZIMUTH + turns * TAU, elevation: DEFAULT_ELEVATION, duration, ease: 'power3.inOut',
    });
  }

  // Ease the camera toward the goal; runs every frame before the scene callbacks.
  private step(dt: number) {
    const g = this.goal;
    if (!this.dragging) {
      if (this.panVel.lengthSq() > 1e-4) {
        g.x += this.panVel.x * dt; g.z += this.panVel.y * dt;
        this.panVel.multiplyScalar(Math.exp(-dt * 4.5));
      } else this.panVel.set(0, 0);
      if (this.orbitVel.lengthSq() > 1e-6) {
        g.azimuth += this.orbitVel.x * dt;
        g.elevation = THREE.MathUtils.clamp(g.elevation + this.orbitVel.y * dt, MIN_ELEVATION, MAX_ELEVATION);
        this.orbitVel.multiplyScalar(Math.exp(-dt * 5));
      } else this.orbitVel.set(0, 0);
    }
    const k = 1 - Math.exp(-dt * 14);
    const ease = (from: number, to: number, eps: number) => Math.abs(to - from) < eps ? to : from + (to - from) * k;
    const x = ease(this.target.x, g.x, 1e-3), z = ease(this.target.z, g.z, 1e-3);
    // zoom eases in log space, so it feels the same at every scale
    const s = Math.abs(g.viewSize - this.size) < 1e-3 ? g.viewSize : Math.exp(Math.log(this.size) + (Math.log(g.viewSize) - Math.log(this.size)) * k);
    const a = ease(this.azimuth, g.azimuth, 1e-4), e = ease(this.elevation, g.elevation, 1e-4);
    if (x === this.target.x && z === this.target.z && s === this.size && a === this.azimuth && e === this.elevation) {
      this.zoomAnchor = null;
      return;
    }
    this.target.x = x; this.target.z = z; this.size = s; this.azimuth = a; this.elevation = e;
    this.updateCamera();
    // keep the ground point under the cursor fixed while a wheel zoom settles
    const za = this.zoomAnchor;
    if (za) {
      const now = this.groundAt(za.sx, za.sy);
      if (now) {
        const dx = za.p.x - now.x, dz = za.p.z - now.z;
        this.target.x += dx; this.target.z += dz; g.x += dx; g.z += dz;
        this.updateCamera();
      }
      if (this.size === g.viewSize) this.zoomAnchor = null;
    }
  }

  // Ground point under a screen position.
  groundAt(clientX: number, clientY: number, y = 0): THREE.Vector3 | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const p = new THREE.Vector3();
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), p) ? p : null;
  }

  project(v: THREE.Vector3, out = { x: 0, y: 0, visible: false }) {
    const p = v.clone().project(this.camera);
    out.x = (p.x + 1) / 2 * this.el.clientWidth;
    out.y = (1 - p.y) / 2 * this.el.clientHeight;
    out.visible = p.z > -1 && p.z < 1 && out.x > -50 && out.y > -30 && out.x < this.el.clientWidth + 50 && out.y < this.el.clientHeight + 30;
    return out;
  }

  private bindControls() {
    const c = this.renderer.domElement;
    type Drag = { orbit: boolean; x: number; y: number; lx: number; ly: number; lt: number; moved: boolean;
      mover: ((x: number, y: number, end: boolean) => void) | null };
    let drag: Drag | null = null;
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('pointerdown', e => {
      if (drag || e.button > 2) return;
      const orbit = e.button === 2 || (e.button === 0 && (e.altKey || e.ctrlKey));
      const mover = !orbit && e.button === 0 && !e.shiftKey ? this.grab?.(e.clientX, e.clientY) ?? null : null;
      drag = { orbit, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, lt: performance.now(), moved: false, mover };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', e => {
      if (!drag) return;
      if (!drag.moved && Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) {
        drag.moved = true;
        // start from where the pointer went down, so the 4px dead zone isn't lost
        drag.lx = drag.x; drag.ly = drag.y;
        if (!drag.mover) { this.stopMotion(); this.dragging = true; c.style.cursor = drag.orbit ? 'move' : 'grabbing'; }
      }
      if (!drag.moved) return;
      if (drag.mover) { c.style.cursor = 'grabbing'; drag.mover(e.clientX, e.clientY, false); return; }
      const now = performance.now(), dt = Math.max((now - drag.lt) / 1000, 1e-3);
      const dx = e.clientX - drag.lx, dy = e.clientY - drag.ly;
      drag.lx = e.clientX; drag.ly = e.clientY; drag.lt = now;
      const g = this.goal;
      if (drag.orbit) {
        // dragging across the whole canvas turns the city once around
        const da = dx / c.clientWidth * TAU, de = dy / c.clientHeight * Math.PI * 0.8;
        g.azimuth += da;
        g.elevation = THREE.MathUtils.clamp(g.elevation + de, MIN_ELEVATION, MAX_ELEVATION);
        // only the spin carries on after release; a tilt stays where it was put
        this.orbitVel.lerp(new THREE.Vector2(da / dt, 0), 0.5);
      } else {
        const unit = this.size / c.clientHeight, lift = unit / Math.sin(this.elevation);
        const rx = Math.sin(this.azimuth), rz = -Math.cos(this.azimuth);
        const fx = -Math.cos(this.azimuth), fz = -Math.sin(this.azimuth);
        const mx = -dx * unit * rx + dy * lift * fx, mz = -dx * unit * rz + dy * lift * fz;
        g.x += mx; g.z += mz;
        // the ground follows the pointer exactly while held; easing is for the release
        this.target.x = g.x; this.target.z = g.z;
        this.updateCamera();
        this.panVel.lerp(new THREE.Vector2(mx / dt, mz / dt), 0.5);
      }
    });
    const end = (e: PointerEvent) => {
      if (!drag) return;
      const d = drag; drag = null;
      this.dragging = false;
      if (d.moved && d.mover) d.mover(e.clientX, e.clientY, true);
      c.style.cursor = '';
      // holding still before letting go means "stop here", not "fling"
      if (performance.now() - d.lt > 80) { this.panVel.set(0, 0); this.orbitVel.set(0, 0); }
      if (!d.moved && e.type === 'pointerup' && e.button === 0) c.dispatchEvent(new CustomEvent('stage-click', { detail: { x: e.clientX, y: e.clientY } }));
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', e => {
      e.preventDefault();
      gsap.killTweensOf(this.goal, 'x,z,viewSize');
      this.panVel.set(0, 0);
      // trackpad pinch arrives as ctrl+wheel with small deltas; some mice report lines, not pixels
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      const f = Math.exp(THREE.MathUtils.clamp(dy, -300, 300) * (e.ctrlKey ? 0.01 : 0.0015));
      const za = this.zoomAnchor;
      if (!za || Math.abs(za.sx - e.clientX) + Math.abs(za.sy - e.clientY) > 2) {
        const p = this.groundAt(e.clientX, e.clientY);
        this.zoomAnchor = p ? { sx: e.clientX, sy: e.clientY, p } : null;
      }
      this.goal.viewSize = THREE.MathUtils.clamp(this.goal.viewSize * f, 8, 420);
    }, { passive: false });
    window.addEventListener('keydown', this.onKey);
  }

  private onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.closest('input,textarea,select') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (getComputedStyle(this.el).visibility === 'hidden') return; // another layer is showing
    const k = e.key;
    if (k === 'q' || k === 'Q') this.rotate(-1);
    else if (k === 'e' || k === 'E') this.rotate(1);
    else if (k === 'r' || k === 'R' || k === 'Home') this.resetView();
    else if (k === 'PageUp' || k === 'PageDown') {
      e.preventDefault();
      gsap.killTweensOf(this.goal, 'elevation');
      this.goal.elevation = THREE.MathUtils.clamp(this.goal.elevation + (k === 'PageUp' ? 0.15 : -0.15), MIN_ELEVATION, MAX_ELEVATION);
    } else if (k.startsWith('Arrow')) {
      e.preventDefault();
      gsap.killTweensOf(this.goal, 'x,z');
      const s = this.goal.viewSize * 0.15, sa = Math.sin(this.azimuth), ca = Math.cos(this.azimuth);
      const [mx, mz] = k === 'ArrowLeft' ? [-sa, ca] : k === 'ArrowRight' ? [sa, -ca] : k === 'ArrowUp' ? [-ca, -sa] : [ca, sa];
      this.goal.x += mx * s; this.goal.z += mz * s;
    } else if (k === '+' || k === '=' || k === '-' || k === '_') {
      this.zoomAnchor = null;
      gsap.killTweensOf(this.goal, 'viewSize');
      this.goal.viewSize = THREE.MathUtils.clamp(this.goal.viewSize * (k === '-' || k === '_' ? 1.25 : 0.8), 8, 420);
    }
  };

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    this.fps = this.fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;
    this.step(dt);
    for (const f of this.frames) f(dt, now / 1000);
    if (!this.hidden) this.composer.render(dt);
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    window.removeEventListener('keydown', this.onKey);
    gsap.killTweensOf(this.goal);
    this.renderer.dispose();
    this.el.innerHTML = '';
  }
}
