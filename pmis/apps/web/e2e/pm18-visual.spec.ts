import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

// PM item 18 (0.15.247): the 👍 acknowledged toggle and the resolved flag on a task comment, English and Arabic.
async function start(page: Page, locale: 'en' | 'ar', theme: 'light' | 'dark') {
  await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [locale, theme]);
  await login(page, 'pm');
  await expect(page.getByTestId('page-my-work')).toBeVisible();
}

for (const [locale, theme] of [['en', 'light'], ['ar', 'dark']] as const) {
  test(`${locale}: react and resolve on a task comment`, async ({ page }) => {
    await start(page, locale, theme);
    await page.goto('/inbox?task=10000000-0000-4000-8000-000000000001');
    await expect(page.getByTestId('task-drawer-body')).toBeVisible();
    await page.getByRole('tab', { name: locale === 'ar' ? 'التعليقات' : 'Comments' }).click();
    await page.getByTestId('comment-input').fill(locale === 'ar' ? 'يرجى التأكيد' : 'please confirm');
    await page.getByTestId('comment-send').click();
    const last = page.getByTestId('comment-list').locator('li').last();
    const id = await last.locator('[data-testid^="comment-actions-"]').getAttribute('data-testid');
    const cid = id!.replace('comment-actions-', '');
    const react = page.getByTestId(`comment-react-${cid}`);
    await expect(react).toHaveAttribute('aria-pressed', 'false');
    await react.click();
    await expect(react).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId(`comment-react-count-${cid}`)).toHaveText('1');
    await page.getByTestId(`comment-resolve-${cid}`).click();
    await expect(page.getByTestId(`comment-resolved-${cid}`)).toContainText(locale === 'ar' ? 'تم الحل' : 'Resolved');
    await expect(page.getByTestId(`comment-reopen-${cid}`)).toBeVisible();
    await page.screenshot({ path: `test-results/pm18-comments-${locale}.png`, fullPage: false });
    await page.getByTestId(`comment-reopen-${cid}`).click();
    await expect(page.getByTestId(`comment-resolve-${cid}`)).toBeVisible();
  });
}
