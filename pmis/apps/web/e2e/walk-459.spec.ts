import { expect, test } from '@playwright/test';

test.skip(!process.env.WALK, 'real-stack run only');

/** D36 (#459): the register form sections show their Arabic names (register_sections.name_ar via section_ar), EN falls back. */
test('walk: Arabic section titles in the record drawer', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill('9001');
  await page.getByTestId('login-password').fill('Walk-Admin-Pass-2026');
  await page.getByTestId('login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });

  // EN pass: the "Advance" section title (NOT in the regSections i18n map)
  await page.goto('/registers/financial_advances');
  await page.getByTestId('register-new').click();
  let drawer = page.locator('[role="dialog"]').first();
  await expect(drawer).toBeVisible({ timeout: 15000 });
  await drawer.getByRole('combobox', { name: /Type/ }).selectOption({ index: 1 });
  await expect(drawer.getByRole('heading', { name: 'Advance', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/walk459-sections-en.png' });
  await page.getByTestId('reg-close').click();
  await page.waitForTimeout(400);
  await page.goto('/registers/financial_advances');

  // switch to Arabic BEFORE opening the drawer (modal blocks the topbar)
  await page.getByTestId('topbar-lang').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  await page.getByTestId('register-new').click();
  drawer = page.locator('[role="dialog"]').first();
  await expect(drawer).toBeVisible({ timeout: 15000 });
  await drawer.locator('select').first().selectOption({ index: 1 });
  await expect(drawer.getByRole('heading', { name: 'العهدة', exact: true })).toBeVisible({ timeout: 10000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log('horizontal overflow px:', overflow);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: 'test-results/walk459-sections-ar.png' });

  // back to English for the next walk
  await page.getByTestId('reg-close').click();
  await page.waitForTimeout(400);
  await page.goto('/registers/financial_advances');
  await page.getByTestId('topbar-lang').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});
