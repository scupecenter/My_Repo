import { expect, test } from '@playwright/test';

test.skip(!process.env.WALK, 'real-stack run only');

/** #474 (0561, 0.15.402): share links to a read-only dashboard view — create, open, manage, revoke, EN and AR. */
test('walk: dashboard share link end to end', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill('9001');
  await page.getByTestId('login-password').fill('Walk-Admin-Pass-2026');
  await page.getByTestId('login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });

  // EN pass: create a link from the dashboard toolbar
  await page.goto('/dashboard');
  await page.getByTestId('dash-share').click(); // P2: the Share / Export menu holds the share-link action
  await page.getByTestId('dash-share-link').click();
  const dialog = page.getByTestId('dashshare-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId('dashshare-label').fill('Weekly ops');
  await page.getByTestId('dashshare-reason').fill('weekly report');
  await page.getByTestId('dashshare-create').click();
  const urlInput = page.getByTestId('dashshare-url');
  await expect(urlInput).toBeVisible({ timeout: 15000 });
  const url = await urlInput.inputValue();
  expect(url).toContain('/dashboard/shared/');
  await page.screenshot({ path: 'test-results/walk474-share-en.png' });
  await page.getByTestId('dashshare-done').click();
  await page.waitForTimeout(400);

  // open the link: the banner names it and the dashboard renders
  await page.goto(new URL(url).pathname);
  await expect(page.getByTestId('shared-banner')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('Loading...').first()).not.toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/walk474-shared-en.png' });

  // Settings > Dashboard > Share links: the row shows, revoke works
  await page.goto('/admin/settings/screens/dashboard');
  const card = page.getByTestId('dsettings-shares');
  await expect(card).toBeVisible({ timeout: 15000 });
  await card.scrollIntoViewIfNeeded();
  const table = page.getByTestId('dsettings-shares-table');
  await expect(table).toBeVisible();
  const row = table.locator('tr', { hasText: 'Weekly ops' }).first();
  await expect(row).toBeVisible();
  await page.screenshot({ path: 'test-results/walk474-settings-en.png' });
  await row.locator('button[data-testid^="dsettings-share-revoke-"]').click();
  await page.getByTestId('dashshare-revoke-reason').fill('no longer needed');
  await page.getByTestId('dashshare-revoke-confirm').click();
  await expect(page.getByTestId('dashshare-revoke-dialog')).not.toBeVisible({ timeout: 15000 });

  // the revoked link opens as gone
  await page.goto(new URL(url).pathname);
  await expect(page.getByTestId('shared-unavailable')).toBeVisible({ timeout: 15000 });

  // AR pass: switch BEFORE opening the dialog (modal blocks the topbar)
  await page.goto('/dashboard');
  await page.getByTestId('topbar-lang').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.getByTestId('dash-share').click();
  await page.getByTestId('dash-share-link').click();
  await expect(page.getByTestId('dashshare-dialog')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log('horizontal overflow px:', overflow);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: 'test-results/walk474-share-ar.png' });
  await page.getByTestId('dashshare-cancel').click();
  await page.waitForTimeout(400);

  await page.goto('/admin/settings/screens/dashboard');
  const cardAr = page.getByTestId('dsettings-shares');
  await expect(cardAr).toBeVisible({ timeout: 15000 });
  await cardAr.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/walk474-settings-ar.png' });

  // back to English for the next walk
  await page.goto('/dashboard');
  await page.getByTestId('topbar-lang').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});
