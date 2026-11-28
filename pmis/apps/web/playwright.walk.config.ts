import { defineConfig } from '@playwright/test';

// Throwaway real-stack walkthrough config (not committed): one strict spec against the walk stack of tools/walkthrough/start.sh.
export default defineConfig({
  testDir: './e2e',
  testMatch: 'walk-media-488.spec.ts',
  timeout: 300000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5174',
    launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH || '/usr/bin/google-chrome' },
    viewport: { width: 1440, height: 900 },
  },
});
