import { defineConfig } from '@playwright/test';

// gap-audit-6 group D (idle presence, View Full Profile, image crop, phone profile editor) against the mock backend on Vite port 1510. Run from apps/desktop:
//   npx playwright test -c e2e/gap6-profile.config.ts --workers=1
const PORT = 1510;

export default defineConfig({
  testDir: '.',
  // GAP6_MATCH=profile-editor runs the neighbouring specs (the avatar/banner pickers upload through the cropper) on this port too
  testMatch: process.env.GAP6_MATCH ? new RegExp(`${process.env.GAP6_MATCH}.*\\.spec\\.ts$`) : /gap6-profile\.spec\.ts$/,
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
