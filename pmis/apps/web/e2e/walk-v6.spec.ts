import { expect, test } from '@playwright/test';

test.skip(!process.env.WALK, 'real-stack run only');

/** V6 (0.15.574): the card size of the board views, a personal Display option of the Layout panel (compact/comfortable/large), EN and AR. */
test('walk: board card size from the Layout panel', async ({ page }) => {
  test.setTimeout(180000);
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill('9001');
  await page.getByTestId('login-password').fill('Walk-Admin-Pass-2026');
  await page.getByTestId('login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });

  // EN: the Site Master board, card size compact then large
  await page.goto('/sites?layout=board');
  const board = page.getByTestId('sites-board-scroll');
  await expect(board).toBeVisible({ timeout: 30000 });
  await expect(board).toHaveAttribute('data-card-size', 'md');
  await page.getByTestId('sites-view').click();
  await expect(page.getByTestId('display-card-md')).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: 'test-results/walkv6-board-md-en.png' });
  await page.getByTestId('display-card-sm').click();
  await page.keyboard.press('Escape');
  await expect(board).toHaveAttribute('data-card-size', 'sm');
  await page.screenshot({ path: 'test-results/walkv6-board-sm-en.png' });

  // AR: the choice follows, large reads without horizontal overflow
  await page.getByTestId('topbar-lang').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.getByTestId('sites-view').click();
  await expect(page.getByTestId('display-card-sm')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('display-card-lg').click();
  await page.keyboard.press('Escape');
  await expect(board).toHaveAttribute('data-card-size', 'lg');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log('horizontal overflow px:', overflow);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: 'test-results/walkv6-board-lg-ar.png' });

  // a register board shows the same control
  await page.getByTestId('topbar-lang').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await page.goto('/registers/procurement?layout=board');
  const rboard = page.getByTestId('register-board-scroll');
  await expect(rboard).toBeVisible({ timeout: 30000 });
  await page.getByTestId('register-view').click();
  await expect(page.getByTestId('display-card-md')).toBeVisible();
  await page.screenshot({ path: 'test-results/walkv6-register-panel-en.png' });
  await page.keyboard.press('Escape');

  // back to comfortable for the next walk
  await page.goto('/sites?layout=board');
  await page.getByTestId('sites-view').click();
  await page.getByTestId('display-card-md').click();
  await page.keyboard.press('Escape');
  await expect(board).toHaveAttribute('data-card-size', 'md');
});
