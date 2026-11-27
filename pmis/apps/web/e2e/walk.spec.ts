import { expect, test } from '@playwright/test';

// Real-stack walkthrough template (runbook docs/ops/walkthrough.md): real API + scratch DB, no mocks. Run only with WALK=1.
// This smoke signs in as the bootstrap admin and saves one real setting through its SQL door. Copy it per feature.
test.skip(!process.env.WALK, 'real-stack run only');
test('real stack smoke: sign in and save the interface features setting through the real door', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill('9001');
  await page.getByTestId('login-password').fill('Walk-Admin-Pass-2026');
  await page.getByTestId('login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
  await page.goto('/admin/settings/screens/interface');
  await expect(page.getByTestId('page-ui-settings')).toBeVisible();
  await page.getByTestId('ui-new-days').fill('21');
  await page.getByTestId('ui-save').click();
  await page.getByTestId('ui-dialog').getByRole('textbox').fill('Walkthrough smoke');
  await page.getByTestId('ui-dialog').getByRole('button', { name: /save|confirm|submit/i }).click();
  await expect(page.getByTestId('ui-dialog')).toBeHidden({ timeout: 15000 });
  await page.screenshot({ path: 'test-results/walk-smoke.png' });
});
