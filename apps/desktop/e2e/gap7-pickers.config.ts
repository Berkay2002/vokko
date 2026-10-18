import { defineConfig } from '@playwright/test';

// gap-audit-7 group C (GIF and sticker favourites and recents) against the mock backend on Vite port 1510. Run from apps/desktop:
//   npx playwright test -c e2e/gap7-pickers.config.ts --workers=1
const PORT = 1510;

export default defineConfig({
  testDir: '.',
  testMatch: /gap7-pickers\.spec\.ts$/,
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, colorScheme: 'dark' },
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    cwd: '..',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
