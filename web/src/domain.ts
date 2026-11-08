import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { Stage } from './city/scene';
import { ink } from './city/env';
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
const BRIDGE = '#3f4539', BRIDGE_A = 0.6; // bridges between isles: the ties' fine line, a little firmer
// The real world stands in quarters around the archipelago, one per kind, in this order.
type WKind = DomainModel['world'][number]['kind'];
const KINDS: WKind[] = ['person', 'system', 'device', 'place', 'money', 'thing'];
const KIND_NAME: Record<WKind, string> = { person: 'People', system: 'Outside systems', device: 'Devices', place: 'Places', money: 'Money', thing: 'Things' };
const LAND_SCALE = 1.5;     // landmarks are drawn this much over their modelled size, to read from the default zoom

type Sel = { k: 'entity'; id: string } | { k: 'flow'; id: string } | { k: 'assumption'; id: string } | { k: 'brief'; id: string } | { k: 'world'; id: string } | null;
type Tab = 'start' | 'task' | 'flows' | 'drift' | 'map';

interface Isle {
  e: DEntity; i: number; x: number; z: number; y: number; r: number; depth: number;
  g: THREE.Group; mats: THREE.Material[]; base: number[]; strain: number; flag: THREE.Object3D | null;
  houses: { mesh: THREE.Object3D; p: string; top: number }[]; debris: THREE.Object3D[];
  label: HTMLElement; hue: number; tall: number;
}
// a map name with what placeLabels keeps on it: size, chosen spot (offset from its natural place), leader line
type Lbl = HTMLElement & { _w?: number; _h?: number; _ci?: number; _at?: { dx: number; dy: number }; _ld?: HTMLElement };
interface Land { w: DomainModel['world'][number]; x: number; z: number; g: THREE.Group; label: HTMLElement; mats: THREE.Material[] }
interface Bridge { a: Isle; b: Isle; verb: string; line: THREE.Line; mat: THREE.LineBasicMaterial; mid: THREE.Vector3; label: HTMLElement }
interface Tether { isle: Isle; land: Land; line: THREE.Line; mat: THREE.LineBasicMaterial }
// a picked isle's (or landmark's) connections carry a current: marching dashes and beads running outward
interface LinkFx { line: Line2; mat: LineMaterial; beads: THREE.Mesh[]; pts: THREE.Vector3[]; cum: number[]; len: number; t: number }
// a session at work: a drone over the isle it touches, and a ring round that isle that reads from any zoom
interface Drone { g: THREE.Group; beam: THREE.Line; ring: THREE.Mesh; color: string; isle: Isle | null; house: number; seen: number; phase: number }
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
  occluders: HTMLElement[] = []; // the host's floating bits over the map: labels keep clear of them
  private canvasBox: HTMLDivElement; private labels: HTMLDivElement; private tip: HTMLDivElement;
  private panel: HTMLDivElement; private body: HTMLDivElement; private headInfo: HTMLDivElement; private headBtns: HTMLDivElement;
  private tabsEl: HTMLDivElement; private empty: HTMLDivElement;
  private state: DomainState | null = null;
  private model: DomainModel | null = null;
  private world = new THREE.Group();
  private isles: Isle[] = []; private byId = new Map<string, Isle>();
  private lands: Land[] = []; private bridges: Bridge[] = []; private tethers: Tether[] = [];
  private links: LinkFx[] = [];
  private groupLabels: { el: HTMLElement; p: THREE.Vector3 }[] = [];
  private posts: { el: HTMLElement; p: THREE.Vector3; kind: WKind; rows: Map<string, HTMLElement> }[] = []; // one signpost per quarter of the real world
  private clouds: THREE.Object3D[] = [];
  private worldA = new Map<string, number>(); // where the layout put each thing of the real world on its ring
  private fileIsles = new Map<string, Isle[]>();  // lowercased path -> isles whose code holds it
  private moduleIsles = new Map<number, Isle[]>(); // city module -> isles with files in it
  private driftBy = new Map<string, DriftFile>();
  private flowFx: FlowFx | null = null;
  private drones = new Map<string, Drone>();
  private sel: Sel = null; private hover: Isle | null = null; private hoverLand: Land | null = null;
  private focusSet: Set<Isle> | null = null; private focusOrder = new Map<Isle, number[]>();
  private tab: Tab = 'start';
  private draft = '';
  private visible = false; private span = 120; private fitted = false;
  private frame = { left: 0, top: 0, right: 800, bottom: 600 };
  private timer = 0; private offLive: () => void;
  private ray = new THREE.Raycaster(); private tmpV = new THREE.Vector3();
  // names the user dragged aside: screen offset from where the name would stand, per browser
  private labelMan = new Map<string, { dx: number; dy: number }>();

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
    try { for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem('vz-dmlabels:' + pid) || '{}'))) this.labelMan.set(k, v as any); } catch { /* none kept */ }

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
    const pts: { p: THREE.Vector3; r: number }[] = [];
    for (const s of this.isles) pts.push({ p: new THREE.Vector3(s.x, s.y + s.tall + 2, s.z), r: s.r }, { p: new THREE.Vector3(s.x, s.y - s.depth, s.z), r: s.r * 0.4 });
    // and the real world around it: its signposts are the ways in, so the first view shows them all,
    // with room above for the signs and beside them for their width
    for (const l of this.lands) pts.push({ p: new THREE.Vector3(l.x, 0, l.z), r: 6 });
    this.home(this.frameAll(pts, this.lands.length ? 64 : 0, this.lands.length ? 44 : 0), animate);
  }
  // Where the camera looks, and how far out, so these points (each with a radius around it) fill the open
  // part of the screen: right of the panel, inside the frame, less padTop/padX pixels for what hangs off
  // them. Exact for the orthographic camera at the goal angle: points are measured on the screen's axes.
  private frameAll(pts: { p: THREE.Vector3; r: number }[], padTop = 0, padX = 0) {
    const st = this.stage, cb = this.canvasBox.getBoundingClientRect(), pr = this.panel.getBoundingClientRect();
    const left = Math.max(this.frame.left, this.panel.style.display === 'none' ? 0 : pr.right) + 10 + padX, right = this.frame.right - 10 - padX;
    const top = this.frame.top + 10 + padTop, bottom = this.frame.bottom - 10;
    const openW = Math.max(200, right - left), openH = Math.max(160, bottom - top);
    // the camera's right and up axes (lookAt from azimuth/elevation, up = +y)
    const az = st.goal.azimuth, el = st.goal.elevation, ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(el), se = Math.sin(el);
    const X = (p: THREE.Vector3) => p.x * sa - p.z * ca, Y = (p: THREE.Vector3) => -se * ca * p.x + ce * p.y - se * sa * p.z;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const { p, r } of pts) { const x = X(p), y = Y(p); x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r); y0 = Math.min(y0, y - r); y1 = Math.max(y1, y + r); }
    const viewSize = Math.max(20, (x1 - x0) * cb.height / openW, (y1 - y0) * cb.height / openH), unit = viewSize / cb.height;
    // the middle of the points goes to the middle of the open area: solve for the ground point the camera aims at
    const ox = (left + right) / 2 - (cb.left + cb.width / 2), oyUp = (cb.top + cb.height / 2) - (top + bottom) / 2;
    const A = (x0 + x1) / 2 - ox * unit, B = -((y0 + y1) / 2 - oyUp * unit) / se;
    return { x: sa * A + ca * B, z: -ca * A + sa * B, viewSize };
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
    for (const d of this.drones.values()) { dispose(d.g); dispose(d.beam); dispose(d.ring); }
    this.drones.clear();
    this.clearFlow();
    this.clearLinks();
    this.isles = []; this.byId.clear(); this.lands = []; this.bridges = []; this.tethers = []; this.groupLabels = []; this.posts = []; this.clouds = [];
    this.fileIsles.clear(); this.moduleIsles.clear();
    this.labels.innerHTML = '';
  }

  private buildScene() {
    this.clear();
    const m = this.model;
    this.empty.style.display = m ? 'none' : '';
    if (!m) return;
    const { pos, worldA } = layout(m);
    this.worldA = worldA;
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
    // lanes (rule 12): lines leaving an isle the same way sit side by side, ordered so they never cross there
    const rels = m.relations.map(r => ({ r, a: this.byId.get(r.a)!, b: this.byId.get(r.b)!, sa: { x: 0, z: 0 }, sb: { x: 0, z: 0 } })).filter(x => x.a && x.b && x.a !== x.b);
    const lanes = new Map<string, { me: Isle; other: Isle; d: P2; shift: P2 }[]>();
    for (const x of rels) for (const [me, other, shift] of [[x.a, x.b, x.sa], [x.b, x.a, x.sb]] as [Isle, Isle, P2][]) {
      const d = exitDir(me, other), key = `${me.i}:${Math.round(d.x * 2)},${Math.round(d.z * 2)}`;
      if (!lanes.has(key)) lanes.set(key, []);
      lanes.get(key)!.push({ me, other, d, shift });
    }
    for (const list of lanes.values()) {
      if (list.length < 2) continue;
      const cross = (l: (typeof list)[number]) => l.d.x * (l.other.z - l.me.z) - l.d.z * (l.other.x - l.me.x);
      list.sort((p, q) => cross(p) - cross(q));
      list.forEach((l, j) => { const o = (j - (list.length - 1) / 2) * LANE; l.shift.x = -l.d.z * o; l.shift.z = l.d.x * o; });
    }
    for (const x of rels) this.bridges.push(this.makeBridge(x.a, x.b, x.r.verb, x.sa, x.sb));
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
    // status (solid/shaky/...) lives in the tooltip and panel; on the map only a missing isle looks different
    const label = h('div', { class: 'dm-lb dm-isle' + (e.status === 'missing' ? ' ghost' : ''), title: 'Drag to move this name · double-click to put it back' }, e.name);
    this.labels.append(label);
    this.dragLabel(label, 'isle:' + e.id, () => this.select({ k: 'entity', id: e.id }, true));
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

  // A bridge is a metro line (rules 8, 9, 12): out of its lane on a's rim, one diagonal, into b's rim,
  // level from deck to deck. Drawn as the ties to the ground are: one fine line, no casing.
  private makeBridge(a: Isle, b: Isle, verb: string, sa: P2, sb: P2): Bridge {
    let p = metroPath({ x: a.x + sa.x, z: a.z + sa.z }, { x: b.x + sb.x, z: b.z + sb.z });
    p = cutStart(p, a, a.r * 0.85);
    p = cutStart([...p].reverse(), b, b.r * 0.85).reverse();
    const pts = lift(p, a.y + 0.15, b.y + 0.15);
    if (pts.length === 1) pts.push(pts[0].clone().setY(pts[0].y + 0.01));
    const mat = new THREE.LineBasicMaterial({ color: BRIDGE, transparent: true, opacity: BRIDGE_A, depthWrite: false });
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat); line.renderOrder = 2;
    this.world.add(line);
    const label = h('div', { class: 'dm-lb dm-verb' }, verb);
    this.labels.append(label);
    return { a, b, verb, line, mat, mid: alongAt(pts, 0.5), label };
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
    // the real things stand around the archipelago in quarters, one per kind (people together,
    // outside systems together...), each quarter on the side of the isles that stand for its things
    const ringR = ringRadius(R, m.world);
    const want = m.world.map((w, k) => {
      const users = this.isles.filter(s => s.e.world.includes(w.id));
      // where the layout put it (it weighed its isles and the flows it starts or ends), else toward its isles
      const ux = users.reduce((s, u) => s + u.x, 0) / (users.length || 1), uz = users.reduce((s, u) => s + u.z, 0) / (users.length || 1);
      const a = this.worldA.get(w.id) ?? (users.length && Math.hypot(ux - cx, uz - cz) > 1 ? Math.atan2(uz - cz, ux - cx) : k / Math.max(1, m.world.length) * Math.PI * 2);
      return { w, a, users };
    });
    const quarters = ringQuarters(want, ringR);
    if (ringR * 1.25 > R * 1.45) { field.scale.setScalar(ringR * 1.25 / (R * 1.45)); rim.scale.setScalar(ringR * 1.25 / (R * 1.45)); }
    this.groupLabels[this.groupLabels.length - 1].p.z = cz + Math.max(R * 1.38, ringR + 24); // "the real world", outside the quarters
    const pave = new THREE.MeshStandardMaterial({ color: '#c3c6bb', roughness: 1 });
    const kerb = new THREE.MeshBasicMaterial({ color: '#8f9688', toneMapped: false });
    for (const q of quarters) {
      // a paved strip under the quarter, and its name on the outer side
      const pad = 7 / ringR, t0 = q.a - q.half - pad, len = q.half * 2 + pad * 2;
      const strip = new THREE.Mesh(new THREE.RingGeometry(ringR - 5.5, ringR + 5.5, Math.max(6, Math.round(len * 24)), 1, -t0 - len, len), pave);
      strip.rotation.x = -Math.PI / 2; strip.position.set(cx, 0.02, cz); strip.receiveShadow = true;
      const edge = new THREE.Mesh(new THREE.RingGeometry(ringR + 5.5, ringR + 6, Math.max(6, Math.round(len * 24)), 1, -t0 - len, len), kerb);
      edge.rotation.x = -Math.PI / 2; edge.position.set(cx, 0.03, cz);
      this.world.add(strip, edge);
      // its signpost: the kind, and every thing in it as a way in
      const rows = new Map<string, HTMLElement>();
      const el = h('div', { class: 'dm-lb dm-post' }, h('div', { class: 'dm-post-h', onclick: () => this.openKind(q.kind) }, KIND_NAME[q.kind], h('span', { class: 'c' }, q.list.length)),
        h('div', { class: 'dm-post-rows' }, q.list.map(({ w }) => {
          const r = this.reach(w.id);
          const b = h('button', { class: 'dm-post-r', title: w.what, onclick: () => this.select(this.sel?.k === 'world' && this.sel.id === w.id ? null : { k: 'world', id: w.id }, true),
            onmouseenter: () => this.setHover(null, this.lands.find(l => l.w.id === w.id) || null), onmouseleave: () => this.setHover(null, null) },
            h('span', { class: 'nm' }, w.name), r.drift ? h('i', { class: 'dr', title: `${r.drift} drift on its isles` }) : null,
            r.flows ? h('span', { class: 'n', title: `${r.flows} flow${r.flows > 1 ? 's' : ''} start or end here` }, r.flows) : null);
          rows.set(w.id, b);
          return b;
        })));
      this.labels.append(el);
      this.posts.push({ el, rows, kind: q.kind, p: new THREE.Vector3(cx + Math.cos(q.a) * ringR, 6.5 * LAND_SCALE, cz + Math.sin(q.a) * ringR) });
    }
    for (const { w, a, users } of want) {
      const x = cx + Math.cos(a) * ringR, z = cz + Math.sin(a) * ringR;
      const g = landmark(w.kind);
      g.position.set(x, 0, z); g.scale.setScalar(LAND_SCALE);
      g.rotation.y = -a + Math.PI / 2; // facing the archipelago
      const mats: THREE.Material[] = [], li = this.lands.length;
      g.traverse(o => { o.userData.land = li; const mt = (o as THREE.Mesh).material as THREE.Material | undefined; if (mt) mats.push(mt); o.castShadow = true; });
      this.world.add(g);
      // the name tag is a button: every thing in the real world is a way in
      const starts = m.flows.filter(f => f.start?.world === w.id).length;
      const label = h('div', { class: 'dm-lb dm-world', title: `${w.what}\nClick to start from here`, onclick: () => this.select({ k: 'world', id: w.id }, true) },
        w.name, starts ? h('span', { class: 'n', title: `Starts ${starts} flow${starts > 1 ? 's' : ''}` }, '▶ ' + starts) : null);
      this.labels.append(label);
      const land: Land = { w, x, z, g, label, mats };
      this.lands.push(land);
      // its ties up to the isles that stand for it: a plumb line down from the isle's tip, then a metro line
      // along the ground (rule 8) into the landmark
      for (const s of users) {
        const run = cutStart([...metroPath({ x: s.x, z: s.z }, { x, z })].reverse(), { x, z }, 3.2 * LAND_SCALE).reverse();
        const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(s.x, s.y - s.depth - 1, s.z), ...run.map(p => new THREE.Vector3(p.x, 0.12, p.z))]);
        const mat = new THREE.LineBasicMaterial({ color: '#5f665a', transparent: true, opacity: TETHER, depthWrite: false });
        const line = new THREE.Line(lg, mat);
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
    // session colours are pale neon made for the night city: ink() gives the deep day version of the hue
    const c = ink(new THREE.Color(color));
    color = '#' + c.getHexString();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.75, 14, 10), new THREE.MeshBasicMaterial({ color: c, toneMapped: false, fog: false }));
    const rotor = new THREE.Mesh(new THREE.TorusGeometry(1.35, 0.12, 6, 24), new THREE.MeshBasicMaterial({ color: '#1a1a1a', toneMapped: false, fog: false }));
    rotor.rotation.x = Math.PI / 2;
    g.add(body, rotor);
    const beam = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: c, toneMapped: false, fog: false }));
    beam.frustumCulled = false;
    // a halo in the session's colour just under the isle's top, wider than it, breathing: its rim
    // shows round the isle from the first, widest view
    const ring = new THREE.Mesh(new THREE.CircleGeometry(1, 64), new THREE.MeshBasicMaterial({ color: c, toneMapped: false, fog: false, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.renderOrder = 1;
    this.world.add(g, beam, ring);
    return { g, beam, ring, color, isle: null, house: -1, seen: 0, phase: (hashStr(color) % 628) / 100 };
  }
  // Which isles have a session at work on them now: their label carries a dot per session and always shows.
  private markLive(now: number) {
    const by = new Map<Isle, string[]>();
    for (const d of this.drones.values()) if (d.isle && now - d.seen < 1500) { if (!by.has(d.isle)) by.set(d.isle, []); by.get(d.isle)!.push(d.color); }
    for (const s of this.isles) {
      const cs = by.get(s) || [], key = cs.join(',');
      if ((s.label.dataset.live || '') === key) continue;
      s.label.dataset.live = key;
      s.label.classList.toggle('live', cs.length > 0);
      s.label.style.setProperty('--lc', cs[0] || '');
      s.label.querySelector('.lv')?.remove();
      if (cs.length) s.label.append(h('span', { class: 'lv', title: `${cs.length} session${cs.length > 1 ? 's' : ''} working here now` }, cs.map(c => h('i', { style: { background: c } }))));
      delete (s.label as any)._w;
    }
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
    if (this.links.length) this.walkLinks(dt);
    const now = performance.now();
    // the drone keeps a readable size on screen when zoomed out
    const grow = Math.max(1, this.stage.viewSize / 110);
    // a live isle's label is always shown, right over the isle's top, where the drone would hover:
    // lift the drone in screen terms until it clears the label (ortho camera, so px per unit is constant)
    const pr = this.stage.project(this.tmpV.set(0, 0, 0), { x: 0, y: 0, visible: false });
    const y0 = pr.y, x0 = pr.x;
    this.stage.project(this.tmpV.set(0, 1, 0), pr);
    const pxUp = Math.max(0.01, y0 - pr.y);
    this.stage.project(this.tmpV.set(1, 0, 0), pr);
    const pxSide = Math.max(0.01, Math.hypot(pr.x - x0, pr.y - y0));
    for (const [k, d] of this.drones) {
      const on = d.isle && now - d.seen < 1500;
      d.g.visible = d.beam.visible = d.ring.visible = !!on;
      if (!on) {
        if (now - d.seen > 60e3) { this.world.remove(d.g, d.beam, d.ring); d.ring.geometry.dispose(); (d.ring.material as THREE.Material).dispose(); this.drones.delete(k); }
        continue;
      }
      const s = d.isle!, a = t * 0.9 + d.phase;
      d.ring.position.set(s.x, s.g.position.y - 0.35, s.z);
      d.ring.scale.setScalar(s.r * 1.12 + (1.2 + 0.6 * Math.sin(t * 3 + d.phase)) * grow);
      (d.ring.material as THREE.MeshBasicMaterial).opacity = 0.6 + 0.3 * Math.sin(t * 3 + d.phase);
      d.g.scale.setScalar(grow);
      const dx = s.x + Math.cos(a) * s.r * 0.45, dz = s.z + Math.sin(a) * s.r * 0.45;
      const top = s.g.position.y + s.tall + 1.6; // where the label stands (placeLabels)
      const lh = (s.label as any)._h || 22, rotorPx = 1.5 * grow * pxSide;
      const ya = this.stage.project(this.tmpV.set(s.x, top, s.z), pr).y; // the label's bottom edge
      const yd = this.stage.project(this.tmpV.set(dx, top, dz), pr).y;   // the drone at that height
      const clear = top + 0.4 + Math.max(0, yd - (ya - lh - 10 - rotorPx)) / pxUp;
      d.g.position.set(dx, Math.max(s.g.position.y + Math.max(7, s.tall + 4) * Math.min(grow, 2), clear) + Math.sin(t * 2 + d.phase) * 0.4, dz);
      const hs = s.houses[d.house];
      const to = hs ? hs.mesh.getWorldPosition(this.tmpV).setY(s.g.position.y + hs.top) : this.tmpV.set(s.x, s.g.position.y, s.z);
      const pa = d.beam.geometry.attributes.position as THREE.BufferAttribute;
      pa.setXYZ(0, d.g.position.x, d.g.position.y, d.g.position.z); pa.setXYZ(1, to.x, to.y, to.z); pa.needsUpdate = true;
    }
    this.markLive(now);
    this.placeLabels();
  };

  // A name can be dragged off whatever it hides; a click without a drag still picks its thing.
  private dragLabel(el: HTMLElement, key: string, click: () => void) {
    const L = el as Lbl, c = this.stage.renderer.domElement;
    const save = () => { try { localStorage.setItem('vz-dmlabels:' + this.pid, JSON.stringify(Object.fromEntries(this.labelMan))); } catch { /* per browser only */ } };
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.stopPropagation(); e.preventDefault();
      const sx = e.clientX, sy = e.clientY, from = L._at ? { ...L._at } : { dx: 0, dy: 0 };
      let moved = false;
      el.setPointerCapture(e.pointerId);
      const mv = (ev: PointerEvent) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true; el.classList.add('dragging');
        this.labelMan.set(key, { dx: from.dx + dx, dy: from.dy + dy });
      };
      const up = () => {
        el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
        el.classList.remove('dragging');
        if (moved) save(); else click();
      };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    });
    el.addEventListener('dblclick', e => { e.stopPropagation(); if (this.labelMan.delete(key)) save(); });
    // the wheel still zooms the map over a name
    el.addEventListener('wheel', e => { e.preventDefault(); c.dispatchEvent(new WheelEvent('wheel', e)); }, { passive: false });
  }

  private placeLabels() {
    const box = this.el.getBoundingClientRect(), cb = this.canvasBox.getBoundingClientRect();
    const ox = cb.left - box.left, oy = cb.top - box.top;
    const taken: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const covers = [this.panel, ...this.occluders].filter(e => e.offsetParent).map(e => e.getBoundingClientRect()).filter(r => r.width);
    const blocked = (x0: number, y0: number, x1: number, y1: number) =>
      covers.some(c => x1 + box.left > c.left && x0 + box.left < c.right && y1 + box.top > c.top && y0 + box.top < c.bottom)
      || taken.some(r => x1 > r.x0 && x0 < r.x1 && y1 > r.y0 && y0 < r.y1);
    const out = { x: 0, y: 0, visible: false };
    // a working session's drone is the liveliest thing on the map: other labels keep off it
    for (const d of this.drones.values()) {
      if (!d.g.visible) continue;
      this.stage.project(d.g.position, out);
      const rr = 1.5 * d.g.scale.x * this.stage.el.clientHeight / this.stage.viewSize + 4;
      if (out.visible) taken.push({ x0: out.x + ox - rr, y0: out.y + oy - rr, x1: out.x + ox + rr, y1: out.y + oy + rr });
    }
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
    // each isle's screen outline: its top disc with the houses on it, and the narrower rock hanging under it.
    // Names must not hide another isle; an isle faded out of the focus is a soft obstacle only.
    type R = { x0: number; y0: number; x1: number; y1: number };
    const isleR: { s: Isle | Land; on: boolean; r: R[] }[] = [];
    const fs = this.focusSet;
    for (const s of this.isles) {
      const y = s.g.position.y;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, seen = false;
      for (let k = 0; k < 8; k++) {
        const a = k * Math.PI / 4;
        this.stage.project(this.tmpV.set(s.x + Math.cos(a) * s.r, y, s.z + Math.sin(a) * s.r), out);
        if (!out.visible) continue;
        seen = true; x0 = Math.min(x0, out.x); x1 = Math.max(x1, out.x); y0 = Math.min(y0, out.y); y1 = Math.max(y1, out.y);
      }
      if (!seen) continue;
      const top = this.stage.project(this.tmpV.set(s.x, y + s.tall, s.z), out).y;
      const bot = this.stage.project(this.tmpV.set(s.x, y - s.depth - 1.2, s.z), out).y;
      const cx = (x0 + x1) / 2, hw = (x1 - x0) * 0.32;
      isleR.push({ s, on: !fs || fs.has(s), r: [
        { x0: x0 + ox, y0: Math.min(y0, top) + oy, x1: x1 + ox, y1: y1 + oy },
        { x0: cx - hw + ox, y0: (y0 + y1) / 2 + oy, x1: cx + hw + ox, y1: Math.max(y1, bot) + oy },
      ] });
    }
    // the landmarks of the real world around the archipelago are things too: names keep off them the same way
    const ends = this.flowFx ? [this.flowFx.f.start?.world, this.flowFx.f.end?.world] : [];
    for (const l of this.lands) {
      const lb = (l as Land & { box?: THREE.Box3 });
      if (!lb.box || lb.box.isEmpty()) lb.box = new THREE.Box3().setFromObject(l.g);
      const { min, max } = lb.box;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, seen = false;
      for (let k = 0; k < 8; k++) {
        this.stage.project(this.tmpV.set(k & 1 ? max.x : min.x, k & 2 ? max.y : min.y, k & 4 ? max.z : min.z), out);
        if (!out.visible) continue;
        seen = true; x0 = Math.min(x0, out.x); x1 = Math.max(x1, out.x); y0 = Math.min(y0, out.y); y1 = Math.max(y1, out.y);
      }
      if (!seen) continue;
      const on = !fs || (this.sel?.k === 'world' && this.sel.id === l.w.id) || this.landInFocus(l) || ends.includes(l.w.id);
      const r = { x0: x0 + ox, y0: y0 + oy, x1: x1 + ox, y1: y1 + oy };
      isleR.push({ s: l, on, r: [r, r] });
    }
    const over = (a: R, x0: number, y0: number, x1: number, y1: number) =>
      Math.max(0, Math.min(a.x1, x1) - Math.max(a.x0, x0)) * Math.max(0, Math.min(a.y1, y1) - Math.max(a.y0, y0));
    const onIsles = (x0: number, y0: number, x1: number, y1: number, own: Isle | Land | null, pad: number) => {
      let hard = 0, soft = 0;
      for (const o of isleR) if (o.s !== own) for (const r of o.r) {
        const a = over(r, x0 - pad, y0 - pad, x1 + pad, y1 + pad);
        if (o.on) hard += a; else soft += a;
      }
      return { hard, soft };
    };
    const W = box.width, H = box.height;
    // A name stands over its point; where that hides another isle (or another name) it tries spots
    // further up, aside, beside or under its own isle, and a thin leader ties it back to its point.
    // A forced name (picked, in focus, live) takes the least bad spot; any other name hides instead.
    // A name the user dragged stays where it was put.
    const placeNear = (el: Lbl, p: THREE.Vector3, o: { force: boolean; show?: boolean; own?: Isle | Land | null; below?: boolean; key?: string; far?: boolean }) => {
      if (o.show === false) { el.style.display = 'none'; return; }
      this.stage.project(p, out);
      if (!out.visible) { el.style.display = 'none'; return; }
      if (!el._w) { el.style.display = ''; el._w = el.offsetWidth; el._h = el.offsetHeight; }
      const w = el._w || 80, hh = el._h || 18, ax = out.x + ox, ay = out.y + oy;
      const bx = ax - w / 2, by = o.below ? ay + 12 : ay - hh;
      const man = o.key ? this.labelMan.get(o.key) : undefined;
      let at = { dx: 0, dy: 0 };
      if (man) at = man;
      else {
        const dir = o.below ? 1 : -1, own = o.own || null;
        const cands: [number, number][] = [[0, 0], [0, dir * 12], [-w * 0.6, 0], [w * 0.6, 0], [0, dir * 24]];
        if (o.far) {
          cands.push([-w * 0.6, dir * 16], [w * 0.6, dir * 16], [0, dir * 38], [-w * 1.1, dir * 10], [w * 1.1, dir * 10]);
          const me = own && isleR.find(q => q.s === own);
          if (me) {
            const d = me.r[0], mid = (d.y0 + d.y1) / 2 - hh / 2;
            cands.push([d.x0 - 6 - w - bx, mid - by], [d.x1 + 6 - bx, mid - by], [ax - w / 2 - bx, me.r[1].y1 + 6 - by]);
          }
          for (let k = 3; k <= 8; k++) cands.push([0, dir * k * 18], [-w * 0.8, dir * k * 18], [w * 0.8, dir * k * 18]);
        }
        const score = (i: number) => {
          const x0 = bx + cands[i][0], y0 = by + cands[i][1], x1 = x0 + w, y1 = y0 + hh;
          let s = i * 0.5; // the nearer spots first
          if (x0 < 0 || y0 < 0 || x1 > W || y1 > H) s += 1e7;
          if (blocked(x0, y0, x1, y1)) s += 1e6;
          const hit = onIsles(x0, y0, x1, y1, own, 3);
          return s + hit.hard * 100 + hit.soft;
        };
        // keep last frame's spot while it is still clear, so names don't jump as the isles bob
        let best = 0, bestS = score(0);
        const last = el._ci ?? 0;
        if (bestS >= 1 && last > 0 && last < cands.length) { const s = score(last); if (s < last * 0.5 + 1) { best = last; bestS = s; } }
        if (bestS >= cands.length * 0.5 + 1) for (let i = 1; i < cands.length; i++) { const s = score(i); if (s < bestS) { best = i; bestS = s; } }
        if (!o.force && bestS >= 100) { el.style.display = 'none'; el._ci = 0; return; }
        el._ci = best;
        at = { dx: cands[best][0], dy: cands[best][1] };
      }
      el._at = at;
      const x = bx + at.dx, y = by + at.dy;
      el.style.display = '';
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      taken.push({ x0: x - 2, y0: y - 2, x1: x + w + 2, y1: y + hh + 2 });
      // the leader: from the name's nearest edge to its point
      const lx = ax - x, ly = ay - y, sx = Math.max(0, Math.min(w, lx)), sy = Math.max(0, Math.min(hh, ly)), len = Math.hypot(lx - sx, ly - sy);
      const moved = at.dx !== 0 || at.dy !== 0;
      if (moved && len > 4) {
        if (!el._ld) { el._ld = h('i', { class: 'dm-ldr' }); el.append(el._ld); }
        el._ld.style.display = '';
        el._ld.style.width = `${len.toFixed(1)}px`;
        el._ld.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) rotate(${Math.atan2(ly - sy, lx - sx).toFixed(3)}rad)`;
      } else if (el._ld) el._ld.style.display = 'none';
    };
    // a playing flow first: its caption, start and end, the step numbers
    const fx = this.flowFx;
    if (fx) {
      place(fx.caption, fx.courier.position, true, true, true);
      for (const el of fx.pins) place(el, (el as any)._p, true);
      for (const n of fx.nums) place(n.el, (n.el as any)._p, true);
    }
    // the real world first: its signposts are the ways in, so they always keep their place;
    // a thing's own tag shows while it is picked or pointed at, to tell which landmark it is
    const selW = this.sel?.k === 'world' ? this.sel.id : null;
    for (const l of this.lands) placeNear(l.label, this.tmpV.set(l.x, 0, l.z), { force: true, show: l.w.id === selW || l === this.hoverLand, own: l, below: true, far: true });
    // signposts of neighbouring quarters would overlap: one that does rises on a longer pole, or leans aside,
    // and where the full list has no room it folds to its heading (the list opens on hover).
    // People first (most flows start with them), then the smallest, so a crowded screen keeps as many as it can.
    const fr = { x0: this.frame.left - box.left + this.panelWidth(), y0: this.frame.top - box.top, x1: this.frame.right - box.left, y1: this.frame.bottom - box.top };
    type Post = HTMLElement & { _w?: number; _h?: number; _mw?: number; _mh?: number };
    const rankP = (q: (typeof this.posts)[number]) => q.kind === 'person' ? -1 : q.rows.size;
    // signposts are cards: they must never sit over the archipelago, so each isle's screen outline
    // (its top disc and the rock hanging under it) is off limits to them, faded or not
    const onIsle = (x0: number, y0: number, x1: number, y1: number) => { const o = onIsles(x0, y0, x1, y1, null, 6); return o.hard + o.soft > 0; };
    for (const q of [...this.posts].sort((a, b) => rankP(a) - rankP(b))) {
      const el = q.el as Post;
      this.stage.project(q.p, out);
      if (!el._w) {
        el.style.display = ''; el.classList.remove('mini'); el._w = el.offsetWidth; el._h = el.offsetHeight;
        el.classList.add('mini'); el._mw = el.offsetWidth; el._mh = el.offsetHeight;
      }
      let at: { x: number; y: number; k: number; w: number; hh: number; bx: number; mini: boolean } | null = null;
      for (const mini of [false, true]) {
        const w = (mini ? el._mw : el._w) || 120, hh = (mini ? el._mh : el._h) || 24, bx = out.x + ox - w / 2, by = out.y + oy - hh - 6;
        for (let k = 0; k < 6 && !at; k++) for (const dx of [0, -w * 0.55, w * 0.55, -w * 1.1, w * 1.1]) {
          const x = bx + dx, y = by - k * 26;
          if (x < fr.x0 || x + w > fr.x1 || y < fr.y0 || y + hh > fr.y1 || blocked(x, y, x + w, y + hh) || onIsle(x, y, x + w, y + hh)) continue;
          at = { x, y, k, w, hh, bx, mini }; break;
        }
        if (at) break;
      }
      if (!out.visible || !at) { el.style.display = 'none'; continue; }
      el.style.display = '';
      el.classList.toggle('mini', at.mini);
      el.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px)`;
      el.style.setProperty('--pole', `${6 + at.k * 26}px`);
      el.style.setProperty('--lean', `${(at.bx - at.x).toFixed(1)}px`);
      taken.push({ x0: at.x - 4, y0: at.y - 4, x1: at.x + at.w + 4, y1: at.y + at.hh + 4 });
    }
    // then what is selected or in focus, then the busiest isles
    const order = [...this.isles].sort((a, b) => this.rank(b) - this.rank(a));
    for (const s of order) placeNear(s.label, this.tmpV.set(s.x, s.g.position.y + s.tall + 1.6, s.z),
      { force: (this.isFocus(s) && !!this.focusSet) || !!s.label.dataset.live, own: s, key: 'isle:' + s.e.id, far: true });
    for (const g of this.groupLabels) place(g.el, g.p, false, !zoomed || g.el.classList.contains('dm-real'));
    for (const b of this.bridges) {
      const show = (this.hover && (b.a === this.hover || b.b === this.hover)) || (this.focusSet && this.focusSet.has(b.a) && this.focusSet.has(b.b)) || (zoomed && !this.focusSet);
      placeNear(b.label, b.mid, { force: false, show: !!show });
    }
  }
  private rank(s: Isle) { return (this.isFocus(s) && this.focusSet ? 1000 : 0) + (this.hover === s ? 2000 : 0) + (s.label.dataset.live ? 3000 : 0) + s.e.code.length + this.bridges.filter(b => b.a === s || b.b === s).length * 2; }
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
    for (const q of this.posts) for (const [id, b] of q.rows) b.classList.toggle('hov', l?.w.id === id);
    this.paintBridges();
  }
  // a fine line can't get wider: hover and focus darken it instead
  private paintBridges() {
    const fs = this.focusSet, s = this.hover;
    for (const b of this.bridges) {
      const hov = !!s && (b.a === s || b.b === s), on = !fs || (fs.has(b.a) && fs.has(b.b));
      b.mat.opacity = hov ? 1 : !on ? 0.08 : fs ? 0.95 : BRIDGE_A;
      b.mat.color.set(hov || (fs && on) ? '#111111' : BRIDGE);
    }
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
    // picking never zooms in: the focus already lights what belongs to it. The view only moves
    // (and widens if it must) when some of it is off screen: an isle picked from the panel,
    // a thing of the real world with its isles, a flow with its start and end on the ground ring.
    if (!fly || !s) return;
    const isle = s.k === 'entity' ? this.byId.get(s.id) : null;
    const land = s.k === 'world' ? this.lands.find(l => l.w.id === s.id) : null;
    const list = isle ? [isle] : this.focusSet ? [...this.focusSet] : [];
    const extra = s.k === 'flow' && this.flowFx ? this.flowFx.stations.filter(x => !x.isle).map(x => x.p) : land ? [new THREE.Vector3(land.x, 0, land.z)] : [];
    this.flyToSet(list, extra);
  }
  private flyToSet(list: Isle[], extra: THREE.Vector3[] = []) {
    if (!list.length && !extra.length) return;
    const pts = list.map(s => ({ p: new THREE.Vector3(s.x, s.y + s.tall, s.z), r: s.r + 4 }));
    // a start or end on the ground: wide enough for its pin's label
    for (const p of extra) pts.push({ p, r: 14 });
    if (this.inView(pts)) return;
    const to = this.frameAll(pts, 40, 60);
    this.stage.flyTo(to.x, to.z, Math.max(this.stage.viewSize, to.viewSize));
  }
  // Whether all these points (with their radius) are on screen now, right of the panel and inside the frame.
  private inView(pts: { p: THREE.Vector3; r: number }[]) {
    const cb = this.canvasBox.getBoundingClientRect(), pr = this.panel.getBoundingClientRect();
    const left = Math.max(this.frame.left, this.panel.style.display === 'none' ? 0 : pr.right) - cb.left, right = this.frame.right - cb.left;
    const top = this.frame.top - cb.top, bottom = this.frame.bottom - cb.top, px = cb.height / this.stage.viewSize;
    const out = { x: 0, y: 0, visible: false };
    return pts.every(({ p, r }) => {
      this.stage.project(p, out);
      const m = r * px * 0.6;
      return out.visible && out.x - m > left && out.x + m < right && out.y - m > top && out.y + m < bottom;
    });
  }
  // What the selection lights up; everything else fades back.
  private applyFocus() {
    const m = this.model, s = this.sel;
    // a reload while the same flow plays keeps its place
    const keep = this.flowFx && s?.k === 'flow' && this.flowFx.f.id === s.id ? { t: this.flowFx.t, playing: this.flowFx.playing } : null;
    this.clearFlow();
    this.clearLinks();
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
    this.paintBridges();
    // ties to the ground stay faint until something is in focus, or they cross the whole map
    for (const t of this.tethers) t.mat.opacity = !fs ? TETHER : fs.has(t.isle) ? (s?.k !== 'world' || t.land.w.id === s.id ? 0.8 : 0.3) : 0.04;
    const ends = this.flowFx ? [this.flowFx.f.start?.world, this.flowFx.f.end?.world] : [];
    for (const l of this.lands) {
      const me = s?.k === 'world' && s.id === l.w.id, on = !fs || me || this.landInFocus(l) || ends.includes(l.w.id);
      l.mats.forEach(mt => fade(mt, on ? 1 : 0.2));
      l.label.classList.toggle('sel', me); l.label.classList.toggle('faded', !on);
    }
    for (const q of this.posts) for (const [id, b] of q.rows) {
      const l = this.lands.find(x => x.w.id === id);
      b.classList.toggle('on', s?.k === 'world' && s.id === id);
      b.classList.toggle('faded', !!fs && !(s?.k === 'world' && s.id === id) && !(l && (this.landInFocus(l) || ends.includes(id))));
    }
    if (m && s) this.showLinks(s);
  }

  // The picked isle's bridges and ties down (or a landmark's ties up) carry a current running away
  // from the pick: thick dashes marching over the fine line, and a few beads riding it.
  private showLinks(s: NonNullable<Sel>) {
    const lines: THREE.Vector3[][] = [];
    const ptsOf = (l: THREE.Line) => { const a = l.geometry.attributes.position as THREE.BufferAttribute; return Array.from({ length: a.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(a, i)); };
    if (s.k === 'entity') {
      const isle = this.byId.get(s.id); if (!isle) return;
      for (const b of this.bridges) if (b.a === isle || b.b === isle) { const p = ptsOf(b.line); lines.push(b.a === isle ? p : p.reverse()); }
      for (const t of this.tethers) if (t.isle === isle) lines.push(ptsOf(t.line));
    } else if (s.k === 'world') {
      for (const t of this.tethers) if (t.land.w.id === s.id) lines.push(ptsOf(t.line).reverse());
    } else return;
    for (const pts of lines) {
      if (pts.length < 2) continue;
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i - 1].distanceTo(pts[i]));
      const len = cum[cum.length - 1]; if (len < 0.5) continue;
      const geo = new LineGeometry(); geo.setPositions(pts.flatMap(p => [p.x, p.y, p.z]));
      const mat = new LineMaterial({ color: 0x111111, linewidth: 3, dashed: true, dashSize: 1.4, gapSize: 1.6, transparent: true, depthWrite: false, toneMapped: false, fog: false } as any);
      const line = new Line2(geo, mat); line.computeLineDistances(); line.renderOrder = 4;
      const beads = Array.from({ length: Math.min(4, Math.max(1, Math.round(len / 18))) }, () => {
        const b = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8), new THREE.MeshBasicMaterial({ color: 0x111111, toneMapped: false, fog: false }));
        b.renderOrder = 4; this.world.add(b); return b;
      });
      this.world.add(line);
      this.links.push({ line, mat, beads, pts, cum, len, t: 0 });
    }
    this.walkLinks(0);
  }
  private walkLinks(dt: number) {
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const k of this.links) {
      if (!still) { k.t += dt; k.mat.dashOffset -= dt * 5; }
      k.beads.forEach((b, j) => {
        // evenly spaced along the line, riding out at a steady speed and starting over at the far end
        const d = ((k.t * 9) + j * k.len / k.beads.length) % k.len;
        let i = 0; while (i < k.cum.length - 2 && k.cum[i + 1] < d) i++;
        const seg = k.cum[i + 1] - k.cum[i];
        b.position.lerpVectors(k.pts[i], k.pts[i + 1], seg ? (d - k.cum[i]) / seg : 0);
        // fade in from the pick, out toward the far end
        const u = d / k.len;
        b.scale.setScalar(Math.max(0.15, Math.min(1, u * 6, (1 - u) * 6)));
      });
    }
  }
  private clearLinks() {
    for (const k of this.links) {
      this.world.remove(k.line, ...k.beads);
      k.line.geometry.dispose(); k.mat.dispose();
      for (const b of k.beads) { b.geometry.dispose(); (b.material as THREE.Material).dispose(); }
    }
    this.links = [];
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
    stations.unshift({ ...stations[0], p: sl ? new THREE.Vector3(sl.x, 6.5, sl.z) : stations[0].p, k: -1, isle: null, houses: [] });
    const last = stations[stations.length - 1];
    add(el ? new THREE.Vector3(el.x, 6.5, el.z) : last.p, n, null);
    const pts: THREE.Vector3[] = [stations[0].p.clone()];
    for (let j = 1; j < stations.length; j++) {
      const a = pts[pts.length - 1], p = stations[j].p;
      // station to station as a metro line (rule 8): straight, one diagonal, straight, its height going evenly
      if (a.distanceTo(p) > 0.01) pts.push(...lift(metroPath(a, p), a.y, p.y).slice(1));
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
      // a git project's map follows its commits by itself; without git there are no commits to follow, so updates stay manual
      : m && !st!.meta?.git && st!.meta?.changedCount ? btn(`Update · ${st!.meta.changedCount} changed`, 'Update the map from the files changed since it was built:\n' + st!.meta.changed.slice(0, 20).join('\n'), () => this.run('update'), 'chip mini go') : null);
    const meta = st?.meta;
    const auto = meta?.git ? h('label', { class: 'dm-auto', title: `Update the map when a commit can change the domain: a code file added, deleted or renamed, or a type, class, table, schema or route declared or dropped. Other commits wait and are read with the next update. Each update is ${meta.updateMode === 'patch' ? 'one short turn' : 'a short run'} of ${st?.llm || 'Sonnet'} over the diff.` },
      h('input', { type: 'checkbox', checked: meta.auto, onchange: (ev: Event) => api.domainStep(this.pid, 'auto', { on: (ev.target as HTMLInputElement).checked }).then(() => this.load(false)) }),
      'Auto-update') : null;
    const s_ = (n: number) => n === 1 ? '' : 's';
    const status = !meta ? '' : !meta.git ? (meta.changedCount ? '' : ' · up to date')
      : !meta.behind ? ' · up to date'
      : meta.waiting ? ` · ${meta.behind} commit${s_(meta.behind)} since, no domain change`
      : ` · ${meta.behind} new commit${s_(meta.behind)}`;
    fill(this.headInfo,
      working ? h('div', { class: 'dm-working', title: job!.why ? 'Why: ' + job!.why : '' }, h('span', { class: 'spinner sm' }),
        `${job!.kind === 'update' ? (job!.auto && job!.head ? `Updating for commit ${job!.head.slice(0, 7)}` : 'Updating') : 'Reading the code'} with ${job!.model || 'your model'} · `, since(job!.started))
      : job?.state === 'error' ? h('div', { class: 'dm-err' }, `Last run failed: ${job.error}`)
      : meta ? h('div', { title: [meta.head ? 'Map of commit ' + meta.head.slice(0, 7) : '', meta.cost ? `${money(meta.cost)} API-equiv. since the last full build` : ''].filter(Boolean).join('\n') },
        `Built ${ago(meta.builtAt)}${meta.model ? ' · ' + meta.model : ''}${meta.lastCost ? ` · last ${meta.kind === 'update' ? 'update' : 'build'} ${money(meta.lastCost)}` : meta.cost ? ' · ' + money(meta.cost) + ' API-equiv.' : ''}${status}`) : null,
      working ? null : auto);
    this.renderEmpty();
    const shown = m || this.busy() ? '' : 'none';
    if (this.panel.style.display !== shown) { this.panel.style.display = shown; this.host.onLayout(); }
    if (!m) { fill(this.tabsEl); fill(this.body); return; }
    const tabB = (t: Tab, label: string, badge?: number) => h('button', { class: 'tab' + (this.tab === t && !this.sel ? ' on' : ''), onclick: () => { this.tab = t; this.select(null); } },
      label, badge ? h('span', { class: 'tbadge' }, badge) : null);
    const driftN = m.assumptions.filter(a => !a.holds).length;
    fill(this.tabsEl, m.world.length ? tabB('start', 'Start from') : null, tabB('task', 'Next task'), tabB('flows', 'Flows'), tabB('drift', 'Drift', driftN), tabB('map', 'Map'));
    const sel = this.sel;
    const scroll = this.body.scrollTop;
    const typing = document.activeElement as HTMLTextAreaElement | null;
    const caret = typing?.classList.contains('dm-ta') ? typing.selectionStart : -1;
    if (sel) fill(this.body, this.card(sel));
    else fill(this.body, this.tab === 'start' && m.world.length ? this.startTab() : this.tab === 'task' || this.tab === 'start' ? this.taskTab() : this.tab === 'flows' ? this.flowsTab() : this.tab === 'drift' ? this.driftTab() : this.mapTab());
    this.body.scrollTop = scroll;
    const ta = caret >= 0 ? this.body.querySelector<HTMLTextAreaElement>('.dm-ta') : null;
    if (ta) { ta.focus(); ta.setSelectionRange(caret, caret); }
  }

  // What a thing in the real world reaches: flows it starts or ends, isles that stand for it, drift on them.
  private reach(id: string) {
    const m = this.model!;
    const ids = new Set(m.entities.filter(e => e.world.includes(id)).map(e => e.id));
    return {
      flows: m.flows.filter(f => f.start?.world === id || f.end?.world === id).length,
      isles: ids.size,
      drift: m.assumptions.filter(a => !a.holds && a.entities.some(e => ids.has(e))).length,
    };
  }
  // A signpost's heading: the panel's list of that kind
  private openKind(kind: WKind) {
    this.tab = 'start'; this.select(null);
    [...this.body.querySelectorAll('h3')].find(x => x.textContent === KIND_NAME[kind])?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  // Everyone and everything in the real world, by kind: pick one to start an investigation from it.
  private startTab() {
    const m = this.model!;
    return [h('p', { class: 'dm-help' }, 'Who and what the project serves, grouped as on the ground around the map. Pick one to see the flows it sets going, the isles that stand for it, and what is strained around it.'),
      ...KINDS.map(kind => this.sect(KIND_NAME[kind], m.world.filter(w => w.kind === kind).map(w => {
        const r = this.reach(w.id);
        return h('div', { class: 'dm-row', onclick: () => this.select({ k: 'world', id: w.id }, true) },
          h('div', { class: 'dm-row-t' }, w.name, r.drift ? h('span', { class: 'pill sev-high', title: 'Drift on its isles' }, r.drift + ' drift') : null),
          h('div', { class: 'dm-row-s' }, w.what),
          h('div', { class: 'dm-row-s' }, `${r.flows} flow${r.flows === 1 ? '' : 's'} · ${r.isles} isle${r.isles === 1 ? '' : 's'}`));
      })))];
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
      h('p', { class: 'dim' }, `Uses ${st?.llm || 'Sonnet'} through your own ${st?.cli || 'Claude Code'}, with read-only tools, from the project folder. ${st?.cli === 'Codex' ? 'Codex has no spending cap: the cost shows when the run ends.' : 'Capped at $10 API-equivalent.'} Later updates only re-read what changed.`),
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
      ...m.flows.map(f => this.flowRow(f))];
  }
  private flowRow(f: DFlow) {
    const via = f.steps.map(s => this.byId.get(s.e)?.e.name).filter((x, i, a) => x && a[i - 1] !== x);
    const who = this.flowWho(f);
    return h('div', { class: 'dm-row', onclick: () => this.select({ k: 'flow', id: f.id }, true) },
      h('div', { class: 'dm-row-t' }, f.name, h('span', { class: 'pill fl-' + f.status }, FLOW[f.status])),
      h('div', { class: 'dm-row-s' }, h('span', {}, who ? [h('b', {}, '▶ ' + who), ' → '] : null, via.join(' → '))),
      f.end?.outcome ? h('div', { class: 'dm-row-s' }, '■ ' + f.end.outcome) : null);
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
      ...KINDS.map(kind => this.sect('The real world · ' + KIND_NAME[kind], m.world.filter(w => w.kind === kind).map(w => h('div', { class: 'dm-row', onclick: () => this.select({ k: 'world', id: w.id }, true) },
        h('div', { class: 'dm-row-t' }, w.name), h('div', { class: 'dm-row-s' }, w.what))))),
    ];
  }

  private card(s: NonNullable<Sel>) {
    const m = this.model!;
    const back = h('button', { class: 'dm-back', onclick: () => this.select(null) }, '← ', { start: 'Start from', task: 'Next task', flows: 'Flows', drift: 'Drift', map: 'Map' }[this.tab]);
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
      // a starting point: what it sets going, what comes back to it, where it lives in the code, what is wrong around it
      const w = m.world.find(x => x.id === s.id); if (!w) return back;
      const ents = m.entities.filter(e => e.world.includes(w.id)), ids = new Set(ents.map(e => e.id));
      const starts = m.flows.filter(f => f.start?.world === w.id);
      const ends = m.flows.filter(f => f.end?.world === w.id && !starts.includes(f));
      const passes = m.flows.filter(f => !starts.includes(f) && !ends.includes(f) && f.steps.some(x => ids.has(x.e)));
      const asm = m.assumptions.filter(a => a.entities.some(id => ids.has(id)));
      const drift = asm.filter(a => !a.holds), rules = asm.filter(a => a.holds);
      const files = new Set(ents.flatMap(e => e.code.map(c => c.p)));
      const weak = ents.filter(e => e.status !== 'solid');
      const live = [...this.drones.values()].filter(d => d.isle && ids.has(d.isle.e.id) && d.g.visible);
      const asmRow = (a: DAssumption) => h('div', { class: 'dm-row' + (a.holds ? '' : ' drift'), onclick: () => this.select({ k: 'assumption', id: a.id }, true) },
        h('div', { class: 'dm-row-t' }, a.text, a.holds ? null : h('span', { class: 'pill sev-' + a.severity }, a.severity)));
      const brief = () => { this.tab = 'task'; this.draft = `${w.name}: `; this.select(null);
        const ta = this.body.querySelector<HTMLTextAreaElement>('.dm-ta'); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } };
      return [back, h('div', { class: 'dm-kicker' }, 'Real world · ' + KIND_NAME[w.kind]), h('h2', {}, w.name), h('p', {}, w.what),
        h('div', { class: 'dm-facts' },
          h('span', {}, h('b', {}, ents.length), ents.length === 1 ? ' isle' : ' isles'),
          h('span', {}, h('b', {}, files.size), files.size === 1 ? ' file' : ' files'),
          h('span', {}, h('b', {}, starts.length + ends.length + passes.length), ' flows'),
          drift.length ? h('span', { class: 'red' }, h('b', {}, drift.length), ' drift') : null),
        live.length ? h('div', { class: 'dm-live' }, live.map(d => h('i', { style: { background: d.color } })), `${live.length} session${live.length > 1 ? 's' : ''} working on it now`) : null,
        h('div', { class: 'dm-actions' }, h('button', { class: 'chip mini', onclick: brief, title: 'Write the next task with this as its subject' }, 'Brief a task about it')),
        this.sect('Starts these flows', starts.map(f => this.flowRow(f))),
        this.sect('Flows that end here', ends.map(f => this.flowRow(f))),
        this.sect('Stands for it in the code', ents.length ? h('div', { class: 'dm-chips' }, ents.map(e => this.chipE(e.id))) : null),
        this.sect('Not solid yet', weak.map(e => h('div', { class: 'dm-row', onclick: () => this.select({ k: 'entity', id: e.id }, true) },
          h('div', { class: 'dm-row-t' }, e.name, h('span', { class: 'pill st-' + e.status }, STATUS[e.status])), e.statusWhy ? h('div', { class: 'dm-row-s' }, e.statusWhy) : null))),
        this.sect('Drift around it', drift.map(asmRow)),
        this.sect('Other flows through its isles', passes.map(f => this.flowRow(f))),
        this.sect('Rules to keep', rules.map(asmRow)),
        !ents.length && !starts.length && !ends.length ? h('p', { class: 'dim' }, 'Nothing in the code is tied to it yet.') : null];
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

