import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import mediapipeAssets from './scripts/vite-mediapipe.mjs';
import dropMockGame from './scripts/vite-drop-mock-game.mjs';
import gamesBundles from './scripts/vite-games.mjs';

// `--mode perf` (the perf harness, e2e/perf.config.ts): a production build with React's profiling renderer so <Profiler> callbacks fire.
export default defineConfig(({ mode }) => ({
  plugins: [react(), mediapipeAssets(), dropMockGame(), gamesBundles()],
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  // The in-game overlay window (src-tauri/src/overlay.rs) and the Pop Out window (src-tauri/src/popout.rs) are their own small pages.
  build: { rollupOptions: { input: { index: 'index.html', overlay: 'overlay.html', popout: 'popout.html' } } },
  resolve: mode === 'perf' ? { alias: [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }] } : undefined,
}));
