import * as THREE from 'three';
import type { City } from '../api';

// District grounds: a tinted lot under every district with a rim in its colour,
// so the city reads as neighbourhoods (Storefront, Database, Security...) and
// not as one field of blocks. They follow the district boxes, so a dragged
// place takes its district's edge along (refit).
const M = 1.2; // ground beyond the outermost plots; the server leaves 1.5 before the avenue
export const LOT_MARGIN = M;
const RIM = 0.8; // border width

// A flat band between two outlines with matching points (a lot and the same lot inset).
function band(outer: THREE.Vector2[], inner: THREE.Vector2[]) {
  const pos: number[] = [], n = Math.min(outer.length, inner.length);
  for (let i = 0; i < n; i++) {
    const a = outer[i], b = inner[i], c = outer[(i + 1) % n], e = inner[(i + 1) % n];
    pos.push(a.x, 0, -a.y, b.x, 0, -b.y, c.x, 0, -c.y, c.x, 0, -c.y, b.x, 0, -b.y, e.x, 0, -e.y);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

function lot(x: number, z: number, w: number, h: number, r: number) {
  // in the XY plane with y = -z, laid flat by the mesh's rotation
  const s = new THREE.Shape();
  r = Math.min(r, w / 2, h / 2);
  s.moveTo(x + r, -z);
  s.lineTo(x + w - r, -z); s.quadraticCurveTo(x + w, -z, x + w, -z - r);
  s.lineTo(x + w, -z - h + r); s.quadraticCurveTo(x + w, -z - h, x + w - r, -z - h);
  s.lineTo(x + r, -z - h); s.quadraticCurveTo(x, -z - h, x, -z - h + r);
  s.lineTo(x, -z - r); s.quadraticCurveTo(x, -z, x + r, -z);
  return s;
}

export class DistrictGrounds {
  group = new THREE.Group();
  private items: { fill: THREE.Mesh; rim: THREE.Mesh; born: number; hue: number }[] = [];

  constructor(private city: City) {
    this.city.districts.forEach(d => {
      const fill = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({
        roughness: 1, emissive: new THREE.Color().setHSL(d.hue / 360, 0.6, 0.5) })); // colour: tone()
      fill.rotation.x = -Math.PI / 2; fill.position.y = -0.02; fill.receiveShadow = true;
      // the border: a solid band in the district's colour along the inside of the lot,
      // unlit, outside the filmic tone mapping and the pale fog (both wash colours into
      // pastels), so it stays vivid on grass and at night
      const rim = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(d.hue / 360, 0.85, 0.45), side: THREE.DoubleSide, toneMapped: false, fog: false }));
      rim.position.y = -0.01;
      this.items.push({ fill, rim, born: d.born, hue: d.hue });
      this.group.add(fill, rim);
    });
    this.refit();
  }

  refit() {
    this.city.districts.forEach((d, i) => {
      const { fill, rim } = this.items[i];
      if (!d.members.length) { fill.visible = rim.visible = false; return; }
      const s = lot(d.x - M, d.z - M, d.w + M * 2, d.h + M * 2, 2);
      fill.geometry.dispose(); fill.geometry = new THREE.ShapeGeometry(s, 6);
      const inner = lot(d.x - M + RIM, d.z - M + RIM, d.w + M * 2 - RIM * 2, d.h + M * 2 - RIM * 2, 2 - RIM);
      rim.geometry.dispose(); rim.geometry = band(s.getPoints(6), inner.getPoints(6));
    });
  }

  // n: 1 night (dark lots, faint glow), 0 day (lots in a clear tint of their colour: the
  // sun and tone mapping lighten them a lot, so a pale tint renders near white and
  // neighbouring districts run together)
  tone(n: number) {
    for (const it of this.items) {
      const m = it.fill.material as THREE.MeshStandardMaterial;
      m.color.setHSL(it.hue / 360, 0.55 - 0.2 * n, 0.6 - 0.525 * n);
      m.emissiveIntensity = 0.025 * n;
      (it.rim.material as THREE.MeshBasicMaterial).color.setHSL(it.hue / 360, 0.9, 0.42 + 0.12 * n);
    }
  }

  // a district's ground appears with its first place
  update(t: number) {
    for (const it of this.items) { const on = t >= it.born; it.fill.visible = on; it.rim.visible = on; }
  }

  // the district whose ground is at (x, z), if it has appeared
  at(x: number, z: number) {
    return this.city.districts.findIndex((d, i) => this.items[i].fill.visible && d.members.length &&
      x >= d.x - M && x <= d.x + d.w + M && z >= d.z - M && z <= d.z + d.h + M);
  }

  // where its name sits: the middle of the edge facing the default camera
  labelAt(i: number, v: THREE.Vector3) {
    const d = this.city.districts[i];
    return v.set(d.x + d.w / 2, 0.4, d.z + d.h + M * 0.5);
  }
}
