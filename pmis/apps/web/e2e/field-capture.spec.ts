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
    await page.screenshot({ path: `test-results/fc-1-raise-${locale}.png` });
    await page.getByTestId('snag-raise-title').fill(locale === 'ar' ? 'شرخ في العمود' : 'Crack on column');
    await page.getByTestId('snag-raise-type').selectOption({ label: locale === 'ar' ? 'شرخ خرساني' : 'Concrete crack' });
    await page.getByTestId('snag-raise-severity').selectOption({ label: locale === 'ar' ? 'ثانوية' : 'Minor' });
    await page.getByTestId('snag-raise-send').click();
    const card = page.getByTestId('snag-list').locator('li[data-state]').first();
    await expect(card).toBeVisible();
    await expect(card.locator('[data-testid^="snag-video-"]')).toBeVisible();
    await expect(card.locator('[data-testid^="snag-annotate-open-"]')).toBeVisible();
    await card.screenshot({ path: `test-results/fc-2-card-${locale}.png` });
  });

  // Item 14 widened: the same capture buttons on a task's document slot. SB128 has B9 (MOS proof: PNG + WEBM) in entry; TR101's A1 shows annotate only (no video format).
  test(`field capture on a task document slot (${locale})`, async ({ page }) => {
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.site.layout', '"list"'); }, locale);
    await login(page, 'pm');
    await answerAnnouncements(page, 'agree');
    await page.goto('/sites/50000000-0000-4000-8000-000000000028');
    const row = page.locator('[data-task="B9"]');
    await row.locator('[data-testid^="grid-open-"]').click();
    await expect(page.getByTestId('task-drawer')).toBeVisible();
    await page.getByTestId('drawer-tab-documents').click();
    const card = page.locator('li[data-testid^="slot-"]').filter({ has: page.locator('[data-testid^="slot-annotate-open-"]') }).first();
    await expect(card).toBeVisible();
    await expect(card.locator('[data-testid^="slot-annotate-open-"]')).toBeVisible();
    await expect(card.locator('[data-testid^="slot-video-"]')).toBeVisible();
    await card.screenshot({ path: `test-results/fc-3-slot-${locale}.png` });
    await page.getByTestId('drawer-tab-comments').click();
    await expect(page.getByTestId('comment-input')).toBeVisible();
    await expect(page.getByTestId('comment-dictate')).toBeVisible();
    await page.screenshot({ path: `test-results/fc-4-comments-${locale}.png` });
    await page.goto('/sites/50000000-0000-4000-8000-000000000001');
    const a1 = page.locator('[data-task="A1"]');
    await a1.locator('[data-testid^="grid-open-"]').click();
    await expect(page.getByTestId('task-drawer')).toBeVisible();
    await page.getByTestId('drawer-tab-documents').click();
    const a1card = page.locator('li[data-testid^="slot-"]').first();
    await expect(a1card.locator('[data-testid^="slot-annotate-open-"]')).toBeVisible();
    await expect(a1card.locator('[data-testid^="slot-video-"]')).toHaveCount(0);
  });
}
