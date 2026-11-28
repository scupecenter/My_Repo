import { expect, test, type APIRequestContext } from '@playwright/test';

test.skip(!process.env.WALK, 'real-stack run only');

/** V10 (0.15.577): the Feed, the records of a register latest-first, read only, EN and AR. */

/** The first register with at least two records. */
async function pickRegister(request: APIRequestContext): Promise<{ key: string; recordId: string }> {
  const regs: { items: { register_key: string }[] } = await (await request.get('/api/v1/registers')).json();
  for (const r of regs.items) {
    const recs = await (await request.get(`/api/v1/registers/${r.register_key}/records?limit=100`)).json();
    const items: { id: string }[] = recs.items ?? [];
    if (items.length >= 2) return { key: r.register_key, recordId: items[0].id };
  }
  throw new Error('no register with two records found');
}

test('walk: the feed on a register, EN and AR', async ({ page, request }) => {
  test.setTimeout(240000);
  const login = await request.post('/api/v1/auth/local/login', { data: { identifier: '9001', password: 'Walk-Admin-Pass-2026' } });
  expect(login.ok()).toBeTruthy();
  const target = await pickRegister(request);

  await page.goto('/login');
  await page.getByTestId('login-identifier').fill('9001');
  await page.getByTestId('login-password').fill('Walk-Admin-Pass-2026');
  await page.getByTestId('login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });

  // EN: the View menu offers Feed; the list shows one line per record
  await page.goto(`/registers/${target.key}`);
  await page.getByTestId('register-view').click();
  await page.getByTestId('register-layout-feed').click();
  await page.waitForURL((u) => u.search.includes('layout=feed'));
  const list = page.getByTestId('register-feed-list');
  await expect(list).toBeVisible({ timeout: 30000 });
  const items = list.getByRole('button');
  expect(await items.count()).toBeGreaterThan(1);
  await expect(page.getByTestId(`register-feed-title-${target.recordId}`)).toBeVisible();
  await page.screenshot({ path: 'test-results/walkv10-feed-en.png', fullPage: true });

  // read only: a line opens its record in the drawer
  await page.getByTestId(`register-feed-item-${target.recordId}`).click();
  await expect(page.getByTestId('register-drawer')).toBeVisible();
  await page.screenshot({ path: 'test-results/walkv10-drawer-en.png' });
  await page.keyboard.press('Escape');

  // AR: same list, no horizontal overflow
  await page.getByTestId('topbar-lang').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('register-feed-list')).toBeVisible();
  await page.screenshot({ path: 'test-results/walkv10-feed-ar.png', fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log('horizontal overflow px:', overflow);
  expect(overflow).toBeLessThanOrEqual(1);

  // back to English for the next walk
  await page.getByTestId('topbar-lang').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});
