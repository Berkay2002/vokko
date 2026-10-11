import { defineConfig } from '@playwright/test';

// Perf harness (docs/perf.md). Serves a production build with React's profiling renderer (`vite build --mode perf`) from
// `vite preview` on port 1445, mock backend with `?seed=big`. Run from apps/desktop:
//   npx playwright test -c e2e/perf.config.ts            (PERF_LABEL=after writes perf-results/after.json)
const PORT = 1445;
const OUT = 'node_modules/.perf-dist';

export default defineConfig({
  testDir: '.',
  testMatch: /perf\.bench\.ts$/,
  timeout: 600_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    launchOptions: {
      args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
      ...(process.env.VOKKO_CHROMIUM ? { executablePath: process.env.VOKKO_CHROMIUM } : {}),
    },
  },
  webServer: {
    command: `npx vite build --mode perf --outDir ${OUT} --emptyOutDir && npx vite preview --mode perf --outDir ${OUT} --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    cwd: '..',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
