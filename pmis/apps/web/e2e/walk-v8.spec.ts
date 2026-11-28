import { expect, test, type APIRequestContext } from '@playwright/test';

test.skip(!process.env.WALK, 'real-stack run only');

/** V8 (0.15.573): Display > Value colours, a personal per-screen switch for the list-value colours of item 15 (#321), EN and AR. */

type Reg = { register_key: string; name_en: string; fields: { code: string; type: string; in_list?: boolean; options?: { value: string; colour?: string | null }[]; list?: { code?: string } | null }[] };

/** The session's current CSRF token (every answer rotates it, so read it right before each write). */
async function freshCsrf(request: APIRequestContext): Promise<string> {
  const s = await (await request.get('/api/v1/auth/session')).json();
  return s.csrf_token;
}

/** Colour a catalogue value when it has none. */
async function ensureColour(request: APIRequestContext, listCode: string, value: string) {
  const cat = await (await request.get(`/api/v1/list-catalogues/${listCode}`)).json();
  const v = (cat.values ?? []).find((x: { code: string }) => x.code === value);
  if (!v || v.colour) return;
  const patch = await request.patch(`/api/v1/list-catalogues/${listCode}/values/${v.id}`, {
    headers: { 'X-CSRF-Token': await freshCsrf(request), 'If-Match': `"${v.version}"` },
    data: { colour: '#0e7490', reason: 'walk setup' },
  });
  expect(patch.ok(), `colour setup PATCH: ${patch.status()}`).toBeTruthy();
}

/** The first register with a visible list field whose value at least one record holds; a colour is set on that option when it has none. */
async function pickColouredCell(request: APIRequestContext): Promise<{ key: string; field: string; recordId: string; value: string }> {
  const regs: { items: Reg[] } = await (await request.get('/api/v1/registers')).json();
  for (const r of regs.items) {
    const f = (r.fields ?? []).find((x) => x.type === 'list' && x.in_list && (x.options ?? []).length > 0);
    if (!f) continue;
    const recs = await (await request.get(`/api/v1/registers/${r.register_key}/records?limit=100`)).json();
    const items: { id: string; data: Record<string, unknown> }[] = recs.items ?? [];
    const hit = items.find((x) => typeof x.data[f.code] === 'string' && (f.options ?? []).some((o) => o.value === x.data[f.code]));
    if (!hit) continue;
    const value = String(hit.data[f.code]);
    if (f.list?.code) await ensureColour(request, f.list.code, value);
    return { key: r.register_key, field: f.code, recordId: hit.id, value };
  }
  // No record holds a list value yet (a fresh walk stack): give the first financial advance a kind and use it.
  const recs = await (await request.get('/api/v1/registers/financial_advances/records?limit=5')).json();
  for (const rec of (recs.items ?? []) as { id: string }[]) {
    const detail = await (await request.get(`/api/v1/registers/financial_advances/records/${rec.id}`)).json();
    const patch = await request.patch(`/api/v1/registers/financial_advances/records/${rec.id}`, {
      headers: { 'X-CSRF-Token': await freshCsrf(request), 'If-Match': `"${detail.version}"` },
      data: { data: { advance_kind: 'Daily allowance' } },
    });
    if (!patch.ok()) continue;
    await ensureColour(request, 'AdvanceKind', 'Daily allowance');
    return { key: 'financial_advances', field: 'advance_kind', recordId: rec.id, value: 'Daily allowance' };
  }
  throw new Error('no register with a list value in a record found');
}

test('walk: value colours on and off from the Layout panel', async ({ page, request }) => {
  test.setTimeout(240000);
  const login = await request.post('/api/v1/auth/local/login', { data: { identifier: '9001', password: 'Walk-Admin-Pass-2026' } });
  expect(login.ok()).toBeTruthy();
  const target = await pickColouredCell(request);

  await page.goto('/login');
  await page.getByTestId('login-identifier').fill('9001');
  await page.getByTestId('login-password').fill('Walk-Admin-Pass-2026');
  await page.getByTestId('login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });

  // EN: the cell shows its colour
  await page.goto(`/registers/${target.key}`);
  const cell = page.getByTestId(`reg-cell-${target.recordId}-${target.field}`);
  await expect(cell).toBeVisible({ timeout: 30000 });
  await expect(cell).toHaveAttribute('data-colour', /^#/);
  await page.screenshot({ path: 'test-results/walkv8-cell-on-en.png' });

  // Layout panel > Display > Value colours off: the plain text, no colour
  await page.getByTestId('register-view').click();
  const toggle = page.getByTestId('display-colors');
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeChecked();
  await page.screenshot({ path: 'test-results/walkv8-panel-en.png' });
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId(`reg-cell-${target.recordId}-${target.field}`)).not.toHaveAttribute('data-colour', /.*/);
  await page.screenshot({ path: 'test-results/walkv8-cell-off-en.png' });

  // AR: same switch, no horizontal overflow
  await page.getByTestId('topbar-lang').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.getByTestId('register-view').click();
  await expect(page.getByTestId('display-colors')).not.toBeChecked();
  await page.screenshot({ path: 'test-results/walkv8-panel-ar.png' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log('horizontal overflow px:', overflow);
  expect(overflow).toBeLessThanOrEqual(1);

  // back on in AR, and back to English for the next walk
  await page.getByTestId('display-colors').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId(`reg-cell-${target.recordId}-${target.field}`)).toHaveAttribute('data-colour', /^#/);
  await page.getByTestId('topbar-lang').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});
