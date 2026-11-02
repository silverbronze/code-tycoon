// Shared state of the sky that every part of the city reads: 1 = full night, 0 =
// midday; rain 0..1. sky.ts writes them, shaders take them as uniforms.
export const ENV = {
  night: { value: 1 },
  rain: { value: 0 },
};
