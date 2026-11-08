import * as THREE from 'three';
import type { City } from '../api';
import type { Stage } from './scene';
import { Construction } from './construction';
import { Roads } from './roads';
import { blocked, fitDistricts, places, saveMove, shift } from './layout';
import { DistrictGrounds, LOT_MARGIN } from './districts';
import { Highlight } from './highlight';
import { ENV, glowBlend, ink } from './env';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { FACADE, RoofKit, SHAPE, hash, styleOf, type Style } from './themes';
import { Dressing } from './dressing';
import { Life } from './life';
import { Follies } from './follies';

// ---- building material: lit windows on the facades, activity glow -------------
// Per-instance attributes: aEm (emissive rgb), aSeed (window pattern), aStyle
// (0 file, 1 warehouse, 2 module block, 3 tower). uRise scales heights for the
// zoom-level transition.
const TINT = { value: 0 }; // 1 while a colour mode replaces the district colours
const TIME = { value: 0 };
// aFacade: the district style's window pattern (themes.ts FACADE). aAge: -1 fresh
// (written this week, glossy) .. 0 .. 1 untouched for months (weathered, ivy up the walls).
// The open ground: grass by day, mottled in patches with a fine grain, lusher where the
// woods grow and paler, drier in the meadows (same noise as wild() in dressing.ts);
// near black at night.
function groundMaterial() {
  const m = new THREE.MeshStandardMaterial({ roughness: 1 });
  m.onBeforeCompile = sh => {
    sh.uniforms.uNight = ENV.night;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vG;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvG = (modelMatrix * vec4(transformed, 1.0)).xz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
        varying vec2 vG; uniform float uNight;
        float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
        float fbm(vec2 p) { return 0.5 * vnoise(p) + 0.3 * vnoise(p * 2.03 + 7.1) + 0.2 * vnoise(p * 4.1 - 3.7); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 g = vG;
        float wild = 0.5 + 0.28 * sin(g.x * 0.11 + 1.7) * sin(g.y * 0.13 - 0.4) + 0.22 * sin((g.x + g.y) * 0.071 + 3.1) * sin((g.x - g.y) * 0.093);
        float patches = fbm(g * 0.09), tufts = fbm(g * 0.7), grain = h2(floor(g * 9.0));
        vec3 grass = mix(vec3(0.30, 0.43, 0.18), vec3(0.43, 0.54, 0.26), patches);    // lush .. fresh
        grass = mix(grass, vec3(0.58, 0.6, 0.36), smoothstep(0.42, 0.3, wild) * smoothstep(0.45, 0.7, patches) * 0.8); // dry meadow
        grass = mix(grass, vec3(0.22, 0.34, 0.14), smoothstep(0.55, 0.7, wild) * 0.6);  // under the woods
        grass *= 0.9 + 0.14 * tufts + 0.06 * grain;
        diffuseColor.rgb = mix(grass, vec3(0.0021, 0.0027, 0.0052), uNight);`);
  };
  return m;
}
function buildingMaterial(rise: { value: number }) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.35 });
  m.onBeforeCompile = sh => {
    sh.uniforms.uRise = rise; sh.uniforms.uTint = TINT; sh.uniforms.uNight = ENV.night; sh.uniforms.uTime = TIME;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aEm; attribute float aSeed; attribute float aStyle; attribute float aFacade; attribute float aAge; uniform float uRise;
        varying vec3 vEm; varying vec3 vWPos; varying vec3 vObjN; varying float vSeed; varying float vStyle; varying float vH; varying float vFacade; varying float vAge; varying float vY01;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vY01 = transformed.y;
        transformed.y *= uRise;
        vEm = aEm; vSeed = aSeed; vStyle = aStyle; vObjN = normal; vFacade = aFacade; vAge = aAge;
        vec4 wp = modelMatrix * instanceMatrix * vec4(transformed, 1.0); vWPos = wp.xyz;
        vH = transformed.y;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vEm; varying vec3 vWPos; varying vec3 vObjN; varying float vSeed; varying float vStyle; varying float vH; varying float vFacade; varying float vAge; varying float vY01;
        uniform float uTint; uniform float uNight; uniform float uTime;
        float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        // weathering and ivy: climbs from the ground, ragged at its top edge
        float age = clamp(vAge, 0.0, 1.0), fresh = clamp(-vAge, 0.0, 1.0);
        float side0 = 1.0 - step(0.5, abs(vObjN.y));
        vec2 iq = vec2((abs(vObjN.x) > 0.5 ? vWPos.z : vWPos.x) * 11.0, vWPos.y * 11.0);
        float leaf = h21(floor(iq) + vSeed * 7.0);
        float ivy = side0 * step(0.02, age) * step(vY01, age * (0.35 + 0.55 * leaf)) * step(0.22, leaf);
        diffuseColor.rgb *= 1.0 - 0.3 * age;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.06, 0.19, 0.07) * (0.7 + 0.6 * leaf), ivy);
        // by day a session at work paints its building in its colour (added light is lost
        // on pale walls); white flashes (selection) have no hue and leave the walls alone.
        // Module blocks and warehouses get a third of the light (world.ts 'big'), so scale back up.
        float emX = max(vEm.r, max(vEm.g, vEm.b)), emN = min(vEm.r, min(vEm.g, vEm.b));
        float paint = (1.0 - uNight) * (emX - emN) / max(emX, 1e-4) * smoothstep(0.0, 0.2, emX * (vStyle > 0.5 && vStyle < 2.5 ? 3.3 : 1.0));
        diffuseColor.rgb = mix(diffuseColor.rgb, vEm / max(emX, 1e-4) * 0.45, paint * 0.9);
        vec3 vEmD = vEm * (1.0 - 0.7 * paint); // and glows less, or it washes back to pastel`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.18, fresh) + age * 0.3;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 0.75, fresh) * (1.0 - age * 0.6);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float side = 1.0 - step(0.5, abs(vObjN.y));
        float roof = 1.0 - side;
        vec2 g = vec2((abs(vObjN.x) > 0.5 ? vWPos.z : vWPos.x) * 4.0, vWPos.y * 3.2);
        vec2 f = fract(g); vec2 id = floor(g);
        float win = step(0.22, f.x) * step(f.x, 0.78) * step(0.28, f.y) * step(f.y, 0.78);
        float lit = step(0.66 + 0.2 * (1.0 - uNight), h21(id + vSeed * 17.3));
        float stripes = step(0.55, fract(vWPos.y * 2.2));
        vec3 warm = vec3(1.0, 0.78, 0.48);
        // the district style's facade
        float fc = vFacade, above = vWPos.y - 0.3;
        if (fc > 0.5 && fc < 1.5) { win = step(0.07, f.x) * step(f.x, 0.93) * step(0.12, f.y); lit = max(lit, 0.35); }         // curtain glass
        else if (fc < 2.5 && fc > 1.5) { win = 0.0; }                                                                             // blank vault walls
        else if (fc < 3.5 && fc > 2.5) { win = step(0.45, f.x) * step(f.x, 0.55) * step(0.15, f.y) * step(f.y, 0.85); }           // arrow slits
        else if (fc < 4.5 && fc > 3.5) { if (above < 0.45) { win = step(0.05, f.x) * step(f.x, 0.95) * step(0.08, above); lit = 1.0; } } // shop window
        else if (fc < 5.5 && fc > 4.5) { win = step(0.32, f.x) * step(f.x, 0.68) * step(0.12, f.y) * step(f.y, 0.92); }          // tall, between columns
        else if (fc < 6.5 && fc > 5.5) { win *= step(0.7, h21(id * 1.31 + 3.1)); lit = max(lit, 0.6); }                          // sparse factory panes
        else if (fc < 7.5 && fc > 6.5) { win = step(0.32, f.y) * step(f.y, 0.68); lit = max(lit, 0.5); }                         // ribbon windows
        else if (fc < 8.5 && fc > 7.5) { win *= step(0.55, h21(id * 1.7 + 9.0)); }                                               // homes: a few rooms
        else if (fc > 9.5) { win = step(0.38, f.x) * step(f.x, 0.62) * step(0.1, f.y) * step(f.y, 0.95); lit = max(lit, 0.45); } // library arches
        win *= 1.0 - ivy;
        lit *= 0.35 + 0.65 * uNight;
        if (fc > 8.5 && fc < 9.5) { // media: LED screens wrap the walls
          float band = step(0.3, fract(vWPos.y * 0.9)) * step(fract(vWPos.y * 0.9), 0.7);
          vec3 led = 0.5 + 0.35 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + (g.x * 0.05 + vWPos.y * 0.08 - uTime * 0.15)));
          totalEmissiveRadiance += side * band * led * 0.08 * (1.0 - ivy); // soft: whole walls of it bloom into glare
        }
        // district colour on the roofs, so neighbourhoods read at a glance
        #ifdef USE_INSTANCING_COLOR
          vec3 tint = vColor / max(max(vColor.r, vColor.g), max(vColor.b, 0.001)) * 0.32; // pure hue, fixed brightness
          if (vStyle < 2.5) totalEmissiveRadiance += vColor * uTint * (roof * 0.6 + side * 0.18); // colour modes must read on dark facades
        #else
          vec3 tint = vec3(0.1);
        #endif
        if (vStyle < 0.5) {
          totalEmissiveRadiance += side * win * lit * warm * 0.22;
          totalEmissiveRadiance += roof * tint * 0.55;
          totalEmissiveRadiance += vEmD * (side * win * 2.2 + roof * 1.3 + 0.18);
        } else if (vStyle < 1.5) {
          totalEmissiveRadiance += side * stripes * vec3(0.95, 0.62, 0.25) * 0.10;
          totalEmissiveRadiance += vEmD * (side * stripes * 1.8 + roof * 0.9 + 0.15);
        } else if (vStyle < 2.5) {
          totalEmissiveRadiance += side * win * lit * warm * 0.16;
          totalEmissiveRadiance += roof * tint * 0.5;
          totalEmissiveRadiance += vEmD * (side * win * 1.6 + roof * 1.1 + 0.15);
        } else {
          totalEmissiveRadiance += vEmD * (0.6 + roof);
          totalEmissiveRadiance += side * step(0.85, fract(vWPos.y * 1.5)) * vec3(0.5, 0.7, 1.0) * 0.25;
        }`);
  };
  return m;
}

interface Inst {
  mesh: THREE.InstancedMesh; em: THREE.InstancedBufferAttribute; count: number; facade: THREE.InstancedBufferAttribute; age: THREE.InstancedBufferAttribute;
  pos: Float32Array; heights: Float32Array; hTo: Float32Array; w: Float32Array; d: Float32Array;
  rise: Float32Array; riseTo: Float32Array; flash: Float32Array; warm: Float32Array; beat: Float32Array; col: Float32Array; dirty: boolean;
}

const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpP = new THREE.Vector3();
const tmpC = new THREE.Color();
const BUILD = new THREE.Color('#ffd49a');
const GRID_DAY = new THREE.Color('#7f9468'), GRID_NIGHT = new THREE.Color('#1a2236');

// "someone is working here": the building breathes, a glow pools at its base and
// rings of light ripple outward, until the session moves on or stops working
interface Aura { I: Inst; i: number; color: THREE.Color; level: number; on: boolean; seed: number; glow: THREE.Mesh; roof: THREE.Sprite; waves: THREE.Mesh[] }
const WAVES = 3;
const glowTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d')!; const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.3, 'rgba(255,255,255,0.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
})();
const glowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const waveGeo = new THREE.RingGeometry(0.86, 1, 64).rotateX(-Math.PI / 2);
const additive = (o: object) => ({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0, toneMapped: false, fog: false, ...o });

function makeInst(n: number, rise: { value: number }, geo: THREE.BufferGeometry = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), style = 0): Inst {
  const em = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
  em.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aEm', em);
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(Float32Array.from({ length: n }, () => Math.random()), 1));
  geo.setAttribute('aStyle', new THREE.InstancedBufferAttribute(new Float32Array(n).fill(style), 1));
  const facade = new THREE.InstancedBufferAttribute(new Float32Array(n), 1), age = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
  geo.setAttribute('aFacade', facade); geo.setAttribute('aAge', age);
  const mesh = new THREE.InstancedMesh(geo, buildingMaterial(rise), Math.max(n, 1));
  mesh.count = n;
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  return { mesh, em, facade, age, count: n, pos: new Float32Array(n * 3), heights: new Float32Array(n), hTo: new Float32Array(n), w: new Float32Array(n), d: new Float32Array(n),
    rise: new Float32Array(n), riseTo: new Float32Array(n), flash: new Float32Array(n), warm: new Float32Array(n), beat: new Float32Array(n),
    col: new Float32Array(n * 3).fill(1), dirty: true };
}

function setMatrix(I: Inst, i: number) {
  const r = I.rise[i], foot = r < 0.01 ? 0.0001 : 0.4 + 0.6 * Math.min(1, r * 1.5); // not built yet: nothing on the ground
  tmpP.set(I.pos[i * 3], 0, I.pos[i * 3 + 2]);
  tmpS.set(I.w[i] * foot, Math.max(0.0001, I.heights[i] * r), I.d[i] * foot);
  tmpM.compose(tmpP, tmpQ, tmpS);
  I.mesh.setMatrixAt(i, tmpM);
}

const KIND_TINT: Record<string, [number, number, number]> = {
  // hue offset, saturation, lightness
  code: [0, 0.42, 0.24], style: [40, 0.5, 0.26], markup: [25, 0.35, 0.22], doc: [0, 0.08, 0.34], config: [0, 0.06, 0.17],
  asset: [-60, 0.3, 0.2], data: [150, 0.4, 0.2], other: [0, 0.05, 0.15],
};

export type Target = { x: number; y: number; z: number };
type Label = { el: HTMLDivElement; v: THREE.Vector3; min: number; max: number; pri: number; born: number; w?: number; h?: number };
type Ref = [number, number]; // [tt, ti]: 1 module or store, 3 outside system
const refKey = (r: Ref) => r[0] + ':' + r[1];

export class World {
  group = new THREE.Group();
  files: Inst; modules: Inst; stores: Inst; towers: Inst; domes: Inst;
  fileRise = { value: 1 }; modRise = { value: 0 }; constRise = { value: 1 };
  lod: 'files' | 'modules' = 'files';
  storeOfInst: number[] = [];          // store instance -> module index
  instOfStore = new Map<number, number>();
  modInstOf = new Map<number, number>(); // module index -> module-building instance
  modInstToModule: number[] = [];
  extInst: { I: Inst; i: number }[] = [];
  born: Float64Array;                   // file births (live writes can move them earlier)
  modBorn: Float64Array; extBorn: Float64Array;
  plates: THREE.InstancedMesh; plateOf: Ref[] = []; plateIdx = new Map<string, number>();
  plateRise: Float32Array; plateTo: Float32Array; plateDim: Float32Array;
  roads!: Roads;
  selLines: THREE.Group | null = null;
  private selNear: { tt: number; ti: number; color: THREE.Color }[] = []; // the places a selection is tied to
  private auras = new Map<string, Aura>();
  private auraGroup = new THREE.Group();
  beacons: THREE.InstancedMesh; beaconFlash: Float32Array;
  labels: HTMLDivElement;
  t0: number; tNow = Infinity;
  uT = { value: 1e12 }; uTime = { value: 0 };
  births: number[];                     // every birth moment, sorted (replay skips quiet stretches only between them)
  private labelEls: Label[] = [];
  private labelsOf = new Map<string, Label[]>(); // labels that ride on a place
  private districtLabels: { d: number; L: Label }[] = [];
  private sel: { tt: number; ti: number } | null = null;
  private highlight = new Highlight();
  onMoved: (() => void) | null = null; // a place was dragged somewhere else
  occluders: { left: number; top: number; right: number; bottom: number }[] = []; // panels on top of the canvas
  tagBoxes: { x: number; y: number; w: number; h: number }[] = [];                  // drone name tags, placed by the view
  private labelBoxes: { x: number; y: number; w: number; h: number }[] = [];        // labels shown last frame (the pin clears them)
  private baseFileCol!: Float32Array; private baseModCol!: Float32Array;
  private pins: THREE.InstancedMesh; private pinList: { ti: number; color: THREE.Color; multi: boolean }[] = [];
  private marks: { tt: number; ti: number; color: THREE.Color }[] = [];
  private ties: THREE.LineSegments | null = null;
  private sites = new Construction();
  styles: Style[] = [];                 // district -> its look (themes.ts)
  fileRoofs!: RoofKit; modRoofs!: RoofKit;
  private scaffold!: THREE.InstancedMesh;
  private ageAt = -Infinity;
  dressing!: Dressing; life!: Life; follies!: Follies;
  private ticker: Label | null = null;
  private grounds: DistrictGrounds;
  private ground: THREE.Mesh; private grid: THREE.GridHelper; private plateHue: number[] = []; private toned = -1;

  constructor(public stage: Stage, public city: City, overlay: HTMLElement) {
    const c = city;
    this.t0 = c.project.t0 - 3600e3;
    stage.scene.add(this.group);
    stage.fitShadow(c.project.w + 30, c.project.h + 30);

    // ground: faint grid that fades into the fog
    const span = Math.max(c.project.w, c.project.h) + 120;
    // (colours come from tone(): pale by day, near black at night)
    const ground = this.ground = new THREE.Mesh(new THREE.PlaneGeometry(span * 3, span * 3), groundMaterial());
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.05; ground.receiveShadow = true;
    const grid = this.grid = new THREE.GridHelper(span * 2, Math.round(span * 2 / 4), '#ffffff', '#ffffff');
    (grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.55;
    grid.position.y = -0.03;
    this.group.add(ground, grid);
    this.grounds = new DistrictGrounds(c);
    this.group.add(this.grounds.group, this.highlight.mesh, this.highlight.pin);

    // one plate per place, tinted by its district
    const places: { ref: Ref; x: number; z: number; w: number; h: number; d: number }[] = [];
    c.modules.forEach((m, i) => places.push({ ref: [1, i], x: m.x, z: m.z, w: m.w, h: m.h, d: m.district }));
    c.externals.forEach((e, i) => places.push({ ref: [3, i], x: e.x - e.w / 2 - 0.4, z: e.z - e.h / 2 - 0.4, w: e.w + 0.8, h: e.h + 0.8, d: e.district }));
    this.plates = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5),
      new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.1, emissive: '#ffffff', emissiveIntensity: 0.05 }), Math.max(1, places.length));
    this.plates.count = places.length; this.plates.receiveShadow = true;
    this.plateRise = new Float32Array(places.length); this.plateTo = new Float32Array(places.length); this.plateDim = new Float32Array(places.length * 4);
    places.forEach((p, k) => {
      this.plateOf.push(p.ref); this.plateIdx.set(refKey(p.ref), k);
      this.plateDim.set([p.x, p.z, p.w, p.h], k * 4);
      const d = c.districts[p.d];
      this.plateHue.push(d?.hue ?? 210);
      this.setPlate(k);
    });
    this.group.add(this.plates);

    this.styles = c.districts.map(styleOf);
    // file buildings
    const nF = c.files.length;
    this.files = makeInst(nF, this.fileRise);
    this.born = new Float64Array(nF);
    c.files.forEach((f, i) => {
      const d = c.districts[c.modules[f.m].district];
      const h = 0.35 + Math.log2(1 + f.size / 1500) * 0.5 + Math.min(f.churn, 40) * 0.05 + Math.min(f.w, 60) * 0.03;
      const sh = SHAPE[f.kind] || SHAPE.other;
      this.files.pos[i * 3] = f.x; this.files.pos[i * 3 + 2] = f.z;
      this.files.heights[i] = this.files.hTo[i] = Math.min(Math.max(0.3, h * sh.h), sh.max); this.files.w[i] = sh.w; this.files.d[i] = sh.w;
      this.files.facade.setX(i, FACADE[this.styles[c.modules[f.m].district]]);
      const [ho, s, l] = KIND_TINT[f.kind] || KIND_TINT.other;
      tmpC.setHSL(((d.hue + ho) % 360 + 360) % 360 / 360, s, l);
      this.files.mesh.setColorAt(i, tmpC);
      this.born[i] = f.born ?? this.t0;
    });
    this.files.mesh.position.y = 0.3;

    // module blocks (zoomed-out level) and data stores
    const codeMods = c.modules.map((m, i) => ({ m, i })).filter(x => !x.m.warehouse);
    const storeMods = c.modules.map((m, i) => ({ m, i })).filter(x => x.m.warehouse);
    this.modBorn = Float64Array.from(c.modules, m => m.born ?? this.t0);
    this.modules = makeInst(codeMods.length, this.modRise, undefined, 2);
    codeMods.forEach(({ m, i }, k) => {
      const d = c.districts[m.district];
      this.modInstOf.set(i, k); this.modInstToModule[k] = i;
      this.modules.pos[k * 3] = m.x + m.w / 2; this.modules.pos[k * 3 + 2] = m.z + m.h / 2;
      this.modules.w[k] = m.w - 1.0; this.modules.d[k] = m.h - 1.0;
      this.modules.heights[k] = 0.0001;
      this.modules.facade.setX(k, FACADE[this.styles[m.district]]);
      this.modules.mesh.setColorAt(k, tmpC.setHSL(d.hue / 360, 0.38, 0.2));
    });
    this.modules.mesh.position.y = 0.3;
    this.stores = makeInst(storeMods.length, this.constRise, undefined, 1);
    storeMods.forEach(({ m, i }, k) => {
      this.storeOfInst[k] = i; this.instOfStore.set(i, k);
      this.stores.pos[k * 3] = m.x + m.w / 2; this.stores.pos[k * 3 + 2] = m.z + m.h / 2;
      this.stores.w[k] = m.w - 0.6; this.stores.d[k] = m.h - 0.6;
      this.stores.heights[k] = this.stores.hTo[k] = 0.9 + Math.log10(Math.max(10, m.files)) * 0.55;
      this.stores.mesh.setColorAt(k, tmpC.setHSL(0.09, 0.35, 0.17));
    });
    this.stores.mesh.position.y = 0.3;

    // outside systems live in the city: servers and sites are towers, services are
    // round utility buildings, local areas are depots; each has a beacon on top
    const ex = c.externals;
    this.extBorn = Float64Array.from(ex, e => e.born ?? this.t0);
    const boxes = ex.map((e, i) => ({ e, i })).filter(x => x.e.type === 'host' || x.e.type === 'local');
    const rounds = ex.map((e, i) => ({ e, i })).filter(x => x.e.type === 'service' || x.e.type === 'web');
    this.towers = makeInst(boxes.length, this.constRise, undefined, 3);
    this.domes = makeInst(rounds.length, this.constRise, new THREE.CylinderGeometry(0.5, 0.5, 1, 24).translate(0, 0.5, 0), 3);
    const extH = (e: City['externals'][number]) => e.type === 'local' ? 1.1 + Math.log10(e.n + 1) * 0.5
      : e.type === 'web' ? 2.2 + Math.log10(e.n + 1) * 0.9 : 1.6 + Math.log10(e.n + 1) * 1.1 + Math.min(e.refCount, 60) * 0.03;
    const place = (I: Inst, k: number, e: City['externals'][number], i: number) => {
      this.extInst[i] = { I, i: k };
      I.pos[k * 3] = e.x; I.pos[k * 3 + 2] = e.z;
      I.w[k] = e.w - 0.5; I.d[k] = e.h - 0.5; I.heights[k] = I.hTo[k] = extH(e);
      I.mesh.setColorAt(k, tmpC.set(e.type === 'local' ? '#20242e' : e.type === 'host' ? '#1d2a3a' : e.type === 'web' ? '#1c2c34' : '#271f3a'));
      if (e.type === 'local') (I.mesh.geometry.getAttribute('aStyle') as THREE.BufferAttribute).setX(k, 1);
    };
    boxes.forEach(({ e, i }, k) => place(this.towers, k, e, i));
    rounds.forEach(({ e, i }, k) => place(this.domes, k, e, i));
    this.towers.mesh.position.y = 0.3; this.domes.mesh.position.y = 0.3;
    this.beacons = new THREE.InstancedMesh(new THREE.SphereGeometry(0.32, 12, 8), new THREE.MeshBasicMaterial({ color: '#ffffff' }), Math.max(1, ex.length));
    this.beacons.count = ex.length;
    this.beaconFlash = new Float32Array(ex.length);
    ex.forEach((e, k) => this.beacons.setColorAt(k, tmpC.set(this.beaconBase(k))));

    for (const I of this.insts()) {
      for (let i = 0; i < I.count; i++) setMatrix(I, i);
      I.mesh.instanceMatrix.needsUpdate = true;
      if (I.mesh.instanceColor) I.mesh.instanceColor.needsUpdate = true;
      this.group.add(I.mesh);
    }
    this.group.add(this.beacons, this.auraGroup, this.sites.group);
    // the district style's roof piece on every building, at both zoom levels
    this.fileRoofs = new RoofKit(this.files, i => this.styles[c.modules[c.files[i].m].district], this.fileRise);
    this.modRoofs = new RoofKit(this.modules, k => this.styles[c.modules[this.modInstToModule[k]].district], this.modRise, true);
    this.fileRoofs.paint('sign', i => tmpC.setHSL(c.districts[c.modules[c.files[i].m].district].hue / 360, 0.9, 0.62).clone());
    this.modRoofs.paint('sign', k => tmpC.setHSL(c.districts[c.modules[this.modInstToModule[k]].district].hue / 360, 0.9, 0.62).clone());
    // billboards: dim, under the bloom threshold, so a block of them doesn't blind
    const screen = (d: number, i: number) => tmpC.setHSL(c.districts[d].hue / 360 + (hash(i * 3.7) - 0.5) * 0.15, 0.45, 0.3 + hash(i * 5.1) * 0.08).clone();
    this.fileRoofs.paint('screen', i => screen(c.modules[c.files[i].m].district, i));
    this.modRoofs.paint('screen', k => screen(c.modules[this.modInstToModule[k]].district, k));
    this.group.add(this.fileRoofs.group, this.modRoofs.group);
    // scaffolding around files with uncommitted changes
    this.scaffold = new THREE.InstancedMesh(scaffoldGeo(), new THREE.MeshStandardMaterial({ color: '#c9a25a', emissive: '#6a4a14', emissiveIntensity: 0.5, roughness: 0.8 }), 512);
    this.scaffold.count = 0; this.scaffold.frustumCulled = false;
    this.group.add(this.scaffold);
    this.modules.mesh.visible = false;
    this.baseFileCol = (this.files.mesh.instanceColor?.array as Float32Array)?.slice() ?? new Float32Array(0);
    this.baseModCol = (this.modules.mesh.instanceColor?.array as Float32Array)?.slice() ?? new Float32Array(0);
    // markers over files with uncommitted changes, in the colour of the session that wrote them
    this.pins = new THREE.InstancedMesh(new THREE.ConeGeometry(0.5, 1.2, 4).rotateX(Math.PI), new THREE.MeshBasicMaterial({ color: '#ffffff' }), 512);
    this.pins.count = 0; this.pins.frustumCulled = false;
    this.group.add(this.pins);

    this.buildRoads();
    this.dressing = new Dressing(this, c);
    this.life = new Life(this, this.dressing, c);
    this.follies = new Follies(c); this.follies.build((x, z) => this.roads.free(x, z));
    this.group.add(this.dressing.group, this.life.group, this.follies.group);

    // labels
    this.labels = document.createElement('div');
    this.labels.className = 'labels';
    overlay.appendChild(this.labels);
    c.districts.forEach((d, di) => {
      const L = this.addLabel(d.name, new THREE.Vector3(0, 0.4, 0), 'lb-district', 60, 1e9, 3, d.born, `hsl(${d.hue} 85% 68%)`);
      this.districtLabels.push({ d: di, L });
    });
    this.placeDistrictLabels();
    const own = (r: Ref, L: Label) => { const k = refKey(r); this.labelsOf.set(k, [...this.labelsOf.get(k) || [], L]); };
    c.modules.forEach((m, i) => {
      const at = new THREE.Vector3(m.x + m.w / 2, m.warehouse ? 1.8 : 0.4, m.z + m.h);
      if (m.warehouse) own([1, i], this.addLabel(m.title || m.label.split('/').slice(-2).join('/'), at, 'lb-warehouse', 0, 140, 1, m.born));
      else own([1, i], this.addLabel(m.title || m.label, at, 'lb-module', 0, 110, 2, this.modBorn[i]));
    });
    ex.forEach((e, k) => own([3, k], this.addLabel(e.label, new THREE.Vector3(e.x, this.extInst[k].I.heights[this.extInst[k].i] + 1.4, e.z), e.type === 'local' ? 'lb-local' : 'lb-ext', 0, 200, 2, e.born)));

    this.labelEls.sort((a, b) => b.pri - a.pri);
    this.births = [...this.born, ...this.extBorn, ...c.modules.filter(m => m.warehouse).map(m => m.born)].filter(b => b > this.t0).sort((a, b) => a - b);
    this.tone(ENV.night.value);
    stage.onFrame(this.frame);
  }

  private insts() { return [this.files, this.modules, this.stores, this.towers, this.domes]; }
  private beaconBase(k: number) { const t = this.city.externals[k].type; return t === 'local' ? '#3a4458' : t === 'host' ? '#3d8fd6' : t === 'web' ? '#3fc1b0' : '#9a6cff'; }

  private setPlate(k: number) {
    const r = this.plateRise[k], s = r < 0.01 ? 0 : 0.6 + 0.4 * Math.min(1, r);
    const [x, z, w, h] = [this.plateDim[k * 4], this.plateDim[k * 4 + 1], this.plateDim[k * 4 + 2], this.plateDim[k * 4 + 3]];
    tmpP.set(x + w * (1 - s) / 2, 0, z + h * (1 - s) / 2); tmpS.set(Math.max(0.0001, w * s), Math.max(0.0001, 0.3 * r), Math.max(0.0001, h * s));
    tmpM.compose(tmpP, tmpQ, tmpS);
    this.plates.setMatrixAt(k, tmpM);
  }

  addLabel(text: string, v: THREE.Vector3, cls: string, min: number, max: number, pri: number, born: number, color?: string) {
    const el = document.createElement('div');
    el.className = 'lb ' + cls;
    el.textContent = text;
    if (color) { el.style.color = color; el.style.setProperty('--k', color); }
    el.style.display = 'none';
    this.labels.appendChild(el);
    const L: Label = { el, v, min, max, pri, born: born ?? this.t0 };
    this.labelEls.push(L);
    return L;
  }
  private placeDistrictLabels() {
    for (const { d, L } of this.districtLabels) this.grounds.labelAt(d, L.v);
  }

  // Centre of a place on the ground.
  center(r: Ref): THREE.Vector3 {
    if (r[0] === 1) { const m = this.city.modules[r[1]]; return new THREE.Vector3(m.x + m.w / 2, 0, m.z + m.h / 2); }
    const e = this.city.externals[r[1]]; return new THREE.Vector3(e.x, 0, e.z);
  }

  // Streets between places (roads.ts), on the plots the plates stand on.
  private buildRoads() {
    const old = this.roads;
    if (old) {
      this.group.remove(old.group);
      old.group.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose?.(); (m.material as THREE.Material)?.dispose?.(); });
    }
    const rects = this.plateOf.map((ref, k) => ({ ref, x: this.plateDim[k * 4], z: this.plateDim[k * 4 + 1], w: this.plateDim[k * 4 + 2], h: this.plateDim[k * 4 + 3] }));
    this.roads = new Roads(this.city, rects, this.t0, this.uT, this.uTime);
    if (old) { this.roads.group.visible = old.group.visible; this.roads.traffic = old.traffic; }
    this.group.add(this.roads.group);
    if (old && this.dressing) { this.dressing.build(); this.dressing.setTime(this.tNow); this.life.rebuild(); this.placeTicker(); this.follies.build((x, z) => this.roads.free(x, z)); this.follies.setTime(this.tNow); }
  }

  // Start dragging the place under the pointer (a module's area with its buildings,
  // a store or an outside system). Returns the mover the stage feeds pointer moves
  // to, or null where there is nothing to move. Places move in whole units, never
  // onto another plot; streets re-route as they go.
  grab(clientX: number, clientY: number): ((x: number, y: number, end: boolean) => void) | null {
    const hit = this.pick(clientX, clientY);
    if (!hit) return null;
    const ref: Ref = hit.tt === 0 ? [1, this.city.files[hit.ti].m] : [hit.tt, hit.ti];
    const k = this.plateIdx.get(refKey(ref));
    const p0 = this.stage.groundAt(clientX, clientY);
    if (k == null || !p0) return null;
    const all = places(this.city);
    let ax = 0, az = 0, routed = 0, cost = 40, laid = true;
    return (x, y, end) => {
      const p = this.stage.groundAt(x, y);
      if (p) {
        const dx = Math.round(p.x - p0.x) - ax, dz = Math.round(p.z - p0.z) - az;
        // blocked straight on: slide along whichever axis is still free
        const step = [[dx, dz], [dx, 0], [0, dz]].find(([sx, sz]) => (sx || sz) && !blocked(this.city, ref, sx, sz, all));
        if (step) { this.move(ref, k, step[0], step[1]); ax += step[0]; az += step[1]; laid = false; }
      }
      const now = performance.now();
      // re-routing every street takes a while on a big city, so leave the frames room in between
      if (!laid && (end || now - routed > Math.max(120, cost * 3))) { this.buildRoads(); this.showSelection(this.sel); cost = performance.now() - now; routed = performance.now(); laid = true; }
      if (end && (ax || az)) { saveMove(this.city, ref, ax, az); this.onMoved?.(); }
    };
  }

  private move(ref: Ref, k: number, dx: number, dz: number) {
    const c = this.city;
    shift(c, ref, dx, dz);
    fitDistricts(c);
    this.grounds.refit();
    this.plateDim[k * 4] += dx; this.plateDim[k * 4 + 1] += dz;
    this.setPlate(k); this.plates.instanceMatrix.needsUpdate = true;
    const nudge = (I: Inst, i: number) => { I.pos[i * 3] += dx; I.pos[i * 3 + 2] += dz; setMatrix(I, i); I.mesh.instanceMatrix.needsUpdate = true; };
    if (ref[0] === 1) {
      c.files.forEach((f, i) => { if (f.m === ref[1]) nudge(this.files, i); });
      const mk = this.modInstOf.get(ref[1]); if (mk != null) nudge(this.modules, mk);
      const sk = this.instOfStore.get(ref[1]); if (sk != null) nudge(this.stores, sk);
    } else { const x = this.extInst[ref[1]]; if (x) nudge(x.I, x.i); }
    this.fileRoofs.dirty = this.modRoofs.dirty = true;
    for (const L of this.labelsOf.get(refKey(ref)) || []) { L.v.x += dx; L.v.z += dz; }
    this.placeDistrictLabels();
  }
  showRoads(on: boolean) { this.roads.group.visible = on; }
  showTraffic(on: boolean) { this.roads.traffic = on; if (!on) this.roads.clear(); }

  // The place (module or outside system) a target belongs to, for roads.
  placeOf(tt: number, ti: number): Ref | null {
    if (tt === 0) { const f = this.city.files[ti]; return f ? [1, f.m] : null; }
    if (tt === 1 || tt === 3) return [tt, ti];
    return null;
  }
  // A session went from one place to another: light the road between them.
  travel(from: Ref | null, to: Ref | null, color: THREE.Color) {
    if (from && to) this.roads.travel(from, to, color);
  }

  // arcs from a selected file (imports / imported by) or place (all its ties); the places
  // at their other ends light up in the tie's colour (selFrame)
  showSelection(sel: { tt: number; ti: number } | null) {
    if (this.selLines) {
      this.group.remove(this.selLines);
      for (const l of this.selLines.children as LineSegments2[]) { l.geometry.dispose(); l.material.dispose(); }
      this.selLines = null;
    }
    this.sel = sel; this.selNear = [];
    this.roads.select([]);
    if (!sel) return;
    const c = this.city;
    const pts: number[] = [], cols: number[] = [];
    const arc = (p0: THREE.Vector3, p1: THREE.Vector3, col: THREE.Color, lift = 1.5) => {
      const mid = p0.clone().add(p1).multiplyScalar(0.5); mid.y = Math.max(p0.y, p1.y) + lift + p0.distanceTo(p1) * 0.3;
      const ps = new THREE.QuadraticBezierCurve3(p0, mid, p1).getPoints(20);
      for (let i = 0; i < ps.length - 1; i++) { pts.push(ps[i].x, ps[i].y, ps[i].z, ps[i + 1].x, ps[i + 1].y, ps[i + 1].z); cols.push(col.r, col.g, col.b, col.r, col.g, col.b); }
    };
    if (sel.tt === 0) {
      const top = (i: number) => new THREE.Vector3(c.files[i].x, this.files.heights[i] * this.files.rise[i] + 0.4, c.files[i].z);
      for (const [a, b] of c.fileEdges) {
        if (a !== sel.ti && b !== sel.ti) continue;
        const col = new THREE.Color(a === sel.ti ? TIE.imp : TIE.work); // amber: imports, cyan: imported by
        arc(top(a), top(b), col);
        this.selNear.push({ tt: 0, ti: a === sel.ti ? b : a, color: col });
      }
    } else if (sel.tt === 1 || sel.tt === 3) {
      // ties with a street light it up; the few without one arc over the city
      const me = refKey([sel.tt, sel.ti]);
      const lit: { k: number; color: THREE.Color }[] = [];
      const air: { to: Ref; col: THREE.Color }[] = [];
      c.links.forEach((l, k) => {
        const ka = refKey(l.a as Ref), kb = refKey(l.b as Ref);
        if (ka !== me && kb !== me) return;
        const col = new THREE.Color(linkColor(l)), other = (ka === me ? l.b : l.a) as Ref;
        this.selNear.push({ tt: other[0], ti: other[1], color: col });
        if (this.roads.hasRoad(k)) { lit.push({ k, color: col }); return; }
        air.push({ to: other, col });
      });
      this.roads.select(lit);
      this.airTies([sel.tt, sel.ti], air, pts, cols);
    }
    if (!pts.length) return;
    // fat screen-space lines over everything, each on a white casing so it reads on grass, lots and roofs alike
    const line = (width: number, color: boolean, order: number) => {
      const g = new LineSegmentsGeometry(); g.setPositions(pts);
      if (color) g.setColors(cols);
      const m = new LineMaterial({ color: 0xffffff, vertexColors: color, linewidth: width, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
      const l = new LineSegments2(g, m); l.renderOrder = order; l.frustumCulled = false;
      return l;
    };
    this.selLines = new THREE.Group();
    this.selLines.add(line(6, false, 20), line(3, true, 21));
    this.group.add(this.selLines);
  }

  // Ties of a place with no street to carry them, drawn as a tidy sheaf instead of a burst
  // from one point: each tie leaves from its own port on the side of the place that faces
  // its other end (ports spread evenly along the side, ordered so neighbours never cross),
  // rises straight out of that side, and lands square on the middle of the facing side of
  // the other place. Every arc has the same shape, its height capped, so far ties don't loop.
  private airTies(from: Ref, ties: { to: Ref; col: THREE.Color }[], pts: number[], cols: number[]) {
    if (!ties.length) return;
    const rect = (r: Ref) => {
      const k = this.plateIdx.get(refKey(r));
      if (k != null) { const D = this.plateDim; return { x: D[k * 4], z: D[k * 4 + 1], w: D[k * 4 + 2], h: D[k * 4 + 3] }; }
      const p = this.center(r); return { x: p.x - 0.5, z: p.z - 0.5, w: 1, h: 1 };
    };
    type Side = 0 | 1 | 2 | 3; // +x, -x, +z, -z
    const N: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const side = (R: { x: number; z: number; w: number; h: number }, tx: number, tz: number): Side => {
      const dx = tx - (R.x + R.w / 2), dz = tz - (R.z + R.h / 2);
      return Math.abs(dx) / Math.max(R.w, 0.1) >= Math.abs(dz) / Math.max(R.h, 0.1) ? (dx >= 0 ? 0 : 1) : (dz >= 0 ? 2 : 3);
    };
    // a point on a side of R, t in 0..1 along it
    const on = (R: { x: number; z: number; w: number; h: number }, s: Side, t: number) =>
      s < 2 ? { x: s === 0 ? R.x + R.w : R.x, z: R.z + R.h * t } : { x: R.x + R.w * t, z: s === 2 ? R.z + R.h : R.z };
    const S = rect(from), sx = S.x + S.w / 2, sz = S.z + S.h / 2;
    const groups: { T: ReturnType<typeof rect>; col: THREE.Color; tx: number; tz: number }[][] = [[], [], [], []];
    for (const t of ties) {
      const T = rect(t.to), tx = T.x + T.w / 2, tz = T.z + T.h / 2;
      groups[side(S, tx, tz)].push({ T, col: t.col, tx, tz });
    }
    const Y = 0.4, up = new THREE.Vector3(0, 1, 0);
    groups.forEach((g, s) => {
      // along the side in the order the targets lie, so lines fan out without crossing
      g.sort((a, b) => s < 2 ? Math.atan2(a.tz - sz, Math.abs(a.tx - sx)) - Math.atan2(b.tz - sz, Math.abs(b.tx - sx))
        : Math.atan2(a.tx - sx, Math.abs(a.tz - sz)) - Math.atan2(b.tx - sx, Math.abs(b.tz - sz)));
      g.forEach((u, i) => {
        const t = g.length === 1 ? 0.5 : 0.2 + 0.6 * i / (g.length - 1);
        const a = on(S, s as Side, t), p0 = new THREE.Vector3(a.x, Y, a.z);
        const ts = side(u.T, a.x, a.z), b = on(u.T, ts, 0.5), p1 = new THREE.Vector3(b.x, Y, b.z);
        const d = Math.hypot(p1.x - p0.x, p1.z - p0.z), hgt = Math.min(1.2 + d * 0.22, 7), reach = Math.min(d * 0.25, 4);
        const n0 = N[s], n1 = N[ts];
        const c0 = p0.clone().addScaledVector(up, hgt).add(new THREE.Vector3(n0[0] * reach, 0, n0[1] * reach));
        const c1 = p1.clone().addScaledVector(up, hgt).add(new THREE.Vector3(n1[0] * reach, 0, n1[1] * reach));
        const ps = new THREE.CubicBezierCurve3(p0, c0, c1, p1).getPoints(28);
        for (let j = 0; j < ps.length - 1; j++) {
          pts.push(ps[j].x, ps[j].y, ps[j].z, ps[j + 1].x, ps[j + 1].y, ps[j + 1].z);
          cols.push(u.col.r, u.col.g, u.col.b, u.col.r, u.col.g, u.col.b);
        }
      });
    });
  }

  // The selection frame follows the selected place (it can be dragged, it rises in a
  // replay) and its buildings glow: a file, or every building of a block.
  private selFrame(dt: number, t: number) {
    const s = this.sel, c = this.city;
    let r: { x: number; z: number; w: number; h: number; y: number; line: number; onTop?: boolean } | null = null;
    const lit: { tt: number; ti: number }[] = [];
    if (s?.tt === 0 && c.files[s.ti]) {
      const k = this.plateIdx.get(refKey([1, c.files[s.ti].m]));
      if (this.lod === 'modules' && k != null) r = this.plateRect(k, 0.14);
      else { const i = s.ti, F = this.files, g = 0.3; r = { x: F.pos[i * 3] - F.w[i] / 2 - g, z: F.pos[i * 3 + 2] - F.d[i] / 2 - g, w: F.w[i] + g * 2, h: F.d[i] + g * 2, y: 0.32, line: 0.1, onTop: true }; } // its neighbours would hide it
      lit.push(s);
    } else if (s && (s.tt === 1 || s.tt === 3)) {
      const k = this.plateIdx.get(refKey([s.tt, s.ti]));
      if (k != null && this.plateRise[k] > 0.05) r = this.plateRect(k, 0.14);
      lit.push(s);
      if (s.tt === 1 && this.lod === 'files') c.files.forEach((f, i) => { if (f.m === s.ti) lit.push({ tt: 0, ti: i }); });
    } else if (s?.tt === 2) {
      const d = c.districts[s.ti];
      if (d?.members.length) r = { x: d.x - LOT_MARGIN, z: d.z - LOT_MARGIN, w: d.w + LOT_MARGIN * 2, h: d.h + LOT_MARGIN * 2, y: 0.02, line: 0.28 };
    }
    this.highlight.set(r);
    // what it is tied to glows in the colour of the tie (a block's files too, when files are shown)
    const near = (m: { tt: number; ti: number }, color: THREE.Color) => {
      const b = this.resolve(m.tt, m.ti); if (!b) return;
      b.I.flash[b.i] = Math.max(b.I.flash[b.i], 0.5 + 0.1 * Math.sin(t * 4));
      const col = b.I.col; col[b.i * 3] = color.r; col[b.i * 3 + 1] = color.g; col[b.i * 3 + 2] = color.b;
    };
    for (const n of this.selNear) {
      near(n, n.color);
      if (n.tt === 1 && this.lod === 'files') c.files.forEach((f, i) => { if (f.m === n.ti) near({ tt: 0, ti: i }, n.color); });
    }
    let top = 0;
    for (const m of lit) {
      const b = this.resolve(m.tt, m.ti); if (!b) continue;
      const lift = b.I === this.files ? this.fileRise.value : b.I === this.modules ? this.modRise.value : 1;
      top = Math.max(top, b.I.mesh.position.y + b.I.heights[b.i] * b.I.rise[b.i] * lift);
      b.I.flash[b.i] = Math.max(b.I.flash[b.i], 0.32 + 0.12 * Math.sin(t * 4));
      const col = b.I.col; col[b.i * 3] = col[b.i * 3 + 1] = col[b.i * 3 + 2] = 1;
    }
    // the pin hangs over the middle of the footprint, above its tallest building
    const pt = r && s?.tt !== 2 ? { x: r.x + r.w / 2, y: Math.max(top, r.y) + 0.4, z: r.z + r.h / 2 } : null;
    this.highlight.setTop(pt);
    this.highlight.lift += (this.pinLift(pt) - this.highlight.lift) * Math.min(1, dt * 8);
    this.highlight.frame(dt, t, this.stage.viewSize);
  }
  // Session tags and labels sit right over building tops and would hide the pin: it rises
  // (world units) until it clears every box it would overlap on screen.
  private pinLift(p: { x: number; y: number; z: number } | null) {
    if (!p) return 0;
    const a = this.stage.project(new THREE.Vector3(p.x, p.y, p.z)), b = this.stage.project(new THREE.Vector3(p.x, p.y + 1, p.z));
    const ppu = a.y - b.y; // screen pixels per world unit up
    if (!a.visible || ppu <= 0) return 0;
    const R = this.highlight.reach(this.stage.viewSize), len = (R.hi - R.lo) * ppu, w = Math.max(14, R.w * ppu * 1.3);
    let tip = a.y - R.lo * ppu;
    const boxes = [...this.tagBoxes, ...this.labelBoxes];
    for (let moved = true, n = 0; moved && n < 12; n++) {
      moved = false;
      for (const q of boxes) if (Math.abs(q.x - a.x) * 2 < q.w + w && tip - len < q.y + q.h / 2 && tip > q.y - q.h / 2) { tip = q.y - q.h / 2 - 4; moved = true; }
    }
    return (a.y - tip) / ppu - R.lo;
  }
  private plateRect(k: number, line: number) {
    const D = this.plateDim;
    return { x: D[k * 4], z: D[k * 4 + 1], w: D[k * 4 + 2], h: D[k * 4 + 3], y: 0.32, line };
  }

  setLod(z: number) {
    const want = this.lod === 'files' ? (z > 120 ? 'modules' : 'files') : (z < 100 ? 'files' : 'modules');
    if (want !== this.lod) { this.lod = want; this.files.mesh.visible = true; this.modules.mesh.visible = true; }
  }

  // The building instance that stands for a place at the current zoom level.
  private resolve(tt: number, ti: number): { I: Inst; i: number } | null {
    if (tt === 0) {
      if (this.lod === 'modules') { const mk = this.modInstOf.get(this.city.files[ti]?.m); if (mk != null) return { I: this.modules, i: mk }; }
      return ti < this.files.count ? { I: this.files, i: ti } : null;
    }
    const it = this.instOf(tt, ti);
    return it ? { I: it[0], i: it[1] } : null;
  }

  // Places where a session is working right now; called every frame. Anything not
  // listed fades out.
  working: { tt: number; ti: number; color: THREE.Color }[] = [];
  setWorking(list: { tt: number; ti: number; color: THREE.Color }[]) {
    this.working = list;
    for (const a of this.auras.values()) a.on = false;
    for (const w of list) {
      const r = this.resolve(w.tt, w.ti); if (!r) continue;
      const key = r.I.mesh.id + ':' + r.i;
      let a = this.auras.get(key);
      if (!a) {
        const glow = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial(additive({ map: glowTex })));
        const roof = new THREE.Sprite(new THREE.SpriteMaterial(additive({ map: glowTex })));
        const waves = Array.from({ length: WAVES }, () => new THREE.Mesh(waveGeo, new THREE.MeshBasicMaterial(additive({ side: THREE.DoubleSide }))));
        a = { ...r, color: w.color.clone(), level: 0, on: true, seed: Math.random() * 6.28, glow, roof, waves };
        this.auraGroup.add(glow, roof, ...waves);
        this.auras.set(key, a);
      }
      a.on = true; a.color.copy(w.color);
    }
  }

  private auraFrame(dt: number, t: number) {
    const zoom = Math.max(1, Math.sqrt(this.stage.viewSize / 40)); // stay visible when zoomed out
    for (const [key, a] of this.auras) {
      const { I, i } = a;
      a.level += ((a.on ? 1 : 0) - a.level) * Math.min(1, dt * (a.on ? 3 : 1.2));
      if (!a.on && a.level < 0.01) {
        I.beat[i] = 0; I.dirty = true;
        this.auraGroup.remove(a.glow, a.roof, ...a.waves);
        for (const o of [a.glow, a.roof, ...a.waves]) (o.material as THREE.Material).dispose();
        this.auras.delete(key);
        continue;
      }
      const beat = 0.5 + 0.5 * Math.sin(t * 3.1 + a.seed); // one breath every ~2s
      I.beat[i] = a.level * (0.3 + 0.7 * beat);
      const c = ink(a.color, tmpC), day = 1 - ENV.night.value, blend = glowBlend();
      if (a.on) { // drift the building's glow colour to the session's
        I.col[i * 3] += (c.r - I.col[i * 3]) * 0.1; I.col[i * 3 + 1] += (c.g - I.col[i * 3 + 1]) * 0.1; I.col[i * 3 + 2] += (c.b - I.col[i * 3 + 2]) * 0.1;
      }
      for (const o of [a.glow, a.roof, ...a.waves]) (o.material as THREE.Material).blending = blend;
      const rise = I.rise[i] * (I === this.files ? this.fileRise.value : I === this.modules ? this.modRise.value : 1);
      const x = I.pos[i * 3], z = I.pos[i * 3 + 2], base = I.mesh.position.y + 0.03, top = base + I.heights[i] * rise;
      const r = Math.min(Math.max(I.w[i], I.d[i]), 4) * 0.72 * zoom; // a whole module block must not flood the city
      a.glow.position.set(x, base, z);
      a.glow.scale.setScalar(r * (4 + beat));
      // by day these cover the ground instead of lighting it: a softer pool, a smaller
      // roof halo (it would hide the painted roof), rings at full strength
      const gm = a.glow.material as THREE.MeshBasicMaterial; gm.color.copy(c); gm.opacity = a.level * (0.3 + 0.4 * beat) * (1 - 0.35 * day);
      a.roof.position.set(x, top + 0.25, z);
      a.roof.scale.setScalar(r * (2.2 + 1.4 * beat) * (1 - 0.4 * day));
      const rm = a.roof.material as THREE.SpriteMaterial; rm.color.copy(c); rm.opacity = a.level * (0.25 + 0.45 * beat) * (1 - 0.4 * day);
      a.waves.forEach((m, k) => {
        const ph = (t * 0.5 + k / WAVES + a.seed) % 1;
        m.position.set(x, base + 0.02, z);
        m.scale.setScalar(r * (0.9 + ph * 3.6));
        const mm = m.material as THREE.MeshBasicMaterial; mm.color.copy(c).multiplyScalar(1 + 0.6 * ENV.night.value); mm.opacity = a.level * 0.85 * (1 - ph) * (1 - ph * ENV.night.value);
      });
    }
  }


  // Building colours: by district (null), or a value per file in 0..1 (-1 = none)
  // drawn on a cold-to-hot ramp, or a colour per file.
  setFileTint(f: ((fi: number) => number | THREE.Color) | null) {
    const fc = this.files.mesh.instanceColor, mc = this.modules.mesh.instanceColor;
    if (!fc || !mc) return; // a project with no code files
    TINT.value = f ? 1 : 0;
    if (!f) { (fc.array as Float32Array).set(this.baseFileCol); (mc.array as Float32Array).set(this.baseModCol); fc.needsUpdate = mc.needsUpdate = true; return; }
    const cold = new THREE.Color('#141925');
    const modAcc = new Map<number, { c: THREE.Color; w: number }>();
    for (let i = 0; i < this.files.count; i++) {
      const v = f(i);
      const col = v instanceof THREE.Color ? v.clone().multiplyScalar(0.9) : v < 0 ? cold.clone() : heat(v);
      this.files.mesh.setColorAt(i, col);
      const mk = this.modInstOf.get(this.city.files[i].m);
      if (mk == null) continue;
      const w = v instanceof THREE.Color ? 1 : v < 0 ? 0.05 : 0.2 + v;
      const a = modAcc.get(mk) || { c: new THREE.Color(0, 0, 0), w: 0 };
      // a module shows its hottest files more than its average
      a.c.add(col.clone().multiplyScalar(w * w)); a.w += w * w; modAcc.set(mk, a);
    }
    for (let k = 0; k < this.modules.count; k++) { const a = modAcc.get(k); this.modules.mesh.setColorAt(k, a && a.w ? a.c.multiplyScalar(1 / a.w) : cold); }
    fc.needsUpdate = mc.needsUpdate = true;
  }

  // Run-down buildings (city health: files many sessions keep rewriting): their
  // district colour turns grey and dark. A colour mode still paints over them.
  private decayFrom: Float32Array | null = null;
  setDecay(list: number[]) {
    const fc = this.files.mesh.instanceColor;
    if (!fc) return;
    if (!this.decayFrom) this.decayFrom = this.baseFileCol.slice();
    this.baseFileCol.set(this.decayFrom);
    for (const i of list) {
      const k = i * 3, [r, g, b] = [this.decayFrom[k], this.decayFrom[k + 1], this.decayFrom[k + 2]], grey = (r + g + b) / 3;
      this.baseFileCol[k] = (r * 0.3 + grey * 0.7) * 0.55; this.baseFileCol[k + 1] = (g * 0.3 + grey * 0.7) * 0.5; this.baseFileCol[k + 2] = (b * 0.3 + grey * 0.7) * 0.45;
    }
    if (!TINT.value) { (fc.array as Float32Array).set(this.baseFileCol); fc.needsUpdate = true; }
  }

  setPins(list: { ti: number; color: THREE.Color; multi: boolean }[]) {
    this.pinList = list.slice(0, 512);
    this.pins.count = this.pinList.length;
    this.scaffold.count = this.pinList.length;
    this.scaffoldAt();
    this.pinList.forEach((p, k) => this.pins.setColorAt(k, p.color));
    if (this.pins.instanceColor) this.pins.instanceColor.needsUpdate = true;
  }

  // The latest commit message runs along the top of the tallest media building.
  setTicker(text: string | null) {
    if (!text) { if (this.ticker) this.ticker.el.style.visibility = 'hidden'; return; }
    if (!this.ticker) { this.ticker = this.addLabel('', new THREE.Vector3(), 'lb-ticker', 0, 230, 3, 0); this.labelEls.sort((a, b) => b.pri - a.pri); this.placeTicker(); }
    this.ticker.el.style.visibility = '';
    if (this.ticker.el.dataset.text !== text) {
      this.ticker.el.dataset.text = text;
      this.ticker.el.innerHTML = '';
      const run = document.createElement('span'); run.textContent = '● ' + text + '   ●   ' + text;
      this.ticker.el.appendChild(run);
      this.ticker.w = undefined;
    }
  }
  private placeTicker() { const p = this.dressing.ticker; if (this.ticker && p) this.ticker.v.set(p.x, p.y, p.z); }

  // Scaffolding stands around a file until its changes are committed.
  private scaffoldAt() {
    const I = this.files;
    this.pinList.forEach((p, k) => {
      const i = p.ti, h = Math.max(0.3, I.heights[i] * I.rise[i] * this.fileRise.value);
      tmpM.compose(tmpP.set(I.pos[i * 3], 0.3, I.pos[i * 3 + 2]), tmpQ, tmpS.set(I.w[i] + 0.14, h + 0.12, I.d[i] + 0.14));
      this.scaffold.setMatrixAt(k, tmpM);
    });
    this.scaffold.instanceMatrix.needsUpdate = true;
    this.scaffold.visible = this.fileRise.value > 0.05;
  }

  // How long since anyone touched each file: fresh this week, weathered and overgrown after months.
  private ages(t: number) {
    const c = this.city, A = this.files.age;
    for (let i = 0; i < this.files.count; i++) {
      const f = c.files[i], last = Math.max(f.last ?? 0, this.born[i] ?? 0, f.born ?? 0);
      const days = (t - last) / 864e5;
      A.setX(i, !last || days < 0 ? 0 : days < 7 ? -(1 - days / 7) : Math.min(1, Math.max(0, (days - 30) / 150)));
    }
    A.needsUpdate = true;
    // a module block weathers with its freshest file
    const fresh = new Float32Array(this.modules.count).fill(1);
    for (let i = 0; i < this.files.count; i++) { const k = this.modInstOf.get(c.files[i].m); if (k != null) fresh[k] = Math.min(fresh[k], A.getX(i)); }
    for (let k = 0; k < this.modules.count; k++) this.modules.age.setX(k, Math.max(0, fresh[k]) * 0.8);
    this.modules.age.needsUpdate = true;
  }

  // Places lit for as long as they are listed (hovered session's footprint).
  setMarks(list: { tt: number; ti: number; color: THREE.Color }[]) { this.marks = list; }

  // Arcs for a set of ties (new connections), on top of everything else.
  showTies(list: { a: [number, number]; b: [number, number] }[] | null) {
    if (this.ties) { this.group.remove(this.ties); this.ties.geometry.dispose(); (this.ties.material as THREE.Material).dispose(); this.ties = null; }
    if (!list?.length) return;
    const pts: number[] = [];
    for (const l of list) {
      const p0 = this.center(l.a), p1 = this.center(l.b); p0.y = 1; p1.y = 1;
      const mid = p0.clone().add(p1).multiplyScalar(0.5); mid.y = 3 + p0.distanceTo(p1) * 0.35;
      const ps = new THREE.QuadraticBezierCurve3(p0, mid, p1).getPoints(24);
      for (let i = 0; i < ps.length - 1; i++) pts.push(ps[i].x, ps[i].y, ps[i].z, ps[i + 1].x, ps[i + 1].y, ps[i + 1].z);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.ties = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#e7f36b', transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.group.add(this.ties);
  }

  // Where an actor should go for a target. y is the roof height.
  position(tt: number, ti: number): Target | null {
    const c = this.city;
    if (tt === 0) {
      const f = c.files[ti]; if (!f) return null;
      const fileY = this.files.heights[ti] * Math.max(this.files.rise[ti], 0.05) * this.fileRise.value + 0.3;
      const mk = this.modInstOf.get(f.m);
      const modY = mk != null ? this.modules.heights[mk] * this.modRise.value + 0.3 : 0;
      return { x: f.x, y: Math.max(fileY, modY), z: f.z };
    }
    if (tt === 1) {
      const m = c.modules[ti]; if (!m) return null;
      const sk = this.instOfStore.get(ti);
      if (sk != null) return { x: m.x + m.w / 2, y: this.stores.heights[sk] + 0.5, z: m.z + m.h / 2 };
      const mk = this.modInstOf.get(ti);
      return { x: m.x + m.w / 2, y: mk != null ? Math.max(this.modules.heights[mk] * this.modRise.value, 1.5) + 0.4 : 1, z: m.z + m.h / 2 };
    }
    if (tt === 2) { const d = c.districts[ti]; return d ? { x: d.x + d.w / 2, y: 1, z: d.z + d.h / 2 } : null; }
    if (tt === 3) { const e = c.externals[ti], x = this.extInst[ti]; return e && x ? { x: e.x, y: x.I.heights[x.i] + 0.9, z: e.z } : null; }
    return null;
  }

  private instOf(tt: number, ti: number): [Inst, number] | null {
    if (tt === 0) return [this.files, ti];
    if (tt === 1) {
      const sk = this.instOfStore.get(ti); if (sk != null) return [this.stores, sk];
      const mk = this.modInstOf.get(ti); return mk != null ? [this.modules, mk] : null;
    }
    if (tt === 3) { const x = this.extInst[ti]; return x ? [x.I, x.i] : null; }
    return null;
  }

  // Light a place up.
  pulse(tt: number, ti: number, color: THREE.Color, strength: number) {
    if (tt === 0 && this.lod === 'modules') { const mk = this.modInstOf.get(this.city.files[ti]?.m); if (mk != null) this.hit(this.modules, mk, color, strength * 0.7); }
    if (tt === 3) this.beaconFlash[ti] = 1;
    const it = this.instOf(tt, ti);
    if (it) this.hit(it[0], it[1], color, strength);
  }

  private hit(I: Inst, i: number, color: THREE.Color, s: number) {
    I.flash[i] = Math.min(1, I.flash[i] + s);
    I.warm[i] = Math.min(1, I.warm[i] + s * 0.25);
    const k = 0.6;
    I.col[i * 3] = I.col[i * 3] * (1 - k) + color.r * k; I.col[i * 3 + 1] = I.col[i * 3 + 1] * (1 - k) + color.g * k; I.col[i * 3 + 2] = I.col[i * 3 + 2] * (1 - k) + color.b * k;
    I.dirty = true;
  }

  // Seed slow "warmth" from history (replay seek).
  setWarmth(tt: number, ti: number, warm: number, color: THREE.Color) {
    const it = this.instOf(tt, ti); if (!it) return;
    const [I, i] = it;
    I.warm[i] = Math.min(1, warm);
    I.col[i * 3] = color.r; I.col[i * 3 + 1] = color.g; I.col[i * 3 + 2] = color.b;
    I.dirty = true;
  }
  decayWarm(k: number) {
    for (const I of this.insts()) for (let i = 0; i < I.count; i++) if (I.warm[i] > 0.001) I.warm[i] *= k; else I.warm[i] = 0;
  }
  clearHeat() {
    for (const I of this.insts()) { I.flash.fill(0); I.warm.fill(0); I.dirty = true; }
    this.roads.clear();
    this.sites.clear();
  }

  // Cranes and diggers beside a building while it goes up or is being written.
  private construct(I: Inst, i: number, seconds: number) {
    if (I === this.modules) return; // the zoomed-out blocks are too far away to see machines
    const lift = I === this.files ? this.fileRise : this.constRise;
    this.sites.start(I.mesh.id + ':' + i, () => [I.pos[i * 3], I.pos[i * 3 + 2]], I.w[i], I.d[i],
      () => I.heights[i] * I.rise[i] * lift.value, seconds, this.stage.target, this.stage.viewSize);
  }

  // A session acted somewhere before its recorded birth (live writes, first calls).
  noteBirth(tt: number, ti: number, ts: number) {
    if (tt === 0 && this.born[ti] > ts) this.born[ti] = ts;
    if (tt === 1 && this.modBorn[ti] > ts) this.modBorn[ti] = ts;
    if (tt === 3 && this.extBorn[ti] > ts) this.extBorn[ti] = ts;
  }

  // The city as it stood at time t: what does not exist yet is not there. With
  // `animate`, new buildings rise out of the ground with a construction flash.
  private modSize = new Float64Array(0);
  setTime(t: number, animate: boolean) {
    this.tNow = t;
    this.uT.value = (t - this.t0) / 1000;
    if (!animate || Math.abs(t - this.ageAt) > 3600e3) { this.ageAt = t; this.ages(Math.min(t, Date.now())); }
    this.grounds.update(t);
    this.dressing?.setTime(t);
    this.follies?.setTime(t);
    const c = this.city;
    const born = (I: Inst, i: number, alive: boolean) => {
      const to = alive ? 1 : 0;
      if (I.riseTo[i] === to) return;
      I.riseTo[i] = to;
      if (!animate) { I.rise[i] = to; setMatrix(I, i); I.mesh.instanceMatrix.needsUpdate = true; }
      else if (to) { this.hit(I, i, BUILD, I === this.files ? 0.8 : 0.25); this.construct(I, i, 6); } // big blocks flash softly
    };
    if (this.modSize.length !== c.modules.length) this.modSize = new Float64Array(c.modules.length);
    const size = this.modSize; size.fill(0);
    const alive = new Uint8Array(c.modules.length);
    for (let i = 0; i < this.files.count; i++) {
      const on = this.born[i] <= t;
      born(this.files, i, on);
      if (on) { const m = c.files[i].m; size[m] += c.files[i].size; alive[m] = 1; }
    }
    c.modules.forEach((m, i) => {
      const on = m.warehouse ? this.modBorn[i] <= t : alive[i] === 1 || this.modBorn[i] <= t && m.files === 0;
      const sk = this.instOfStore.get(i);
      if (sk != null) born(this.stores, sk, on);
      const mk = this.modInstOf.get(i);
      if (mk != null) {
        born(this.modules, mk, on);
        const h = on ? 1 + Math.log2(1 + size[i] / 20000) * 0.9 : 0.0001;
        this.modules.hTo[mk] = h;
        if (!animate) { this.modules.heights[mk] = h; setMatrix(this.modules, mk); this.modules.mesh.instanceMatrix.needsUpdate = true; }
      }
      this.platePlan(1, i, on, animate);
    });
    c.externals.forEach((e, i) => {
      const on = this.extBorn[i] <= t, x = this.extInst[i];
      born(x.I, x.i, on);
      this.platePlan(3, i, on, animate);
    });
  }
  private platePlan(tt: number, ti: number, on: boolean, animate: boolean) {
    const k = this.plateIdx.get(tt + ':' + ti); if (k == null) return;
    const to = on ? 1 : 0;
    if (this.plateTo[k] === to) return;
    this.plateTo[k] = to;
    if (!animate) { this.plateRise[k] = to; this.setPlate(k); this.plates.instanceMatrix.needsUpdate = true; }
  }
  growOnWrite(fi: number) { // an edited file bumps up a little
    const I = this.files;
    if (I.riseTo[fi] === 0) I.riseTo[fi] = 1;
    I.rise[fi] = Math.max(0.0, I.rise[fi]) * 0.92;
    this.construct(I, fi, 4);
  }
  // First birth after t (replay: do not skip over the city being built).
  nextBirth(t: number) {
    const b = this.births;
    let lo = 0, hi = b.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (b[m] <= t) lo = m + 1; else hi = m; }
    return b[lo];
  }

  // The folly (follies.ts) under the pointer, unless a building stands in front of it.
  follyAt(clientX: number, clientY: number) {
    const r = this.stage.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.stage.camera);
    const f = this.follies.hit(ray.ray);
    if (!f) return null;
    const front = ray.intersectObjects([this.towers.mesh, this.domes.mesh, this.stores.mesh, this.lod === 'files' ? this.files.mesh : this.modules.mesh], false)
      .find(h => h.instanceId != null && !(h.object === this.files.mesh && this.files.rise[h.instanceId] < 0.05));
    return front && front.distance < f.dist ? null : this.follies.rides[f.i];
  }

  pick(clientX: number, clientY: number): { tt: number; ti: number } | null {
    const r = this.stage.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, this.stage.camera);
    const meshes = [this.towers.mesh, this.domes.mesh, this.stores.mesh, this.lod === 'files' ? this.files.mesh : this.modules.mesh, this.plates];
    const hits = ray.intersectObjects(meshes, false);
    for (const h of hits) {
      if (h.instanceId == null) continue;
      if (h.object === this.files.mesh) { if (this.files.rise[h.instanceId] < 0.05) continue; return { tt: 0, ti: h.instanceId }; }
      if (h.object === this.modules.mesh) return { tt: 1, ti: this.modInstToModule[h.instanceId] };
      if (h.object === this.stores.mesh) return { tt: 1, ti: this.storeOfInst[h.instanceId] };
      if (h.object === this.towers.mesh || h.object === this.domes.mesh) {
        const ti = this.extInst.findIndex(x => x.I.mesh === h.object && x.i === h.instanceId);
        if (ti >= 0) return { tt: 3, ti };
      }
      if (h.object === this.plates) { if (this.plateRise[h.instanceId] < 0.05) continue; const [tt, ti] = this.plateOf[h.instanceId]; return { tt, ti }; }
    }
    // open ground: the district it belongs to
    const g = this.stage.groundAt(clientX, clientY);
    const d = g ? this.grounds.at(g.x, g.z) : -1;
    return d >= 0 ? { tt: 2, ti: d } : null;
  }

  private labelTick = 0;
  // Day and night recolour the open ground, the grid, district lots and place plates;
  // buildings, roads and lamps read ENV.night themselves.
  private tone(n: number) {
    this.toned = n;
    (this.grid.material as THREE.LineBasicMaterial).color.copy(GRID_DAY).lerp(GRID_NIGHT, n);
    (this.grid.material as THREE.LineBasicMaterial).opacity = 0.07 + 0.48 * n; // by day the grass carries the ground
    this.grounds.tone(n);
    this.plateHue.forEach((hue, k) => this.plates.setColorAt(k, tmpC.setHSL(hue / 360, 0.45, 0.76 - 0.66 * n)));
    if (this.plates.instanceColor) this.plates.instanceColor.needsUpdate = true;
  }

  private frame = (dt: number, t: number) => {
    if (Math.abs(ENV.night.value - this.toned) > 0.005) this.tone(ENV.night.value);
    this.uTime.value = t; TIME.value = t;
    this.auraFrame(dt, t);
    this.sites.update(dt, t, this.stage.viewSize);
    // LOD crossfade: heights of the two building sets swap
    const fTo = this.lod === 'files' ? 1 : 0, mTo = 1 - fTo;
    this.fileRise.value += (fTo - this.fileRise.value) * Math.min(1, dt * 6);
    this.modRise.value += (mTo - this.modRise.value) * Math.min(1, dt * 6);
    this.files.mesh.visible = this.fileRise.value > 0.01;
    this.modules.mesh.visible = this.modRise.value > 0.01;

    this.selFrame(dt, t);
    for (const m of this.marks) { // hovered footprint: held lit
      const r = this.resolve(m.tt, m.ti); if (!r) continue;
      r.I.flash[r.i] = Math.max(r.I.flash[r.i], 0.55 + 0.25 * Math.sin(t * 6));
      const c = r.I.col; c[r.i * 3] = m.color.r; c[r.i * 3 + 1] = m.color.g; c[r.i * 3 + 2] = m.color.b;
    }
    for (const I of this.insts()) {
      let matrices = false;
      for (let i = 0; i < I.count; i++) {
        let ch = false;
        if (I.rise[i] !== I.riseTo[i]) {
          const d = I.riseTo[i] - I.rise[i];
          I.rise[i] = Math.abs(d) < 0.01 ? I.riseTo[i] : I.rise[i] + d * Math.min(1, dt * 4);
          ch = true;
        }
        if (I.heights[i] !== I.hTo[i]) {
          const d = I.hTo[i] - I.heights[i];
          I.heights[i] = Math.abs(d) < 0.005 ? I.hTo[i] : I.heights[i] + d * Math.min(1, dt * 3);
          ch = true;
        }
        if (ch) { setMatrix(I, i); matrices = true; }
      }
      if (matrices) {
        I.mesh.instanceMatrix.needsUpdate = true;
        if (I === this.files) this.fileRoofs.dirty = true; else if (I === this.modules) this.modRoofs.dirty = true;
      }
      const em = I.em.array as Float32Array;
      const big = I === this.modules || I === this.stores ? 0.3 : 1; // wide roofs bloom much more than towers
      let any = false;
      for (let i = 0; i < I.count; i++) {
        const f = I.flash[i], w = I.warm[i];
        if (f > 0.001) I.flash[i] = f * Math.exp(-dt * 2.2);
        const e = Math.min(1.5, f * 1.3 + w * 0.4 + I.beat[i] * 0.9) * big; // capped: a busy building glows, it does not blow out the frame
        if (e > 0.002 || em[i * 3] + em[i * 3 + 1] + em[i * 3 + 2] > 0) {
          em[i * 3] = I.col[i * 3] * e; em[i * 3 + 1] = I.col[i * 3 + 1] * e; em[i * 3 + 2] = I.col[i * 3 + 2] * e;
          if (e <= 0.002) em[i * 3] = em[i * 3 + 1] = em[i * 3 + 2] = 0;
          any = true;
        }
      }
      if (any || I.dirty) { I.em.needsUpdate = true; I.dirty = false; }
    }
    // plates grow in under new places
    let plates = false;
    for (let k = 0; k < this.plateTo.length; k++) {
      if (this.plateRise[k] === this.plateTo[k]) continue;
      const d = this.plateTo[k] - this.plateRise[k];
      this.plateRise[k] = Math.abs(d) < 0.01 ? this.plateTo[k] : this.plateRise[k] + d * Math.min(1, dt * 5);
      this.setPlate(k); plates = true;
    }
    if (plates) this.plates.instanceMatrix.needsUpdate = true;
    this.fileRoofs.sync(); this.modRoofs.sync();
    this.roads.frame(dt, this.stage.viewSize);
    this.dressing.frame(dt, t);
    this.follies.frame(dt, t);
    this.life.frame(dt, t, this.stage.viewSize);
    // beacons ride on their buildings and blink: slow idle pulse + flash on traffic
    const bc = this.beacons.instanceColor;
    const ex = this.city.externals;
    for (let k = 0; k < ex.length; k++) {
      const x = this.extInst[k], r = x.I.rise[x.i];
      tmpM.compose(tmpP.set(ex[k].x, x.I.heights[x.i] * r + 0.6, ex[k].z), tmpQ, tmpS.setScalar(Math.max(0.0001, r)));
      this.beacons.setMatrixAt(k, tmpM);
      this.beaconFlash[k] *= Math.exp(-dt * 2.5);
      const blink = 0.35 + 0.25 * Math.max(0, Math.sin(t * 2 + k * 1.7)) + this.beaconFlash[k] * 3;
      this.beacons.setColorAt(k, tmpC.set(this.beaconBase(k)).multiplyScalar(blink));
    }
    this.beacons.instanceMatrix.needsUpdate = true;
    if (bc) bc.needsUpdate = true;
    if (this.scaffold.count && (this.fileRoofs.dirty || (this.labelTick & 15) === 0)) this.scaffoldAt();
    if (this.pins.count) {
      const zoom = Math.max(1, Math.sqrt(this.stage.viewSize / 40));
      this.pinList.forEach((p, k) => {
        const pos = this.position(0, p.ti); if (!pos) return;
        const bob = Math.sin(t * 2.4 + p.ti) * 0.15;
        tmpM.compose(tmpP.set(pos.x, pos.y + 0.9 * zoom + bob, pos.z), tmpQ, tmpS.setScalar(zoom * (p.multi ? 1.35 + 0.25 * Math.sin(t * 7) : 1)));
        this.pins.setMatrixAt(k, tmpM);
      });
      this.pins.instanceMatrix.needsUpdate = true;
    }
    if ((this.labelTick++ & 1) === 0) this.placeLabels();
  };

  private placeLabels() {
    const z = this.stage.viewSize;
    const o = { x: 0, y: 0, visible: false };
    const taken: { x: number; y: number; w: number; h: number; pri: number }[] = this.tagBoxes.map(t => ({ ...t, pri: 4 }));
    const under = (x: number, y: number, w: number) => this.occluders.some(r => x + w / 2 > r.left - 6 && x - w / 2 < r.right + 6 && y > r.top - 10 && y < r.bottom + 10);
    const hide = (el: HTMLDivElement) => { if (el.style.display !== 'none') el.style.display = 'none'; };
    for (const L of this.labelEls) {
      const show = z >= L.min && z <= L.max && L.born <= this.tNow;
      if (!show) { hide(L.el); continue; }
      this.stage.project(L.v, o);
      if (!o.visible) { hide(L.el); continue; }
      if (L.w == null) { // measure the real box once (a hidden label measures 0)
        L.el.style.display = '';
        L.w = L.el.offsetWidth + 10; L.h = L.el.offsetHeight + 5;
        if (L.w <= 10) L.w = undefined;
      }
      const w = L.w ?? L.el.textContent!.length * 7 + 10, h = L.h ?? 16;
      // try the anchor, then a nudge above or below, before giving up
      const y = [0, -h, h].map(d => o.y + d).find(y => !under(o.x, y, w) &&
        !taken.some(t => (L.pri < 3 || t.pri >= 3) && Math.abs(t.x - o.x) * 2 < t.w + w && Math.abs(t.y - y) * 2 < t.h + h));
      if (y == null) { hide(L.el); continue; }
      taken.push({ x: o.x, y, w, h, pri: L.pri });
      if (L.el.style.display === 'none') L.el.style.display = '';
      L.el.style.transform = `translate(${o.x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
    }
    this.labelBoxes = taken;
  }

  dispose() {
    this.labels.remove();
    this.stage.scene.remove(this.group);
    this.group.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose?.(); const mat = m.material as THREE.Material | THREE.Material[]; if (Array.isArray(mat)) mat.forEach(x => x.dispose()); else mat?.dispose?.(); });
  }
}

