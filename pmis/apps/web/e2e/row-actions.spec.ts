import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Row menu and J/K (item 4), against the mock layer: EN/light and AR/dark, on the My Work grid.
for (const c of [{ locale: 'en', theme: 'light' }, { locale: 'ar', theme: 'dark' }] as const) {
  test(`rows: J/K move the focus and right-click opens the row menu (${c.locale}/${c.theme})`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [c.locale, c.theme]);
    await login(page, 'pm');
    await page.goto('/sites');
    const rows = page.locator('.gx-row');
    await expect(rows.first()).toBeVisible();
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('j');
    await expect(rows.nth(0)).toBeFocused();
    await page.keyboard.press('j');
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press('k');
    await expect(rows.nth(0)).toBeFocused();
    await rows.nth(1).click({ button: 'right' });
    await expect(page.getByTestId('row-menu')).toBeVisible();
    await page.waitForTimeout(600);
    await expect(page.getByTestId('row-menu')).toBeVisible();
    await page.screenshot({ path: `test-results/row-menu-${c.locale}.png` });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('row-menu')).toHaveCount(0);
    await expect(rows.nth(1)).toBeFocused();
  });
}
