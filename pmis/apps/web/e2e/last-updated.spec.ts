import { expect, test } from '@playwright/test';
import { answerAnnouncements, login } from './helpers';

// Item 3: "Updated X ago" and the refresh button in the page header. EN, AR, and a 390px phone.
for (const c of [{ locale: 'en', w: 1280 }, { locale: 'ar', w: 1280 }, { locale: 'en', w: 390 }] as const) {
  test(`last updated and refresh (${c.locale}, ${c.w}px)`, async ({ page }) => {
    await page.setViewportSize({ width: c.w, height: 900 });
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); }, c.locale);
    await login(page, 'pm');
    await answerAnnouncements(page, 'agree');
    await page.getByTestId('nav-sites').click();
    await expect(page.getByTestId('last-updated').first()).toBeVisible();
    await expect(page.getByTestId('last-updated-text').first()).not.toBeEmpty();
    await page.getByTestId('last-updated-refresh').first().click();
    await expect(page.getByTestId('last-updated-text').first()).toBeVisible();
    await page.screenshot({ path: `test-results/last-updated-${c.locale}-${c.w}.png` });
  });
}
