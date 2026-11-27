import { expect, test } from '@playwright/test';

// Real-stack walkthrough for Decision 36 visual fixes 6-8 (2026-11-27): real API + scratch DB, no mocks. Run only with WALK=1.
test.skip(!process.env.WALK, 'real-stack run only');

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill('9001');
  await page.getByTestId('login-password').fill('Walk-Admin-Pass-2026');
  await page.getByTestId('login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
}

test('messages fills the window, the breadcrumb names the page once, EN and AR', async ({ page }) => {
  await signIn(page);

  // 6: the conversation panel fills the window height (no dead strip below it).
  await page.goto('/messages');
  await expect(page.getByTestId('page-messages')).toBeVisible({ timeout: 20000 });
  await page.screenshot({ path: 'test-results/walk-d36-messages-en.png', fullPage: false });

  // 7: the breadcrumb says Site Master once on the master list.
  await page.goto('/sites');
  await expect(page.getByTestId('page-sites')).toBeVisible({ timeout: 20000 });
  const crumbs = await page.getByTestId('breadcrumb').textContent();
  expect(crumbs?.match(/Site Master/g)).toHaveLength(1);
  await page.screenshot({ path: 'test-results/walk-d36-sites-breadcrumb-en.png' });

  // AR: messages and the breadcrumb in Arabic, RTL.
  await page.getByTestId('topbar-lang').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.goto('/messages');
  await expect(page.getByTestId('page-messages')).toBeVisible({ timeout: 20000 });
  await page.screenshot({ path: 'test-results/walk-d36-messages-ar.png' });
  await page.goto('/sites');
  const crumbsAr = await page.getByTestId('breadcrumb').textContent();
  expect(crumbsAr?.match(/ماستر المواقع/g)).toHaveLength(1);
  await page.screenshot({ path: 'test-results/walk-d36-sites-breadcrumb-ar.png' });
});
