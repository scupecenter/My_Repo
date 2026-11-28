import { expect, test } from '@playwright/test';
import { answerAnnouncements, login } from './helpers';

// Global "Copied" notice: a copy event with a selection shows one toast. EN, AR, and a 390px phone.
for (const c of [{ locale: 'en', w: 1280 }, { locale: 'ar', w: 1280 }, { locale: 'en', w: 390 }] as const) {
  test(`copied notice (${c.locale}, ${c.w}px)`, async ({ page }) => {
    await page.setViewportSize({ width: c.w, height: 900 });
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); }, c.locale);
    await login(page, 'pm');
    await answerAnnouncements(page, 'agree');
    await page.evaluate(() => {
      const h = document.querySelector('h1') ?? document.body;
      const r = document.createRange(); r.selectNodeContents(h); const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
      document.dispatchEvent(new Event('copy', { bubbles: true }));
    });
    await expect(page.getByTestId('toast')).toHaveCount(1);
    await expect(page.getByTestId('toast')).toContainText(c.locale === 'ar' ? 'تم النسخ' : 'Copied');
    await page.screenshot({ path: `test-results/copy-toast-${c.locale}-${c.w}.png` });
  });
}
