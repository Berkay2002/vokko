import { defineConfig } from '@playwright/test';

// Who controls media in a call (e2e/bot-control.spec.ts) on its own fresh Vite (port 1461). BOTCTL_SPECS (a regex) runs other
// specs on the same port instead, e.g. BOTCTL_SPECS='(watch-together|stremio.*|spotify.*|voice-ui)\.spec\.ts$'.
// Run from apps/desktop: npx playwright test -c e2e/bot-control.config.ts (BOTCTL_PORT moves it off 1461 for a parallel worker)
const PORT = Number(process.env.BOTCTL_PORT ?? 1461);

export default defineConfig({
  testDir: '.',
  testMatch: process.env.BOTCTL_SPECS ? new RegExp(process.env.BOTCTL_SPECS) : /bot-control\.spec\.ts$/,
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
