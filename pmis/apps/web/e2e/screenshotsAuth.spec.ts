import { test } from '@playwright/test';
import path from 'node:path';

// Run with: SHOTS=1 npx playwright test e2e/screenshotsAuth.spec.ts   (sign-in, forgot and reset pages; EN/AR, light/dark, desktop/mobile)
const OUT = process.env.SHOTS_OUT ?? path.resolve('../../design/screens/auth');
test.skip(!process.env.SHOTS, 'screenshots are generated on demand');

const SIZES = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } } as const;

for (const locale of ['en', 'ar'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const [size, viewport] of Object.entries(SIZES)) {
      test(`auth pages ${locale} ${theme} ${size}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [locale, theme]);
        const shot = async (name: string) => { await page.waitForTimeout(350); await page.screenshot({ path: `${OUT}/${name}-${locale}-${theme}-${size}.png` }); };
        await page.goto('/login');
        await page.getByTestId('login-identifier').waitFor();
        await shot('login');
        await page.getByTestId('login-identifier').fill('1204');
        await page.getByTestId('login-password').fill('wrong-password-12');
        await page.getByTestId('login-password-toggle').click();
        await page.getByTestId('login-submit').click();
        await page.getByTestId('login-error').waitFor();
        await shot('login-error');
        await page.goto('/forgot-password');
        await page.getByTestId('forgot-identifier').fill('1204');
        await shot('forgot');
        await page.getByTestId('forgot-submit').click();
        await page.getByTestId('forgot-sent').waitFor();
        await shot('forgot-sent');
        await page.goto('/reset-password#token=' + 'a'.repeat(43));
        await page.getByTestId('reset-password').fill('Brand-New-Passphrase-2026');
        await page.getByTestId('reset-password2').fill('Brand-New-Passphrase-2026');
        await shot('reset');
      });
    }
  }
}
