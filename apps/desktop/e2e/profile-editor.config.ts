import { defineConfig } from '@playwright/test';

// Profile editor specs against the mock backend on Vite port 1442 with a fresh server, so a Vite from another worktree is never
// reused by accident. Run from apps/desktop:
//   $env:PLAYWRIGHT_BROWSERS_PATH='<dev dir>\ms-playwright'; npx playwright test -c e2e/profile-editor.config.ts
const PORT = 1442;

export default defineConfig({
  testDir: '.',
  // PE_WITH_SETTINGS=1 also runs the settings and profile specs that open the editor's neighbours (they stay on this port 1442 server)
  testMatch: process.env.PE_WITH_SETTINGS ? /(profile-editor(\..+)?|perks|settings-modal|shell-visual)\.spec\.ts$/ : /profile-editor(\..+)?\.spec\.ts$/,
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
  },
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    cwd: '..',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
