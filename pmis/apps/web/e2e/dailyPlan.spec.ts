import { expect, test } from '@playwright/test';
import { login } from './helpers';

// My Work > Daily Plan (plan W7, contract 0.15.67), against the mock layer: EN/light and AR/dark. The page opens from the side menu, shows the two tabs,
// saves a reason for a row below target, and Copy for email puts an HTML table on the clipboard.
const CASES = [
  { locale: 'en', theme: 'light', title: 'Daily Plan', tomorrow: 'Tomorrow', reasonNeeded: 'Reason needed' },
  { locale: 'ar', theme: 'dark', title: 'الخطة اليومية', tomorrow: 'خطة الغد', reasonNeeded: 'السبب مطلوب' },
] as const;

for (const c of CASES) {
  test(`daily plan: progress, reason, tomorrow and copy for email (${c.locale}/${c.theme})`, async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [c.locale, c.theme]);
    await login(page, 'pm');
    await page.getByTestId('nav-daily_plan').click();
    await expect(page.getByTestId('page-daily-plan')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', c.locale === 'ar' ? 'rtl' : 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(c.title);
    await expect(page.getByTestId('nav-daily_plan')).toHaveAttribute('aria-current', 'page');

    // a past working day: TR102 has planned work and nothing done
    await page.getByTestId('daily-plan-date').fill('2026-11-22');
    await expect(page.getByTestId('daily-plan-row-TR101')).toBeVisible();
    await expect(page.getByTestId('daily-plan-reason-missing-TR102')).toHaveText(c.reasonNeeded);
    await page.getByTestId('daily-plan-edit-TR102').click();
    await page.getByTestId('daily-plan-field-reason').fill('Rain stopped the crane');
    await page.getByTestId('daily-plan-row-dialog-submit').click();
    await expect(page.getByTestId('daily-plan-row-dialog')).toHaveCount(0);
    await expect(page.getByTestId('daily-plan-cell-TR102-reason')).toContainText('Rain stopped the crane');
    await expect(page.getByTestId('daily-plan-reason-missing-TR102')).toHaveCount(0);

    await page.getByTestId('daily-plan-tab-tomorrow').click();
    await expect(page.getByTestId('daily-plan-tab-tomorrow')).toHaveText(c.tomorrow);
    await expect(page.getByTestId('daily-plan-shown-date')).toContainText('2026-11-23');
    await expect(page.getByTestId('daily-plan-th-access_valid')).toBeVisible();

    await page.getByTestId('daily-plan-copy').click();
    const html = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const it = items.find((x) => x.types.includes('text/html'));
      return it ? await (await it.getType('text/html')).text() : '';
    });
    expect(html).toContain('<table');
    expect(html).toContain('Daily Progress 2026-11-22');
    expect(html).toContain('Tomorrow Plan 2026-11-23');
  });
}