// Poles at the corners and planks every storey, as a unit box standing on y = 0.
function scaffoldGeo() {
  const g: THREE.BufferGeometry[] = [];
  for (const [x, z] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) g.push(new THREE.BoxGeometry(0.03, 1, 0.03).translate(x, 0.5, z));
  for (const y of [0.25, 0.5, 0.75, 1]) { g.push(new THREE.BoxGeometry(1.02, 0.025, 0.06).translate(0, y, 0.5), new THREE.BoxGeometry(0.06, 0.025, 1.02).translate(0.5, y, 0)); }
  g.push(new THREE.BoxGeometry(0.02, 1.1, 0.02).rotateX(0).rotateZ(0.95).translate(0, 0.5, 0.5));
  return mergeGeometries(g.map(x => { x.deleteAttribute('uv'); return x; }))!;
}

// Why two places are tied: amber imports, violet named in code, cyan worked on together.
// Deep enough to read on the light day ground; the schematic's COL uses the same three.
const TIE = { imp: '#d98a1c', ref: '#8a5cf0', work: '#1798bd' };
export function linkColor(l: { imp: number; ref: number; task: number; commit: number }) {
  const imp = Math.log2(1 + l.imp) * 1.5, ref = Math.log2(1 + l.ref) * 2, work = Math.log2(1 + l.task) * 1.2 + Math.log2(1 + l.commit);
  return imp >= ref && imp >= work ? TIE.imp : ref >= work ? TIE.ref : TIE.work;
}

// 0 cold blue -> 1 hot amber/white, for the colour modes
const RAMP = ['#1d3a6e', '#2f6fb0', '#3fb3a6', '#e0b13f', '#ff7a3d', '#ffd9b0'].map(c => new THREE.Color(c));
function heat(v: number) {
  const x = Math.max(0, Math.min(1, v)) * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(x));
  return RAMP[i].clone().lerp(RAMP[i + 1], x - i);
}
