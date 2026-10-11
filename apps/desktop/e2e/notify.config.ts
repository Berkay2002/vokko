import { defineConfig } from '@playwright/test';

// vokko-notify: mock backend on its own Vite (port 1426, fresh server) so a Vite from another worktree can never be reused by accident.
// Run from apps/desktop: npx playwright test -c e2e/notify.config.ts
const PORT = 1426;

export default defineConfig({
  testDir: '.',
  // Default: only the notify spec. NOTIFY_ALL=1 runs every mock-backed spec on port 1426 (regression pass).
  testMatch: process.env.NOTIFY_ALL ? /\.spec\.ts$/ : /notify\.spec\.ts$/,
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
