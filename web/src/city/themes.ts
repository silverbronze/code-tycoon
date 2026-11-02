import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { City } from '../api';

// District looks. Every district carries a style from a closed catalog (server/roles.mjs
// STYLES): the base roles by id, a project's own districts by the summarizer's pick or
// by keywords, so a project with "Game engine" or "ML models" gets a look too. A style
// is a facade pattern (drawn in the building shader, world.ts) plus a roof piece on
// every building (here) and props on the district's ground (dressing.ts).
export type Style = 'shops' | 'vault' | 'fortress' | 'bank' | 'factory' | 'power' | 'lab' | 'media' | 'gallery' | 'library'
  | 'workshop' | 'offices' | 'campus' | 'port' | 'civic' | 'homes';
const GENERIC: Style[] = ['offices', 'workshop', 'homes', 'civic', 'campus', 'port'];
const KNOWN = new Set<string>(['shops', 'vault', 'fortress', 'bank', 'factory', 'power', 'lab', 'media', 'gallery', 'library', 'workshop', 'offices', 'campus', 'port', 'civic', 'homes']);

// An older server sends no style: same hash fallback as the server.
const ROLE: Record<string, Style> = { storefront: 'shops', database: 'vault', security: 'fortress', payments: 'bank', pipeline: 'factory', infra: 'power', qa: 'lab',
  marketing: 'media', brand: 'gallery', docs: 'library', workspace: 'workshop', api: 'offices' };
