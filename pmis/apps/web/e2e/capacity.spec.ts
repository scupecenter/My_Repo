import { expect, test } from '@playwright/test';
import { login, stepUp } from './helpers';

// Resource capacity planning: an admin defines a skill, a crew and an effort in Settings; the Capacity screen shows the week load. EN, AR, and a 390px phone.
for (const c of [{ locale: 'en', w: 1280 }, { locale: 'ar', w: 1280 }, { locale: 'en', w: 390 }] as const) {
  test(`capacity plan follows its settings (${c.locale}, ${c.w}px)`, async ({ page }) => {
    await page.setViewportSize({ width: c.w, height: 900 });
    await page.addInitScript((l) => { if (!localStorage.getItem('pmis.locale')) localStorage.setItem('pmis.locale', l); }, c.locale);
    await login(page, 'pm');
    await page.goto('/admin/settings/screens/capacity');
    await page.getByTestId('capset-skill-add').click();
    await page.getByTestId('capset-skill-0-code').fill('civil');
    await page.getByTestId('capset-skill-0-en').fill('Civil');
    await page.getByTestId('capset-skill-0-ar').fill('مدني');
    await page.getByTestId('capset-crew-add').click();
    await page.getByTestId('capset-crew-0-name').fill('Crew A');
    await page.getByTestId('capset-crew-0-size').fill('2');
    await page.getByTestId('capset-crew-0-skill-civil').check({ force: true });
    await page.getByTestId('capset-effort-add').click();
    await page.getByTestId('capset-effort-0-code').fill('civil_works');
    await page.getByTestId('capset-effort-0-days').fill('4');
    await page.getByTestId('capset-save').click();
    await page.getByTestId('capset-dialog-reason').fill('Capacity set up');
    await page.getByTestId('capset-dialog-submit').click();
    await stepUp(page);
    await expect(page.getByTestId('toast').first()).toBeVisible();
    // the screen, reached in-app (the mock keeps its state until a reload): 2 tasks x 4 days = 8 against 2 people x 5 days x 80 % = 8, 100 %
    await page.evaluate(() => { history.pushState({}, '', '/capacity'); dispatchEvent(new PopStateEvent('popstate')); });
    await expect(page.getByTestId('page-capacity')).toBeVisible();
    await expect(page.getByTestId('capacity-cell-1-civil-1')).toHaveText('100%');
    await expect(page.getByTestId('capacity-cell-1-civil-1')).toHaveAttribute('data-status', 'tight');
    await expect(page.getByTestId('capacity-cell-1-civil-0')).toHaveAttribute('data-status', 'ok');
    await page.screenshot({ path: `test-results/capacity-${c.locale}-${c.w}.png` });
  });
}
