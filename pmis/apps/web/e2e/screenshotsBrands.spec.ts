import { test } from '@playwright/test';
import path from 'node:path';
import { login } from './helpers';

// Run with: SHOTS=1 npx playwright test e2e/screenshotsBrands.spec.ts   (the two designs of 0164 on My Work and the Dashboard; EN/AR, light/dark)
const OUT = process.env.SHOTS_OUT ?? path.resolve('../../design/screens/brands');
test.skip(!process.env.SHOTS, 'screenshots are generated on demand');

for (const brand of ['obsidian', 'sahara'] as const) {
  for (const locale of ['en', 'ar'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      test(`design ${brand} ${locale} ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.addInitScript(([l, t, b]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); localStorage.setItem('pmis.brand', b); }, [locale, theme, brand]);
        await login(page, 'pm');
        await page.getByTestId('page-my-work').waitFor({ timeout: 15000 }).catch(() => undefined);
        await page.evaluate((b) => document.documentElement.setAttribute('data-brand', b), brand);
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${OUT}/${brand}-mywork-${locale}-${theme}.png` });
        await page.goto('/dashboard');
        await page.waitForTimeout(2500); // the shell applies the user's own design after /me answers; the preview sets the design under test after that
        await page.evaluate((b) => document.documentElement.setAttribute('data-brand', b), brand);
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${OUT}/${brand}-dashboard-${locale}-${theme}.png` });
      });
    }
  }
}
