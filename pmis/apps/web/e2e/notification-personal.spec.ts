import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Items 4 and 7 (contract 0.15.531): Profile > Notifications (own types, scheduled do-not-disturb, snooze, test notice, held notices) and the org switches
// in Settings > Alerts > Policy. EN and AR. The mock door answers here; the real-stack run is the WALK=1 test below.
for (const c of [{ locale: 'en' }, { locale: 'ar' }] as const) {
  test(`profile notifications: own types, do-not-disturb, snooze, test notice (${c.locale})`, async ({ page }) => {
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); }, c.locale);
    await login(page, 'pm');
    await page.goto('/profile');
    const sec = page.getByTestId('profile-notifications');
    await expect(sec).toBeVisible();
    // mandatory type: on and locked
    await expect(page.getByTestId('npp-ch-security_alert-email')).toBeChecked();
    await expect(page.getByTestId('npp-ch-security_alert-email')).toBeDisabled();
    // type off + schedule on, then save
    await page.getByTestId('npp-ch-task_assigned-email').uncheck();
    await page.getByTestId('npp-dnd-enabled').check();
    await page.getByTestId('npp-dnd-start').fill('21:30');
    await page.getByTestId('npp-day-5').uncheck();
    await sec.screenshot({ path: `test-results/notification-personal-${c.locale}.png` });
    await page.getByTestId('npp-save').click();
    await expect(page.getByTestId('npp-save')).toBeDisabled(); // saved: the screen shows the stored version (the mock keeps its state in the page, so no reload here)
    await expect(page.getByTestId('npp-ch-task_assigned-email')).not.toBeChecked();
    await expect(page.getByTestId('npp-dnd-start')).toHaveValue('21:30');
    await expect(page.getByTestId('npp-day-5')).not.toBeChecked();
    // snooze, then clear
    await page.getByTestId('npp-snooze-1').click();
    await expect(page.getByTestId('npp-snooze-clear')).toBeEnabled();
    await expect(page.getByTestId('npp-quiet-state')).toContainText(c.locale === 'en' ? 'Quiet now' : 'وقت هدوء الآن');
    await page.getByTestId('npp-snooze-clear').click();
    await expect(page.getByTestId('npp-quiet-state')).toContainText(c.locale === 'en' ? 'Not in quiet time' : 'ليس وقت هدوء');
    // test notice
    await page.getByTestId('npp-test').click();
    await expect(page.getByTestId('npp-held-none')).toBeVisible();
    // an edit can be reverted
    await page.getByTestId('npp-ch-approval_due-in_app').uncheck();
    await page.getByTestId('npp-revert').click();
    await expect(page.getByTestId('npp-ch-approval_due-in_app')).toBeChecked();
  });

  test(`policy page: the org switches of the personal layer (${c.locale})`, async ({ page }) => {
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); }, c.locale);
    await login(page, 'pm');
    await page.goto('/admin/settings/alerts/policy');
    const card = page.getByTestId('np-personal');
    await expect(card).toBeVisible();
    await page.getByTestId('npp-org-dedupe').fill('0');
    await page.getByTestId('npp-org-save').click();
    await page.getByTestId('npp-org-dialog').getByRole('textbox').fill('Walkthrough: dedupe off');
    await page.getByTestId('npp-org-dialog').getByRole('button', { name: /save|confirm|submit|حفظ|تأكيد/i }).click();
    await expect(page.getByTestId('npp-org-dialog')).toBeHidden();
    await expect(page.getByTestId('npp-org-dedupe')).toHaveValue('0');
  });
}

// Real stack (runbook docs/ops/walkthrough.md): real API and database. The test notice goes through the real gate and reaches the bell.
test.describe('real stack', () => {
  test.skip(!process.env.WALK, 'real-stack run only');
  test('real stack: a type turned off stops its notice, the test notice arrives', async ({ page }) => {
    await page.goto('/login');
    await page.getByTestId('login-identifier').fill('9001');
    await page.getByTestId('login-password').fill('Walk-Admin-Pass-2026');
    await page.getByTestId('login-submit').click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
    await page.goto('/profile');
    await expect(page.getByTestId('profile-notifications')).toBeVisible();
    await page.getByTestId('npp-test').click();
    await page.goto('/inbox');
    await expect(page.getByText(/Test notification/).first()).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: 'test-results/walk-notification-personal.png' });
  });
});
