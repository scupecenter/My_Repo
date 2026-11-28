import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Layout panel on the remaining table screens: the audit log, the field changes log and the warehouse tables open the panel (density, display options).
// The auditor reads the logs; the PM reads the warehouse. EN and AR.
for (const c of [{ locale: 'en' }, { locale: 'ar' }] as const) {
  test(`layout panel on the logs and the warehouse tables (${c.locale})`, async ({ page }) => {
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); }, c.locale);
    await login(page, 'pm');
    for (const [url, id] of [['/audit', 'audit-log-layout'], ['/admin/logs/field-changes', 'field-changes-layout'], ['/warehouse', 'wh-item-table-layout']] as const) {
      await page.goto(url);
      await page.getByTestId(id).click();
      await expect(page.getByTestId(`${id}-panel`)).toBeVisible();
      await expect(page.getByTestId('display-zebra')).toBeVisible();
      if (url === '/warehouse') await page.screenshot({ path: `test-results/layout-everywhere-${c.locale}.png` });
      await page.keyboard.press('Escape');
    }
  });
}
