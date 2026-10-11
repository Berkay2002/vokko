import { defineConfig } from '@playwright/test';

// vokko-client-states: mock backend on its own Vite (port 1434, fresh server) so a Vite from another worktree can never be reused by accident.
// Run from apps/desktop: npx playwright test -c e2e/client-states.config.ts
const PORT = 1434;

export default defineConfig({
  testDir: '.',
  // Default: only the client-states spec. CLIENT_STATES_ALL=1 runs every mock-backed spec on port 1434 (regression pass).
  testMatch: process.env.CLIENT_STATES_ALL ? /\.spec\.ts$/ : /client-states\.spec\.ts$/,
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
