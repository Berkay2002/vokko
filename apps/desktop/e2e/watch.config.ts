import { defineConfig } from '@playwright/test';

// Watch Together mock e2e on its own fresh Vite (port 1448) so a Vite from another worktree is never reused by accident.
// Run from apps/desktop: npx playwright test -c e2e/watch.config.ts
const PORT = 1448;

export default defineConfig({
  testDir: '.',
  testMatch: /watch-together\.spec\.ts$/,
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
