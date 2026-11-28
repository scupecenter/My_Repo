import { expect, test } from '@playwright/test';
import { answerAnnouncements, login } from './helpers';

// Item 16: copy-link button in the task drawer. EN, AR, and a 390px phone.
for (const c of [{ locale: 'en', w: 1280 }, { locale: 'ar', w: 1280 }, { locale: 'en', w: 390 }] as const) {
  test(`drawer copy link (${c.locale}, ${c.w}px)`, async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
    await page.setViewportSize({ width: c.w, height: 900 });
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.site.layout', '"list"'); }, c.locale);
    await login(page, 'pm');
    await answerAnnouncements(page, 'agree');
    await page.goto('/sites/50000000-0000-4000-8000-000000000001');
    await page.locator('[data-task="A1"]').locator('[data-testid^="grid-open-"]').click();
    await expect(page.getByTestId('task-drawer')).toBeVisible();
    await page.getByTestId('drawer-copy-link').click();
    await expect(page.getByTestId('drawer-copy-note')).not.toBeEmpty();
    await page.screenshot({ path: `test-results/copy-link-${c.locale}-${c.w}.png` });
  });
}
