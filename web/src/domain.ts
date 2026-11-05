import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { Stage } from './city/scene';
import { api, live, type City, type DomainState, type DomainModel, type DEntity, type DFlow, type DAssumption, type Brief, type DriftFile, type EStatus } from './api';
import { h, put, ago, dur, money } from './util';
import './domain.css';

// The domain map: what the project is about, as floating isles. Every entity
// (Order, Session, Invoice...) is an isle; bridges are the relations between them,
// labelled with their verb; the files that implement an entity stand on it as small
// buildings (shape = what the file does for it). Far below lies the real world: the
// people, systems and places the entities stand for, tied up to their isles. Strain
// shows on the isles: cracks and falling rocks where the code is shaky, scaffolding
// where it is half built, a ghost where it is missing, a red flag where code built
// for an older setup is still carrying the new one. Flows run as a courier across
// the bridges; a task brief lights up the part of the map the next task touches.

export interface DomainHost {
  onFile(p: string): void;          // open a file in the Inspect tab
  onLayout(): void;                 // the panel appeared or went: things floating over the map move
}

const STATUS: Record<EStatus, string> = { solid: 'Solid', shaky: 'Shaky', partial: 'Half built', missing: 'Missing', unknown: 'Unknown' };
const STATUS_TIP: Record<EStatus, string> = {
  solid: 'Works and fits the current design', shaky: 'Works, but strained, patched or inconsistent', partial: 'Partly built',
  missing: 'Needed by a flow or named in docs and tasks, but not built', unknown: 'Not enough evidence either way' };
const DOES: Record<string, string> = { defines: 'Defines', stores: 'Stores', changes: 'Changes', shows: 'Shows', uses: 'Uses' };
const DOES_TIP: Record<string, string> = { defines: 'tall block: where the entity is defined (types, models, schemas)',
  stores: 'silo: where it is saved and loaded', changes: 'workshop: where it is created or changed', shows: 'billboard: where it is shown to people', uses: 'small block: code that only uses it' };
const FLOW: Record<string, string> = { works: 'Works', partial: 'Partial', broken: 'Broken', unknown: 'Unknown' };
const GRASS_HUES = [95, 150, 45, 190, 25, 120, 210, 65, 165, 10];
const SKY = new THREE.Color('#e9edf0');
const RED = new THREE.Color('#d2232a');
const ISLE_Y = 18;          // isle tops float about this high over the real world
const STRAIN_FLAG = 6;      // summed drift score of an isle's files that raises the red flag
const TETHER = 0.22;        // opacity of the ties down to the real world when nothing is in focus

type Sel = { k: 'entity'; id: string } | { k: 'flow'; id: string } | { k: 'assumption'; id: string } | { k: 'brief'; id: string } | { k: 'world'; id: string } | null;
type Tab = 'task' | 'flows' | 'drift' | 'map';

interface Isle {
  e: DEntity; i: number; x: number; z: number; y: number; r: number; depth: number;
  g: THREE.Group; mats: THREE.Material[]; base: number[]; strain: number; flag: THREE.Object3D | null;
  houses: { mesh: THREE.Object3D; p: string; top: number }[]; debris: THREE.Object3D[];
  label: HTMLElement; hue: number; tall: number;
}
interface Land { w: DomainModel['world'][number]; x: number; z: number; g: THREE.Group; label: HTMLElement; mats: THREE.Material[] }
interface Bridge { a: Isle; b: Isle; verb: string; line: Line2; mat: LineMaterial; mid: THREE.Vector3; label: HTMLElement }
interface Tether { isle: Isle; land: Land; line: THREE.Line; mat: THREE.LineDashedMaterial }
interface Drone { g: THREE.Group; beam: THREE.Line; color: string; isle: Isle | null; house: number; seen: number; phase: number }
// A flow played as a walk: the courier waits at each station (start, every step, end), then
// travels the arc to the next. k is the step index; -1 is the start, steps.length the end.
interface Station { p: THREE.Vector3; k: number; isle: Isle | null; houses: Isle['houses']; pi: number; dwell: number; move: number }
interface FlowFx {
  f: DFlow; line: Line2; mat: LineMaterial; pts: THREE.Vector3[]; cum: number[]; stations: Station[]; total: number;
  t: number; playing: boolean; cur: number; courier: THREE.Mesh; beams: THREE.LineSegments;
  nums: { el: HTMLElement; ks: number[] }[]; pins: HTMLElement[]; caption: HTMLElement;
}

// put() appends; panels here are re-rendered whole
const fill = (el: Element, ...kids: any[]) => { el.replaceChildren(); return put(el, ...kids); };
const clip = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s;