export function styleOf(d: City['districts'][number]): Style {
  if (d.style && KNOWN.has(d.style)) return d.style as Style;
  const r = ROLE[d.id] || ROLE[d.kind || ''];
  if (r) return r;
  let h = 0; for (const ch of d.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return GENERIC[h % GENERIC.length];
}

// Facade patterns, read by the building shader (aFacade).
export const FACADE: Record<Style, number> = {
  offices: 1, campus: 1, vault: 2, power: 2, gallery: 2, fortress: 3, shops: 4, bank: 5, civic: 5,
  factory: 6, workshop: 6, port: 6, lab: 7, homes: 8, media: 9, library: 10,
};

// File buildings take their shape from the file type: code stands slim and tall,
// config and data spread wide and low, docs sit in between, assets are small.
export const SHAPE: Record<string, { w: number; h: number; max: number }> = {
  code: { w: 0.62, h: 1.15, max: 9 }, markup: { w: 0.7, h: 0.95, max: 7 }, style: { w: 0.7, h: 0.8, max: 5 },
  doc: { w: 0.76, h: 0.75, max: 4 }, config: { w: 0.86, h: 0.42, max: 1.4 }, data: { w: 0.88, h: 0.5, max: 1.8 },
  asset: { w: 0.55, h: 0.6, max: 2.5 }, other: { w: 0.68, h: 0.8, max: 5 },
};

// ---- roof pieces ------------------------------------------------------------------
const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z);
const cyl = (r0: number, r1: number, h: number, x = 0, y = 0, z = 0, seg = 10) => new THREE.CylinderGeometry(r0, r1, h, seg).translate(x, y + h / 2, z);
// a prism along x with a triangular end: apex at fraction `apex` across z (0.5 gable, 0 lean-to)
function prism(w: number, h: number, d: number, apex = 0.5, y = 0) {
  const s = new THREE.Shape();
  s.moveTo(-d / 2, 0); s.lineTo(d / 2, 0); s.lineTo(-d / 2 + d * apex, h); s.closePath();
  return new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: false }).rotateY(Math.PI / 2).translate(-w / 2, y, 0);
}
function dome(r: number, y = 0, x = 0, z = 0) { return new THREE.SphereGeometry(r, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2).translate(x, y, z); }
function merge(...g: THREE.BufferGeometry[]) {
  const flat = g.map(x => { const n = x.index ? x.toNonIndexed() : x; for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal') n.deleteAttribute(k); return n; });
  return mergeGeometries(flat)!;
}

// fit 'span': x/z follow the footprint, y the shorter side (gables, parapets);
// 'round': all three follow the shorter side (domes, masts). glow: lit by the
// instance colour (signs, screens, lamps); others take the material colour.
interface Piece { geo: THREE.BufferGeometry; color: string; fit: 'span' | 'round'; glow?: boolean; at?: 'roof' | 'ground'; tall?: number; chance?: number; tag?: 'chimney' | 'lamp' | 'screen' | 'sign' }
function pieces(): Record<Style, Piece[]> {
  return {
    shops: [
      { geo: merge(box(0.8, 0.24, 0.05, 0, 0.16, 0.3), box(0.04, 0.16, 0.04, -0.3, 0, 0.3), box(0.04, 0.16, 0.04, 0.3, 0, 0.3)), color: '#ffffff', fit: 'span', glow: true, tag: 'sign' },
      { geo: prism(1.06, 0.07, 0.26, 1, 0).rotateX(0).translate(0, 0.32, 0.6), color: '#c2475b', fit: 'span', at: 'ground' },
    ],
    vault: [{ geo: merge(box(0.2, 0.12, 0.2, -0.2, 0, -0.15), box(0.2, 0.12, 0.2, 0.2, 0, 0.15), box(1.0, 0.04, 1.0)), color: '#59606d', fit: 'span' }],
    fortress: [{ geo: merge(...[[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]].map(([x, z]) => box(0.18, 0.18, 0.18, x * 0.41, 0, z * 0.41))), color: '#6d6a66', fit: 'span' }],
    bank: [
      { geo: merge(prism(1.04, 0.26, 1.04, 0.5, 0.05), box(1.06, 0.05, 1.06)), color: '#d9c38c', fit: 'span' },
      { geo: merge(box(1.08, 0.06, 0.2, 0, 0, 0.58), ...[-0.36, -0.12, 0.12, 0.36].map(x => cyl(0.045, 0.05, 0.5, x, 0.06, 0.58, 8)), box(1.08, 0.07, 0.16, 0, 0.56, 0.58)), color: '#e8dcc0', fit: 'span', at: 'ground' },
    ],
    factory: [
      { geo: merge(prism(1, 0.22, 0.5, 0, 0).translate(0, 0, -0.25), prism(1, 0.22, 0.5, 0, 0).translate(0, 0, 0.25)), color: '#7a5a4a', fit: 'span' },
      { geo: cyl(0.06, 0.085, 0.9, 0.3, 0, -0.3), color: '#8a4b3a', fit: 'round', tag: 'chimney' },
    ],
    power: [{ geo: merge(box(0.4, 0.22, 0.3, -0.15, 0, 0), cyl(0.04, 0.04, 0.3, 0.25, 0, -0.2, 6), cyl(0.04, 0.04, 0.3, 0.25, 0, 0.2, 6), box(0.05, 0.05, 0.5, 0.25, 0.28, 0)), color: '#6c7584', fit: 'span' }],
    lab: [
      { geo: dome(0.34), color: '#cfd8e6', fit: 'round' },
      { geo: new THREE.SphereGeometry(0.08, 8, 6).translate(0.36, 0.1, 0.36), color: '#ffffff', fit: 'round', glow: true, tag: 'lamp' },
    ],
    media: [{ geo: merge(box(0.92, 0.46, 0.05, 0, 0.3, 0)), color: '#ffffff', fit: 'span', glow: true, tag: 'screen' },
      { geo: merge(box(0.05, 0.32, 0.05, -0.35, 0, 0.05), box(0.05, 0.32, 0.05, 0.35, 0, 0.05)), color: '#3a4152', fit: 'span' }],
    gallery: [{ geo: new THREE.ConeGeometry(0.5, 0.42, 4).rotateY(Math.PI / 4).translate(0, 0.21, 0), color: '#9fd8ff', fit: 'span', glow: true }],
    library: [
      { geo: merge(prism(1.04, 0.3, 1.04, 0.5, 0), box(1.06, 0.04, 1.06)), color: '#5b4636', fit: 'span' },
      { geo: merge(box(0.9, 0.06, 0.18, 0, 0, 0.56), ...[-0.3, 0, 0.3].map(x => cyl(0.04, 0.045, 0.42, x, 0.06, 0.56, 8))), color: '#d8cfbd', fit: 'span', at: 'ground' },
    ],
    workshop: [{ geo: prism(1.02, 0.26, 1.02, 0, 0), color: '#5d6168', fit: 'span' }],
    offices: [
      { geo: merge(box(0.5, 0.08, 0.5), cyl(0.02, 0.025, 0.9, 0.15, 0.08, 0.1, 6), cyl(0.015, 0.02, 0.6, -0.12, 0.08, -0.1, 6)), color: '#7c8aa0', fit: 'round', tall: 3 },
      { geo: box(0.9, 0.05, 0.9), color: '#3f7a46', fit: 'span', chance: 0.25 },
    ],
    campus: [{ geo: merge(cyl(0.3, 0.3, 0.12, 0, 0, 0, 16), dome(0.3, 0.12)), color: '#b9c3d6', fit: 'round' },
      { geo: merge(cyl(0.02, 0.03, 0.2, 0.32, 0, 0.3, 6), new THREE.ConeGeometry(0.16, 0.08, 14, 1, true).rotateX(Math.PI * 0.8).translate(0.32, 0.25, 0.3)), color: '#e6ebf2', fit: 'round' }],
    port: [{ geo: merge(box(0.42, 0.18, 0.2, -0.18, 0, -0.18), box(0.42, 0.18, 0.2, 0.18, 0, 0.16), box(0.42, 0.18, 0.2, 0.0, 0.18, 0)), color: '#c46a2f', fit: 'span' }],
    civic: [{ geo: merge(cyl(0.3, 0.3, 0.16, 0, 0, 0, 16), dome(0.3, 0.16), cyl(0.012, 0.012, 0.5, 0, 0.42, 0, 5)), color: '#d7dbe2', fit: 'round' },
      { geo: box(0.9, 0.05, 0.9), color: '#3f7a46', fit: 'span', chance: 0.2 }],
    homes: [{ geo: merge(prism(1.08, 0.36, 1.08, 0.5, 0), box(0.1, 0.22, 0.1, 0.28, 0.12, -0.18)), color: '#a5503a', fit: 'span' }],
  };
}

type Src = { pos: Float32Array; heights: Float32Array; rise: Float32Array; w: Float32Array; d: Float32Array; count: number; mesh: THREE.InstancedMesh };
interface Part { mesh: THREE.InstancedMesh; piece: Piece; idx: number[] }

// Roof (and front) pieces on every building of a set of instances, for its district's style.
export class RoofKit {
  group = new THREE.Group();
  parts: Part[] = [];
  chimneys: { i: number; x: number; z: number; part: Part }[] = []; // chimney tops, for smoke
  dirty = true;
  private seen = -1;

  // styleAt: the style of instance i; module: big zoomed-out blocks (pieces stay modest)
  constructor(private src: Src, styleAt: (i: number) => Style, private lift: { value: number }, private module = false) {
    const P = pieces(), by = new Map<Piece, number[]>();
    for (let i = 0; i < src.count; i++) {
      const s = styleAt(i), seed = hash(i * 7.13 + (module ? 99 : 0));
      const list = P[s];
      // a piece with a chance replaces the style's first piece (roof garden instead of antennas)
      const alt = list.find(p => p.chance && seed < p.chance);
      for (const p of list) {
        if (p.chance && p !== alt) continue;
        if (alt && p === list[0]) continue;
        if (module && p.at === 'ground') continue;
        if (!by.has(p)) by.set(p, []);
        by.get(p)!.push(i);
      }
    }
    for (const [piece, idx] of by) {
      const mat = piece.glow ? new THREE.MeshBasicMaterial({ color: '#ffffff' })
        : new THREE.MeshStandardMaterial({ color: piece.color, roughness: 0.7, metalness: 0.2, emissive: piece.color, emissiveIntensity: 0.06 });
      const mesh = new THREE.InstancedMesh(piece.geo, mat, idx.length);
      mesh.castShadow = !module; mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (piece.glow) idx.forEach((_, k) => mesh.setColorAt(k, new THREE.Color(piece.color)));
      const part = { mesh, piece, idx };
      this.parts.push(part);
      if (piece.tag === 'chimney') idx.forEach(i => this.chimneys.push({ i, x: 0.3, z: -0.3, part }));
      this.group.add(mesh);
    }
  }

  // Colour of the glowing pieces with a tag (signs in their district hue, lab lamps by test results).
  paint(tag: Piece['tag'], f: (i: number) => THREE.Color) {
    for (const p of this.parts) {
      if (p.piece.tag !== tag) continue;
      p.idx.forEach((i, k) => p.mesh.setColorAt(k, f(i)));
      if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
    }
  }

  // Top of building i and the scale its pieces take.
  scaleOf(i: number) { const S = this.src; return this.module ? Math.min(S.w[i], S.d[i], 4) * 0.45 : Math.min(S.w[i], S.d[i]); }
  top(i: number) { const S = this.src; return S.mesh.position.y + S.heights[i] * S.rise[i] * this.lift.value; }

  sync() {
    const lift = this.lift.value;
    this.group.visible = lift > 0.02;
    if (!this.group.visible) return;
    if (!this.dirty && lift === this.seen) return;
    this.dirty = false; this.seen = lift;
    const S = this.src;
    for (const { mesh, piece, idx } of this.parts) {
      idx.forEach((i, k) => {
        const r = S.rise[i] * lift, tall = piece.tall && S.heights[i] < piece.tall && !this.module;
        if (r < 0.05 || tall) { M.makeScale(0, 0, 0); mesh.setMatrixAt(k, M); return; }
        const s = this.scaleOf(i), ground = piece.at === 'ground';
        const sx = piece.fit === 'span' ? S.w[i] : s, sz = piece.fit === 'span' ? S.d[i] : s;
        const sy = (ground ? 1 : s) * Math.min(1, r);
        P.set(S.pos[i * 3], ground ? S.mesh.position.y : this.top(i), S.pos[i * 3 + 2]);
        M.compose(P, Q, V.set(sx, sy, sz));
        mesh.setMatrixAt(k, M);
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() { for (const p of this.parts) { p.mesh.geometry.dispose(); (p.mesh.material as THREE.Material).dispose(); } }
}

const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), V = new THREE.Vector3();
export function hash(x: number) { const s = Math.sin(x * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
