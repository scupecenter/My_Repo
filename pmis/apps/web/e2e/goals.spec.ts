import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Goals (contract 0.15.99), against the mock layer: EN/light and AR/dark. Settings, Screens, Goals adds a goal and saves it with a reason; the Dashboard
// card Goals then shows it with its progress, and links to the sites list and back to the settings.
const CASES = [
  { locale: 'en', theme: 'light', title: 'Goals', name: 'On-Air push' },
  { locale: 'ar', theme: 'dark', title: 'الأهداف', name: 'On-Air push' },
] as const;

for (const c of CASES) {
  test(`goals: add, save and see on the dashboard (${c.locale}/${c.theme})`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [c.locale, c.theme]);
    await login(page, 'pm');
    await page.goto('/admin/settings/screens/goals');
    await expect(page.getByTestId('page-goals-settings')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', c.locale === 'ar' ? 'rtl' : 'ltr');
    await expect(page.getByTestId('settings-section-screens-goals')).toHaveText(c.title);
    await expect(page.getByTestId('goals-empty')).toBeVisible();
    await page.getByTestId('goal-add').click();
    await page.getByTestId('goal-name-en-goal').fill(c.name);
    await page.getByTestId('goal-target-goal').fill('5');
    await page.getByTestId('goals-save').click();
    await page.getByTestId('goals-save-dialog-reason').fill('Quarter plan');
    await page.getByTestId('goals-save-dialog-submit').click();
    await expect(page.getByTestId('goals-version')).toContainText('1');
    await page.getByTestId('page-goals-settings').screenshot({ path: `test-results/goals-settings-${c.locale}.png` });

    await page.getByTestId('goals-link-dashboard').click();
    await expect(page.getByTestId('dash-goals')).toBeVisible();
    await expect(page.getByTestId('dash-goal-goal')).toContainText(c.name);
    await expect(page.getByTestId('dash-goal-goal').getByRole('progressbar')).toBeVisible();
    await page.getByTestId('dash-goals').scrollIntoViewIfNeeded();
    await page.getByTestId('dash-goals').screenshot({ path: `test-results/goals-dashboard-${c.locale}.png` });
    await page.getByTestId('dash-goals-settings').click();
    await expect(page.getByTestId('page-goals-settings')).toBeVisible();
  });
}