// deterministic noise, so a project's map looks the same on every load
function hashStr(s: string) { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return x >>> 0; }
function rng(seed: number) {
  let a = seed || 1;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export class DomainMap {
  el: HTMLDivElement;
  stage: Stage;
  private canvasBox: HTMLDivElement; private labels: HTMLDivElement; private tip: HTMLDivElement;
  private panel: HTMLDivElement; private body: HTMLDivElement; private headInfo: HTMLDivElement; private headBtns: HTMLDivElement;
  private tabsEl: HTMLDivElement; private empty: HTMLDivElement;
  private state: DomainState | null = null;
  private model: DomainModel | null = null;
  private world = new THREE.Group();
  private isles: Isle[] = []; private byId = new Map<string, Isle>();
  private lands: Land[] = []; private bridges: Bridge[] = []; private tethers: Tether[] = [];
  private groupLabels: { el: HTMLElement; p: THREE.Vector3 }[] = [];
  private clouds: THREE.Object3D[] = [];
  private fileIsles = new Map<string, Isle[]>();  // lowercased path -> isles whose code holds it
  private moduleIsles = new Map<number, Isle[]>(); // city module -> isles with files in it
  private driftBy = new Map<string, DriftFile>();
  private flowFx: FlowFx | null = null;
  private drones = new Map<string, Drone>();
  private sel: Sel = null; private hover: Isle | null = null; private hoverLand: Land | null = null;
  private focusSet: Set<Isle> | null = null; private focusOrder = new Map<Isle, number[]>();
  private tab: Tab = 'task';
  private draft = '';
  private visible = false; private span = 120; private fitted = false;
  private frame = { left: 0, top: 0, right: 800, bottom: 600 };
  private timer = 0; private offLive: () => void;
  private ray = new THREE.Raycaster(); private tmpV = new THREE.Vector3();

  constructor(parent: HTMLElement, private pid: string, private city: City, private host: DomainHost) {
    this.el = h('div', { class: 'domain' }) as HTMLDivElement;
    this.canvasBox = h('div', { class: 'dm-stage' }) as HTMLDivElement;
    this.labels = h('div', { class: 'dm-labels' }) as HTMLDivElement;
    this.tip = h('div', { class: 'dm-tip' }) as HTMLDivElement;
    this.empty = h('div', { class: 'dm-empty glass' }) as HTMLDivElement;
    this.headInfo = h('div', { class: 'dm-meta' }) as HTMLDivElement;
    this.headBtns = h('div', { class: 'dm-hbtns' }) as HTMLDivElement;
    this.tabsEl = h('div', { class: 'tabs' }) as HTMLDivElement;
    this.body = h('div', { class: 'dm-body' }) as HTMLDivElement;
    this.panel = h('div', { class: 'dm-panel glass' },
      h('div', { class: 'dm-head' }, h('div', { class: 'dm-title' }, 'Domain map'), this.headBtns), this.headInfo, this.tabsEl, this.body) as HTMLDivElement;
    this.el.append(this.canvasBox, this.labels, this.empty, this.panel, this.tip);
    parent.appendChild(this.el);

    this.stage = new Stage(this.canvasBox);
    this.dress();
    this.stage.scene.add(this.world);
    this.stage.onFrame(this.tick);
    const c = this.stage.renderer.domElement;
    c.addEventListener('stage-click', (e: any) => this.onClick(e.detail.x, e.detail.y));
    c.addEventListener('pointermove', this.onMove);
    c.addEventListener('pointerleave', () => { this.tip.style.opacity = '0'; this.setHover(null, null); });
    this.offLive = live.on(m => { if (m.type === 'domain' && m.pid === this.pid) this.load(!!m.changed); });
    // only the running clocks tick; a full re-render would take the caret out of the task box
    this.timer = window.setInterval(() => { for (const el of this.el.querySelectorAll<HTMLElement>('[data-since]')) el.textContent = dur(Date.now() - Number(el.dataset.since)); }, 1000);
    this.setVisible(false);
    this.load(true);
  }

  // ------------------------------------------------------------------ public
  setVisible(on: boolean) {
    this.visible = on;
    this.el.style.display = on ? '' : 'none';
    this.canvasBox.style.visibility = on ? '' : 'hidden';
    this.stage.hidden = !on;
    if (on) { this.stage.resize(); if (!this.fitted && this.isles.length) { this.fit(false); this.fitted = true; } }
  }
  // The part of the screen not covered by the city view's panels, in client coordinates.
  setFrame(r: { left: number; top: number; right: number; bottom: number }) {
    this.frame = r;
    const box = this.el.getBoundingClientRect();
    Object.assign(this.panel.style, { left: `${r.left - box.left + 14}px`, top: `${r.top - box.top + 14}px`, bottom: `${box.bottom - r.bottom + 14}px` });
    const pw = this.panel.offsetWidth || 340;
    Object.assign(this.empty.style, { left: `${(r.left + pw + 28 + r.right) / 2 - box.left}px`, top: `${(r.top + r.bottom) / 2 - box.top}px` });
  }
  // The whole archipelago in the open part of the screen: right of the panel, inside the frame.
  // How much of the frame's left the panel takes (0 while there is nothing to show in it).
  panelWidth() { return this.panel.style.display === 'none' ? 0 : (this.panel.offsetWidth || 340) + 14; }
  fit(animate = true) {
    if (!this.isles.length) return;
    const b = new THREE.Box3();
    for (const s of this.isles) b.expandByPoint(new THREE.Vector3(s.x - s.r, 0, s.z - s.r)).expandByPoint(new THREE.Vector3(s.x + s.r, 0, s.z + s.r));
    this.home(this.frameBox(b), animate);
  }
  // Where the camera looks so that box b (on the ground plan) fills the open part of the screen.
  private frameBox(b: THREE.Box3) {
    const c = b.getCenter(new THREE.Vector3()), size = b.getSize(new THREE.Vector3()), ext = Math.max(size.x, size.z);
    const st = this.stage, cb = this.canvasBox.getBoundingClientRect(), pr = this.panel.getBoundingClientRect();
    const left = Math.max(this.frame.left, this.panel.style.display === 'none' ? 0 : pr.right) + 10, right = this.frame.right - 10;
    const openW = Math.max(240, right - left), openH = Math.max(240, this.frame.bottom - this.frame.top - 20);
    const v = Math.max((ext * 0.75 + 24) * cb.height / openH, (ext * 0.95 + 20) * cb.height / openW);
    // aim at the isles, which float ISLE_Y over the ground: the ground point behind them on the line of sight
    const az = st.goal.azimuth, el = st.goal.elevation, back = ISLE_Y * 0.6 / Math.tan(el);
    let tx = c.x - back * Math.cos(az), tz = c.z - back * Math.sin(az);
    // then slide the view, as a drag would, so that point sits mid-way in the open area
    const ox = (left + right) / 2 - (cb.left + cb.width / 2), oy = (this.frame.top + this.frame.bottom) / 2 - (cb.top + cb.height / 2);
    const unit = v / cb.height, lift = unit / Math.sin(el);
    tx += -ox * unit * Math.sin(az) - oy * lift * Math.cos(az);
    tz += ox * unit * Math.cos(az) - oy * lift * Math.sin(az);
    return { x: tx, z: tz, viewSize: v };
  }
  private home(to: { x: number; z: number; viewSize: number }, animate: boolean) {
    const st = this.stage;
    st.home = to;
    if (animate) st.flyTo(to.x, to.z, to.viewSize); else { st.target.set(to.x, 0, to.z); Object.assign(st.goal, { x: to.x, z: to.z }); st.viewSize = to.viewSize; st.updateCamera(); }
  }
  // Sessions at work now: [tt, ti] of the place each is on (0 file, 1 module), in its colour.
  setActive(list: { tt: number; ti: number; color: string }[]) {
    const now = performance.now();
    for (const w of list) {
      let isle: Isle | null = null, house = -1;
      if (w.tt === 0) {
        const f = this.city.files[w.ti];
        const cand = f ? this.fileIsles.get(f.p.toLowerCase()) : null;
        if (cand?.length) { isle = cand[0]; house = isle.houses.findIndex(x => x.p.toLowerCase() === f!.p.toLowerCase()); }
        else if (f) isle = this.moduleIsles.get(f.m)?.[0] || null;
      } else if (w.tt === 1) isle = this.moduleIsles.get(w.ti)?.[0] || null;
      let d = this.drones.get(w.color);
      if (!d) { d = this.makeDrone(w.color); this.drones.set(w.color, d); }
      d.isle = isle; d.house = house; d.seen = now;
    }
  }
  // The city was rebuilt (new files): re-tie the isles to it.
  setCity(c: City) {
    this.city = c;
    if (this.model) { this.buildScene(); this.applyFocus(); }
  }
  dispose() {
    clearInterval(this.timer);
    this.offLive();
    this.clear();
    this.stage.dispose();
    this.el.remove();
  }

  // ------------------------------------------------------------------ data
  private busy() { return this.state?.job?.state === 'working' || !!this.state?.briefs.some(b => b.state === 'working'); }
  private async load(rebuild: boolean) {
    let st: DomainState;
    try { st = await api.domain(this.pid); } catch (e: any) { this.empty.style.display = ''; fill(this.empty, h('div', { class: 'dm-err' }, 'Could not load the domain map: ' + e.message)); return; }
    const fresh = rebuild || JSON.stringify(st.model) !== JSON.stringify(this.model);
    this.state = st;
    this.driftBy = new Map(st.drift.map(d => [d.p.toLowerCase(), d]));
    if (fresh) {
      this.model = st.model;
      this.buildScene();
      if (this.visible && this.isles.length) { this.fit(this.fitted); this.fitted = true; }
    }
    if (this.sel?.k === 'brief' && !st.briefs.some(b => b.id === (this.sel as any).id)) this.sel = null;
    this.applyFocus();
    this.renderPanel();
  }

  // ------------------------------------------------------------------ scene
  private dress() {
    const s = this.stage.scene;
    s.background = SKY.clone();
    s.fog = new THREE.Fog(SKY.clone(), 300, 600);
    this.stage.bloom.enabled = false;
    this.stage.renderer.toneMappingExposure = 1;
    s.traverse(o => {
      if (o instanceof THREE.HemisphereLight) { o.color.set('#ffffff'); o.groundColor.set('#b9b2a4'); o.intensity = 1.25; }
      if (o instanceof THREE.DirectionalLight) { o.color.set('#fff4e4'); o.intensity = 1.9; o.position.set(-50, 140, 70); }
    });
  }

  private clear() {
    const dispose = (o: THREE.Object3D) => o.traverse(x => {
      const m = x as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = (m as any).material; if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((y: THREE.Material) => y.dispose());
    });
    for (const c of [...this.world.children]) { dispose(c); this.world.remove(c); }
    for (const d of this.drones.values()) { dispose(d.g); dispose(d.beam); }
    this.drones.clear();
    this.clearFlow();
    this.isles = []; this.byId.clear(); this.lands = []; this.bridges = []; this.tethers = []; this.groupLabels = []; this.clouds = [];
    this.fileIsles.clear(); this.moduleIsles.clear();
    this.labels.innerHTML = '';
  }

  private buildScene() {
    this.clear();
    const m = this.model;
    this.empty.style.display = m ? 'none' : '';
    if (!m) return;
    const pos = layout(m);
    const gIdx = new Map(m.groups.map((g, i) => [g.id, i]));
    const fileOf = new Map(this.city.files.map(f => [f.p.toLowerCase(), f]));
    m.entities.forEach((e, i) => {
      const p = pos.get(e.id)!;
      const gi = gIdx.get(e.group) ?? 0;
      const hue = GRASS_HUES[gi % GRASS_HUES.length];
      const strain = e.code.reduce((s, c) => s + (this.driftBy.get(c.p.toLowerCase())?.score || 0), 0);
      const isle = this.makeIsle(e, i, p.x, p.z, p.r, hue, strain, fileOf);
      this.isles.push(isle); this.byId.set(e.id, isle);
      for (const c of e.code) {
        const k = c.p.toLowerCase();
        if (!this.fileIsles.has(k)) this.fileIsles.set(k, []);
        this.fileIsles.get(k)!.push(isle);
        const f = fileOf.get(k);
        if (f) { if (!this.moduleIsles.has(f.m)) this.moduleIsles.set(f.m, []); const l = this.moduleIsles.get(f.m)!; if (!l.includes(isle)) l.push(isle); }
      }
    });
    // drift assumptions raise the flag on the isles they name
    for (const a of m.assumptions) if (!a.holds && a.severity !== 'low') for (const id of a.entities) { const s = this.byId.get(id); if (s && !s.flag) this.raiseFlag(s); }
    for (const s of this.isles) if (!s.flag && s.strain >= STRAIN_FLAG) this.raiseFlag(s);
    for (const r of m.relations) {
      const a = this.byId.get(r.a), b = this.byId.get(r.b);
      if (a && b) this.bridges.push(this.makeBridge(a, b, r.verb));
    }
    // archipelago names over each group
    for (const g of m.groups) {
      const members = this.isles.filter(s => s.e.group === g.id);
      if (!members.length) continue;
      const c = new THREE.Vector3();
      for (const s of members) c.add(new THREE.Vector3(s.x, 0, s.z));
      c.divideScalar(members.length);
      let top = -Infinity; for (const s of members) top = Math.max(top, s.z - s.r);
      const el = h('div', { class: 'dm-lb dm-group', title: g.what }, g.name);
      this.labels.append(el);
      this.groupLabels.push({ el, p: new THREE.Vector3(c.x, ISLE_Y + 12, Math.min(c.z, top)) });
    }
    this.makeGround(m);
    this.makeClouds();
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const s of this.isles) { x0 = Math.min(x0, s.x - s.r); x1 = Math.max(x1, s.x + s.r); z0 = Math.min(z0, s.z - s.r); z1 = Math.max(z1, s.z + s.r); }
    this.span = Math.max(x1 - x0, z1 - z0, 60);
    this.stage.fitShadow(this.span * 1.3, this.span * 1.3);
  }

  private makeIsle(e: DEntity, i: number, x: number, z: number, r: number, hue: number, strain: number, fileOf: Map<string, City['files'][number]>): Isle {
    const rnd = rng(hashStr(e.id));
    const ghost = e.status === 'missing';
    const g = new THREE.Group();
    const y = ISLE_Y + (rnd() - 0.5) * 5;
    g.position.set(x, y, z);
    const grass = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(hue / 360, 0.38, 0.56), roughness: 1, flatShading: true });
    const dirt = new THREE.MeshStandardMaterial({ color: '#9c8466', roughness: 1, flatShading: true });
    const rock = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true });
    const wall = new THREE.MeshStandardMaterial({ color: '#f5f3ef', roughness: 0.85 });
    const roof = new THREE.MeshStandardMaterial({ color: '#2e2e2e', roughness: 0.8 });
    const glass = new THREE.MeshStandardMaterial({ color: '#c9d4db', roughness: 0.3, metalness: 0.1 });
    const tree = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(hue / 360, 0.35, 0.32), roughness: 1, flatShading: true });
    const mats: THREE.Material[] = [grass, dirt, rock, wall, roof, glass, tree];
    if (ghost) for (const mt of mats) Object.assign(mt, { transparent: true, opacity: 0.28, depthWrite: false });
    // the top: an irregular disc of turf
    const outline: THREE.Vector2[] = [];
    const N = 18, ph = rnd() * 6;
    for (let k = 0; k < N; k++) {
      const a = k / N * Math.PI * 2, rr = r * (0.88 + 0.1 * Math.sin(a * 3 + ph) + 0.08 * (rnd() - 0.5));
      outline.push(new THREE.Vector2(Math.cos(a) * rr, Math.sin(a) * rr));
    }
    const topG = new THREE.ExtrudeGeometry(new THREE.Shape(outline), { depth: 1.4, bevelEnabled: true, bevelThickness: 0.3, bevelSize: 0.35, bevelSegments: 1, curveSegments: 1 });
    topG.rotateX(-Math.PI / 2); topG.translate(0, -1.4, 0);
    const top = new THREE.Mesh(topG, [grass, dirt]);
    top.castShadow = top.receiveShadow = true;
    g.add(top);
    // the rock underneath, an upturned jagged cone, lighter at the top
    const depth = r * 1.15 + 3;
    const rockG = new THREE.ConeGeometry(r * 0.96, depth, 11, 4);
    rockG.rotateX(Math.PI); rockG.translate(0, -depth / 2 - 1.2, 0);
    const pa = rockG.attributes.position as THREE.BufferAttribute;
    const cols = new Float32Array(pa.count * 3), hi = new THREE.Color('#b9ab94'), lo = new THREE.Color('#6d6255'), cc = new THREE.Color();
    for (let k = 0; k < pa.count; k++) {
      const vx = pa.getX(k), vy = pa.getY(k), vz = pa.getZ(k);
      const n = hashStr(`${e.id}${vx.toFixed(2)},${vy.toFixed(2)},${vz.toFixed(2)}`) / 4294967296;
      const t = (-1.2 - vy) / depth; // 0 at the top, 1 at the tip
      const s = t > 0.02 && t < 0.98 ? 0.82 + n * 0.32 : 1;
      pa.setXYZ(k, vx * s, vy + (t > 0.02 && t < 0.98 ? (n - 0.5) * 1.2 : 0), vz * s);
      cc.copy(hi).lerp(lo, Math.min(1, t * 1.1 + (n - 0.5) * 0.15));
      cols[k * 3] = cc.r; cols[k * 3 + 1] = cc.g; cols[k * 3 + 2] = cc.b;
    }
    rockG.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    rockG.computeVertexNormals();
    const rockM = new THREE.Mesh(rockG, rock);
    rockM.castShadow = true;
    g.add(rockM);
    // the code that implements it, as buildings
    const houses: Isle['houses'] = [];
    const code = ghost ? [] : e.code;
    let tall = 0;
    code.forEach((c, k) => {
      const f = fileOf.get(c.p.toLowerCase());
      const kb = f ? f.size / 1024 : 4;
      const hgt = Math.min(7, 1.2 + Math.log2(kb + 1) * 0.75);
      const w = 1.3 + Math.min(0.9, kb / 80);
      const a = k * 2.399 + ph, rr = r * 0.6 * Math.sqrt((k + 0.6) / Math.max(code.length, 1));
      const b = building(c.does, w, hgt, wall, roof, glass);
      b.position.set(Math.cos(a) * rr, 0, Math.sin(a) * rr);
      b.rotation.y = -a;
      g.add(b);
      houses.push({ mesh: b, p: c.p, top: hgt });
      tall = Math.max(tall, hgt);
    });
    // a few trees on the rim
    if (!ghost) {
      const nT = 2 + Math.floor(rnd() * Math.min(6, r / 1.5));
      for (let k = 0; k < nT; k++) {
        const a = rnd() * Math.PI * 2, rr = r * (0.7 + rnd() * 0.15);
        const tr = new THREE.Mesh(new THREE.ConeGeometry(0.55 + rnd() * 0.3, 1.6 + rnd() * 1.2, 6), tree);
        tr.position.set(Math.cos(a) * rr, 0.9, Math.sin(a) * rr); tr.castShadow = true;
        g.add(tr);
      }
    }
    const debris: THREE.Object3D[] = [];
    if (e.status === 'shaky') {
      // cracks across the turf and rocks breaking away underneath
      const pts: number[] = [];
      for (let c = 0; c < 2; c++) {
        let a = rnd() * Math.PI * 2, px = Math.cos(a) * r * 0.9, pz = Math.sin(a) * r * 0.9;
        for (let s = 0; s < 6; s++) {
          const nx = px * 0.72 + (rnd() - 0.5) * r * 0.35, nz = pz * 0.72 + (rnd() - 0.5) * r * 0.35;
          pts.push(px, 0.06, pz, nx, 0.06, nz); px = nx; pz = nz;
        }
      }
      const cg = new THREE.BufferGeometry(); cg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const crackM = new THREE.LineBasicMaterial({ color: '#2a211b' });
      mats.push(crackM);
      g.add(new THREE.LineSegments(cg, crackM));
      for (let k = 0; k < 3; k++) {
        const d = new THREE.Mesh(new THREE.DodecahedronGeometry(0.5 + rnd() * 0.7, 0), rock);
        const a = rnd() * Math.PI * 2;
        d.position.set(Math.cos(a) * r * 0.7, -depth * (0.35 + rnd() * 0.4), Math.sin(a) * r * 0.7);
        d.userData.y0 = d.position.y; d.userData.ph = rnd() * 6;
        g.add(d); debris.push(d);
      }
    }
    if (e.status === 'partial') {
      // scaffolding where the rest still has to go
      const a = ph + Math.PI, sx = Math.cos(a) * r * 0.45, sz = Math.sin(a) * r * 0.45;
      const sg = new THREE.EdgesGeometry(new THREE.BoxGeometry(2.6, 3.6, 2.6, 2, 3, 2));
      sg.translate(sx, 1.8, sz);
      const scM = new THREE.LineBasicMaterial({ color: '#555555' });
      mats.push(scM);
      g.add(new THREE.LineSegments(sg, scM));
    }
    if (ghost) {
      const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(outline.map(p => new THREE.Vector3(p.x, 0.1, -p.y))),
        new THREE.LineDashedMaterial({ color: '#333333', dashSize: 0.8, gapSize: 0.6, transparent: true }));
      ring.computeLineDistances();
      mats.push(ring.material as THREE.Material);
      g.add(ring);
    }
    g.traverse(o => { o.userData.isle = i; });
    this.world.add(g);
    const dot = h('i', { class: 'st st-' + e.status });
    const label = h('div', { class: 'dm-lb dm-isle' + (e.status === 'missing' ? ' ghost' : '') }, dot, e.name);
    this.labels.append(label);
    return { e, i, x, z, y, r, depth, g, mats, base: mats.map(mt => mt.opacity), strain, flag: null, houses, debris, label, hue, tall };
  }

  private raiseFlag(s: Isle) {
    const f = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 5, 5), new THREE.MeshStandardMaterial({ color: '#333333' }));
    pole.position.y = 2.5;
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.1), new THREE.MeshBasicMaterial({ color: RED, side: THREE.DoubleSide, toneMapped: false, fog: false }));
    cloth.position.set(0.9, 4.4, 0);
    f.add(pole, cloth);
    const a = hashStr(s.e.id + 'flag') / 4294967296 * Math.PI * 2;
    f.position.set(Math.cos(a) * s.r * 0.78, 0, Math.sin(a) * s.r * 0.78);
    f.userData.cloth = cloth;
    f.traverse(o => { o.userData.isle = s.i; });
    s.g.add(f);
    s.mats.push(pole.material as THREE.Material, cloth.material as THREE.Material);
    s.base.push(1, 1);
    s.flag = f;
    s.label.classList.add('drift');
  }

  private makeBridge(a: Isle, b: Isle, verb: string): Bridge {
    const pa = new THREE.Vector3(a.x, a.y, a.z), pb = new THREE.Vector3(b.x, b.y, b.z);
    const dir = pb.clone().sub(pa).setY(0).normalize();
    const p0 = pa.clone().addScaledVector(dir, a.r * 0.85).setY(a.y + 0.1), p1 = pb.clone().addScaledVector(dir, -b.r * 0.85).setY(b.y + 0.1);
    const d = p0.distanceTo(p1);
    const mid = p0.clone().lerp(p1, 0.5); mid.y = Math.min(p0.y, p1.y) - 1 - d * 0.07;
    const pts: number[] = [];
    for (let k = 0; k <= 20; k++) {
      const t = k / 20, u = 1 - t;
      pts.push(u * u * p0.x + 2 * u * t * mid.x + t * t * p1.x, u * u * p0.y + 2 * u * t * mid.y + t * t * p1.y, u * u * p0.z + 2 * u * t * mid.z + t * t * p1.z);
    }
    const geo = new LineGeometry(); geo.setPositions(pts);
    const mat = new LineMaterial({ color: 0x6d5d4b, linewidth: 2.2, transparent: true, opacity: 1 });
    const line = new Line2(geo, mat);
    line.computeLineDistances();
    this.world.add(line);
    const label = h('div', { class: 'dm-lb dm-verb' }, verb);
    this.labels.append(label);
    const m3 = new THREE.Vector3(pts[30], pts[31], pts[32]);
    return { a, b, verb, line, mat, mid: m3, label };
  }

  private makeGround(m: DomainModel) {
    // the real world, far below: a field with a landmark for each real thing
    let cx = 0, cz = 0;
    for (const s of this.isles) { cx += s.x; cz += s.z; }
    cx /= Math.max(1, this.isles.length); cz /= Math.max(1, this.isles.length);
    let R = 30; for (const s of this.isles) R = Math.max(R, Math.hypot(s.x - cx, s.z - cz) + s.r);
    const field = new THREE.Mesh(new THREE.CircleGeometry(R * 1.45, 72), new THREE.MeshStandardMaterial({ color: '#d3dbc8', roughness: 1 }));
    field.rotation.x = -Math.PI / 2; field.position.set(cx, -0.05, cz); field.receiveShadow = true;
    this.world.add(field);
    const rim = new THREE.Mesh(new THREE.RingGeometry(R * 1.45, R * 1.47, 72), new THREE.MeshBasicMaterial({ color: '#9aa391', toneMapped: false }));
    rim.rotation.x = -Math.PI / 2; rim.position.set(cx, 0, cz);
    this.world.add(rim);
    const realL = h('div', { class: 'dm-lb dm-real' }, 'The real world');
    this.labels.append(realL);
    this.groupLabels.push({ el: realL, p: new THREE.Vector3(cx, 0, cz + R * 1.38) });
    // the real things stand around the archipelago, each on the side of the isles that stand for it,
    // spread along the ring so none sits under an isle or on top of another
    const ringR = R * 1.18, minGap = 14 / ringR;
    const want = m.world.map((w, k) => {
      const users = this.isles.filter(s => s.e.world.includes(w.id));
      const ux = users.reduce((s, u) => s + u.x, 0) / (users.length || 1), uz = users.reduce((s, u) => s + u.z, 0) / (users.length || 1);
      const a = users.length && Math.hypot(ux - cx, uz - cz) > 1 ? Math.atan2(uz - cz, ux - cx) : k / Math.max(1, m.world.length) * Math.PI * 2;
      return { w, k, a, users };
    }).sort((p, q) => p.a - q.a);
    for (let it = 0; it < 80; it++) {
      let moved = false;
      for (let j = 0; j < want.length && want.length > 1; j++) {
        const p = want[j], q = want[(j + 1) % want.length];
        let gap = q.a - p.a; if (j === want.length - 1) gap += Math.PI * 2;
        if (gap < minGap) { const d = (minGap - gap) / 2; p.a -= d; q.a += d; moved = true; }
      }
      if (!moved) break;
    }
    for (const { w, a, users } of want) {
      const x = cx + Math.cos(a) * ringR, z = cz + Math.sin(a) * ringR;
      const g = landmark(w.kind);
      g.position.set(x, 0, z);
      const mats: THREE.Material[] = [], li = this.lands.length;
      g.traverse(o => { o.userData.land = li; const mt = (o as THREE.Mesh).material as THREE.Material | undefined; if (mt) mats.push(mt); o.castShadow = true; });
      this.world.add(g);
      const label = h('div', { class: 'dm-lb dm-world' }, w.name);
      this.labels.append(label);
      const land: Land = { w, x, z, g, label, mats };
      this.lands.push(land);
      for (const s of users) {
        const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(s.x, s.y - s.depth - 1, s.z), new THREE.Vector3(x, 3.2, z)]);
        const mat = new THREE.LineDashedMaterial({ color: '#6a6a6a', dashSize: 1.1, gapSize: 0.9, transparent: true, opacity: TETHER });
        const line = new THREE.Line(lg, mat); line.computeLineDistances();
        this.world.add(line);
        this.tethers.push({ isle: s, land, line, mat });
      }
    }
  }

  private makeClouds() {
    const rnd = rng(hashStr(this.pid + 'clouds'));
    const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, transparent: true, opacity: 0.9 });
    const n = Math.round(6 + this.isles.length / 3);
    let cx = 0, cz = 0; for (const s of this.isles) { cx += s.x; cz += s.z; } cx /= Math.max(1, this.isles.length); cz /= Math.max(1, this.isles.length);
    for (let k = 0; k < n; k++) {
      const c = new THREE.Group();
      const parts = 3 + Math.floor(rnd() * 4);
      for (let p = 0; p < parts; p++) {
        const s = new THREE.Mesh(new THREE.SphereGeometry(1.4 + rnd() * 1.6, 9, 7), mat);
        s.position.set(p * 1.7 - parts * 0.8, rnd() * 0.8, (rnd() - 0.5) * 1.6); s.scale.y = 0.6;
        c.add(s);
      }
      c.position.set(cx + (rnd() - 0.5) * this.spanGuess() * 1.6, 5 + rnd() * 6, cz + (rnd() - 0.5) * this.spanGuess() * 1.6);
      c.userData.v = 0.6 + rnd() * 0.8; c.userData.x0 = cx;
      this.world.add(c); this.clouds.push(c);
    }
  }
  private spanGuess() { let m = 40; for (const s of this.isles) m = Math.max(m, Math.abs(s.x) + s.r, Math.abs(s.z) + s.r); return m * 2; }

  private makeDrone(color: string): Drone {
    const g = new THREE.Group();
    const c = new THREE.Color(color);
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.75, 14, 10), new THREE.MeshBasicMaterial({ color: c, toneMapped: false, fog: false }));
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.35, 0.12, 6, 24), new THREE.MeshBasicMaterial({ color: '#1a1a1a', toneMapped: false, fog: false }));
    ring.rotation.x = Math.PI / 2;
    g.add(body, ring);
    const beam = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: c, toneMapped: false, fog: false }));
    beam.frustumCulled = false;
    this.world.add(g, beam);
    return { g, beam, color, isle: null, house: -1, seen: 0, phase: (hashStr(color) % 628) / 100 };
  }

  // ------------------------------------------------------------------ frame
  private tick = (dt: number, t: number) => {
    if (!this.visible) return;
    for (const s of this.isles) {
      s.g.position.y = s.y + Math.sin(t * 0.5 + s.i * 1.7) * 0.25;
      for (const d of s.debris) d.position.y = d.userData.y0 + Math.sin(t * 0.8 + d.userData.ph) * 0.4 - ((t * 0.6 + d.userData.ph) % 3) * 0.3;
      if (s.flag) s.flag.userData.cloth.rotation.y = Math.sin(t * 2.4 + s.i) * 0.35;
    }
    for (const c of this.clouds) { c.position.x += c.userData.v * dt; if (c.position.x > c.userData.x0 + this.span) c.position.x -= this.span * 2; }
    if (this.flowFx) this.walkFlow(dt);
    const now = performance.now();
    for (const [k, d] of this.drones) {
      const on = d.isle && now - d.seen < 1500;
      d.g.visible = d.beam.visible = !!on;
      if (!on) { if (now - d.seen > 60e3) { this.world.remove(d.g, d.beam); this.drones.delete(k); } continue; }
      const s = d.isle!, a = t * 0.9 + d.phase;
      d.g.position.set(s.x + Math.cos(a) * s.r * 0.45, s.g.position.y + Math.max(7, s.tall + 4) + Math.sin(t * 2 + d.phase) * 0.4, s.z + Math.sin(a) * s.r * 0.45);
      const hs = s.houses[d.house];
      const to = hs ? hs.mesh.getWorldPosition(this.tmpV).setY(s.g.position.y + hs.top) : this.tmpV.set(s.x, s.g.position.y, s.z);
      const pa = d.beam.geometry.attributes.position as THREE.BufferAttribute;
      pa.setXYZ(0, d.g.position.x, d.g.position.y, d.g.position.z); pa.setXYZ(1, to.x, to.y, to.z); pa.needsUpdate = true;
    }
    this.placeLabels();
  };

  private placeLabels() {
    const box = this.el.getBoundingClientRect(), cb = this.canvasBox.getBoundingClientRect();
    const ox = cb.left - box.left, oy = cb.top - box.top;
    const taken: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const panel = this.panel.getBoundingClientRect();
    const blocked = (x0: number, y0: number, x1: number, y1: number) =>
      (x1 + box.left > panel.left && x0 + box.left < panel.right && y1 + box.top > panel.top && y0 + box.top < panel.bottom)
      || taken.some(r => x1 > r.x0 && x0 < r.x1 && y1 > r.y0 && y0 < r.y1);
    const out = { x: 0, y: 0, visible: false };
    const place = (el: HTMLElement, p: THREE.Vector3, force: boolean, show = true, below = false) => {
      if (!show) { el.style.display = 'none'; return; }
      this.stage.project(p, out);
      // sizes are measured once, while shown: a hidden label measures 0
      const box2 = el as HTMLElement & { _w?: number; _h?: number };
      if (!box2._w) { el.style.display = ''; box2._w = el.offsetWidth; box2._h = el.offsetHeight; }
      const w = box2._w || 80, hh = box2._h || 18;
      const x = out.x + ox - w / 2, y = below ? out.y + oy + 12 : out.y + oy - hh;
      if (!out.visible || (!force && blocked(x, y, x + w, y + hh))) { el.style.display = 'none'; return; }
      el.style.display = '';
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      taken.push({ x0: x - 2, y0: y - 2, x1: x + w + 2, y1: y + hh + 2 });
    };
    const zoomed = this.stage.viewSize < 110;
    // a playing flow first: its caption, start and end, the step numbers
    const fx = this.flowFx;
    if (fx) {
      place(fx.caption, fx.courier.position, true, true, true);
      for (const el of fx.pins) place(el, (el as any)._p, true);
      for (const n of fx.nums) place(n.el, (n.el as any)._p, true);
    }
    // most important first: what is selected or in focus, then the busiest isles
    const order = [...this.isles].sort((a, b) => this.rank(b) - this.rank(a));
    for (const s of order) place(s.label, this.tmpV.set(s.x, s.g.position.y + s.tall + 1.6, s.z), this.isFocus(s) && !!this.focusSet);
    for (const g of this.groupLabels) place(g.el, g.p, false, !zoomed || g.el.classList.contains('dm-real'));
    for (const l of this.lands) place(l.label, this.tmpV.set(l.x, 3.8, l.z), false, !this.focusSet || this.landInFocus(l));
    for (const b of this.bridges) {
      const show = (this.hover && (b.a === this.hover || b.b === this.hover)) || (this.focusSet && this.focusSet.has(b.a) && this.focusSet.has(b.b)) || (zoomed && !this.focusSet);
      place(b.label, b.mid, false, !!show);
    }
  }
  private rank(s: Isle) { return (this.isFocus(s) && this.focusSet ? 1000 : 0) + (this.hover === s ? 2000 : 0) + s.e.code.length + this.bridges.filter(b => b.a === s || b.b === s).length * 2; }
  private isFocus(s: Isle) { return !this.focusSet || this.focusSet.has(s); }
  private landInFocus(l: Land) { return this.tethers.some(t => t.land === l && this.focusSet!.has(t.isle)); }

  // ------------------------------------------------------------------ picking
  private pick(x: number, y: number): { isle: Isle | null; house: string | null; land: Land | null } {
    const r = this.stage.renderer.domElement.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2((x - r.left) / r.width * 2 - 1, -(y - r.top) / r.height * 2 + 1), this.stage.camera);
    const hits = this.ray.intersectObjects(this.world.children, true);
    for (const hgt of hits) {
      let o: THREE.Object3D | null = hgt.object, house: string | null = null;
      if (!(o as THREE.Mesh).isMesh) continue;
      while (o) {
        if (o.userData.file) house = o.userData.file;
        if (o.userData.isle != null) return { isle: this.isles[o.userData.isle], house, land: null };
        if (o.userData.land != null) return { isle: null, house: null, land: this.lands[o.userData.land] };
        o = o.parent;
      }
    }
    return { isle: null, house: null, land: null };
  }
  private onMove = (ev: PointerEvent) => {
    if (ev.buttons) return;
    const p = this.pick(ev.clientX, ev.clientY);
    this.setHover(p.isle, p.land);
    const box = this.el.getBoundingClientRect();
    let html: HTMLElement | null = null;
    if (p.isle) {
      const e = p.isle.e, c = p.house ? e.code.find(x => x.p === p.house) : null;
      html = c ? h('div', {}, h('b', { class: 'mono' }, c.p.split('/').pop()), h('div', {}, `${DOES[c.does]} ${e.name}${c.note ? ' · ' + c.note : ''}`), h('div', { class: 'dim' }, 'Click to open in Inspect'))
        : h('div', {}, h('b', {}, e.name), h('span', { class: 'pill st-' + e.status }, STATUS[e.status]), h('div', {}, e.what), e.real ? h('div', { class: 'dim' }, 'Real world: ' + e.real) : null);
    } else if (p.land) html = h('div', {}, h('b', {}, p.land.w.name), h('div', {}, p.land.w.what));
    this.stage.renderer.domElement.style.cursor = p.isle || p.land ? 'pointer' : '';
    if (!html) { this.tip.style.opacity = '0'; return; }
    fill(this.tip, html);
    Object.assign(this.tip.style, { opacity: '1', left: `${ev.clientX - box.left + 14}px`, top: `${ev.clientY - box.top + 14}px` });
  };
  private setHover(s: Isle | null, l: Land | null) {
    if (s === this.hover && l === this.hoverLand) return;
    this.hover = s; this.hoverLand = l;
    for (const b of this.bridges) b.mat.linewidth = s && (b.a === s || b.b === s) ? 3.6 : 2.2;
  }
  private onClick(x: number, y: number) {
    const p = this.pick(x, y);
    if (p.house) { this.host.onFile(p.house); }
    if (p.isle) this.select({ k: 'entity', id: p.isle.e.id }, !p.house);
    else if (p.land) this.select({ k: 'world', id: p.land.w.id });
    else if (this.sel?.k === 'entity' || this.sel?.k === 'world') this.select(null);
  }

  // ------------------------------------------------------------------ focus
  private select(s: Sel, fly = false) {
    this.sel = s;
    this.applyFocus();
    this.renderPanel();
    if (fly && s?.k === 'entity') { const i = this.byId.get(s.id); if (i) this.stage.flyTo(i.x, i.z, Math.min(this.stage.viewSize, 90)); }
    // a flow's start and end may sit on the ground ring: keep them in the frame
    if (fly && this.focusSet && s?.k !== 'entity') this.flyToSet([...this.focusSet], s?.k === 'flow' && this.flowFx ? this.flowFx.stations.filter(x => !x.isle).map(x => x.p) : []);
  }
  private flyToSet(list: Isle[], extra: THREE.Vector3[] = []) {
    if (!list.length) return;
    const b = new THREE.Box3();
    for (const s of list) b.expandByPoint(new THREE.Vector3(s.x - s.r, 0, s.z - s.r)).expandByPoint(new THREE.Vector3(s.x + s.r, 0, s.z + s.r));
    // frameBox aims at the height of the isles; a point on the ground shows up nearer the camera, so move it out by as much
    const az = this.stage.goal.azimuth, back = ISLE_Y * 0.6 / Math.tan(this.stage.goal.elevation);
    for (const p of extra) {
      const gx = p.x + back * Math.cos(az), gz = p.z + back * Math.sin(az);
      // wide enough for the pin's label, centred on the point
      b.expandByPoint(new THREE.Vector3(gx - 46, 0, gz - 46)).expandByPoint(new THREE.Vector3(gx + 46, 0, gz + 46));
    }
    const to = this.frameBox(b);
    this.stage.flyTo(to.x, to.z, Math.max(50, to.viewSize));
  }
  // What the selection lights up; everything else fades back.
  private applyFocus() {
    const m = this.model, s = this.sel;
    // a reload while the same flow plays keeps its place
    const keep = this.flowFx && s?.k === 'flow' && this.flowFx.f.id === s.id ? { t: this.flowFx.t, playing: this.flowFx.playing } : null;
    this.clearFlow();
    this.focusOrder.clear();
    let ids: string[] | null = null;
    if (m && s) {
      if (s.k === 'entity') ids = [s.id, ...m.relations.filter(r => r.a === s.id || r.b === s.id).map(r => r.a === s.id ? r.b : r.a)];
      else if (s.k === 'world') ids = m.entities.filter(e => e.world.includes(s.id)).map(e => e.id);
      else if (s.k === 'assumption') ids = m.assumptions.find(a => a.id === s.id)?.entities || [];
      else if (s.k === 'flow') {
        const f = m.flows.find(x => x.id === s.id);
        if (f) { ids = f.steps.map(x => x.e); this.showFlow(f, keep); }
      } else if (s.k === 'brief') {
        const b = this.state?.briefs.find(x => x.id === s.id)?.result;
        if (b) { ids = b.entities; b.entities.forEach((id, k) => { const i = this.byId.get(id); if (i) this.focusOrder.set(i, [k + 1]); }); }
      }
    }
    this.focusSet = ids ? new Set(ids.map(id => this.byId.get(id)).filter(Boolean) as Isle[]) : null;
    if (this.focusSet && !this.focusSet.size) this.focusSet = null;
    const fs = this.focusSet;
    const focusId = s?.k === 'entity' ? this.byId.get(s.id) : null;
    for (const i of this.isles) {
      const on = !fs || fs.has(i);
      i.mats.forEach((mt, k) => fade(mt, on ? i.base[k] : i.base[k] * 0.16));
      i.label.classList.toggle('faded', !on);
      i.label.classList.toggle('sel', i === focusId);
      const n = this.focusOrder.get(i);
      i.label.dataset.n = n ? n.join('·') : '';
      delete (i.label as any)._w; // the number badge and bold change its width
    }
    for (const b of this.bridges) {
      const on = !fs || (fs.has(b.a) && fs.has(b.b));
      b.mat.opacity = on ? 1 : 0.12;
      b.mat.color.set(fs && on ? 0x1a1a1a : 0x6d5d4b);
    }
    // ties to the ground stay faint until something is in focus, or they cross the whole map
    for (const t of this.tethers) t.mat.opacity = !fs ? TETHER : fs.has(t.isle) ? (s?.k !== 'world' || t.land.w.id === s.id ? 0.8 : 0.3) : 0.04;
    const ends = this.flowFx ? [this.flowFx.f.start?.world, this.flowFx.f.end?.world] : [];
    for (const l of this.lands) { const on = !fs || this.landInFocus(l) || (s?.k === 'world' && s.id === l.w.id) || ends.includes(l.w.id); l.mats.forEach(mt => fade(mt, on ? 1 : 0.2)); }
  }

  private flowWho(f: DFlow) { return this.model?.world.find(w => w.id === f.start?.world)?.name || ''; }
  private flowOutcome(f: DFlow) { return f.end?.outcome || f.steps[f.steps.length - 1]?.do || ''; }
  // Lay the flow out as stations along one arc: from the real world up to the first isle,
  // isle to isle, and down to where the result lands. Each step's files get a beam.
  private showFlow(f: DFlow, keep: { t: number; playing: boolean } | null) {
    const n = f.steps.length;
    const landOf = (id?: string | null) => id ? this.lands.find(l => l.w.id === id) || null : null;
    const sl = landOf(f.start?.world), el = landOf(f.end?.world);
    const stations: Station[] = [];
    const add = (p: THREE.Vector3, k: number, isle: Isle | null, houses: Isle['houses'] = []) => stations.push({ p, k, isle, houses, pi: 0, dwell: 0, move: 0 });
    f.steps.forEach((s, k) => {
      const isle = this.byId.get(s.e); if (!isle) return;
      // maps built before steps named their files: the flow's files that stand on this isle
      const want = new Set((s.files?.length ? s.files : f.files).map(p => p.toLowerCase()));
      add(new THREE.Vector3(isle.x, isle.y + isle.tall + 3.2, isle.z), k, isle, isle.houses.filter(hs => want.has(hs.p.toLowerCase())).slice(0, 4));
    });
    if (!stations.length) return;
    // start and end sit on their real-world landmark, or on the first and last isle
    stations.unshift({ ...stations[0], p: sl ? new THREE.Vector3(sl.x, 4.5, sl.z) : stations[0].p, k: -1, isle: null, houses: [] });
    const last = stations[stations.length - 1];
    add(el ? new THREE.Vector3(el.x, 4.5, el.z) : last.p, n, null);
    const pts: THREE.Vector3[] = [stations[0].p.clone()];
    for (let j = 1; j < stations.length; j++) {
      const a = pts[pts.length - 1], p = stations[j].p;
      if (a.distanceTo(p) > 0.01) {
        const mid = a.clone().lerp(p, 0.5); mid.y = Math.max(a.y, p.y) + 4 + a.distanceTo(p) * 0.08;
        for (let i = 1; i <= 16; i++) { const t = i / 16, u = 1 - t; pts.push(new THREE.Vector3(u * u * a.x + 2 * u * t * mid.x + t * t * p.x, u * u * a.y + 2 * u * t * mid.y + t * t * p.y, u * u * a.z + 2 * u * t * mid.z + t * t * p.z)); }
      }
      stations[j].pi = pts.length - 1;
    }
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i - 1].distanceTo(pts[i]));
    stations.forEach((st, j) => {
      st.dwell = st.k < 0 ? 2 : st.k >= n ? 3.2 : 2.8;
      const len = j < stations.length - 1 ? cum[stations[j + 1].pi] - cum[st.pi] : 0;
      st.move = j === stations.length - 1 ? 0 : len > 0.01 ? Math.max(0.6, len / 24) : 0.3;
    });
    const line: number[] = [];
    for (const p of pts) line.push(p.x, p.y, p.z);
    if (pts.length === 1) line.push(pts[0].x, pts[0].y + 0.01, pts[0].z);
    const geo = new LineGeometry(); geo.setPositions(line);
    const mat = new LineMaterial({ color: 0xd2232a, linewidth: 3.2, dashed: true, dashSize: 1.6, gapSize: 1.1, toneMapped: false, fog: false } as any);
    const l2 = new Line2(geo, mat); l2.computeLineDistances(); l2.renderOrder = 5;
    const courier = new THREE.Mesh(new THREE.SphereGeometry(0.9, 14, 10), new THREE.MeshBasicMaterial({ color: RED, toneMapped: false, fog: false }));
    courier.position.copy(pts[0]);
    const beams = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(8 * 3), 3)),
      new THREE.LineBasicMaterial({ color: RED, toneMapped: false, fog: false }));
    beams.frustumCulled = false; beams.visible = false;
    this.world.add(l2, courier, beams);
    // step numbers on the isles, several when the flow comes back
    const byIsle = new Map<Isle, number[]>();
    f.steps.forEach((s, k) => { const i = this.byId.get(s.e); if (i) { if (!byIsle.has(i)) byIsle.set(i, []); byIsle.get(i)!.push(k); } });
    const nums = [...byIsle].map(([i, ks]) => {
      const e = h('div', { class: 'dm-lb dm-step' }, ks.map(k => k + 1).join(' · '));
      (e as any)._p = new THREE.Vector3(i.x, i.y + i.tall + 5.5, i.z);
      this.labels.append(e);
      return { el: e, ks };
    });
    const who = this.flowWho(f) || f.start?.by;
    // over the landmark, or over the isle's step number
    const pin = (text: string, cls: string, land: Land | null, st: Station) => {
      const e = h('div', { class: 'dm-lb dm-pin ' + cls }, text);
      (e as any)._p = land ? new THREE.Vector3(land.x, 8, land.z) : st.p.clone().setY(st.p.y + 5.6);
      this.labels.append(e);
      return e;
    };
    const pins = [pin('▶ Start' + (who ? ' · ' + clip(who, 34) : ''), 'start', sl, stations[0]), pin('■ End' + (el ? ' · ' + el.w.name : ''), 'end', el, stations[stations.length - 1])];
    const caption = h('div', { class: 'dm-lb dm-cap' });
    this.labels.append(caption);
    const total = stations.reduce((a, s) => a + s.dwell + s.move, 0);
    this.flowFx = { f, line: l2, mat, pts, cum, stations, total, t: keep ? keep.t % total : 0, playing: keep ? keep.playing : true, cur: -2, courier, beams, nums, pins, caption };
    this.walkFlow(0);
  }
  // Move the courier along the timeline: wait at a station, travel to the next.
  private walkFlow(dt: number) {
    const f = this.flowFx!;
    f.mat.dashOffset -= dt * 4;
    if (f.playing) f.t = (f.t + dt) % f.total;
    let t = f.t, j = 0;
    while (j < f.stations.length - 1 && t >= f.stations[j].dwell + f.stations[j].move) { t -= f.stations[j].dwell + f.stations[j].move; j++; }
    const st = f.stations[j], next = f.stations[j + 1];
    if (t < st.dwell || !next) f.courier.position.copy(f.pts[st.pi]);
    else {
      let d = f.cum[st.pi] + (t - st.dwell) / st.move * (f.cum[next.pi] - f.cum[st.pi]), i = st.pi;
      while (i < next.pi - 1 && f.cum[i + 1] < d) i++;
      const seg = f.cum[i + 1] - f.cum[i];
      f.courier.position.lerpVectors(f.pts[i], f.pts[Math.min(i + 1, f.pts.length - 1)], seg ? Math.min(1, (d - f.cum[i]) / seg) : 0);
    }
    if (j !== f.cur) this.flowAt(j);
    // while it waits, beams down to the buildings that do the step
    const hs = t < st.dwell && st.isle ? st.houses : [];
    f.beams.visible = hs.length > 0;
    if (hs.length) {
      const pa = f.beams.geometry.attributes.position as THREE.BufferAttribute, c = f.courier.position;
      hs.forEach((x, k) => {
        const to = x.mesh.getWorldPosition(this.tmpV).setY(st.isle!.g.position.y + x.top);
        pa.setXYZ(k * 2, c.x, c.y, c.z); pa.setXYZ(k * 2 + 1, to.x, to.y, to.z);
      });
      pa.needsUpdate = true;
      f.beams.geometry.setDrawRange(0, hs.length * 2);
    }
  }
  // The courier reached station j: light the step in the panel and on the map, say what happens.
  private flowAt(j: number) {
    const f = this.flowFx!, st = f.stations[j], n = f.f.steps.length;
    f.cur = j;
    for (const li of this.body.querySelectorAll<HTMLElement>('[data-fk]')) {
      const on = Number(li.dataset.fk) === st.k;
      li.classList.toggle('on', on);
      if (on && f.playing) li.scrollIntoView({ block: 'nearest' });
    }
    for (const x of f.nums) x.el.classList.toggle('on', x.ks.includes(st.k));
    const step = f.f.steps[st.k];
    fill(f.caption, st.k < 0 ? [h('b', {}, 'Start'), ' ', f.f.start?.by || this.flowWho(f.f) || f.f.why]
      : st.k >= n ? [h('b', {}, 'Done'), ' ', this.flowOutcome(f.f)]
      : [h('b', {}, `${st.k + 1}/${n} ${this.byId.get(step.e)?.e.name || ''}`), ' ', step.do]);
    delete (f.caption as any)._w;
    const pos = this.body.querySelector('.dm-flowpos');
    if (pos) pos.textContent = st.k < 0 ? 'Start' : st.k >= n ? 'End' : `Step ${st.k + 1} of ${n}`;
  }
  // Jump to a station by step index (-1 start, steps.length end).
  private flowGo(k: number, play?: boolean) {
    const f = this.flowFx; if (!f) return;
    const j = Math.max(0, f.stations.findIndex(s => s.k >= k));
    f.t = f.stations.slice(0, j).reduce((a, s) => a + s.dwell + s.move, 0);
    if (play != null) f.playing = play;
    f.cur = -2;
    this.walkFlow(0);
    this.flowPlay(f.playing);
  }
  private flowPlay(on = !this.flowFx?.playing) {
    if (!this.flowFx) return;
    this.flowFx.playing = on;
    const b = this.body.querySelector('.dm-play');
    if (b) b.textContent = on ? '❚❚ Pause' : '▶ Play';
  }
  private flowStep(d: number) {
    const f = this.flowFx; if (!f) return;
    const k = f.stations[f.cur]?.k ?? -1;
    this.flowGo(Math.max(-1, Math.min(f.f.steps.length, k + d)), false);
  }
  private clearFlow() {
    const f = this.flowFx;
    if (!f) return;
    this.world.remove(f.line, f.courier, f.beams);
    f.line.geometry.dispose(); f.mat.dispose(); f.courier.geometry.dispose(); (f.courier.material as THREE.Material).dispose();
    f.beams.geometry.dispose(); (f.beams.material as THREE.Material).dispose();
    for (const x of f.nums) x.el.remove();
    for (const el of [...f.pins, f.caption]) el.remove();
    this.flowFx = null;
  }

  // ------------------------------------------------------------------ panel
  private renderPanel() {
    const st = this.state, m = this.model;
    // header: when the map was made, what changed since, the build controls
    const job = st?.job, working = job?.state === 'working';
    const btn = (label: string, title: string, fn: () => void, cls = 'chip mini') => h('button', { class: cls, title, onclick: fn }, label);
    fill(this.headBtns,
      working ? btn('Stop', 'Stop reading the code', () => api.domainStep(this.pid, 'stop'))
      : m ? [st!.meta?.changedCount ? btn(`Update · ${st!.meta.changedCount} changed`, 'Update the map from the files changed since it was built:\n' + st!.meta.changed.slice(0, 20).join('\n'), () => this.run('update'), 'chip mini go') : null,
        btn('Rebuild', 'Read the whole project again and redraw the map from scratch', () => this.run('build'))] : null);
    const meta = st?.meta;
    fill(this.headInfo,
      working ? h('div', { class: 'dm-working' }, h('span', { class: 'spinner sm' }), `${job!.kind === 'update' ? 'Updating' : 'Reading the code'} with ${job!.model || 'your model'} · `, since(job!.started))
      : job?.state === 'error' ? h('div', { class: 'dm-err' }, `Last run failed: ${job.error}`)
      : meta ? `Built ${ago(meta.builtAt)}${meta.model ? ' · ' + meta.model : ''}${meta.cost ? ' · ' + money(meta.cost) + ' API-equiv.' : ''}${meta.changedCount ? '' : ' · up to date'}` : '');
    this.renderEmpty();
    const shown = m || this.busy() ? '' : 'none';
    if (this.panel.style.display !== shown) { this.panel.style.display = shown; this.host.onLayout(); }
    if (!m) { fill(this.tabsEl); fill(this.body); return; }
    const tabB = (t: Tab, label: string, badge?: number) => h('button', { class: 'tab' + (this.tab === t && !this.sel ? ' on' : ''), onclick: () => { this.tab = t; this.select(null); } },
      label, badge ? h('span', { class: 'tbadge' }, badge) : null);
    const driftN = m.assumptions.filter(a => !a.holds).length;
    fill(this.tabsEl, tabB('task', 'Next task'), tabB('flows', 'Flows'), tabB('drift', 'Drift', driftN), tabB('map', 'Map'));
    const sel = this.sel;
    const scroll = this.body.scrollTop;
    const typing = document.activeElement as HTMLTextAreaElement | null;
    const caret = typing?.classList.contains('dm-ta') ? typing.selectionStart : -1;
    if (sel) fill(this.body, this.card(sel));
    else fill(this.body, this.tab === 'task' ? this.taskTab() : this.tab === 'flows' ? this.flowsTab() : this.tab === 'drift' ? this.driftTab() : this.mapTab());
    this.body.scrollTop = scroll;
    const ta = caret >= 0 ? this.body.querySelector<HTMLTextAreaElement>('.dm-ta') : null;
    if (ta) { ta.focus(); ta.setSelectionRange(caret, caret); }
  }

  private renderEmpty() {
    const st = this.state, m = this.model, job = st?.job;
    this.empty.style.display = m ? 'none' : '';
    if (m) return;
    if (job?.state === 'working') {
      fill(this.empty, h('div', { class: 'dm-e-h' }, 'Reading the project…'),
        h('p', {}, `${job.model || 'Your model'} is reading the code read-only and naming what it is about: the entities, how they connect, the flows through them, and where old code is carrying a new setup. A mid-size project takes a few minutes.`),
        h('div', { class: 'dm-working' }, h('span', { class: 'spinner sm' }), since(job.started)),
        h('button', { class: 'chip', onclick: () => api.domainStep(this.pid, 'stop') }, 'Stop'));
      return;
    }
    fill(this.empty, h('div', { class: 'dm-e-h' }, 'Map what this project is about'),
      h('p', {}, 'The city shows the code. The domain map shows what the code is for: the things the project deals with (orders, users, sessions…), how they relate to each other and to the real world, the flows through them, and the parts built for an older setup that now drag.'),
      h('p', { class: 'dim' }, `Uses ${st?.llm || 'your default model'} through your own Claude Code, with read-only tools, from the project folder. Capped at $10 API-equivalent; later updates only re-read what changed.`),
      job?.state === 'error' ? h('div', { class: 'dm-err' }, 'Last run failed: ' + job.error) : null,
      h('button', { class: 'chip go', onclick: () => this.run('build') }, 'Build the domain map'));
  }

  private async run(step: 'build' | 'update') {
    const r = await api.domainStep(this.pid, step);
    if (r.error && r.error !== 'busy') alertBox(this.panel, r.error);
    this.load(false);
  }

  private chipE(id: string) {
    const e = this.byId.get(id)?.e;
    return e ? h('button', { class: 'dm-ent st-' + e.status, title: e.what, onclick: () => this.select({ k: 'entity', id }, true) }, h('i', { class: 'st st-' + e.status }), e.name) : null;
  }
  private fileRow(p: string, extra?: string | null, badge?: string) {
    const d = this.driftBy.get(p.toLowerCase());
    return h('div', { class: 'dm-file', onclick: () => this.host.onFile(p), title: 'Open in Inspect' },
      badge ? h('span', { class: 'dm-badge' }, badge) : null,
      h('span', { class: 'mono fp' }, p),
      d ? h('span', { class: 'dm-strain', title: `Drift signals: ${d.markerCount} comments, ${d.pinned.length} pinned flags${d.rework ? `, rewritten by ${d.rework} tasks in 30 days` : ''}${d.twin ? ', an old twin' : ''}` }, d.score) : null,
      extra ? h('div', { class: 'dim note' }, extra) : null);
  }
  private sect(title: string, ...kids: any[]) {
    const items = kids.flat().filter(Boolean);
    return items.length ? h('div', { class: 'dm-sect' }, h('h3', {}, title), ...items) : null;
  }

  private taskTab() {
    const st = this.state!;
    const ta = h('textarea', { class: 'dm-ta', rows: 4, placeholder: 'What do you want to do next?\ne.g. "Let buyers save a search and get an email when a matching lot appears"',
      oninput: (ev: Event) => { this.draft = (ev.target as HTMLTextAreaElement).value; go.disabled = !this.draft.trim(); },
      onkeydown: (ev: KeyboardEvent) => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) send(); } }) as HTMLTextAreaElement;
    ta.value = this.draft;
    const send = async () => {
      const task = this.draft.trim(); if (!task) return;
      go.disabled = true;
      const r = await api.brief(this.pid, task);
      if (r.error) { alertBox(this.panel, r.error); go.disabled = false; return; }
      this.draft = '';
      this.load(false);
    };
    const go = h('button', { class: 'chip go', disabled: !this.draft.trim(), onclick: send, title: 'Ctrl+Enter' }, 'Brief me') as HTMLButtonElement;
    const list = st.briefs.map(b => h('div', { class: 'dm-row', onclick: () => this.select({ k: 'brief', id: b.id }, true) },
      h('div', { class: 'dm-row-t' }, b.task),
      h('div', { class: 'dm-row-s' }, b.state === 'working' ? [h('span', { class: 'spinner sm' }), ' reading the code · ', since(b.started)]
        : b.state === 'error' ? h('span', { class: 'red' }, b.error || 'failed')
        : `${b.result?.entities.length || 0} entities · ${b.result?.files.length || 0} files · ${b.result?.steps.length || 0} steps · ${ago(b.ended || b.started)}`)));
    return [
      h('p', { class: 'dm-help' }, 'Describe the next task. You get the slice of the project it touches: the entities and files, what already exists, what is missing, the rules to keep, the old code in the way, and a prompt to hand to Claude Code.'),
      ta, h('div', { class: 'dm-actions' }, go),
      list.length ? h('div', { class: 'dm-sect' }, h('h3', {}, 'Briefs'), ...list) : null,
    ];
  }

  private flowsTab() {
    const m = this.model!;
    return [h('p', { class: 'dm-help' }, 'What people and the system do end to end. Pick one to walk it: where it starts, each isle and file it passes, where it ends.'),
      ...m.flows.map(f => {
        const via = f.steps.map(s => this.byId.get(s.e)?.e.name).filter((x, i, a) => x && a[i - 1] !== x);
        const who = this.flowWho(f);
        return h('div', { class: 'dm-row', onclick: () => this.select({ k: 'flow', id: f.id }, true) },
          h('div', { class: 'dm-row-t' }, f.name, h('span', { class: 'pill fl-' + f.status }, FLOW[f.status])),
          h('div', { class: 'dm-row-s' }, h('span', {}, who ? [h('b', {}, '▶ ' + who), ' → '] : null, via.join(' → '))),
          f.end?.outcome ? h('div', { class: 'dm-row-s' }, '■ ' + f.end.outcome) : null);
      })];
  }

  private driftTab() {
    const m = this.model!, st = this.state!;
    const sev = { high: 0, medium: 1, low: 2 };
    const drift = m.assumptions.filter(a => !a.holds).sort((a, b) => sev[a.severity] - sev[b.severity]);
    const rules = m.assumptions.filter(a => a.holds);
    const row = (a: DAssumption) => h('div', { class: 'dm-row', onclick: () => this.select({ k: 'assumption', id: a.id }, true) },
      h('div', { class: 'dm-row-t' }, a.text, a.holds ? null : h('span', { class: 'pill sev-' + a.severity }, a.severity)),
      a.holds ? null : h('div', { class: 'dm-row-s' }, a.was && a.now ? `Was: ${a.was} · Now: ${a.now}` : a.cost));
    return [
      h('p', { class: 'dm-help' }, 'Code made for an earlier setup that newer code now works around. Red flags on the map mark the isles that carry it.'),
      this.sect('Built for an older setup', drift.map(row)) || h('div', { class: 'empty' }, 'No drift found.'),
      this.sect('Rules any change must keep', rules.map(row)),
      this.sect('Strained files (local scan)', st.drift.slice(0, 15).map(d => this.fileRow(d.p,
        [d.markers[0]?.text || d.pinned[0]?.text, d.rework ? `rewritten by ${d.rework} tasks in 30 days` : null, d.twin ? 'old twin of another file' : null].filter(Boolean).join(' · ')))),
    ];
  }

  private mapTab() {
    const m = this.model!;
    const counts: Record<string, number> = {};
    for (const e of m.entities) counts[e.status] = (counts[e.status] || 0) + 1;
    return [
      m.summary ? h('p', { class: 'dm-sum' }, m.summary) : null,
      this.sect('Isles', (['solid', 'shaky', 'partial', 'missing', 'unknown'] as EStatus[]).filter(s => counts[s]).map(s =>
        h('div', { class: 'dm-leg', title: STATUS_TIP[s] }, h('i', { class: 'st st-' + s }), `${STATUS[s]} · ${counts[s]}`, h('span', { class: 'dim' }, ' ' + STATUS_TIP[s])))),
      this.sect('Buildings are the code', Object.keys(DOES).map(k => h('div', { class: 'dm-leg' }, h('b', {}, DOES[k]), h('span', { class: 'dim' }, ' ' + DOES_TIP[k])))),
      this.sect('Archipelagos', m.groups.map(g => h('div', { class: 'dm-row', onclick: () => { this.select(null); this.flyToSet(this.isles.filter(s => s.e.group === g.id)); } },
        h('div', { class: 'dm-row-t' }, g.name), h('div', { class: 'dm-row-s' }, g.what),
        h('div', { class: 'dm-chips' }, m.entities.filter(e => e.group === g.id).map(e => this.chipE(e.id)))))),
      this.sect('The real world below', m.world.map(w => h('div', { class: 'dm-row', onclick: () => this.select({ k: 'world', id: w.id }, true) },
        h('div', { class: 'dm-row-t' }, w.name, h('span', { class: 'dim' }, ' · ' + w.kind)), h('div', { class: 'dm-row-s' }, w.what)))),
    ];
  }

  private card(s: NonNullable<Sel>) {
    const m = this.model!;
    const back = h('button', { class: 'dm-back', onclick: () => this.select(null) }, '← ', { task: 'Next task', flows: 'Flows', drift: 'Drift', map: 'Map' }[this.tab]);
    if (s.k === 'entity') {
      const e = this.byId.get(s.id)?.e; if (!e) return back;
      const rel = m.relations.filter(r => r.a === e.id || r.b === e.id);
      const flows = m.flows.filter(f => f.steps.some(x => x.e === e.id));
      const asm = m.assumptions.filter(a => a.entities.includes(e.id));
      const group = m.groups.find(g => g.id === e.group);
      const live = [...this.drones.values()].filter(d => d.isle?.e.id === e.id && d.g.visible);
      return [back,
        h('div', { class: 'dm-kicker' }, group?.name || ''), h('h2', {}, e.name, h('span', { class: 'pill st-' + e.status, title: STATUS_TIP[e.status] }, STATUS[e.status])),
        h('p', {}, e.what),
        e.statusWhy ? h('p', { class: 'dim' }, e.statusWhy) : null,
        live.length ? h('div', { class: 'dm-live' }, live.map(d => h('i', { style: { background: d.color } })), `${live.length} session${live.length > 1 ? 's' : ''} working here now`) : null,
        this.sect('In the real world', e.real ? h('p', {}, e.real) : null, e.world.map(id => { const w = m.world.find(x => x.id === id); return w ? h('button', { class: 'dm-ent', onclick: () => this.select({ k: 'world', id }, true) }, w.name) : null; })),
        this.sect('States', e.states.length ? h('div', { class: 'dm-chips' }, e.states.map(x => h('span', { class: 'dm-state' }, x))) : null),
        this.sect('Rules and facts', e.facts.map(f => h('div', { class: 'dm-li' }, f))),
        this.sect('Connections', rel.map(r => h('div', { class: 'dm-rel' }, r.a === e.id ? [h('b', {}, e.name), ` ${r.verb} `, this.chipE(r.b)] : [this.chipE(r.a), ` ${r.verb} `, h('b', {}, e.name)]))),
        this.sect('Flows through it', flows.map(f => h('div', { class: 'dm-row', onclick: () => this.select({ k: 'flow', id: f.id }, true) }, h('div', { class: 'dm-row-t' }, f.name, h('span', { class: 'pill fl-' + f.status }, FLOW[f.status]))))),
        this.sect('Assumptions', asm.map(a => h('div', { class: 'dm-row' + (a.holds ? '' : ' drift'), onclick: () => this.select({ k: 'assumption', id: a.id }, true) }, h('div', { class: 'dm-row-t' }, a.text)))),
        this.sect('Code', e.code.map(c => this.fileRow(c.p, c.note, DOES[c.does]))),
      ];
    }
    if (s.k === 'world') {
      const w = m.world.find(x => x.id === s.id); if (!w) return back;
      return [back, h('div', { class: 'dm-kicker' }, 'Real world · ' + w.kind), h('h2', {}, w.name), h('p', {}, w.what),
        this.sect('Stands for it in the code', h('div', { class: 'dm-chips' }, m.entities.filter(e => e.world.includes(w.id)).map(e => this.chipE(e.id))))];
    }
    if (s.k === 'flow') {
      const f = m.flows.find(x => x.id === s.id); if (!f) return back;
      const fx = this.flowFx, n = f.steps.length, cur = fx ? fx.stations[fx.cur]?.k : null;
      const endW = m.world.find(w => w.id === f.end?.world);
      // Start, every step with the isle and files that do it, End: clicking one holds the walk there
      const stop = (k: number, mark: string, cls: string, ...kids: any[]) => h('li', { class: cls + (cur === k ? ' on' : ''), 'data-fk': String(k),
        onclick: (ev: Event) => { if ((ev.target as HTMLElement).closest('.dm-ent, .dm-file')) return; this.flowGo(k, false); } },
        h('span', { class: 'jn' }, mark), ...kids);
      const shown = new Set<string>();
      const steps = f.steps.map((x, k) => {
        const own = (x.files?.length ? x.files : f.files.filter(p => this.byId.get(x.e)?.e.code.some(c => c.p === p))).slice(0, 4);
        own.forEach(p => shown.add(p));
        return stop(k, String(k + 1), 'step', h('div', { class: 'jh' }, this.chipE(x.e)), h('div', { class: 'jd' }, x.do),
          own.map(p => this.fileRow(p)), x.risk ? h('div', { class: 'jr' }, '⚠ ' + x.risk) : null);
      });
      const rest = f.files.filter(p => !shown.has(p));
      return [back, h('div', { class: 'dm-kicker' }, 'Flow'), h('h2', {}, f.name, h('span', { class: 'pill fl-' + f.status }, FLOW[f.status])),
        f.why ? h('p', {}, f.why) : null,
        h('div', { class: 'dm-flowctl' },
          h('button', { class: 'chip mini', title: 'Previous stop', onclick: () => this.flowStep(-1) }, '‹'),
          h('button', { class: 'chip mini dm-play', onclick: () => this.flowPlay() },fx?.playing ? '❚❚ Pause' : '▶ Play'),
          h('button', { class: 'chip mini', title: 'Next stop', onclick: () => this.flowStep(1) }, '›'),
          h('span', { class: 'dm-flowpos dim' }, cur == null ? '' : cur < 0 ? 'Start' : cur >= n ? 'End' : `Step ${cur + 1} of ${n}`)),
        h('ol', { class: 'dm-journey' },
          stop(-1, '▶', 'start', h('div', { class: 'jt' }, 'Starts'), h('div', { class: 'jd' }, h('b', {}, this.flowWho(f) || 'At ' + (this.byId.get(f.steps[0].e)?.e.name || 'the first step'))), f.start?.by ? h('div', { class: 'jd dim' }, f.start.by) : null),
          steps,
          stop(n, '■', 'end', h('div', { class: 'jt' }, 'Ends'), h('div', { class: 'jd' }, this.flowOutcome(f)), endW ? h('div', { class: 'jd dim' }, 'Lands at ' + endW.name) : null)),
        f.note ? h('p', { class: f.status === 'works' ? 'dim' : 'dm-warn' }, f.note) : null,
        this.sect('Other files on the way', rest.map(p => this.fileRow(p)))];
    }
    if (s.k === 'assumption') {
      const a = m.assumptions.find(x => x.id === s.id); if (!a) return back;
      const kv = (k: string, v: string) => v ? h('div', { class: 'dm-kv' }, h('b', {}, k), h('div', {}, v)) : null;
      return [back, h('div', { class: 'dm-kicker' }, a.holds ? 'Rule to keep' : `Drift · ${a.severity}`), h('h2', { class: 'sm' }, a.text),
        kv('Built for', a.was), kv('Now', a.now), kv('Evidence', a.evidence), kv('Costs today', a.cost), kv(a.holds ? 'Keep it by' : 'Fix', a.fix),
        this.sect('Isles', h('div', { class: 'dm-chips' }, a.entities.map(id => this.chipE(id)))),
        this.sect('Files', a.files.map(p => this.fileRow(p)))];
    }
    const b = this.state!.briefs.find(x => x.id === s.id);
    if (!b) return back;
    const r = b.result;
    const head = [back, h('div', { class: 'dm-kicker' }, 'Next task'), h('h2', { class: 'sm' }, b.task)];
    if (b.state === 'working') return [...head, h('div', { class: 'dm-working' }, h('span', { class: 'spinner sm' }), `${b.model || 'The model'} is reading the code for this task · `, since(b.started))];
    if (!r) return [...head, h('div', { class: 'dm-err' }, b.error || 'failed'), h('button', { class: 'chip mini', onclick: () => this.dropBrief(b) }, 'Remove')];
    const aRef = (id: string | null) => id ? h('button', { class: 'dm-link', onclick: () => this.select({ k: 'assumption', id }, true) }, '↗') : null;
    const copy = h('button', { class: 'chip go', onclick: async () => { await navigator.clipboard.writeText(r.prompt); copy.textContent = 'Copied'; setTimeout(() => copy.textContent = 'Copy prompt for Claude Code', 1500); } }, 'Copy prompt for Claude Code');
    return [...head,
      r.goal ? h('p', {}, r.goal) : null,
      h('div', { class: 'dm-actions' }, r.prompt ? copy : null, h('button', { class: 'chip mini', onclick: () => this.dropBrief(b) }, 'Remove')),
      this.sect('Isles involved', h('div', { class: 'dm-chips' }, r.entities.map((id, k) => [h('span', { class: 'dm-n' }, k + 1), this.chipE(id)]))),
      this.sect('New things it adds', r.newEntities.map(n => h('div', { class: 'dm-li' }, h('b', {}, n.name), ' · ', n.what))),
      this.sect('Questions for you', r.questions.map(q => h('div', { class: 'dm-li dm-q' }, q))),
      this.sect('Steps', h('ol', { class: 'dm-steps' }, r.steps.map(x => h('li', {}, x)))),
      this.sect('Missing', r.missing.map(x => h('div', { class: 'dm-li' }, x))),
      this.sect('Already there', r.done.map(x => h('div', { class: 'dm-li dim' }, x))),
      this.sect('Old code in the way', r.drift.map(d => h('div', { class: 'dm-li drift' }, h('span', { class: 'pill how-' + d.how.replace(' ', '-') }, d.how), ' ', d.text, aRef(d.a), d.why ? h('div', { class: 'dim note' }, d.why) : null))),
      this.sect('Rules to keep', r.respect.map(x => h('div', { class: 'dm-li' }, x.text, aRef(x.a)))),
      this.sect('Files', r.files.map(f => f.act === 'new' ? h('div', { class: 'dm-file new' }, h('span', { class: 'dm-badge' }, 'New'), h('span', { class: 'mono fp' }, f.p), f.why ? h('div', { class: 'dim note' }, f.why) : null)
        : this.fileRow(f.p, f.why, f.act === 'edit' ? 'Edit' : 'Read'))),
      r.flows.length ? this.sect('Flows it touches', r.flows.map(id => { const f = m.flows.find(x => x.id === id); return f ? h('div', { class: 'dm-row', onclick: () => this.select({ k: 'flow', id }, true) }, h('div', { class: 'dm-row-t' }, f.name)) : null; })) : null,
      h('div', { class: 'dim note' }, `${b.model || ''}${b.cost ? ' · ' + money(b.cost) + ' API-equiv.' : ''} · ${ago(b.ended || b.started)}`),
    ];
  }
  private async dropBrief(b: Brief) {
    await api.dropBrief(this.pid, b.id);
    this.sel = null;
    this.load(false);
  }
}

