import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Item 8: the bell opens a side panel from the inline-end edge (right in English, left in Arabic) once the admin chooses it in Settings > Screens > Interface.
for (const c of [{ locale: 'en' }, { locale: 'ar' }] as const) {
  test(`bell side panel: chosen in Settings, opens at the inline-end edge, closes with Escape (${c.locale})`, async ({ page }) => {
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); }, c.locale);
    await login(page, 'pm');
    await page.goto('/admin/settings/screens/interface');
    await page.getByTestId('ui-panel-mode').selectOption('side_panel');
    await page.getByTestId('ui-panel-width').selectOption('wide');
    await page.getByTestId('ui-panel').screenshot({ path: `test-results/ui-panel-settings-${c.locale}.png` });
    await page.getByTestId('ui-save').click();
    await page.getByTestId('ui-dialog').getByRole('textbox').fill('Side panel');
    await page.getByTestId('ui-dialog').getByRole('button', { name: /save|confirm|submit|حفظ|تأكيد/i }).click();
    await expect(page.getByTestId('ui-dialog')).toBeHidden();
    await page.goto('/my-work');
    await page.getByTestId('topbar-bell').click();
    const panel = page.getByTestId('bell-panel');
    await expect(panel).toHaveAttribute('data-mode', 'side_panel');
    await expect(page.getByTestId('bell-tabs')).toBeVisible();
    const box = (await panel.boundingBox())!;
    const vw = page.viewportSize()!.width;
    if (c.locale === 'en') expect(box.x + box.width).toBeGreaterThan(vw - 2); else expect(box.x).toBeLessThan(2);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `test-results/ui-panel-${c.locale}.png` });
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  });
}
