import { defineConfig } from '@playwright/test';

// vokko-search: the mock-backend specs on Vite port 1425 with a fresh server, so a Vite from another worktree can never be reused
// by accident. Run from apps/desktop: npx playwright test -c e2e/search.config.ts
const PORT = 1425;

export default defineConfig({
  testDir: '.',
  testMatch: /e2e[\\/]search[^\\/]*\.spec\.ts$/,
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
