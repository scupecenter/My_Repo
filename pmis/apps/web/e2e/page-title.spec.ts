import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Tab title per screen: "<page or record> | <product>", EN and AR, updated on navigation and on a record deep link.
for (const c of [{ locale: 'en', product: 'Telecom Site Delivery Workspace' }, { locale: 'ar', product: 'مساحة عمل تسليم مواقع الاتصالات' }] as const) {
  test(`tab title follows the screen (${c.locale})`, async ({ page }) => {
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); }, c.locale);
    await login(page, 'pm');
    await page.goto('/dashboard');
    await expect.poll(() => page.title()).toMatch(new RegExp(` \\| ${c.product}$`));
    const dash = await page.title();
    await page.goto('/my-work');
    await expect.poll(() => page.title()).not.toBe(dash);
    await page.goto('/registers/procurement');
    await expect.poll(() => page.title()).toMatch(new RegExp(` \\| ${c.product}$`));
    const list = await page.title();
    const id = await page.evaluate(async () => (await (await fetch('/api/v1/registers/procurement/records?limit=1')).json()).items[0].id);
    await page.goto(`/registers/procurement?record=${id}`);
    await expect.poll(() => page.title()).toMatch(new RegExp(` \\| ${c.product}$`));
    expect(list.length).toBeGreaterThan(c.product.length + 3);
  });
}
