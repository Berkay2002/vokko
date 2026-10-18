import { defineConfig } from '@playwright/test';

// Long-call soak (docs/perf.md, "Long calls"): the perf build (vite build --mode perf) from vite preview on port 1446, mock backend.
// Run from apps/desktop:  SOAK_MINUTES=60 SOAK_LABEL=after npx playwright test -c e2e/soak.config.ts
const PORT = Number(process.env.VOKKO_SOAK_PORT ?? 1446);
const OUT = 'node_modules/.soak-dist';
const MINUTES = Number(process.env.SOAK_MINUTES ?? 60);

export default defineConfig({
  testDir: '.',
  testMatch: /soak\.bench\.ts$/,
  timeout: (MINUTES + 10) * 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    launchOptions: {
      args: ['--enable-precise-memory-info', '--js-flags=--expose-gc', '--autoplay-policy=no-user-gesture-required'],
      ...(process.env.VOKKO_CHROMIUM ? { executablePath: process.env.VOKKO_CHROMIUM } : {}),
    },
  },
  webServer: {
    command: `npx vite build --mode perf --minify false --outDir ${OUT} --emptyOutDir && npx vite preview --mode perf --outDir ${OUT} --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    cwd: '..',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
