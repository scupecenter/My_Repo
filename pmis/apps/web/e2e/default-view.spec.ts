import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Default view per screen: save a view, make it my default with the star, leave and come back (the screen opens on it), see it in My profile > Default views and reset it. EN and AR.
for (const c of [{ locale: 'en' }, { locale: 'ar' }] as const) {
  test(`default view: star, reopen, profile list and reset (${c.locale})`, async ({ page }) => {
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); }, c.locale);
    await login(page, 'pm');
    await page.goto('/approvals');
    await page.getByTestId('views-save').click();
    await page.getByTestId('views-name').fill('Default walk');
    await page.getByTestId('views-name-ok').click();
    await expect(page.getByTestId('views-default')).toBeVisible();
    await page.getByTestId('views-default').click();
    await expect(page.getByTestId('views-default')).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: `test-results/default-view-${c.locale}.png` });
    // leave and come back inside the app: the screen opens on the default view by itself
    await page.getByTestId('topbar-user').click();
    await page.getByTestId('user-menu-profile').click();
    await expect(page.getByTestId('profile-default-views')).toBeVisible();
    await expect(page.locator('[data-testid^="dv-row-"]')).toHaveCount(1);
    await page.goBack();
    await expect(page.getByTestId('views-default')).toHaveAttribute('aria-pressed', 'true');
    await page.goForward();
    await expect(page.getByTestId('profile-default-views')).toBeVisible();
    await page.locator('[data-testid^="dv-reset-"]').first().click();
    await expect(page.locator('[data-testid^="dv-row-"]')).toHaveCount(0);
  });
}
