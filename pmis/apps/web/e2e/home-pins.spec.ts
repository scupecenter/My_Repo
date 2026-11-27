import { expect, test } from '@playwright/test';
import { login } from './helpers';

// 0.15.245 (item 16): the pinned views card on the dashboard, EN/light and AR/dark (RTL).
for (const c of [{ locale: 'en', theme: 'light', suffix: 'en' }, { locale: 'ar', theme: 'dark', suffix: 'ar' }] as const) {
  test(`pinned views card (${c.suffix})`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [c.locale, c.theme]);
    await login(page, 'pm');
    await expect(page.getByTestId('nav-dashboard')).toBeVisible();
    // Create a view and pin it through the mock API (in-browser fetch is intercepted by MSW); a full page load would reset the mock state,
    // so the pin happens before the dashboard is opened and every navigation below is in-app.
    const id = await page.evaluate(async () => {
      const mk = async (path: string, body: unknown) => {
        const r = await fetch(`/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error(`${path}: ${r.status}`);
        return r.json();
      };
      const v = (await mk('/saved-views', { screen_key: 'register-issues', name: 'Late issues — pinned', filters: {} })) as { id: string };
      await mk(`/saved-views/${v.id}/pin`, {});
      return v.id;
    });
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
