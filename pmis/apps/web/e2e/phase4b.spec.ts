import { expect, test, type Page } from '@playwright/test';
import { answerAnnouncements, login } from './helpers';

// Phase 4b (X1 to X7) in both languages and both themes: English with the light theme, Arabic with the dark one (RTL needs no special cases).
const MENTION = '30000000-0000-4000-8000-000000000003'; // seeded mention of the task WM105 D14
const SITE = '50000000-0000-4000-8000-000000000001';

async function start(page: Page, locale: 'en' | 'ar', theme: 'light' | 'dark') {
  await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [locale, theme]);
  await login(page, 'pm');
  await expect(page.getByTestId('page-my-work')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
  if (theme === 'dark') await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  else await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
}

for (const [locale, theme] of [['en', 'light'], ['ar', 'dark']] as const) {
  test.describe(`${locale} ${theme}`, () => {
    test('inbox: the bell leads to it, read and snooze work, and a mention opens its task', async ({ page }) => {
      await start(page, locale, theme);
      await expect(page.getByTestId('bell-count')).toHaveText('3');
      await page.getByTestId('topbar-bell').click();
      await page.getByTestId('bell-open-inbox').click();
      await expect(page.getByTestId('page-inbox')).toBeVisible();
      await expect(page.getByTestId('inbox-unread')).toContainText('3');
      if (locale === 'ar') await expect(page.getByRole('heading', { level: 1 })).toHaveText('صندوق الوارد');

      const first = page.getByTestId('inbox-item-30000000-0000-4000-8000-000000000001');
      await page.getByTestId('inbox-toggle-30000000-0000-4000-8000-000000000001').click();
      await expect(first).toHaveAttribute('data-read', 'true');
      await page.getByTestId('inbox-snooze-30000000-0000-4000-8000-000000000002').click();
      await page.getByTestId('inbox-snooze-tomorrow-30000000-0000-4000-8000-000000000002').click();
      await expect(page.getByTestId('inbox-item-30000000-0000-4000-8000-000000000002')).toHaveCount(0);
      await page.getByTestId('inbox-snoozed').selectOption('only');
      await expect(page.getByTestId('inbox-item-30000000-0000-4000-8000-000000000002')).toBeVisible();
      await page.getByTestId('inbox-snoozed').selectOption('hide');

      await page.getByTestId(`inbox-open-${MENTION}`).click();
      await expect(page.getByTestId('task-drawer-body')).toBeVisible();
      await expect(page.getByTestId(`inbox-item-${MENTION}`)).toHaveAttribute('data-read', 'true');
    });

    test('mention in a task comment, time in state and the follow button of the site', async ({ page }) => {
      await start(page, locale, theme);
      await page.goto('/inbox?task=10000000-0000-4000-8000-000000000001');
      await expect(page.getByTestId('task-drawer-body')).toBeVisible();
      await page.getByRole('tab', { name: locale === 'ar' ? 'التعليقات' : 'Comments' }).click();
      await page.getByTestId('comment-input').fill('please look @sa');
      await page.getByTestId('mention-opt-1204').click();
      await page.getByTestId('comment-send').click();
      await expect(page.getByTestId('comment-mentions')).toContainText(`${locale === 'ar' ? 'وصلت إلى' : 'Reached'}: Sami Nuri`);
      await page.getByRole('tab', { name: locale === 'ar' ? 'الزمن' : 'Time' }).click();
      await expect(page.getByTestId('tis-row-entry')).toBeVisible();
      await expect(page.getByTestId('tis-segments')).toBeVisible();

      await page.goto(`/sites/${SITE}`);
      const follow = page.getByTestId('follow-site');
      await expect(follow).toBeEnabled();
      await expect(follow).toHaveAttribute('aria-pressed', 'false');
      await follow.click();
      await expect(follow).toHaveAttribute('aria-pressed', 'true');
      await page.reload();
      await expect(page.getByTestId('follow-site')).toHaveAttribute('aria-pressed', 'true');
      await page.getByTestId('follow-site').click();
      await expect(page.getByTestId('follow-site')).toHaveAttribute('aria-pressed', 'false');
    });

    test('workload: open and late per person, the reassign decision opens for a person, and the time report sits below', async ({ page }) => {
      await start(page, locale, theme);
      await page.getByTestId('nav-workload').click();
      await expect(page.getByTestId('page-workload')).toBeVisible();
      const rows = page.locator('[data-testid^="workload-row-"]');
      await expect(rows.first()).toBeVisible();
      await rows.first().locator('[data-testid^="workload-reassign-"]').click();
      await expect(page.getByTestId('cover-dialog')).toBeVisible();
      await expect(page.getByTestId('cover-person-only')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('cover-dialog')).toHaveCount(0);
      await expect(page.getByTestId('time-table')).toBeVisible();
      await page.getByTestId('time-group-team').click();
      await expect(page.getByTestId('time-row-cw')).toBeVisible();
    });

    test('weekly status: a lead writes an update, it shows in its week, and the author edits it', async ({ page }) => {
      await start(page, locale, theme);
      await page.getByTestId('nav-status_updates').click();
      await expect(page.getByTestId('page-status-updates')).toBeVisible();
      await page.getByTestId('status-new').click();
      await expect(page.getByTestId('status-dialog-submit')).toBeDisabled();
      await page.getByTestId('status-region').selectOption('3');
      await page.getByTestId('status-summary').fill('Zawia sites are on plan.');
      await page.getByTestId('status-health-at_risk').check();
      await page.getByTestId('status-dialog-submit').click();
      const mine = page.locator('li', { hasText: 'Zawia sites are on plan.' });
      await expect(mine).toBeVisible();
      await expect(mine).toHaveAttribute('data-health', 'at_risk');
      await mine.locator('[data-testid^="status-edit-"]').click();
      await page.getByTestId('status-health-off_track').check();
      await page.getByTestId('status-dialog-submit').click();
      await expect(mine).toHaveAttribute('data-health', 'off_track');
    });

    test('a person who is no lead reads the status updates but cannot write, and has no workload page', async ({ page }) => {
      await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [locale, theme]);
      await login(page, 'engineer');
      await answerAnnouncements(page); // the seed gives this account one blocking notice
      await page.getByTestId('nav-status_updates').click();
      await expect(page.getByTestId('page-status-updates')).toBeVisible();
      await expect(page.getByTestId('status-new')).toHaveCount(0);
      await expect(page.getByTestId('nav-workload')).toHaveCount(0);
    });
  });
}
