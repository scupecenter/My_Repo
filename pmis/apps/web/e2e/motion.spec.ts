import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Motion system (item 2), against the mock layer: EN/light and AR/dark. The choice in Settings, Screens, Motion sets data-motion on the page, turns the
// transitions off (a dialog panel has no animation time) and survives a reload.
for (const c of [{ locale: 'en', theme: 'light' }, { locale: 'ar', theme: 'dark' }] as const) {
  test(`motion: reduced choice is applied and kept (${c.locale}/${c.theme})`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [c.locale, c.theme]);
    await login(page, 'pm');
    await page.goto('/admin/settings/screens/motion');
    await expect(page.getByTestId('page-motion-settings')).toBeVisible();
    await expect(page.getByTestId('motion-auto')).toBeChecked();
    await expect(page.getByTestId('motion-preview')).toHaveCSS('animation-name', 'motion-pop');
    await page.getByTestId('motion-reduced').check();
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
    await expect(page.getByTestId('motion-preview')).toHaveCSS('animation-duration', '1e-05s');
    await page.getByTestId('page-motion-settings').screenshot({ path: `test-results/motion-${c.locale}.png` });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
    await expect(page.getByTestId('motion-reduced')).toBeChecked();
    await page.getByTestId('motion-link-display').click();
    await expect(page).toHaveURL(/settings\/screens\/tables/);
  });
}

test('motion: the operating system setting alone also removes animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page, 'pm');
  await page.goto('/admin/settings/screens/motion');
  await expect(page.getByTestId('motion-preview')).toHaveCSS('animation-duration', '1e-05s');
});
