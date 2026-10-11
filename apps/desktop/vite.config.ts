import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import mediapipeAssets from './scripts/vite-mediapipe.mjs';

// `--mode perf` (the perf harness, e2e/perf.config.ts): a production build with React's profiling renderer so <Profiler> callbacks fire.
export default defineConfig(({ mode }) => ({
  plugins: [react(), mediapipeAssets()],
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  resolve: mode === 'perf' ? { alias: [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }] } : undefined,
}));
