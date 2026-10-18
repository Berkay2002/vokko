import { defineConfig } from '@playwright/test';

// vokko-gap6-chat: the chat-phone specs on Vite port 1506 with a fresh server. Run from apps/desktop with --workers=1:
// npx playwright test -c e2e/chat-phone.config.ts
const PORT = 1506;

export default defineConfig({
  testDir: '.',
  testMatch: /e2e[\\/]chat-phone[^\\/]*\.spec\.ts$/,
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
