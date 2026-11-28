import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Item 10: the More menu as an icon grid with search, chosen in Profile > Appearance. EN and AR. The list stays the default.
for (const c of [{ locale: 'en' }, { locale: 'ar' }] as const) {
  test(`more menu: grid with search after choosing it in Profile (${c.locale})`, async ({ page }) => {
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); }, c.locale);
    await login(page, 'pm');
    await page.setViewportSize({ width: 560, height: 900 });
    await page.goto('/sites');
    await page.getByTestId('more-menu').click();
    await expect(page.getByTestId('more-panel')).toHaveAttribute('data-mode', 'list');
    await page.keyboard.press('Escape');

    await page.goto('/profile');
    await page.getByTestId('pf-ap-more_menu').selectOption('grid');
    await page.getByTestId('pf-ap-apply').click();
    await expect(page.getByTestId('pf-ap-apply')).toBeDisabled();

    await page.goto('/sites');
    await page.getByTestId('more-menu').click();
    const panel = page.getByTestId('more-panel');
    await expect(panel).toHaveAttribute('data-mode', 'grid');
    await expect(page.getByTestId('more-search')).toBeVisible();
    await page.screenshot({ path: `test-results/more-grid-${c.locale}.png` });
    await page.getByTestId('more-search').fill('zzzzqq');
    await expect(page.getByTestId('more-none')).toBeVisible();
    await page.getByTestId('more-search').fill('');
    await expect(page.getByTestId('more-none')).toHaveCount(0);
    await expect(panel.getByRole('menuitem').first()).toBeVisible();

    // back to the list so the shared test user is left as found
    await page.keyboard.press('Escape');
    await page.goto('/profile');
    await page.getByTestId('pf-ap-more_menu').selectOption('list');
    await page.getByTestId('pf-ap-apply').click();
    await expect(page.getByTestId('pf-ap-apply')).toBeDisabled();
  });
}
