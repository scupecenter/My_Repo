import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Saved views as tabs (item 3): EN and AR. Save a view, see it as a tab, switch with the arrow keys.
for (const c of [{ locale: 'en' }, { locale: 'ar' }] as const) {
  test(`views: saved views show as tabs (${c.locale})`, async ({ page }) => {
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); }, c.locale);
    await login(page, 'pm');
    await page.goto('/sites');
    await expect(page.getByTestId('views-tabs')).toBeVisible();
    await page.getByTestId('views-save').click();
    await page.getByTestId('views-name').fill(`Tab view ${c.locale}`);
    await page.getByTestId('views-name-ok').click();
    const tab = page.getByRole('tab', { name: `Tab view ${c.locale}` });
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('views-tabs').screenshot({ path: `test-results/view-tabs-${c.locale}.png` });
    await tab.focus();
    await page.keyboard.press(c.locale === 'ar' ? 'ArrowRight' : 'ArrowLeft');
    await expect(page.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true');
  });
}
