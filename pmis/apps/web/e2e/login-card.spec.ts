import { expect, test } from '@playwright/test';
import { login, stepUp } from './helpers';

// Item 13: login card display settings. An admin hides parts of the card and sets a welcome text; the signed-out card follows. EN, AR, and a 390px phone.
for (const c of [{ locale: 'en', w: 1280 }, { locale: 'ar', w: 1280 }, { locale: 'en', w: 390 }] as const) {
  test(`login card follows its display settings (${c.locale}, ${c.w}px)`, async ({ page }) => {
    await page.setViewportSize({ width: c.w, height: 800 });
    await page.addInitScript((l) => { if (!localStorage.getItem('pmis.locale')) localStorage.setItem('pmis.locale', l); }, c.locale);
    await login(page, 'pm');
    await page.goto('/admin/settings/screens/login');
    await page.getByTestId('lp-show_remember').uncheck();
    await page.getByTestId('lp-show_help').uncheck();
    await page.getByTestId('lp-welcome-title-en').fill('Welcome back');
    await page.getByTestId('lp-welcome-title-ar').fill('أهلاً بعودتك');
    await page.getByTestId('lp-save').click();
    await page.getByTestId('lp-dialog-reason').fill('Login card display');
    await page.getByTestId('lp-dialog-submit').click();
    await stepUp(page);
    await expect(page.getByTestId('toast').first()).toBeVisible();
    // the signed-out card, reached in-app (the mock keeps its state until a reload)
    await page.evaluate(() => { history.pushState({}, '', '/login'); dispatchEvent(new PopStateEvent('popstate')); });
    await expect(page.getByTestId('login-form')).toBeVisible();
    await expect(page.getByTestId('login-remember')).toHaveCount(0);
    await expect(page.getByTestId('login-help')).toHaveCount(0);
    await expect(page.getByTestId('login-title')).toHaveText(c.locale === 'ar' ? 'أهلاً بعودتك' : 'Welcome back');
    await expect(page.getByTestId('login-forgot')).toBeVisible();
    await expect(page.getByTestId('auth-lang')).toBeVisible();
    await page.screenshot({ path: `test-results/login-card-${c.locale}-${c.w}.png` });
  });
}
