import { test } from '@playwright/test';
import { login } from './helpers';
import path from 'node:path';

// Run with: SHOTS=1 npx playwright test e2e/screenshots3b.spec.ts
const OUT = path.resolve('../../design/screens/app');
test.skip(!process.env.SHOTS, 'screenshots are generated on demand');

for (const [locale, theme] of [['en', 'light'], ['ar', 'dark']] as const) {
  test(`phase 3b screens ${locale} ${theme}`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [locale, theme]);
    const shot = async (name: string) => { await page.waitForTimeout(500); await page.screenshot({ path: `${OUT}/${name}-${locale}-${theme}.png`, fullPage: true }); };
    await page.goto('/login');
    await login(page, 'pm');

    await page.getByTestId('nav-admin.settings').click();
    await page.getByTestId('holiday-2026-11-03').waitFor();
    await shot('settings-calendar');
    await page.getByTestId('settings-tab-sla').click(); await page.getByTestId('sla-create-draft').click();
    await page.getByTestId('sla-create-dialog-reason').fill('Tighten A2'); await page.getByTestId('sla-create-dialog-submit').click();
    await page.getByTestId('sla-ovr-add-A2').click(); await page.getByTestId('sla-max-A2').fill('6'); await page.getByTestId('sla-A2').waitFor(); await shot('settings-sla');
    await page.getByTestId('settings-tab-weights').click(); await page.getByTestId('weights-code').selectOption('health_index'); await page.getByTestId('weights-error-health_index').waitFor(); await shot('settings-weights');
    await page.getByTestId('settings-tab-freeze').click(); await page.getByTestId('freeze-lift').waitFor(); await shot('settings-freeze');
    await page.getByTestId('settings-tab-dlp').click(); await page.getByTestId('dlp-version-2').waitFor(); await shot('settings-dlp');
    await page.getByTestId('settings-tab-idle').click(); await page.getByTestId('idle-days').waitFor(); await shot('settings-idle');
    await page.getByTestId('settings-tab-notifications').click(); await page.getByTestId('np-row-no_holder').waitFor(); await shot('settings-notifications');
    await page.getByTestId('settings-tab-retention').click(); await page.getByTestId('ret-audit').waitFor(); await shot('settings-retention');
    await page.getByTestId('settings-tab-staff-visibility').click(); await page.getByTestId('sv-email').waitFor(); await shot('settings-staff-visibility');

    await page.getByTestId('nav-admin.security_log').click();
    await page.getByTestId('seclog-row-36').waitFor();
    await page.getByTestId('integrity-security').click();
    await page.getByTestId('integrity-result-security').waitFor();
    await shot('security-log');

    await page.getByTestId('nav-admin.users').click(); await page.getByTestId('users-tab-online').click();
    await page.getByTestId('session-own').waitFor();
    await shot('online-now');

    await page.getByTestId('nav-admin.users').click();
    await page.getByTestId('users-tab-deleted').click();
    await page.getByTestId('deleted-row-9001').waitFor();
    await shot('users-deleted');
  });
}
