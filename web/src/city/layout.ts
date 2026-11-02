import type { City } from '../api';

// Places the user dragged somewhere else: a whole-unit offset per module or outside
// system, kept per project in this browser and laid over the server's layout.
type Offsets = Record<string, [number, number]>; // "m:<module id>" | "e:<external id>"
const KEY = (pid: string) => 'vz-layout:' + pid;
export type Ref = [number, number]; // [tt, ti]: 1 module or store, 3 outside system

function load(pid: string): Offsets {
  try { return JSON.parse(localStorage.getItem(KEY(pid)) || '{}') || {}; } catch { return {}; }
}
const idOf = (c: City, r: Ref) => r[0] === 1 ? 'm:' + c.modules[r[1]].key : 'e:' + c.externals[r[1]].id; // a folder split across districts has one key per block

// The plot a place stands on (the plate under it).
export function plot(c: City, r: Ref) {
  if (r[0] === 1) { const m = c.modules[r[1]]; return { x: m.x, z: m.z, w: m.w, h: m.h }; }
  const e = c.externals[r[1]]; return { x: e.x - e.w / 2 - 0.4, z: e.z - e.h / 2 - 0.4, w: e.w + 0.8, h: e.h + 0.8 };
}
export const places = (c: City): Ref[] => [...c.modules.map((_, i): Ref => [1, i]), ...c.externals.map((_, i): Ref => [3, i])];

// Would the plot of r, moved by (dx, dz), crowd another plot? A street's width stays free.
export function blocked(c: City, r: Ref, dx: number, dz: number, all = places(c)) {
  const a = plot(c, r), GAP = 1;
  return all.some(o => {
    if (o[0] === r[0] && o[1] === r[1]) return false;
    const b = plot(c, o);
    return a.x + dx < b.x + b.w + GAP && a.x + dx + a.w + GAP > b.x && a.z + dz < b.z + b.h + GAP && a.z + dz + a.h + GAP > b.z;
  });
}

// Move a place in the city data: the module's files go with it.
export function shift(c: City, r: Ref, dx: number, dz: number) {
  if (r[0] === 1) {
    const m = c.modules[r[1]]; m.x += dx; m.z += dz;
    for (const f of c.files) if (f.m === r[1]) { f.x += dx; f.z += dz; }
  } else { const e = c.externals[r[1]]; e.x += dx; e.z += dz; }
}

// Districts are drawn around their members, so they follow them.
export function fitDistricts(c: City) {
  for (const d of c.districts) {
    if (!d.members.length) continue;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const r of d.members) { const p = plot(c, r as Ref); x0 = Math.min(x0, p.x); z0 = Math.min(z0, p.z); x1 = Math.max(x1, p.x + p.w); z1 = Math.max(z1, p.z + p.h); }
    d.x = x0; d.z = z0; d.w = x1 - x0; d.h = z1 - z0;
  }
}

// Lay the saved moves over a freshly loaded city. A move that would now land on
// another place (the server re-laid the city) is skipped.
export function applyLayout(c: City) {
  const o = load(c.project.id), all = places(c);
  let any = false;
  for (const r of all) {
    const v = o[idOf(c, r)];
    if (!v || blocked(c, r, v[0], v[1], all)) continue;
    shift(c, r, v[0], v[1]); any = true;
  }
  if (any) fitDistricts(c);
}

export function saveMove(c: City, r: Ref, dx: number, dz: number) {
  const o = load(c.project.id), id = idOf(c, r), v = o[id] || [0, 0];
  v[0] += dx; v[1] += dz;
  if (v[0] || v[1]) o[id] = v; else delete o[id];
  try { localStorage.setItem(KEY(c.project.id), JSON.stringify(o)); } catch { /* private mode: the move lasts this visit */ }
}
export function hasLayout(pid: string) { return Object.keys(load(pid)).length > 0; }
export function resetLayout(pid: string) { try { localStorage.removeItem(KEY(pid)); } catch { /* nothing kept */ } }
