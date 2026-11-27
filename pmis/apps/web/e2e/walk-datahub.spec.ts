import { expect, test, type Page } from '@playwright/test';

// Real-stack walkthrough of the Data hub (runbook docs/ops/walkthrough.md). Run only with WALK=1.
test.skip(!process.env.WALK, 'real stack run only');

async function login(page: Page, locale: 'en' | 'ar') {
  await page.addInitScript((l) => localStorage.setItem('pmis.locale', l), locale);
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill('9001');
  await page.getByTestId('login-password').fill('Walk-Admin-Pass-2026');
  await page.getByTestId('login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
}

test('data hub: landing, quick download (audited), settings hide a widget, EN and AR', async ({ page }) => {
  await login(page, 'en');
  await page.goto('/data-hub');
  await expect(page.getByTestId('page-data-hub')).toBeVisible();
  await expect(page.getByTestId('hub-widget-batches')).toBeVisible();
  await page.screenshot({ path: 'test-results/walk-datahub-en.png', fullPage: true });

  // cascading dropdowns: template first, then the action
  const tpl = page.getByTestId('hub-quickbar-template');
  await tpl.click();
  await page.screenshot({ path: 'test-results/walk-datahub-quick-open.png' });
  await page.getByRole('option').first().click();
  await page.getByTestId('hub-quickbar-action').click();
  await page.getByTestId('hub-quickbar-action-opt-blank').click();
  const dl = page.waitForEvent('download');
  await page.getByTestId('hub-quickbar-go').click();
  await dl;
  await page.reload();
  await expect(page.getByTestId('hub-my-downloads')).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: 'test-results/walk-datahub-downloads-en.png', fullPage: true });

  // the gear opens the one settings place; hide template changes and save through the real door
  await page.getByTestId('hub-settings-gear').click();
  await expect(page.getByTestId('page-dh-settings')).toBeVisible();
  await page.getByTestId('dh-widget-template_changes').uncheck();
  await page.getByTestId('dh-view-templates-rows').click();
  await page.screenshot({ path: 'test-results/walk-datahub-settings-en.png', fullPage: true });
  await page.getByTestId('dh-save').click();
  await page.getByTestId('dh-dialog').getByRole('textbox').fill('Walkthrough: hide template changes');
  await page.getByTestId('dh-dialog').getByRole('button', { name: /save|confirm|submit/i }).click();
  await expect(page.getByTestId('dh-dialog')).toBeHidden({ timeout: 15000 });
  await page.goto('/data-hub');
  await expect(page.getByTestId('hub-widget-template_changes')).toHaveCount(0);
  await expect(page.getByTestId('hub-widget-health')).toBeVisible();
  await page.screenshot({ path: 'test-results/walk-datahub-hidden-en.png', fullPage: true });
});

test('data hub in Arabic: RTL landing and settings', async ({ page }) => {
  await login(page, 'ar');
  await page.goto('/data-hub');
  await expect(page.getByTestId('page-data-hub')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
  await page.getByTestId('hub-quickbar-template').click();
  await page.screenshot({ path: 'test-results/walk-datahub-ar.png', fullPage: true });
  await page.goto('/admin/settings/screens/data-hub');
  await expect(page.getByTestId('page-dh-settings')).toBeVisible();
  await page.screenshot({ path: 'test-results/walk-datahub-settings-ar.png', fullPage: true });
});
