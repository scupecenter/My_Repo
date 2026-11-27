import { expect, test } from '@playwright/test';

// Real-stack walkthrough of item (b): every lower tab of the site page on the table standard (runbook docs/ops/walkthrough.md). Needs one site WLK-001 (inserted by SQL).
test.skip(!process.env.WALK, 'real-stack run only');
const TABS = ['master', 'documents', 'snags', 'scope', 'activity', 'warehouse'];
for (const locale of ['en', 'ar'] as const) {
  test(`walk: site lower tabs on the table standard (${locale})`, async ({ page }) => {
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); }, locale);
    await page.goto('/login');
    await page.getByTestId('login-identifier').fill('9001');
    await page.getByTestId('login-password').fill('Walk-Admin-Pass-2026');
    await page.getByTestId('login-submit').click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
    await page.goto('/sites');
    await page.getByText('WLK-001').first().click();
    await expect(page.getByTestId('site-section-tabs')).toBeVisible({ timeout: 20000 });
    for (const tab of TABS) {
      const btn = page.getByTestId(`site-section-${tab}`);
      if (!(await btn.count())) { console.log('no tab', tab); continue; }
      await btn.click();
      await page.waitForTimeout(1200);
      await page.screenshot({ path: `/downloads/walk-site-${tab}-${locale}.png` });
    }
  });
}
