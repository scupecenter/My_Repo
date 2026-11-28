import { defineConfig } from '@playwright/test';

// Throwaway: probe the remembered view mode against the PRODUCTION build (no StrictMode double-invoke) served on :5175.
export default defineConfig({
  testDir: './e2e',
  testMatch: 'walk-media-488-prod.spec.ts',
  timeout: 120000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5175',
    launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH || '/usr/bin/google-chrome' },
    viewport: { width: 1440, height: 900 },
  },
});
