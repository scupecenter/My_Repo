import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Item 11 sidebar entry: My Work > Follow-up opens the hub, EN and AR (RTL).
for (const c of [{ locale: 'en', dir: 'ltr' }, { locale: 'ar', dir: 'rtl' }] as const) {
  test(`sidebar: Follow-up entry opens the hub (${c.locale})`, async ({ page }) => {
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); }, c.locale);
    await login(page, 'pm');
    await page.getByTestId('nav-follow_up').click();
    await expect(page).toHaveURL(/\/follow-up$/);
    await expect(page.getByTestId('nav-follow_up')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('fup-approvals')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', c.dir);
  });
}
