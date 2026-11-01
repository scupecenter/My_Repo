import { expect, test } from '@playwright/test';
import { login } from './helpers';

// UI plan phases 1-2: real-code previews of the Site Register with the new sidebar tree (AR/dark, EN/light).
for (const [l, t] of [['ar', 'dark'], ['en', 'light']] as const) {
  test(`ui phase 2 preview (${l}/${t})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(([a, b]) => { localStorage.setItem('pmis.locale', a); localStorage.setItem('pmis.theme', b); }, [l, t]);
    await login(page, 'pm');
    await page.getByTestId('nav-sites').click();
    await expect(page.getByTestId('page-sites')).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `../../design/previews/ui-phase2/sites-${l}-${t}.png` });
  });
}