// ------------------------------------------------------------------ layout
// One optimisation over everything an isle is tied to: the isles it relates to, the isles a flow
// hops to from it, and the thing in the real world it stands for. The real world stands on a ring
// around the archipelago in quarters by kind, re-placed as the isles settle, so an isle drifts to the
// side its landmark is on and its tie down stays short. Then, like the metro maps' rule 10, the
// busiest isles sit in the middle, isles tied to nothing go to the edges, and isles of a size swap
// places wherever that makes the lines shorter. Deterministic, so the map keeps its shape between loads.
const ISLE_GAP = 30, GROUP_GAP = 48; // open sky between neighbouring isles, and between archipelagos
const RING_SPACE = 13, RING_GAP = 26; // ring length between neighbours in a quarter, and between quarters
const RING_K = 1.18; // the ring's radius over the archipelago's (plus ISLE_Y): room for the signposts, no more
type WorldThing = DomainModel['world'][number];
function ringRadius(R: number, world: WorldThing[]) {
  const kindsIn = KINDS.filter(k => world.some(w => w.kind === k)).length;
  return Math.max(R * RING_K + ISLE_Y,((world.length - kindsIn) * RING_SPACE + kindsIn * RING_GAP) / (Math.PI * 2 * 0.9));
}
// The real world's quarters on a ring of radius ringR: each quarter centred on where its things pull,
// pushed apart until none overlap; each thing's angle `a` is rewritten to its final place.
function ringQuarters<T extends { w: WorldThing; a: number }>(want: T[], ringR: number) {
  const step = RING_SPACE / ringR, gapA = RING_GAP / ringR;
  const quarters = KINDS.map(kind => {
    const list = want.filter(x => x.w.kind === kind);
    if (!list.length) return null;
    const a = Math.atan2(list.reduce((s, x) => s + Math.sin(x.a), 0), list.reduce((s, x) => s + Math.cos(x.a), 0));
    // inside the quarter, each thing keeps its side: sorted by where its isles pull it
    list.sort((p, q) => Math.atan2(Math.sin(p.a - a), Math.cos(p.a - a)) - Math.atan2(Math.sin(q.a - a), Math.cos(q.a - a)));
    return { kind, list, a, half: (list.length - 1) * step / 2 };
  }).filter(Boolean).sort((p, q) => p!.a - q!.a) as { kind: WKind; list: T[]; a: number; half: number }[];
  for (let it = 0; it < 120 && quarters.length > 1; it++) {
    let moved = false;
    for (let j = 0; j < quarters.length; j++) {
      const p = quarters[j], q = quarters[(j + 1) % quarters.length];
      let gap = q.a - p.a; if (j === quarters.length - 1) gap += Math.PI * 2;
      const need = p.half + q.half + gapA;
      if (gap < need) { const d = (need - gap) / 2; p.a -= d; q.a += d; moved = true; }
    }
    if (!moved) break;
  }
  for (const q of quarters) q.list.forEach((x, j) => { x.a = q.a - q.half + j * step; });
  return quarters;
}

