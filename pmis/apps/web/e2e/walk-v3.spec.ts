import { expect, test } from '@playwright/test';

test.skip(!process.env.WALK, 'real-stack run only');

/** V3 (0.15.575): the timeline generalized to every register with a date field — Layout panel view, field picker, EN and AR. */
test('walk: register timeline', async ({ page }) => {
  test.setTimeout(180000);
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill('9001');
  await page.getByTestId('login-password').fill('Walk-Admin-Pass-2026');
  await page.getByTestId('login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });

  // EN: a register with date fields (permits carries issue/expiry dates) offers the timeline view
  await page.goto('/registers/permits');
  await page.getByTestId('register-view').click();
  await page.getByTestId('register-layout-timeline').click();
  await page.waitForURL((u) => u.searchParams.get('layout') === 'timeline', { timeout: 15000 });
  const tl = page.getByTestId('register-timeline');
  await expect(tl).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('register-timeline-cols')).toBeVisible();
  await page.screenshot({ path: 'test-results/walkv3-timeline-en.png' });

  // the field picker rides the URL
  const boxes = page.getByTestId('register-timeline-cols').locator('input[type=checkbox]');
  const n = await boxes.count();
  expect(n).toBeGreaterThan(0);
  if (n > 1) {
    await boxes.nth(0).click();
    await page.waitForTimeout(400);
    expect(new URL(page.url()).searchParams.get('tl')).toBeTruthy();
  }

  // a row opens its record (the drawer, or the page when the person chose so)
  const row = page.locator('[data-testid^="register-timeline-open-"]').first();
  if (await row.count()) {
    await row.click();
    await page.waitForTimeout(800);
    await page.keyboard.press('Escape');
  }

  // AR: full Arabic, no horizontal overflow
  await page.getByTestId('topbar-lang').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('register-timeline')).toBeVisible({ timeout: 15000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log('horizontal overflow px:', overflow);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: 'test-results/walkv3-timeline-ar.png' });

  // back to English for the next walk
  await page.getByTestId('topbar-lang').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});
