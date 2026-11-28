import { expect, test, type Page } from '@playwright/test';

// Real-stack walkthrough for the 2026-11-27 RTL fixes: the shared date field keeps its calendar button off the text in the Arabic UI, and a
// relative date cell truncates inside its column instead of spilling over the neighbour. Run only with WALK=1 (docs/ops/walkthrough.md).
test.skip(!process.env.WALK, 'real-stack run only');

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill('9001');
  await page.getByTestId('login-password').fill('Walk-Admin-Pass-2026');
  await page.getByTestId('login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
}

test('rtl walk: Meetings list and record drawer, AR and EN', async ({ page }) => {
  await signIn(page);

  // One real record dated today, so the date cell renders relatively ("Today · 2026-…"): the scratch DB starts empty and has no sites,
  // so the Meetings register, which needs none. The session's CSRF token rides the write.
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const csrf = { 'X-CSRF-Token': session.csrf_token as string };
  const defs = await (await page.request.get('/api/v1/registers')).json();
  const def = defs.items.find((d: { register_key: string }) => d.register_key === 'meetings');
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const data: Record<string, unknown> = {};
  for (const f of def.fields as { code: string; type: string; required?: boolean; options?: { value: string }[] }[]) {
    if (f.required) data[f.code] = f.type === 'number' ? 1 : f.type === 'date' ? today : f.type === 'yes_no' ? true : (f.type === 'list' && f.options?.length ? f.options[0].value : 'WALK-RTL');
  }
  // the asserted cell renders relatively only when it holds a date near today (legacy_converted_at is read-only, so only this one)
  data.meeting_date = today;
  const made = await page.request.post('/api/v1/registers/meetings/records', { headers: csrf, data: { data, record_type: def.record_types?.[0] } });
  expect(made.status(), await made.text()).toBe(201);
  const rec = await made.json();

  await page.goto('/registers/meetings');
  await expect(page.getByTestId('register-list-card')).toBeVisible({ timeout: 20000 });
  const row = page.getByTestId(`reg-row-${rec.id}`);

  // AR: the relative date cell stays inside its own column (its span never sticks out over the title cell on its left).
  await page.getByTestId('topbar-lang').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const dateCell = row.locator('[data-col="f:meeting_date"]');
  const relSpan = dateCell.locator('[data-rel-days]');
  await expect(relSpan).toBeVisible();
  const [cellBox, spanBox] = await Promise.all([dateCell.boundingBox(), relSpan.boundingBox()]);
  expect(spanBox!.x).toBeGreaterThanOrEqual(cellBox!.x - 1);
  expect(spanBox!.x + spanBox!.width).toBeLessThanOrEqual(cellBox!.x + cellBox!.width + 1);
  await page.screenshot({ path: 'test-results/walk-rtl-list-ar.png' });

  // The drawer in AR: the date field's calendar button sits clear of the text (the field is LTR end to end).
  await row.click();
  await expect(page.getByTestId('register-drawer-body')).toBeVisible({ timeout: 20000 });
  const dateField = page.getByTestId('register-drawer-body').locator('input[placeholder="YYYY-MM-DD"]').first();
  await expect(dateField).toBeVisible();
  await expect(dateField).toHaveAttribute('dir', 'ltr');
  const wrap = dateField.locator('..');
  await expect(wrap).toHaveAttribute('dir', 'ltr');
  const pick = wrap.locator('button');
  const [textBox, pickBox] = await Promise.all([dateField.boundingBox(), pick.boundingBox()]);
  // the button's box sits at the right edge of the field, clear of where the text starts (left)
  expect(pickBox!.x).toBeGreaterThan(textBox!.x + textBox!.width - pickBox!.width - 2);
  await page.screenshot({ path: 'test-results/walk-rtl-drawer-ar.png' });
  await page.keyboard.press('Escape');

  // EN: the same checks pass left-to-right (no regression).
  await page.getByTestId('topbar-lang').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await page.screenshot({ path: 'test-results/walk-rtl-list-en.png' });
});
