import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Decision 11: typed input asks before a dialog closes. Stay keeps the typing, Discard closes. EN/light and AR/dark (RTL).
for (const c of [{ locale: 'en', theme: 'light' }, { locale: 'ar', theme: 'dark' }] as const) {
  test(`unsaved guard: department dialog stay/discard (${c.locale}/${c.theme})`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [c.locale, c.theme]);
    await login(page, 'pm');
    await page.goto('/admin/users');
    await page.getByTestId('users-tab-departments').click();
    await page.getByTestId('dept-new').click();
    await page.getByTestId('dept-code').fill('zz');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('unsaved-dialog')).toBeVisible();
    await page.waitForTimeout(500);
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/unsaved-guard-${c.locale}.png` });
    await page.getByTestId('unsaved-stay').click();
    await expect(page.getByTestId('dept-code')).toHaveValue('zz');
    await expect(page.getByTestId('unsaved-dialog')).toHaveCount(0);
    await page.getByTestId('dept-code').focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('unsaved-dialog')).toBeVisible();
    await page.getByTestId('unsaved-discard').click();
    await expect(page.getByTestId('dept-dialog')).toHaveCount(0);
  });
}