// ------------------------------------------------------------------ helpers
// a clock the panel timer keeps current
const since = (t: number) => h('span', { 'data-since': String(t) }, dur(Date.now() - t));

// a material switched in or out of transparency needs its shader rebuilt
function fade(mt: THREE.Material, o: number) {
  const tr = o < 1;
  if (mt.transparent !== tr) { mt.transparent = tr; mt.depthWrite = !tr; mt.needsUpdate = true; }
  mt.opacity = o;
}

function alertBox(parent: HTMLElement, msg: string) {
  const el = h('div', { class: 'dm-toast' }, msg);
  parent.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// A file standing on an isle; its shape says what it does for the entity.
function building(does: string, w: number, hgt: number, wall: THREE.Material, roof: THREE.Material, glass: THREE.Material) {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, y: number) => { const m = new THREE.Mesh(geo, mat); m.position.y = y; m.castShadow = m.receiveShadow = true; g.add(m); return m; };
  if (does === 'stores') {
    add(new THREE.CylinderGeometry(w * 0.55, w * 0.55, hgt, 12), wall, hgt / 2);
    add(new THREE.ConeGeometry(w * 0.6, w * 0.5, 12), roof, hgt + w * 0.25);
  } else if (does === 'changes') {
    const hh = Math.max(1, hgt * 0.6);
    add(new THREE.BoxGeometry(w * 1.3, hh, w), wall, hh / 2);
    const r = add(new THREE.ConeGeometry(w * 0.95, w * 0.6, 4), roof, hh + w * 0.3); r.rotation.y = Math.PI / 4; r.scale.set(1, 1, 0.75);
    add(new THREE.BoxGeometry(0.3, w * 0.8, 0.3), roof, hh + w * 0.4).position.x = w * 0.35;
  } else if (does === 'shows') {
    add(new THREE.BoxGeometry(0.18, hgt * 0.5, 0.18), roof, hgt * 0.25);
    add(new THREE.BoxGeometry(w * 1.5, hgt * 0.55, 0.22), glass, hgt * 0.72);
  } else if (does === 'uses') {
    add(new THREE.BoxGeometry(w * 0.75, hgt * 0.45, w * 0.75), wall, hgt * 0.225);
    add(new THREE.BoxGeometry(w * 0.8, 0.14, w * 0.8), roof, hgt * 0.45 + 0.07);
  } else {
    add(new THREE.BoxGeometry(w, hgt, w), wall, hgt / 2);
    add(new THREE.BoxGeometry(w * 1.04, 0.18, w * 1.04), roof, hgt + 0.09);
  }
  return g;
}

