import { expect, test, type APIRequestContext } from '@playwright/test';

test.skip(!process.env.WALK, 'real-stack run only');

/** V9 (0.15.576): the Gallery, a card grid on every register from the View menu, read only, EN and AR. */

type RegDef = { register_key: string; fields: { code: string; type: string; in_list?: boolean; options?: { value: string }[] }[] };

/** The session's current CSRF token (every answer rotates it, so read it right before each write). */
async function freshCsrf(request: APIRequestContext): Promise<string> {
  const s = await (await request.get('/api/v1/auth/session')).json();
  return s.csrf_token;
}

/** The first register with at least two records, and one record that shows a title (seeded when none does). */
async function pickRegister(request: APIRequestContext): Promise<{ key: string; recordId: string }> {
  const regs: { items: RegDef[] } = await (await request.get('/api/v1/registers')).json();
  for (const r of regs.items) {
    const recs = await (await request.get(`/api/v1/registers/${r.register_key}/records?limit=100`)).json();
    const items: { id: string; data: Record<string, unknown> }[] = recs.items ?? [];
    if (items.length < 2) continue;
    const listed = (r.fields ?? []).filter((x) => x.in_list);
    const titled = items.find((x) => listed.some((f) => x.data[f.code] !== undefined && x.data[f.code] !== null && x.data[f.code] !== ''));
    if (titled) return { key: r.register_key, recordId: titled.id };
    // none shows a title yet: give the first editable record a value of its first listed list field
    const f = listed.find((x) => x.type === 'list' && (x.options ?? []).length > 0);
    if (!f) continue;
    for (const rec of items) {
      const detail = await (await request.get(`/api/v1/registers/${r.register_key}/records/${rec.id}`)).json();
      const patch = await request.patch(`/api/v1/registers/${r.register_key}/records/${rec.id}`, {
        headers: { 'X-CSRF-Token': await freshCsrf(request), 'If-Match': `"${detail.version}"` },
        data: { data: { [f.code]: f.options![0].value } },
      });
      if (patch.ok()) return { key: r.register_key, recordId: rec.id };
    }
  }
  throw new Error('no register with two records found');
}

test('walk: the gallery grid on a register, EN and AR', async ({ page, request }) => {
  test.setTimeout(240000);
  const login = await request.post('/api/v1/auth/local/login', { data: { identifier: '9001', password: 'Walk-Admin-Pass-2026' } });
  expect(login.ok()).toBeTruthy();
  const target = await pickRegister(request);

  await page.goto('/login');
  await page.getByTestId('login-identifier').fill('9001');
  await page.getByTestId('login-password').fill('Walk-Admin-Pass-2026');
  await page.getByTestId('login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });

  // EN: the View menu offers Gallery; the grid shows one card per record
  await page.goto(`/registers/${target.key}`);
  await page.getByTestId('register-view').click();
  await page.getByTestId('register-layout-gallery').click();
  await page.waitForURL((u) => u.search.includes('layout=gallery'));
  const grid = page.getByTestId('register-gallery-grid');
  await expect(grid).toBeVisible({ timeout: 30000 });
  const cards = grid.getByRole('button');
  expect(await cards.count()).toBeGreaterThan(1);
  await expect(page.getByTestId(`register-gallery-title-${target.recordId}`)).toBeVisible();
  await page.screenshot({ path: 'test-results/walkv9-gallery-en.png', fullPage: true });

  // read only: a card opens its record in the drawer
  await page.getByTestId(`register-gallery-card-${target.recordId}`).click();
  await expect(page.getByTestId('register-drawer')).toBeVisible();
  await page.screenshot({ path: 'test-results/walkv9-drawer-en.png' });
  await page.keyboard.press('Escape');

  // AR: same grid, no horizontal overflow
  await page.getByTestId('topbar-lang').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('register-gallery-grid')).toBeVisible();
  await page.screenshot({ path: 'test-results/walkv9-gallery-ar.png', fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log('horizontal overflow px:', overflow);
  expect(overflow).toBeLessThanOrEqual(1);

  // back to English for the next walk
  await page.getByTestId('topbar-lang').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});
