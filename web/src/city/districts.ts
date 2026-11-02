import * as THREE from 'three';
import type { City } from '../api';

// District grounds: a tinted lot under every district with a rim in its colour,
// so the city reads as neighbourhoods (Storefront, Database, Security...) and
// not as one field of blocks. They follow the district boxes, so a dragged
// place takes its district's edge along (refit).
const M = 1.2; // ground beyond the outermost plots; the server leaves 1.5 before the avenue

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
  private items: { fill: THREE.Mesh; rim: THREE.LineLoop; born: number }[] = [];

  constructor(private city: City) {
    this.city.districts.forEach(d => {
      const fill = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(d.hue / 360, 0.35, 0.075), roughness: 1, emissive: new THREE.Color().setHSL(d.hue / 360, 0.6, 0.5), emissiveIntensity: 0.025 }));
      fill.rotation.x = -Math.PI / 2; fill.position.y = -0.02; fill.receiveShadow = true;
      const rim = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
        color: new THREE.Color().setHSL(d.hue / 360, 0.7, 0.5), transparent: true, opacity: 0.55 }));
      rim.position.y = -0.005;
      this.items.push({ fill, rim, born: d.born });
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
      rim.geometry.dispose(); rim.geometry = new THREE.BufferGeometry().setFromPoints(s.getPoints(6).map(p => new THREE.Vector3(p.x, 0, -p.y)));
    });
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
