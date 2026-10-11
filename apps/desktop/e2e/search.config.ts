import { defineConfig } from '@playwright/test';

// vokko-search: the mock-backend specs on Vite port 1425 with a fresh server, so a Vite from another worktree can never be reused
// by accident. Run from apps/desktop: npx playwright test -c e2e/search.config.ts
const PORT = 1425;

export default defineConfig({
  testDir: '.',
  // VOKKO_E2E_ALL=1 runs every mock-backend spec on this port (regression check of the shell with the search slots filled).
  testMatch: process.env.VOKKO_E2E_ALL ? /\.spec\.ts$/ : /e2e[\\/]search[^\\/]*\.spec\.ts$/,
  testIgnore: [/real(\..+)?\.spec\.ts$/],
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
