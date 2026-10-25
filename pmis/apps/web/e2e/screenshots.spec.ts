import { test } from '@playwright/test';
import path from 'node:path';

// Run with: SHOTS=1 npx playwright test e2e/screenshots.spec.ts
const OUT = path.resolve('../../design/screens/app');
test.skip(!process.env.SHOTS, 'screenshots are generated on demand');

for (const [locale, theme] of [['en', 'light'], ['ar', 'dark']] as const) {
  test(`screens ${locale} ${theme}`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [locale, theme]);
    await page.goto('/login');
    await page.screenshot({ path: `${OUT}/login-${locale}-${theme}.png` });
    await page.getByTestId('login-identifier').fill('1001');
    await page.getByTestId('login-submit').click();
    await page.getByTestId('mock-account-pm').click();
    await page.getByTestId('my-work-count-do_now').waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/my-work-${locale}-${theme}.png` });
    await page.getByTestId('nav-approvals').click();
    await page.locator('[data-site="WM105"] [data-testid^="approval-open-"]').click();
    await page.getByTestId('approval-detail').getByText('WM105').waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/approvals-${locale}-${theme}.png` });
    await page.getByTestId('nav-sites').click();
    await page.getByTestId('site-row-TR101').waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/sites-${locale}-${theme}.png` });
    await page.getByTestId('site-row-BG105').click(); // a site mid-way, so the pipeline shows rings in several states
    await page.locator('[data-task]').first().waitFor();
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}/site-page-${locale}-${theme}.png` });
    await page.getByTestId('pipe-node-te_pac').click();
    await page.locator('[data-state="entry"] [data-testid^="grid-open-"]').first().click();
    await page.getByTestId('task-drawer-body').waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/task-drawer-${locale}-${theme}.png` });
    await page.keyboard.press('Escape');
    await page.getByTestId('nav-admin.matrix').click();
    await page.getByTestId('matrix-row-site_release').waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/matrix-${locale}-${theme}.png` });
  });
}
