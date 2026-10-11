import { defineConfig } from '@playwright/test';

// Two modes, one switch:
//   mock (default)   VITE_VOKKO_API unset, the in-memory backend. Runs every spec except real.spec.ts.
//   real             VOKKO_REAL=1, a vokko-server at VOKKO_REAL_API (default http://127.0.0.1:8711). Runs only real.spec.ts.
// Both serve the client from Vite on port 1422.
const REAL = !!process.env.VOKKO_REAL;
const API = process.env.VOKKO_REAL_API ?? 'http://127.0.0.1:8711';
const PORT = process.env.VOKKO_E2E_PORT ?? '1422';

export default defineConfig({
  testDir: 'e2e',
  testMatch: REAL ? /real(\..+)?\.spec\.ts$/ : /\.spec\.ts$/,
  testIgnore: REAL ? [] : [/real(\..+)?\.spec\.ts$/, /video[^\\/]*\.spec\.ts$/],
  timeout: REAL ? 90_000 : 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    permissions: ['notifications'], // system Chrome starts at 'default', which shows the notification prompt bar over the top of every page
    launchOptions: process.env.VOKKO_CHROMIUM ? { executablePath: process.env.VOKKO_CHROMIUM } : {},
  },
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    // Real mode needs VITE_VOKKO_API baked into a fresh Vite: never reuse a mock one.
    reuseExistingServer: !REAL,
    env: REAL ? { VITE_VOKKO_API: API } : {},
    timeout: 60_000,
  },
});