// A real person, system, device, place, thing or money on the ground.
function landmark(kind: string) {
  const g = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: '#3b3b3b', roughness: 0.8 });
  const light = new THREE.MeshStandardMaterial({ color: '#f2f0eb', roughness: 0.9 });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
  if (kind === 'person') {
    add(new THREE.CylinderGeometry(0.55, 0.75, 1.8, 10), dark, 0, 0.9);
    add(new THREE.SphereGeometry(0.5, 12, 10), light, 0, 2.25);
  } else if (kind === 'system') {
    add(new THREE.BoxGeometry(2, 3, 2), light, 0, 1.5);
    add(new THREE.BoxGeometry(2.05, 0.2, 2.05), dark, 0, 3.1);
    add(new THREE.CylinderGeometry(0.06, 0.06, 1.4, 5), dark, 0.6, 3.9);
  } else if (kind === 'device') {
    add(new THREE.BoxGeometry(0.25, 1, 0.25), dark, 0, 0.5);
    add(new THREE.BoxGeometry(2, 1.3, 0.2), dark, 0, 1.5);
  } else if (kind === 'place') {
    add(new THREE.BoxGeometry(2.2, 1.5, 2), light, 0, 0.75);
    const r = add(new THREE.ConeGeometry(1.8, 1.1, 4), dark, 0, 2.05); r.rotation.y = Math.PI / 4;
  } else if (kind === 'money') {
    for (let k = 0; k < 3; k++) add(new THREE.CylinderGeometry(0.8, 0.8, 0.3, 14), k % 2 ? light : dark, k * 0.1, 0.15 + k * 0.32);
  } else {
    add(new THREE.BoxGeometry(1.5, 1.5, 1.5), light, 0, 0.75);
    add(new THREE.BoxGeometry(1.55, 0.2, 1.55), dark, 0, 1.5);
  }
  // a dark plate under it, so it reads on the grass
  const plate = add(new THREE.CylinderGeometry(1.7, 1.7, 0.1, 18), new THREE.MeshStandardMaterial({ color: '#b8c0ad', roughness: 1 }), 0, 0.05);
  plate.receiveShadow = true;
  return g;
}

