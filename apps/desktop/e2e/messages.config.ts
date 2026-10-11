import { defineConfig } from '@playwright/test';

// vokko-messages: the same specs as playwright.config.ts (mock backend) but on Vite port 1423 with a fresh server, so a Vite from
// another worktree on 1422 can never be reused by accident. Run from apps/desktop: npx playwright test -c e2e/messages.config.ts
const PORT = 1423;

export default defineConfig({
  testDir: '.',
  testMatch: /\.spec\.ts$/,
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
