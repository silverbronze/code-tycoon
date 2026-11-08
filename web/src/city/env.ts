import * as THREE from 'three';

// Shared state of the sky that every part of the city reads: 1 = full night, 0 =
// midday; rain 0..1. sky.ts writes them, shaders take them as uniforms.
export const ENV = {
  night: { value: 1 },
  rain: { value: 0 },
};

// Session colours are neon, made for the night: on the light day city a pale colour
// reads as white. By day the same hue is drawn deep and saturated (lighter sessions,
// like subagents, stay a step lighter); a muted grey session stays grey.
const HSL = { h: 0, s: 0, l: 0 }, INK = new THREE.Color();
export function ink(c: THREE.Color, out = new THREE.Color()) {
  c.getHSL(HSL);
  INK.setHSL(HSL.h, HSL.s < 0.3 ? HSL.s : 1, Math.min(0.55, Math.max(0.28, 0.4 + (HSL.l - 0.66) * 0.8)));
  return out.copy(INK).lerp(c, ENV.night.value);
}
// Glows add light at night; on a light day additive light vanishes, so they cover instead.
export const glowBlend = () => ENV.night.value > 0.5 ? THREE.AdditiveBlending : THREE.NormalBlending;
