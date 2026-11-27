import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Inbox priority (item 6): EN and AR. Priority items come first, carry a chip, and the filter keeps only them.
for (const c of [{ locale: 'en' }, { locale: 'ar' }] as const) {
  test(`inbox: priority first and the priority-only filter (${c.locale})`, async ({ page }) => {
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); }, c.locale);
    await login(page, 'pm');
    await page.goto('/inbox');
    await expect(page.getByTestId('page-inbox')).toBeVisible();
    await expect(page.getByTestId('inbox-priority-only')).toBeVisible();
    await page.getByTestId('page-inbox').screenshot({ path: `test-results/inbox-${c.locale}.png` });
    await page.getByTestId('inbox-priority-only').click();
    await expect(page).toHaveURL(/tab=priority/);
    await expect(page.getByTestId('inbox-priority-only')).toHaveAttribute('aria-pressed', 'true');
    const items = page.locator('[data-testid^="inbox-item-"]');
    const n = await items.count();
    for (let i = 0; i < n; i++) await expect(items.nth(i).locator('[data-testid^="inbox-priority-"]')).toHaveCount(1);
  });
}
