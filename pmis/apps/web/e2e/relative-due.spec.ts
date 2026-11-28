import { expect, test } from '@playwright/test';
import { answerAnnouncements, login } from './helpers';

// Item 4: the due date in words and a colour beside the exact date, in the grid and the task drawer. EN, AR, and a 390px phone.
for (const c of [{ locale: 'en', w: 1280 }, { locale: 'ar', w: 1280 }, { locale: 'en', w: 390 }] as const) {
  test(`relative due date (${c.locale}, ${c.w}px)`, async ({ page }) => {
    await page.setViewportSize({ width: c.w, height: 900 });
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.site.layout', '"list"'); }, c.locale);
    await login(page, 'pm');
    await answerAnnouncements(page, 'agree');
    await page.goto('/sites/50000000-0000-4000-8000-000000000001');
    const chip = page.locator('[data-testid^="reldue-"]').first();
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('data-tone', /late|soon|near|far/);
    await page.screenshot({ path: `test-results/relative-due-${c.locale}-${c.w}.png` });
    await page.locator('[data-testid^="grid-open-"]').first().click();
    await expect(page.getByTestId('task-drawer')).toBeVisible();
    if (await page.getByTestId('drawer-due-date').count()) await expect(page.getByTestId('drawer-reldue')).toBeVisible();
  });
}
