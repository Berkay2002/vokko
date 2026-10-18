import { defineConfig } from '@playwright/test';

// vokko-gap7-media: the gap7-media specs on Vite port 1504 with a fresh server. Run from apps/desktop with --workers=1:
// npx playwright test -c e2e/gap7-media.config.ts
const PORT = 1504;

export default defineConfig({
  testDir: '.',
  testMatch: /e2e[\\/]gap7-media[^\\/]*\.spec\.ts$/,
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
