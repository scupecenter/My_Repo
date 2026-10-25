import { defineConfig } from '@playwright/test';

// Chromium is preinstalled; no `playwright install`. Override with PW_CHROMIUM_PATH if needed.
const executablePath = process.env.PW_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  fullyParallel: false,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5174', viewport: { width: 1440, height: 900 }, launchOptions: { executablePath } },
  webServer: { command: 'npx vite --port 5174 --strictPort', url: 'http://localhost:5174/login', reuseExistingServer: !process.env.CI, timeout: 60_000 },
});
