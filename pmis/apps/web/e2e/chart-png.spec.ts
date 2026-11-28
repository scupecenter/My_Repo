import { expect, test } from '@playwright/test';
import { answerAnnouncements, login } from './helpers';

// Item 14: a chart on the dashboard downloads as a PNG. EN, AR, and a 390px phone.
for (const c of [{ locale: 'en', w: 1280 }, { locale: 'ar', w: 1280 }, { locale: 'en', w: 390 }] as const) {
  test(`chart PNG download (${c.locale}, ${c.w}px)`, async ({ page }) => {
    await page.setViewportSize({ width: c.w, height: 900 });
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); }, c.locale);
    await login(page, 'pm');
    await answerAnnouncements(page, 'agree');
    await page.goto('/');
    const btn = page.locator('[data-testid$="-png"]').first();
    await expect(btn).toBeVisible();
    await expect(page.locator('[data-testid$="-png"] >> nth=0')).toHaveAttribute('aria-label', /.+/);
    await page.locator('svg').first().waitFor();
    const [dl] = await Promise.all([page.waitForEvent('download'), btn.click()]);
    expect(dl.suggestedFilename()).toMatch(/\.png$/);
    await page.screenshot({ path: `test-results/chart-png-${c.locale}-${c.w}.png` });
  });
}
