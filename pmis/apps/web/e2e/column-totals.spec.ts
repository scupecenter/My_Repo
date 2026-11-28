import { expect, test } from '@playwright/test';
import { answerAnnouncements, login } from './helpers';

// Item 1: the totals row at the foot of a register grid with number columns. EN, AR, and a 390px phone.
for (const c of [{ locale: 'en', w: 1280 }, { locale: 'ar', w: 1280 }, { locale: 'en', w: 390 }] as const) {
  test(`register grid totals row (${c.locale}, ${c.w}px)`, async ({ page }) => {
    await page.setViewportSize({ width: c.w, height: 900 });
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); }, c.locale);
    await login(page, 'pm');
    await answerAnnouncements(page, 'agree');
    await page.goto('/registers/procurement?view=grid');
    await expect(page.getByTestId('register-grid')).toBeVisible();
    const row = page.locator('[data-testid$="-totals"]').first();
    if (await row.count()) {
      await expect(row).toBeVisible();
      const fn = row.locator('select').first();
      await fn.selectOption('count');
      await expect(row.locator('[data-fn="count"]').first()).toBeVisible();
      await page.screenshot({ path: `test-results/totals-${c.locale}-${c.w}.png` });
    }
  });
}
