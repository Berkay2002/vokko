import { defineConfig } from '@playwright/test';

// Chat e2e runs against the mock backend (VITE_VOKKO_API unset) on the chat worktree's port.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:1422',
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    launchOptions: process.env.VOKKO_CHROMIUM ? { executablePath: process.env.VOKKO_CHROMIUM } : {},
  },
  webServer: {
    command: 'npm run dev -- --port 1422',
    url: 'http://127.0.0.1:1422',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
