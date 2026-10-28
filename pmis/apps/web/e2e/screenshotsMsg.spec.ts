import { expect, test } from '@playwright/test';
import path from 'node:path';
import { login } from './helpers';

// Run with: SHOTS=1 SHOTS_DIR=/some/dir npx playwright test e2e/screenshotsMsg.spec.ts
const OUT = path.resolve(process.env.SHOTS_DIR ?? 'test-results/shots');
test.skip(!process.env.SHOTS, 'screenshots are generated on demand');

for (const [locale, theme] of [['en', 'light'], ['ar', 'dark']] as const) {
  test(`messages, announcements, departments ${locale} ${theme}`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [locale, theme]);
    const shot = async (name: string) => { await page.waitForTimeout(400); await page.screenshot({ path: `${OUT}/${name}-${locale}-${theme}.png`, fullPage: true }); };
    await login(page, 'engineer');
    await expect(page.getByTestId('ann-popup')).toBeVisible();
    await shot('announcement-popup');
    await page.getByTestId('ann-popup-disagree').click();
    await page.getByTestId('ann-popup-note').fill('Clashes with the night shift');
    await shot('announcement-popup-disagree');
    await page.getByTestId('ann-popup-submit').click();
    await page.getByTestId('topbar-signout').click();

    await login(page, 'reviewer');
    await page.getByTestId('nav-messages').click();
    await page.locator('[data-testid^="thread-subject-"]').first().click();
    await page.getByTestId('reply-body').fill('Noted, thanks.');
    await page.getByTestId('reply-send').click();
    await expect(page.getByTestId('reply-list')).toContainText('Noted, thanks.');
    await shot('messages-thread');
    await page.getByTestId('messages-new').click();
    await page.getByTestId('new-message-to').selectOption({ index: 1 });
    await shot('messages-new');
    await page.keyboard.press('Escape');
    await page.getByTestId('topbar-signout').click();

    await login(page, 'pm');
    await page.getByTestId('nav-announcements').click();
    await page.getByTestId('ann-list').waitFor();
    await shot('announcements-list');
    await page.getByTestId('ann-new-open').click();
    await page.getByTestId('ann-title').fill('Quarterly safety briefing');
    await page.getByTestId('ann-body').fill('Attendance is required.\nPlease answer.');
    await page.getByTestId('ann-dept-CIVIL').check();
    await shot('announcements-new');
    await page.keyboard.press('Escape');
    await page.locator('[data-testid^="ann-open-"]').first().click();
    await page.getByTestId('ann-resp-1306').waitFor();
    await shot('announcements-results');
    await page.getByTestId('nav-admin.users').click();
    await page.getByTestId('user-dept-1103').waitFor();
    await shot('users-department-column');
    await page.getByTestId('users-tab-departments').click();
    await page.getByTestId('dept-row-CIVIL').waitFor();
    await shot('departments');
    await page.getByTestId('users-tab-active').click();
    await page.getByTestId('user-open-1103').click();
    await page.getByTestId('org-manager-value').waitFor();
    await shot('user-org');
    await page.getByTestId('org-edit').click();
    await page.getByTestId('org-dialog').waitFor();
    await shot('user-org-dialog');
  });
}
