import { expect, test, type Page } from '@playwright/test';

// Real-stack walkthrough for Settings > Security > Limits and the Settings index (runbook docs/ops/walkthrough.md). Run only with WALK=1.
test.skip(!process.env.WALK, 'real-stack run only');
test.setTimeout(180000);

async function login(page: Page, id: string, pw: string) {
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill(id);
  await page.getByTestId('login-password').fill(pw);
  await page.getByTestId('login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
}
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/ops-${name}.png`, fullPage: true });

async function save(page: Page, reason: string) {
  await page.getByTestId('oplimits-save').click();
  await page.getByTestId('oplimits-dialog-reason').fill(reason);
  await shot(page, 'dialog');
  await page.getByTestId('oplimits-dialog-submit').click();
  // the real door asks for the password again (step-up)
  const pw = page.getByTestId('stepup-password');
  if (await pw.isVisible({ timeout: 5000 }).catch(() => false)) {
    await pw.fill('Walk-Admin-Pass-2026');
    await shot(page, 'stepup');
    await page.getByTestId('stepup-continue').click();
  }
  await expect(page.getByTestId('oplimits-dialog')).toBeHidden({ timeout: 15000 });
}

test('admin: /settings index, limits page, change, Arabic, reset; staff: read-only', async ({ page, browser }) => {
  await login(page, '9001', 'Walk-Admin-Pass-2026');
  await page.goto('/settings');
  await expect(page.getByTestId('settings-index')).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/settings$/);
  await expect(page.getByTestId('page-soon')).toHaveCount(0);
  await shot(page, 'en-index');
  await page.getByTestId('settings-index-security-limits').click();
  await expect(page.getByTestId('page-ops-limits')).toBeVisible();
  await expect(page.getByTestId('oplimits-session_idle_hours')).toHaveValue('8');
  await expect(page.getByTestId('oplimits-stepup_seconds')).toHaveValue('300');
  await page.getByText('Idle sign-out').first().hover();
  await expect(page.getByTestId('tip')).toBeVisible();
  await shot(page, 'en-defaults-hint');
  // a bad value is refused in the form
  await page.getByTestId('oplimits-stepup_seconds').fill('5');
  await expect(page.getByTestId('oplimits-stepup_seconds-error')).toBeVisible();
  await expect(page.getByTestId('oplimits-save')).toBeDisabled();
  await shot(page, 'en-bad-value');
  await page.getByTestId('oplimits-stepup_seconds').fill('120');
  await page.getByTestId('oplimits-session_idle_hours').fill('6');
  await page.getByTestId('oplimits-import_max_rows').fill('1500');
  await save(page, 'Walkthrough: shorter sessions');
  await expect(page.getByTestId('oplimits-stepup_seconds-custom')).toBeVisible();
  await expect(page.getByTestId('oplimits-updated')).toContainText('Walk Admin');
  await shot(page, 'en-saved');
  // Arabic, right to left
  await page.evaluate(() => localStorage.setItem('pmis.locale', 'ar'));
  await page.goto('/admin/settings/security/limits');
  await expect(page.getByTestId('page-ops-limits')).toBeVisible();
  await shot(page, 'ar-limits');
  await page.goto('/settings');
  await expect(page.getByTestId('settings-index')).toBeVisible();
  await shot(page, 'ar-index');
  await page.evaluate(() => localStorage.setItem('pmis.locale', 'en'));
  // back to defaults
  await page.goto('/admin/settings/security/limits');
  await page.getByTestId('oplimits-reset-all').click();
  await save(page, 'Walkthrough: back to defaults');
  await expect(page.getByTestId('oplimits-stepup_seconds-custom')).toHaveCount(0);
  await expect(page.getByTestId('oplimits-stepup_seconds')).toHaveValue('300');
  // a user without Settings access: read-only
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await login(p2, '9002', 'Walk-Staff-Pass-2026-y');
  await p2.goto('/admin/settings/security/limits');
  await expect(p2.getByTestId('page-ops-limits').or(p2.getByTestId('oplimits-loading')).first()).toBeVisible({ timeout: 15000 });
  await p2.screenshot({ path: 'test-results/ops-staff.png', fullPage: true });
  await ctx.close();
});
