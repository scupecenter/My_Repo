import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Item (a): the layout of My Work and of the site page is picked in one Layout panel (the same control as Sites), in EN and AR.
for (const locale of ['en', 'ar'] as const) {
  test(`My Work and the site page use the Layout panel (${locale})`, async ({ page }) => {
    await page.addInitScript((l) => { if (!localStorage.getItem('pmis.locale')) localStorage.setItem('pmis.locale', l); }, locale);
    await login(page, 'reviewer');
    await page.goto('/my-work');
    await page.getByTestId('my-work-view').click();
    await expect(page.getByTestId('my-work-view-panel')).toBeVisible();
    await page.screenshot({ path: `/downloads/viewmenu-mywork-${locale}.png` });
    await page.getByTestId('my-work-layout-board').click();
    await expect(page).toHaveURL(/layout=board/);
    await page.getByTestId('nav-sites').click();
    await page.getByTestId('site-row-TR101').click();
    await page.getByTestId('site-view').click();
    await expect(page.getByTestId('site-view-panel')).toBeVisible();
    await page.screenshot({ path: `/downloads/viewmenu-site-${locale}.png` });
    await page.getByTestId('site-layout-timeline').click();
    await expect(page.getByTestId('task-row')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
  });
}
