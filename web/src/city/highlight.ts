import * as THREE from 'three';
import { ENV } from './env';

// The selection frame: whatever is picked on the map (a district, a block, a store, an
// outside system, a file) gets a bold outline on the ground around its footprint, with
// heavier corner brackets and a ring that keeps pulsing outward from it. Ink black by
// day (it reads on grass and lots alike), white at night. One flat quad; the shader
// keeps line widths in world units whatever the footprint's size.
const PAD = 1.6; // room around the footprint for the pulse

export class Highlight {
  mesh: THREE.Mesh;
  // a map pin over the selected building, bobbing: the frame alone gets lost among towers
  pin = new THREE.Mesh(
    new THREE.ConeGeometry(0.42, 1.1, 4).rotateX(Math.PI).translate(0, 0.55, 0),
    new THREE.MeshBasicMaterial({ transparent: true, depthTest: false }));
  private u = { uSize: { value: new THREE.Vector2(1, 1) }, uLine: { value: 0.12 }, uTime: { value: 0 }, uNight: ENV.night, uShow: { value: 0 } };
  private on = false; private top: { x: number; y: number; z: number } | null = null;

  constructor() {
    const mat = new THREE.ShaderMaterial({
      uniforms: this.u, transparent: true, depthWrite: false,
      vertexShader: `varying vec2 vP; uniform vec2 uSize;
        void main() { vP = position.xz * uSize; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec2 vP; uniform vec2 uSize; uniform float uLine; uniform float uTime; uniform float uNight; uniform float uShow;
        void main() {
          vec2 half_ = uSize * 0.5 - ${PAD.toFixed(1)};             // the footprint (plus a small gap)
          vec2 q = abs(vP) - half_;
          float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);  // distance to the frame, < 0 inside
          float aa = fwidth(d) * 0.8;
          float line = 1.0 - smoothstep(uLine - aa, uLine + aa, abs(d - uLine));
          // corner brackets: a heavier band near each corner
          vec2 c = half_ - abs(vP); float len = min(min(half_.x, half_.y) * 0.45, 2.5);
          float corner = step(max(c.x, c.y), len) * (1.0 - smoothstep(uLine * 2.4 - aa, uLine * 2.4 + aa, abs(d - uLine * 2.4))) * step(-uLine * 0.2, d);
          // a ring pulsing outward, fading as it goes
          float ph = fract(uTime * 0.6), r = uLine * 3.0 + ph * ${(PAD - 0.4).toFixed(1)};
          float ring = (1.0 - smoothstep(0.0, uLine * 0.9 + aa, abs(d - r))) * (1.0 - ph) * 0.6 * step(0.0, d);
          // the footprint itself is washed lightly so the whole shape reads
          float wash = step(d, 0.0) * 0.08;
          float a = max(max(line, corner), max(ring, wash)) * uShow;
          if (a < 0.01) discard;
          gl_FragColor = vec4(mix(vec3(0.04), vec3(1.0), uNight), a);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat);
    this.mesh.renderOrder = 5; this.mesh.visible = false; this.mesh.frustumCulled = false;
    this.pin.renderOrder = 6; this.pin.visible = false;
  }

  lift = 0; // world units the pin rises to clear the labels over its building (set by the world)

  // the top of the selected building, for the pin (null: no pin, e.g. a district)
  setTop(p: { x: number; y: number; z: number } | null) { this.top = p; }

  // the pin's extent over its top at this zoom, bob included (world units): tip, head, width
  reach(zoom: number) { const k = Math.max(0.8, zoom / 30); return { lo: 0.25 * k, hi: 1.85 * k, w: 0.84 * k }; }

  // footprint: corner x, z, size w, h, at height y; line: stroke width (world units);
  // onTop: drawn through the buildings in front (a single file among towers)
  set(r: { x: number; z: number; w: number; h: number; y: number; line: number; onTop?: boolean } | null) {
    this.on = !!r;
    if (!r) return;
    (this.mesh.material as THREE.ShaderMaterial).depthTest = !r.onTop;
    const W = r.w + PAD * 2, H = r.h + PAD * 2;
    this.mesh.position.set(r.x + r.w / 2, r.y, r.z + r.h / 2);
    this.mesh.scale.set(W, 1, H);
    this.u.uSize.value.set(W, H); this.u.uLine.value = r.line;
  }

  // zoom: the stage's viewSize, so the pin keeps a readable size on screen
  frame(dt: number, t: number, zoom: number) {
    this.u.uTime.value = t;
    const s = this.u.uShow;
    s.value += ((this.on ? 1 : 0) - s.value) * Math.min(1, dt * 8);
    this.mesh.visible = s.value > 0.01;
    const p = this.top, k = Math.max(0.8, zoom / 30); // about 40 px tall at any zoom
    this.pin.visible = !!p && this.mesh.visible;
    if (p) {
      this.pin.position.set(p.x, p.y + this.lift + k * (0.5 + 0.25 * Math.sin(t * 3)), p.z);
      this.pin.scale.setScalar(k); this.pin.rotation.y = t * 0.8;
      const m = this.pin.material as THREE.MeshBasicMaterial;
      m.color.setScalar(0.04).lerp(new THREE.Color(1, 1, 1), ENV.night.value); m.opacity = s.value;
    }
  }
}
