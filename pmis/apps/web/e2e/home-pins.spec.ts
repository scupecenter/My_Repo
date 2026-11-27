import { expect, test } from '@playwright/test';
import { login } from './helpers';

// 0.15.245 (item 16): the pinned views card on the dashboard, EN/light and AR/dark (RTL).
for (const c of [{ locale: 'en', theme: 'light', suffix: 'en' }, { locale: 'ar', theme: 'dark', suffix: 'ar' }] as const) {
  test(`pinned views card (${c.suffix})`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [c.locale, c.theme]);
    await login(page, 'pm');
    await expect(page.getByTestId('nav-dashboard')).toBeVisible();
    // Create the view through the mock API (in-browser fetch is intercepted by MSW); a full page load would reset the mock state,
    // so every navigation below is in-app. The PIN itself goes through the real toggle so the card's cached list is invalidated
    // (a raw fetch would leave the dashboard's first, empty read cached for its stale window).
    const id = await page.evaluate(async () => {
      const r = await fetch('/api/v1/saved-views', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ screen_key: 'register-issues', name: 'Late issues — pinned', filters: {} }) });
      if (!r.ok) throw new Error(`/saved-views: ${r.status}`);
      return ((await r.json()) as { id: string }).id;
    });
    await page.getByTestId('nav-issues').click();
    await page.getByTestId(`views-tab-register-issues-${id}`).click();
    await expect(page.getByTestId('views-pin-home')).toBeVisible();
    await page.getByTestId('views-pin-home').click();
    await expect(page.getByTestId('views-pin-home')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('nav-dashboard').click();
    const card = page.getByTestId('dash-pinned-views');
    await expect(card).toBeVisible();
    await expect(page.getByTestId(`pin-row-${id}`)).toContainText('Late issues');
    await expect(page.getByTestId(`pin-count-${id}`)).toContainText(/[0-9]/);
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: `test-results/pins-1-card-${c.suffix}.png` });

    // The pin link opens the register screen with the view applied (?view_id), and the pin toggle reflects the pinned state.
    await page.getByTestId(`pin-link-${id}`).click();
    await expect(page.getByTestId('saved-views')).toBeVisible();
    await expect(page.getByTestId(`views-tab-register-issues-${id}`)).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('views-pin-home')).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: `test-results/pins-2-toggle-${c.suffix}.png`, fullPage: false });
  });
}
