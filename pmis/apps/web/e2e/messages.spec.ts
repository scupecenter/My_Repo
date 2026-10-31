import { expect, test, type Page } from '@playwright/test';
import { answerAnnouncements, login, type DemoAccount } from './helpers';

async function signIn(page: Page, locale: 'en' | 'ar', account: DemoAccount) {
  await page.addInitScript((l) => { if (!localStorage.getItem('pmis.locale')) localStorage.setItem('pmis.locale', l); }, locale);
  await login(page, account);
}
const signOut = (page: Page) => page.getByTestId('topbar-signout').click();

for (const locale of ['en', 'ar'] as const) {
  test.describe(locale, () => {
    test('admin sends an announcement, the recipient is blocked until answering, a disagreement needs a note, the admin sees the results', async ({ page }) => {
      const title = 'E2E: new site access rule';
      await signIn(page, locale, 'pm');
      await page.getByTestId('nav-announcements').click();
      await page.getByTestId('ann-new-open').click();
      await expect(page.getByTestId('ann-warning')).toBeVisible();
      await expect(page.getByTestId('ann-new-submit')).toBeDisabled();
      await page.getByTestId('ann-title').fill(title);
      await page.getByTestId('ann-body').fill('Line one\nLine two');
      await page.getByTestId('ann-all').check();
      await page.getByTestId('ann-new-submit').click();
      await expect(page.getByTestId('ann-new')).toHaveCount(0);
      const row = page.locator('[data-testid^="ann-row-"]').filter({ hasText: title });
      await expect(row).toBeVisible();
      await signOut(page);

      // The recipient: the seeded announcement first (oldest), then the new one.
      await login(page, 'engineer');
      const popup = page.getByTestId('ann-popup');
      await expect(popup).toBeVisible();
      await expect(page.getByTestId('ann-popup-title')).toHaveText('Updated site access rules');
      await page.keyboard.press('Escape');
      await page.mouse.click(5, 5); // outside
      await expect(popup).toBeVisible();
      await expect(page.locator('body')).toHaveCSS('pointer-events', 'none'); // the page behind is inert
      await page.getByTestId('ann-popup-agree').click();
      await expect(page.getByTestId('ann-popup-title')).toHaveText(title);
      await expect(page.getByTestId('ann-popup-body')).toContainText('Line two');
      await page.getByTestId('ann-popup-disagree').click();
      await expect(page.getByTestId('ann-popup-submit')).toBeDisabled();
      await page.getByTestId('ann-popup-note').fill('ab');
      await expect(page.getByTestId('ann-popup-submit')).toBeDisabled();
      await page.getByTestId('ann-popup-note').fill('Clashes with the night shift');
      await page.getByTestId('ann-popup-submit').click();
      await expect(popup).toHaveCount(0);
      await expect(page.getByTestId('page-my-work')).toBeVisible();
      await signOut(page);

      // The admin sees the results.
      await login(page, 'pm');
      await page.getByTestId('nav-announcements').click();
      await page.locator('[data-testid^="ann-open-"]').filter({ hasText: title }).click();
      await expect(page.getByTestId('ann-detail-title')).toHaveText(title);
      await expect(page.getByTestId('ann-stat-disagree')).toContainText('1');
      await expect(page.getByTestId('ann-resp-note-1204')).toHaveText('Clashes with the night shift');
      await page.getByTestId('ann-filter').selectOption('disagree');
      await expect(page.locator('[data-testid^="ann-resp-1"]').filter({ has: page.getByTestId('ann-resp-decision-1204') })).toHaveCount(1);
      await expect(page.getByTestId('ann-resp-1102')).toHaveCount(0);
      await page.getByTestId('ann-filter').selectOption('pending');
      await expect(page.getByTestId('ann-resp-1102')).toBeVisible(); // has not answered the new one
      const download = page.waitForEvent('download');
      await page.getByTestId('ann-export').click();
      expect((await download).suggestedFilename()).toMatch(/\.csv$/);
    });

    test('an employee writes to the manager, the manager replies twice: original, reply box, then newest first', async ({ page }) => {
      const subject = 'E2E: site visit question';
      await signIn(page, locale, 'auditor'); // Ali Barka, reports to Mona Fathi
      await page.getByTestId('nav-messages').click();
      await page.getByTestId('messages-new').click();
      await page.getByTestId('new-message-to').selectOption({ index: 1 });
      await page.getByTestId('new-message-subject').fill(subject);
      await page.getByTestId('new-message-body').fill('Which site first?\nPlease confirm.');
      await page.getByTestId('new-message-submit').click();
      await expect(page.getByTestId('thread-title')).toHaveText(subject);
      await expect(page.getByTestId('msg-original-body')).toContainText('Please confirm.');
      await signOut(page);

      await login(page, 'reviewer'); // Mona Fathi
      await expect(page.getByTestId('messages-badge')).toBeVisible();
      await page.getByTestId('nav-messages').click();
      const mine = page.locator('[data-testid^="thread-subject-"]').filter({ hasText: subject });
      await expect(mine).toBeVisible();
      await mine.click();
      await expect(page.getByTestId('thread-title')).toHaveText(subject);
      for (const text of ['First reply', 'Second reply']) {
        await page.getByTestId('reply-body').fill(text);
        await page.getByTestId('reply-send').click();
        await expect(page.getByTestId('reply-list')).toContainText(text);
      }
      const replies = page.getByTestId('reply-list').locator('article');
      await expect(replies).toHaveCount(2);
      await expect(replies.nth(0)).toContainText('Second reply'); // newest first
      await expect(replies.nth(1)).toContainText('First reply');
      const y = async (id: string) => (await page.getByTestId(id).boundingBox())!.y;
      expect(await y('msg-original')).toBeLessThan(await y('reply-box'));
      expect(await y('reply-box')).toBeLessThan((await replies.nth(0).boundingBox())!.y);
      await signOut(page);

      await login(page, 'auditor');
      await page.getByTestId('nav-messages').click();
      await expect(page.locator('[data-testid^="thread-"][data-unread="true"]').filter({ hasText: subject })).toBeVisible();
    });

    test('an admin edits a manager and department, and the Departments sub-tab lists them', async ({ page }) => {
      await signIn(page, locale, 'pm');
      await page.getByTestId('nav-admin.users').click();
      await expect(page.getByTestId('user-dept-1103')).toBeVisible();
      await page.getByTestId('users-tab-departments').click();
      await expect(page.getByTestId('dept-row-CIVIL')).toBeVisible();
      await page.getByTestId('users-tab-active').click();
      await page.getByTestId('user-open-1103').click();
      await expect(page.getByTestId('org-manager-value')).toContainText('1102');
      await page.getByTestId('org-edit').click();
      await page.getByTestId('org-dialog-reason').fill('Moved to civil works');
      await page.getByTestId('org-department').selectOption({ index: 1 });
      await page.getByTestId('org-dialog-submit').click();
      await page.getByTestId('stepup-password').fill('Demo-Pm-2026-pass');
      await page.getByTestId('stepup-continue').click();
      await expect(page.getByTestId('org-dialog')).toHaveCount(0);
      await expect(page.getByTestId('toast').first()).toBeVisible();
    });
  });
}

test('answerAnnouncements helper answers the seeded pop-up', async ({ page }) => {
  await login(page, 'engineer');
  expect(await answerAnnouncements(page, 'agree')).toBe(1);
  await expect(page.getByTestId('page-my-work')).toBeVisible();
});
