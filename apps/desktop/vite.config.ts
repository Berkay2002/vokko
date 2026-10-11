import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import mediapipeAssets from './scripts/vite-mediapipe.mjs';

export default defineConfig({
  plugins: [react(), mediapipeAssets()],
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
});