// Isles of a group cluster together; related isles pull toward each other;
// nothing overlaps. Deterministic, so the map keeps its shape between loads.
function layout(m: DomainModel) {
  const deg = new Map<string, number>();
  for (const r of m.relations) { deg.set(r.a, (deg.get(r.a) || 0) + 1); deg.set(r.b, (deg.get(r.b) || 0) + 1); }
  const radius = (e: DEntity) => e.status === 'missing' ? 3.6 : 4 + Math.sqrt(e.code.length) * 1.5;
  const groups = m.groups.map(g => ({ g, list: m.entities.filter(e => e.group === g.id).sort((a, b) => (deg.get(b.id) || 0) - (deg.get(a.id) || 0)) })).filter(x => x.list.length);
  // order groups around the ring so linked groups sit side by side
  const gOf = new Map(m.entities.map(e => [e.id, e.group]));
  const w = new Map<string, number>();
  for (const r of m.relations) { const a = gOf.get(r.a)!, b = gOf.get(r.b)!; if (a !== b) { const k = [a, b].sort().join('|'); w.set(k, (w.get(k) || 0) + 1); } }
  const ring: typeof groups = [];
  const left = [...groups].sort((a, b) => b.list.length - a.list.length);
  ring.push(left.shift()!);
  while (left.length) {
    const last = ring[ring.length - 1].g.id;
    left.sort((a, b) => (w.get([b.g.id, last].sort().join('|')) || 0) - (w.get([a.g.id, last].sort().join('|')) || 0));
    ring.push(left.shift()!);
  }
  const gR = ring.map(x => 10 + Math.sqrt(x.list.reduce((s, e) => s + radius(e) ** 2, 0)) * 2.7);
  const circ = gR.reduce((s, r) => s + r * 2 + 18, 0);
  const R = ring.length > 1 ? Math.max(circ / (2 * Math.PI), gR[0] + 6) : 0;
  const pos = new Map<string, { x: number; z: number; r: number; gx: number; gz: number }>();
  let ang = 0;
  ring.forEach((x, gi) => {
    const share = (gR[gi] * 2 + 18) / circ * Math.PI * 2;
    const a = ang + share / 2; ang += share;
    const gx = Math.cos(a) * R, gz = Math.sin(a) * R;
    x.list.forEach((e, k) => {
      const t = k * 2.399, d = k ? 11 * Math.sqrt(k) : 0;
      pos.set(e.id, { x: gx + Math.cos(t) * d, z: gz + Math.sin(t) * d, r: radius(e), gx, gz });
    });
  });
  const ids = [...pos.keys()], P = ids.map(id => pos.get(id)!);
  const idx = new Map(ids.map((id, i) => [id, i]));
  const springs = m.relations.map(r => [idx.get(r.a), idx.get(r.b)]).filter(([a, b]) => a != null && b != null) as [number, number][];
  for (let it = 0; it < 500; it++) {
    const k = 1 - it / 500;
    for (const [a, b] of springs) {
      const p = P[a], q = P[b], dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz) || 1;
      const want = p.r + q.r + 18, f = (d - want) / d * 0.03 * k;
      p.x += dx * f; p.z += dz * f; q.x -= dx * f; q.z -= dz * f;
    }
    for (const p of P) { p.x += (p.gx - p.x) * 0.012 * k; p.z += (p.gz - p.z) * 0.012 * k; }
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
      const p = P[i], q = P[j], dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz) || 0.01;
      const min = p.r + q.r + 12;
      if (d < min) { const f = (min - d) / d * 0.5; p.x -= dx * f; p.z -= dz * f; q.x += dx * f; q.z += dz * f; }
    }
  }
  let cx = 0, cz = 0; for (const p of P) { cx += p.x; cz += p.z; } cx /= P.length || 1; cz /= P.length || 1;
  for (const p of P) { p.x -= cx; p.z -= cz; }
  return pos;
}
