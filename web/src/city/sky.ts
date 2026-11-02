import * as THREE from 'three';
import type { Stage } from './scene';
import { ENV } from './env';

// Time of day and weather. The sky follows the clock of the moment on screen (now when
// live, the replay's time otherwise): a dark night with lit windows and street lamps,
// a blue dusk, a pale day. Rain falls while tests are failing; lightning flashes when
// sessions keep colliding on the same file.
const NIGHT = { bg: new THREE.Color('#05070d'), hemi: new THREE.Color('#6d7fb8'), hemiI: 0.55, sun: new THREE.Color('#9fb6ee'), sunI: 0.75 };
const DAY = { bg: new THREE.Color('#2b3a52'), hemi: new THREE.Color('#c9d6ee'), hemiI: 1.05, sun: new THREE.Color('#fff0d8'), sunI: 1.45 };
const DUSK = new THREE.Color('#3a2a3e');
const DROPS = 1600;

export class Sky {
  enabled = true;   // day and night follow the clock; off = always night (the classic look)
  weather = true;
  private hemi: THREE.HemisphereLight | null = null;
  private sun: THREE.DirectionalLight | null = null;
  private rainTo = 0; private flash = 0; private nextBolt = 0; private thunder = false;
  private rain: THREE.LineSegments; private drops: Float32Array;
  private tmp = new THREE.Color();

  constructor(private stage: Stage) {
    stage.scene.traverse(o => { if (o instanceof THREE.HemisphereLight) this.hemi = o; if (o instanceof THREE.DirectionalLight) this.sun = o; });
    this.drops = new Float32Array(DROPS * 6);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(this.drops, 3).setUsage(THREE.DynamicDrawUsage));
    this.rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#9fc4ff', transparent: true, opacity: 0, depthWrite: false }));
    this.rain.frustumCulled = false; this.rain.visible = false;
    stage.scene.add(this.rain);
  }

  setWeather(rain: boolean, thunder: boolean) { this.rainTo = rain ? 1 : 0; this.thunder = thunder; }

  // ms timestamp of the moment on screen
  update(dt: number, t: number, now: number) {
    const d = new Date(now), h = d.getHours() + d.getMinutes() / 60;
    // 0 at 13:00, 1 from 20:30 to 05:30, smooth dawn and dusk
    const night = this.enabled ? 1 - smooth(5.5, 8.5, h) * (1 - smooth(17.5, 20.5, h)) : 1;
    ENV.night.value += (night - ENV.night.value) * Math.min(1, dt * 2);
    const n = ENV.night.value, dusk = Math.max(0, 1 - Math.abs(n - 0.5) * 2) * 0.6;
    const r = (ENV.rain.value += ((this.weather ? this.rainTo : 0) - ENV.rain.value) * Math.min(1, dt * 0.8));
    const sc = this.stage.scene;
    const bg = this.tmp.copy(DAY.bg).lerp(NIGHT.bg, n).lerp(DUSK, dusk).multiplyScalar(1 - r * 0.35);
    (sc.background as THREE.Color).copy(bg); (sc.fog as THREE.Fog).color.copy(bg);
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 3);
    if (this.thunder && this.weather && t > this.nextBolt) { this.flash = 1; this.nextBolt = t + 4 + Math.random() * 9; }
    const bolt = this.flash > 0.5 || (this.flash > 0.1 && this.flash < 0.3) ? this.flash : 0;
    if (this.hemi) { this.hemi.color.copy(DAY.hemi).lerp(NIGHT.hemi, n); this.hemi.intensity = (DAY.hemiI + (NIGHT.hemiI - DAY.hemiI) * n) * (1 - r * 0.3) + bolt * 2.5; }
    if (this.sun) { this.sun.color.copy(DAY.sun).lerp(NIGHT.sun, n).lerp(DUSK.clone().offsetHSL(0.05, 0.3, 0.4), dusk); this.sun.intensity = (DAY.sunI + (NIGHT.sunI - DAY.sunI) * n) * (1 - r * 0.5); }
    // rain: streaks in a box around what the camera looks at
    this.rain.visible = r > 0.02;
    if (this.rain.visible) {
      const s = this.stage, span = s.viewSize * 1.2, top = span * 0.5, tx = s.target.x, tz = s.target.z, len = span * 0.012;
      const p = this.drops;
      for (let i = 0; i < DROPS; i++) {
        const k = i * 6;
        if (p[k + 1] <= 0.1 || Math.abs(p[k] - tx) > span || Math.abs(p[k + 2] - tz) > span) {
          p[k] = tx + (Math.random() - 0.5) * span * 2; p[k + 2] = tz + (Math.random() - 0.5) * span * 2; p[k + 1] = Math.random() * top;
        }
        p[k + 1] -= dt * (18 + (i % 7) * 2);
        p[k + 3] = p[k] + len * 0.15; p[k + 4] = p[k + 1] + len; p[k + 5] = p[k + 2];
      }
      (this.rain.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (this.rain.material as THREE.LineBasicMaterial).opacity = 0.35 * r;
    }
  }

  dispose() {
    this.stage.scene.remove(this.rain); this.rain.geometry.dispose(); (this.rain.material as THREE.Material).dispose();
    ENV.night.value = 1; ENV.rain.value = 0;
    (this.stage.scene.background as THREE.Color).copy(NIGHT.bg); (this.stage.scene.fog as THREE.Fog).color.copy(NIGHT.bg);
    if (this.hemi) { this.hemi.color.copy(NIGHT.hemi); this.hemi.intensity = NIGHT.hemiI; }
    if (this.sun) { this.sun.color.copy(NIGHT.sun); this.sun.intensity = NIGHT.sunI; }
  }
}
function smooth(a: number, b: number, x: number) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
