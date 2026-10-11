import { defineConfig } from '@playwright/test';

// vokko-video: the mock-backend specs on Vite port 1436 with a fresh server, so a Vite from another worktree can never be
// reused by accident. Chromium gets a fake camera and auto-accepted permission prompts so the camera preview, background
// processing and publishing paths run without hardware.
// Run from apps/desktop: npx playwright test -c e2e/video.config.ts   (VIDEO_ALL=1 runs every mock-backed spec on this port)
const PORT = 1436;

export default defineConfig({
  testDir: '.',
  testMatch: process.env.VIDEO_ALL ? /\.spec\.ts$/ : /video[^\\/]*\.spec\.ts$/,
  testIgnore: [/real(\..+)?\.spec\.ts$/],
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    permissions: ['camera', 'microphone'],
    launchOptions: {
      ...(process.env.VOKKO_CHROMIUM ? { executablePath: process.env.VOKKO_CHROMIUM } : {}),
      // swiftshader gives headless Chromium a WebGL 2 context, which the background segmenter needs.
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    cwd: '..',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
