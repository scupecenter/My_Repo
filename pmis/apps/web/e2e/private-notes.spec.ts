import { expect, test } from '@playwright/test';
import { answerAnnouncements, login } from './helpers';

// Item 7: a private note under the task drawer. EN, AR, and a 390px phone.
for (const c of [{ locale: 'en', w: 1280 }, { locale: 'ar', w: 1280 }, { locale: 'en', w: 390 }] as const) {
  test(`private note (${c.locale}, ${c.w}px)`, async ({ page }) => {
    await page.setViewportSize({ width: c.w, height: 900 });
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.site.layout', '"list"'); }, c.locale);
    await login(page, 'pm');
    await answerAnnouncements(page, 'agree');
    await page.goto('/sites/50000000-0000-4000-8000-000000000001');
    await page.locator('[data-task="A1"]').locator('[data-testid^="grid-open-"]').click();
    await expect(page.getByTestId('task-drawer')).toBeVisible();
    await page.getByTestId('private-note-toggle').click();
    await page.getByTestId('private-note-text').fill('call the owner');
    await page.getByTestId('private-note-save').click();
    await expect(page.getByTestId('private-note-status')).not.toBeEmpty();
    await expect(page.getByTestId('private-note-has')).toBeVisible();
    await page.screenshot({ path: `test-results/private-note-${c.locale}-${c.w}.png` });
  });
}
