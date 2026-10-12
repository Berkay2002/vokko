import { defineConfig } from '@playwright/test';

// vokko-guild-sidebar: mock backend on its own Vite (port 1443, fresh server) so a Vite from another worktree can never be reused by accident.
// Run from apps/desktop: npx playwright test -c e2e/guild-sidebar.config.ts
const PORT = 1443;

export default defineConfig({
  testDir: '.',
  // Default: only the guild-sidebar spec. GUILD_SIDEBAR_ALL=1 runs every mock-backed spec on port 1443 (regression pass).
  testMatch: process.env.GUILD_SIDEBAR_ALL ? /\.spec\.ts$/ : /guild-sidebar\.spec\.ts$/,
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
