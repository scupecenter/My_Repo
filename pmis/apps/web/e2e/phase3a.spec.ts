import { expect, test, type Page } from '@playwright/test';
import { login, withStepUp, type DemoAccount } from './helpers';

async function signIn(page: Page, locale: 'en' | 'ar', account: DemoAccount) {
  await page.addInitScript((l) => { if (!localStorage.getItem('pmis.locale')) localStorage.setItem('pmis.locale', l); }, locale);
  await login(page, account);
}

for (const locale of ['en', 'ar'] as const) {
  test.describe(locale, () => {
    test('admin assigns a role to a pending user, who then sees My Work', async ({ page }) => {
      await signIn(page, locale, 'pm');
      await page.getByTestId('nav-admin.users').click();
      await expect(page.getByTestId('user-status-1211')).toBeVisible();
      await page.getByTestId('user-select-1211').check();
      await page.getByTestId('users-assign').click();
      await page.getByTestId('assign-role-cw_team_lead').check();
      // The dry-run preview comes first (it needs the step-up too); confirm opens only after it.
      await withStepUp(page, () => page.getByTestId('assign-preview').click());
      await expect(page.getByTestId('assign-preview-done')).toBeVisible();
      await page.getByTestId('assign-dialog-reason').fill('New joiner in Zawia');
      await page.getByTestId('assign-dialog-submit').click();
      await expect(page.getByTestId('user-status-1211')).toHaveAttribute('data-testid', 'user-status-1211');
      await expect(page.getByTestId('assign-dialog')).toHaveCount(0);
      await page.getByTestId('topbar-signout').click();
      await login(page, 'pending');
      await expect(page.getByTestId('page-my-work')).toBeVisible();
      await expect(page.getByTestId('pending-screen')).toHaveCount(0);
    });

    test('lead reassigns an absent person\'s task', async ({ page }) => {
      await signIn(page, locale, 'pm');
      await page.getByTestId('nav-absence').click();
      const list = page.getByTestId('alerts-absent');
      await expect(list.getByRole('listitem').first()).toBeVisible();
      const before = Number(await page.getByTestId('alerts-count-absent').textContent());
      expect(before).toBeGreaterThan(0);
      await list.getByRole('listitem').first().locator('[data-testid^="alert-reassign-"]').click();
      await page.getByTestId('cover-to-search').fill('Ali');
      await page.getByTestId('cover-to-opt-1103').click();
      await page.getByTestId('cover-dialog-reason').fill('Mona is on sick leave');
      await page.getByTestId('cover-dialog-submit').click();
      await expect(page.getByTestId('alerts-count-absent')).toHaveText(String(before - 1));
      await expect(page.getByTestId('toast').first()).toBeVisible();
    });

    test('exports the whole project and a partial, and downloads with the Arabic file name', async ({ page }) => {
      // Chromium here drops non-ASCII download names from the Download object, so read the anchor's `download` attribute instead.
      await page.addInitScript(() => {
        const click = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { if (this.download) (window as unknown as { __dl: string[] }).__dl = [...((window as unknown as { __dl?: string[] }).__dl ?? []), this.download]; click.call(this); };
      });
      await signIn(page, locale, 'pm');
      await page.getByTestId('topbar-export').click();
      await page.getByTestId('export-start').click();
      const first = page.locator('[data-testid^="export-row-"]').first();
      await expect(first.locator('[data-testid^="export-status-"]')).toHaveText(locale === 'ar' ? 'جاهز' : 'Ready', { timeout: 10_000 });
      await first.locator('[data-testid^="export-download-"]').click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { __dl?: string[] }).__dl?.[0])).toBe('تصدير_ماستر_2026-10-25.xlsx');

      await page.getByTestId('export-kind-parts').check();
      await page.getByTestId('export-part-gecol').check();
      await page.getByTestId('export-part-hlc').check();
      await page.getByTestId('export-start').click();
      await expect(page.locator('[data-testid^="export-row-"]')).toHaveCount(2);
      await expect(page.locator('[data-testid^="export-status-"]').first()).toHaveText(locale === 'ar' ? 'جاهز' : 'Ready', { timeout: 10_000 });
    });
  });
}
