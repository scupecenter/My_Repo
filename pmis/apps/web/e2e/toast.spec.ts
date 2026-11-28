import { expect, test } from '@playwright/test';
import { login } from './helpers';

// The standard toast (done notice): bottom corner (right in English, left in Arabic), a green check and the text,
// gone by itself after about 4.5 s. Run in EN/light and AR/dark against the mock layer, through the follow button of a site.
// The red, stay-until-closed error toast is covered by the unit test (src/components/toast.test.tsx).
const SITE = '50000000-0000-4000-8000-000000000001';

for (const c of [{ locale: 'en', theme: 'light' }, { locale: 'ar', theme: 'dark' }] as const) {
  test(`toast: bottom corner, green check, goes away by itself (${c.locale}/${c.theme})`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [c.locale, c.theme]);
    await login(page, 'pm');
    await expect(page.getByTestId('page-my-work')).toBeVisible();
    await page.goto(`/sites/${SITE}`);
    const follow = page.getByTestId('follow-site');
    await expect(follow).toBeEnabled();
    await follow.click();
    const toast = page.getByTestId('toast').first();
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAttribute('data-kind', 'ok');
    await expect(page.getByTestId('toast-check').first()).toBeVisible();
    await expect(page.getByTestId('toast-close')).toHaveCount(0);
    // the corner: right side in English, left side in Arabic; near the bottom
    const box = (await toast.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(box.y + box.height).toBeGreaterThan(vp.height - 80);
    if (c.locale === 'ar') expect(box.x).toBeLessThan(vp.width / 3);
    else expect(box.x + box.width).toBeGreaterThan((vp.width * 2) / 3);
    await page.screenshot({ path: `test-results/toast-${c.locale}.png` });
    // auto-dismiss between 4 and 5 s: still there at 3 s, gone by 6.5 s
    await page.waitForTimeout(3000);
    await expect(toast).toBeVisible();
    await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 3500 });
    // leave the site as it was
    await follow.click();
    await expect(follow).toHaveAttribute('aria-pressed', 'false');
  });
}
