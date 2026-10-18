import { defineConfig } from '@playwright/test';

// Voice UI parity e2e (mock backend) on its own fresh Vite, port 1429.
// Run from apps/desktop: npx playwright test -c e2e/voice-ui.config.ts   (VOICE_ALL=1 runs every mock-backed spec on this port)
const PORT = Number(process.env.VOKKO_E2E_PORT ?? 1429);

export default defineConfig({
  testDir: '.',
  testMatch: process.env.VOICE_ALL ? /\.spec\.ts$/ : /voice(-ui)?\.spec\.ts$/,
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
