import { defineConfig } from 'vite';

const api = 'http://127.0.0.1:' + (process.env.VISUALIZER_PORT || 4400);

export default defineConfig({
  root: 'web',
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: {
    port: 5173,
    proxy: { '/api': api, '/hook': api, '/ws': { target: api.replace('http', 'ws'), ws: true } },
  },
});
