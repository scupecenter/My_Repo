import { expect, test } from '@playwright/test';
import { answerAnnouncements, login } from './helpers';

// Visual check for item 14 (field quick capture): dictation on the raise form, annotate + video buttons on the snag card.
for (const locale of ['en', 'ar'] as const) {
  test(`field quick capture (${locale})`, async ({ page }) => {
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.site.layout', '"list"'); }, locale);
    await login(page, 'engineer');
    await answerAnnouncements(page, 'agree');
    await page.getByTestId('nav-sites').click();
    await page.getByTestId('site-row-TR101').click();
    await page.getByTestId('site-section-snags').click();
    await page.getByTestId('snag-raise').click();
    await page.screenshot({ path: `/downloads/fc-1-raise-${locale}.png` });
    await page.getByTestId('snag-raise-title').fill(locale === 'ar' ? 'شرخ في العمود' : 'Crack on column');
    await page.getByTestId('snag-raise-type').selectOption({ label: locale === 'ar' ? 'شرخ خرساني' : 'Concrete crack' });
    await page.getByTestId('snag-raise-severity').selectOption({ label: locale === 'ar' ? 'ثانوية' : 'Minor' });
    await page.getByTestId('snag-raise-send').click();
    const card = page.getByTestId('snag-list').locator('li[data-state]').first();
    await expect(card).toBeVisible();
    await expect(card.locator('[data-testid^="snag-video-"]')).toBeVisible();
    await expect(card.locator('[data-testid^="snag-annotate-open-"]')).toBeVisible();
    await card.screenshot({ path: `/downloads/fc-2-card-${locale}.png` });
  });
}