function layout(m: DomainModel) {
  const radius = (e: DEntity) => e.status === 'missing' ? 3.6 : 4 + Math.sqrt(e.code.length) * 1.5;
  const E = m.entities, n = E.length;
  const idx = new Map(E.map((e, i) => [e.id, i]));
  // ties between isles, weighted: a relation 1, each hop of a flow 0.5 (summed, capped)
  const tieW = new Map<string, number>();
  const tie = (a: number | undefined, b: number | undefined, w: number) => {
    if (a == null || b == null || a === b) return;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`; tieW.set(k, Math.min(2.5, (tieW.get(k) || 0) + w));
  };
  for (const r of m.relations) tie(idx.get(r.a), idx.get(r.b), 1);
  // ties down to the real world: what an isle stands for 1, where a flow starts or ends 0.5
  const down = new Map<string, Map<number, number>>(m.world.map(w => [w.id, new Map()]));
  const tieDown = (wid: string | null | undefined, i: number | undefined, w: number) => {
    const d = wid ? down.get(wid) : null; if (!d || i == null) return; d.set(i, Math.min(2, (d.get(i) || 0) + w));
  };
  E.forEach((e, i) => { for (const w of e.world) tieDown(w, i, 1); });
  for (const f of m.flows) {
    const seq = f.steps.map(s => idx.get(s.e)).filter((x): x is number => x != null);
    for (let j = 1; j < seq.length; j++) tie(seq[j - 1], seq[j], 0.5);
    tieDown(f.start?.world, seq[0], 0.5); tieDown(f.end?.world, seq[seq.length - 1], 0.5);
  }
  const ties = [...tieW].map(([k, w]) => { const [a, b] = k.split('|').map(Number); return { a, b, w }; });
  const deg = new Float64Array(n);
  for (const t of ties) { deg[t.a] += t.w; deg[t.b] += t.w; }
  for (const d of down.values()) for (const [i, w] of d) deg[i] += w * 0.5;

  // a first guess: archipelagos around a ring, linked ones side by side, isles in a sunflower
  const groups = m.groups.map(g => ({ g, list: E.map((e, i) => i).filter(i => E[i].group === g.id).sort((a, b) => deg[b] - deg[a]) })).filter(x => x.list.length);
  const gOf = E.map(e => e.group);
  const gw = new Map<string, number>();
  for (const t of ties) { const a = gOf[t.a], b = gOf[t.b]; if (a !== b) { const k = [a, b].sort().join('|'); gw.set(k, (gw.get(k) || 0) + t.w); } }
  const ring: typeof groups = [];
  const left = [...groups].sort((a, b) => b.list.length - a.list.length);
  if (left.length) ring.push(left.shift()!);
  while (left.length) {
    const last = ring[ring.length - 1].g.id;
    left.sort((a, b) => (gw.get([b.g.id, last].sort().join('|')) || 0) - (gw.get([a.g.id, last].sort().join('|')) || 0));
    ring.push(left.shift()!);
  }
  const P = E.map(e => ({ x: 0, z: 0, r: radius(e) }));
  const gR = ring.map(x => 14 + Math.sqrt(x.list.reduce((s, i) => s + P[i].r ** 2, 0)) * 3.6);
  const circ = gR.reduce((s, r) => s + r * 2 + GROUP_GAP, 0);
  const R0 = ring.length > 1 ? Math.max(circ / (2 * Math.PI), gR[0] + 6) : 0;
  let ang = 0;
  ring.forEach((x, gi) => {
    const share = (gR[gi] * 2 + GROUP_GAP) / circ * Math.PI * 2;
    const a = ang + share / 2; ang += share;
    x.list.forEach((i, k) => { const t = k * 2.399, d = k ? 16 * Math.sqrt(k) : 0; P[i].x = Math.cos(a) * R0 + Math.cos(t) * d; P[i].z = Math.sin(a) * R0 + Math.sin(t) * d; });
  });
  const members = groups.map(x => x.list);

  // the real world on its ring, placed from where its isles are now
  const wpos = new Map<string, { x: number; z: number; a: number }>();
  const placeWorld = () => {
    let cx = 0, cz = 0; for (const p of P) { cx += p.x; cz += p.z; } cx /= n || 1; cz /= n || 1;
    let R = 30; for (const p of P) R = Math.max(R, Math.hypot(p.x - cx, p.z - cz) + p.r);
    const ringR = ringRadius(R, m.world);
    const want = m.world.map((w, k) => {
      let vx = 0, vz = 0; for (const [i, wt] of down.get(w.id)!) { vx += (P[i].x - cx) * wt; vz += (P[i].z - cz) * wt; }
      return { w, a: Math.hypot(vx, vz) > 1 ? Math.atan2(vz, vx) : k / Math.max(1, m.world.length) * Math.PI * 2 };
    });
    ringQuarters(want, ringR);
    for (const x of want) wpos.set(x.w.id, { x: cx + Math.cos(x.a) * ringR, z: cz + Math.sin(x.a) * ringR, a: x.a });
    return { cx, cz, R };
  };
  let ctr = { cx: 0, cz: 0, R: 30 };
  const repel = (f0: number) => {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const p = P[i], q = P[j], dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz) || 0.01;
      const min = p.r + q.r + ISLE_GAP + (gOf[i] === gOf[j] ? 0 : 12);
      if (d < min) { const f = (min - d) / d * f0; p.x -= dx * f; p.z -= dz * f; q.x += dx * f; q.z += dz * f; }
    }
  };
  const IT = 600;
  for (let it = 0; it < IT; it++) {
    const k = 1 - it / IT;
    if (it % 25 === 0) ctr = placeWorld();
    // ties pull isles to a comfortable span, never closer than their open sky
    for (const t of ties) {
      const p = P[t.a], q = P[t.b], dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz) || 1;
      const want = p.r + q.r + ISLE_GAP + 8, f = (d - want) / d * 0.03 * k * t.w;
      p.x += dx * f; p.z += dz * f; q.x -= dx * f; q.z -= dz * f;
    }
    // each archipelago holds together
    for (const list of members) {
      let gx = 0, gz = 0; for (const i of list) { gx += P[i].x; gz += P[i].z; } gx /= list.length; gz /= list.length;
      for (const i of list) { P[i].x += (gx - P[i].x) * 0.012 * k; P[i].z += (gz - P[i].z) * 0.012 * k; }
    }
    // the busiest to the middle; an isle tied to nothing gets no pull and drifts to the edge
    for (let i = 0; i < n; i++) { const c = 0.0012 * k * Math.min(deg[i], 6); P[i].x -= P[i].x * c; P[i].z -= P[i].z * c; }
    // and toward the side its real-world things stand on: a point half-way out on that side, not the ring
    // itself, or the archipelago would grow toward the ring and push the ring out after it
    for (const [wid, d] of down) {
      const w = wpos.get(wid); if (!w) continue;
      const tx = ctr.cx + Math.cos(w.a) * ctr.R * 0.5, tz = ctr.cz + Math.sin(w.a) * ctr.R * 0.5;
      for (const [i, wt] of d) { const f = 0.006 * k * wt; P[i].x += (tx - P[i].x) * f; P[i].z += (tz - P[i].z) * f; }
    }
    repel(0.5);
  }
  // swaps: two isles of about one size trade places when that shortens the lines they draw
  const at = (i: number, x: number, z: number) => {
    let c = 0;
    for (const t of ties) if (t.a === i || t.b === i) { const o = P[t.a === i ? t.b : t.a]; c += t.w * Math.hypot(o.x - x, o.z - z); }
    for (const [wid, d] of down) { const wt = d.get(i); const w = wpos.get(wid); if (wt && w) c += wt * 0.6 * Math.hypot(w.x - x, w.z - z); }
    return c;
  };
  placeWorld();
  for (let round = 0; round < 4; round++) {
    let swapped = false;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (gOf[i] !== gOf[j] || Math.abs(P[i].r - P[j].r) > 2.5) continue;
      const before = at(i, P[i].x, P[i].z) + at(j, P[j].x, P[j].z);
      const pi = { x: P[i].x, z: P[i].z };
      P[i].x = P[j].x; P[i].z = P[j].z; P[j].x = pi.x; P[j].z = pi.z;
      if (at(i, P[i].x, P[i].z) + at(j, P[j].x, P[j].z) < before - 1) swapped = true;
      else { P[j].x = P[i].x; P[j].z = P[i].z; P[i].x = pi.x; P[i].z = pi.z; }
    }
    if (!swapped) break;
    placeWorld();
  }
  for (let it = 0; it < 60; it++) repel(0.5);
  // a ring sized by its many real-world things leaves open sky between it and the archipelago:
  // spread the isles out to fill it (same shape, same angles), so they are not piled in the middle
  {
    const { cx, cz, R } = placeWorld();
    const s = Math.min(1.8, (ringRadius(0, m.world) - ISLE_Y) / RING_K / R);
    if (s > 1.02) for (const p of P) { p.x = cx + (p.x - cx) * s; p.z = cz + (p.z - cz) * s; }
  }
  const { cx, cz } = placeWorld();
  const pos = new Map<string, { x: number; z: number; r: number }>();
  E.forEach((e, i) => pos.set(e.id, { x: P[i].x - cx, z: P[i].z - cz, r: P[i].r }));
  // angles are about the centre, which the shift does not change
  const worldA = new Map([...wpos].map(([id, w]) => [id, w.a]));
  return { pos, worldA };
}

// ------------------------------------------------------------------ metro lines
// Lines are drawn by the rules of the schematic layer (schematic.ts, rules 8, 9, 12, after Beck's
// Underground map): taut, straight out, at most one 45° diagonal, straight in; every bend the same
// radius; a light casing so two lines crossing stay two lines; lines leaving an isle the same way each
// keep their own lane.
type P2 = { x: number; z: number };
const BEND = 3.5, LANE = 1.9;
function metroPath(a: P2, b: P2): P2[] {
  const dx = b.x - a.x, dz = b.z - a.z, ax = Math.abs(dx), az = Math.abs(dz);
  const major = Math.max(ax, az), minor = Math.min(ax, az);
  if (minor < 0.4 || major - minor < 0.4) return [a, b]; // already one straight run
  const sx = Math.sign(dx), sz = Math.sign(dz), run = (major - minor) / 2;
  const p1 = ax > az ? { x: a.x + sx * run, z: a.z } : { x: a.x, z: a.z + sz * run };
  const p2 = { x: p1.x + sx * minor, z: p1.z + sz * minor };
  return fillet([a, p1, p2, b]);
}
// The direction a metro line leaves a from (toward b), as one of 8.
function exitDir(a: P2, b: P2): P2 {
  const p = metroPath(a, b), q = p[1], d = Math.hypot(q.x - a.x, q.z - a.z) || 1;
  return { x: (q.x - a.x) / d, z: (q.z - a.z) / d };
}
// Round each corner with the same radius (less where a run is too short to hold it).
function fillet(pts: P2[]): P2[] {
  const out: P2[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], c = pts[i], b = pts[i + 1];
    const l0 = Math.hypot(c.x - a.x, c.z - a.z), l1 = Math.hypot(b.x - c.x, b.z - c.z);
    const t = Math.min(BEND, l0 / 2, l1 / 2);
    if (t < 0.05) { out.push(c); continue; }
    const s = { x: c.x + (a.x - c.x) / l0 * t, z: c.z + (a.z - c.z) / l0 * t }, e = { x: c.x + (b.x - c.x) / l1 * t, z: c.z + (b.z - c.z) / l1 * t };
    for (let k = 0; k <= 4; k++) { const u = k / 4, v = 1 - u; out.push({ x: v * v * s.x + 2 * v * u * c.x + u * u * e.x, z: v * v * s.z + 2 * v * u * c.z + u * u * e.z }); }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
// Drop the start of a line that lies inside a circle (an isle's rim), cutting at the rim.
function cutStart(pts: P2[], c: P2, r: number): P2[] {
  const inside = (p: P2) => Math.hypot(p.x - c.x, p.z - c.z) < r;
  let i = 0; while (i < pts.length - 1 && inside(pts[i + 1])) i++;
  if (i >= pts.length - 1) return pts.slice(-1);
  const a = pts[i], b = pts[i + 1];
  if (!inside(a)) return pts.slice(i);
  let lo = 0, hi = 1;
  for (let k = 0; k < 20; k++) { const m = (lo + hi) / 2; if (inside({ x: a.x + (b.x - a.x) * m, z: a.z + (b.z - a.z) * m })) lo = m; else hi = m; }
  return [{ x: a.x + (b.x - a.x) * hi, z: a.z + (b.z - a.z) * hi }, ...pts.slice(i + 1)];
}
// A plan line raised into the scene, its height going evenly from y0 to y1 along its length.
function lift(pts: P2[], y0: number, y1: number): THREE.Vector3[] {
  const L = pathLen(pts) || 1;
  let s = 0;
  return pts.map((p, i) => { if (i) s += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z); return new THREE.Vector3(p.x, y0 + (y1 - y0) * s / L, p.z); });
}
// The point a fraction t of the way along a line.
function alongAt(pts: THREE.Vector3[], t: number) {
  let L = 0; for (let i = 1; i < pts.length; i++) L += pts[i].distanceTo(pts[i - 1]);
  let want = L * t;
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i].distanceTo(pts[i - 1]);
    if (want <= d) return pts[i - 1].clone().lerp(pts[i], d ? want / d : 0);
    want -= d;
  }
  return pts[pts.length - 1].clone();
}
function pathLen(pts: P2[]) { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z); return s; }
