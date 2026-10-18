import { defineConfig } from '@playwright/test';

// gap-audit-8 group A (blocked authors folded, topic markdown) against the mock backend on Vite port 1520. Run from apps/desktop:
//   npx playwright test -c e2e/gap8-blocked.config.ts --workers=1
const PORT = 1520;

export default defineConfig({
  testDir: '.',
  testMatch: /(chat|chat-polish|messages|keyboard-nav|live-window|channel-jump|block-confirm|gap8-blocked.shots|shell-polish|mentions|responsive|access-settings|channel-start|a11y|a11y-screens)\.spec\.ts$/,
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  expect: { timeout: 8000 },
  use: { actionTimeout: 8000, baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1440, height: 900 }, colorScheme: 'dark', permissions: ['notifications'] },
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    cwd: '..',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
