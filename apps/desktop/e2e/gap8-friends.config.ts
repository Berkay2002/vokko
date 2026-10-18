import { defineConfig } from '@playwright/test';

// gap-audit-8 group B (Add Friend answers from the store, the bot profile card) against the mock backend on Vite port 1521. Run from apps/desktop:
//   npx playwright test -c e2e/gap8-friends.config.ts --workers=1
const PORT = 1521;

export default defineConfig({
  testDir: '.',
  testMatch: /(gap8-friends|apps)\.spec\.ts$/,
  // apps.spec.ts is the whole bots suite; only its profile-card tests belong to this group
  grep: /Add Friend answers|profile card/,
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, colorScheme: 'dark', viewport: { width: 1440, height: 900 } },
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    cwd: '..',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
