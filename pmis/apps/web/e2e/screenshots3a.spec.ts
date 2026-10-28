import { test } from '@playwright/test';
import { login, withStepUp } from './helpers';
import path from 'node:path';

// Run with: SHOTS=1 npx playwright test e2e/screenshots3a.spec.ts
const OUT = path.resolve('../../design/screens/app');
test.skip(!process.env.SHOTS, 'screenshots are generated on demand');

for (const [locale, theme] of [['en', 'light'], ['ar', 'dark']] as const) {
  test(`phase 3a screens ${locale} ${theme}`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [locale, theme]);
    const shot = async (name: string) => { await page.waitForTimeout(500); await page.screenshot({ path: `${OUT}/${name}-${locale}-${theme}.png` }); };
    await page.goto('/login');
    await login(page, 'pm');

    await page.getByTestId('nav-admin.users').click();
    await page.getByTestId('user-row-1305').waitFor();
    await shot('users');
    await page.getByTestId('user-open-1204').click();
    await page.getByTestId('assignment-list').locator('tr').first().waitFor();
    await shot('user-detail');

    await page.getByTestId('nav-admin.users').click(); await page.getByTestId('people-tab-delegation').click();
    await page.getByTestId('deleg-new').click();
    await page.getByTestId('deleg-to-search').fill('Ali');
    await page.getByTestId('deleg-to-opt-1103').click();
    await page.getByTestId('deleg-right-reassign').check();
    await page.getByTestId('deleg-right-edit_date').check();
    await page.getByTestId('deleg-until').fill('2026-11-30');
    await page.getByTestId('delegation-dialog-reason').fill('Cover during my leave');
    await withStepUp(page, () => page.getByTestId('delegation-dialog-submit').click());
    await page.getByTestId('deleg-row-1103').waitFor();
    await shot('delegation');

    await page.getByTestId('nav-absence').click();
    await page.getByTestId('alerts-absent').getByRole('listitem').first().waitFor();
    await shot('absence');

    await page.getByTestId('topbar-export').click();
    await page.getByTestId('export-kind-parts').check();
    await page.getByTestId('export-part-gecol').check();
    await page.getByTestId('export-part-hlc').check();
    await page.getByTestId('export-start').click();
    await page.locator('[data-testid^="export-download-"]').first().waitFor({ timeout: 10_000 });
    await shot('export-dialog');
  });
}
