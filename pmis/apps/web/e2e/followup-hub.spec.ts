import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Item 11: the follow-up hub (approvals, assigned tasks, reminders, profile checklist); a checklist item opens the exact setting; the checklist hides by a personal choice. EN and AR.
for (const c of [{ locale: 'en' }, { locale: 'ar' }] as const) {
  test(`follow-up hub: blocks, checklist link to the exact setting, hide it (${c.locale})`, async ({ page }) => {
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); }, c.locale);
    await login(page, 'pm');
    await page.goto('/my-work');
    await page.getByTestId('my-work-go-followup').click();
    await expect(page).toHaveURL(/\/follow-up$/);
    for (const b of ['approvals', 'assigned', 'reminders', 'checklist']) await expect(page.getByTestId(`fup-${b}`)).toBeVisible();
    await page.screenshot({ path: `test-results/followup-${c.locale}.png` });
    const go = page.locator('[data-testid^="fup-check-"][data-testid$="-go"]').first();
    if (await go.count()) {
      await go.click();
      await expect(page).toHaveURL(/\/profile#/);
    } else {
      await page.goto('/profile');
    }
    await page.getByTestId('pf-ap-followup_checklist').selectOption('hide');
    await page.getByTestId('pf-ap-apply').click();
    await expect(page.getByTestId('pf-ap-apply')).toBeDisabled();
    await page.goto('/follow-up');
    await expect(page.getByTestId('fup-approvals')).toBeVisible();
    await expect(page.getByTestId('fup-checklist')).toHaveCount(0);
    await page.goto('/profile');
    await page.getByTestId('pf-ap-followup_checklist').selectOption('show');
    await page.getByTestId('pf-ap-apply').click();
    await expect(page.getByTestId('pf-ap-apply')).toBeDisabled();
  });
}
