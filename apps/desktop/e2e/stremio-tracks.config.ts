import { defineConfig } from '@playwright/test';

// Stremio audio and subtitle languages (plus the existing Stremio spec) on its own fresh Vite, port 1451.
// Run from apps/desktop: npx playwright test -c e2e/stremio-tracks.config.ts
const PORT = 1451;

export default defineConfig({
  testDir: '.',
  testMatch: /stremio(-tracks)?\.spec\.ts$/,
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    launchOptions: process.env.VOKKO_CHROMIUM ? { executablePath: process.env.VOKKO_CHROMIUM } : {},
  },
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    cwd: '..',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
