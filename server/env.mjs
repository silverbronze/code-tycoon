// Settings are CODETYCOON_*. Before the rename (v0.4) they were VISUALIZER_*;
// an old name still works when the new one is not set.
for (const [k, v] of Object.entries(process.env)) {
  if (!k.startsWith('VISUALIZER_')) continue;
  const n = 'CODETYCOON_' + k.slice('VISUALIZER_'.length);
  if (process.env[n] === undefined) process.env[n] = v;
}
