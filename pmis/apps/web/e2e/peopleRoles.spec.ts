import { expect, test } from '@playwright/test';
import { login, withStepUp } from './helpers';

// Users & Roles tabs for assignments and permission profiles, in both languages and both themes (RTL needs no special cases).
for (const [locale, theme] of [['en', 'light'], ['ar', 'dark']] as const) {
  test(`assignments and profiles tabs ${locale} ${theme}`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [locale, theme]);
    await login(page, 'pm');
    await page.getByTestId('nav-admin.users').click();
    await page.getByTestId('people-tab-assignments').click();
    await expect(page.getByTestId('page-assignments')).toBeVisible();
    if (locale === 'ar') {
      await expect(page.getByTestId('people-tab-assignments')).toHaveText('الإسنادات');
      await expect(page.getByTestId('people-tab-profiles')).toHaveText('ملفات الصلاحيات');
      await expect(page.getByTestId('people-tab-delegation')).toHaveText('التفويضات');
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    }
    await page.getByTestId('people-tab-profiles').click();
    await expect(page.getByTestId('page-profiles')).toBeVisible();
    await page.getByTestId('profile-new').click();
    await expect(page.getByTestId('grant-sites-view')).toBeVisible();
    await page.getByTestId('profile-code').fill('QA_VIEW');
    await page.getByTestId('profile-name-en').fill('QA viewer');
    await page.getByTestId('grant-sites-view').check();
    await page.getByTestId('profile-dialog-reason').fill('New read-only profile');
    await withStepUp(page, () => page.getByTestId('profile-dialog-submit').click());
    await expect(page.getByTestId('profile-row-QA_VIEW')).toBeVisible();
  });
}
