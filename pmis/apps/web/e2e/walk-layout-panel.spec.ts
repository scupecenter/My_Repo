import { expect, test } from '@playwright/test';

// Real-stack walkthrough for the unified Layout panel (V1, 2026-11-27): real API + scratch DB, no mocks. Run only with WALK=1.
// Signs in as the bootstrap admin and walks the Layout panel on the Sites master in EN and AR, saving screenshots.
test.skip(!process.env.WALK, 'real-stack run only');

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill('9001');
  await page.getByTestId('login-password').fill('Walk-Admin-Pass-2026');
  await page.getByTestId('login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
}

test('layout panel walk: Sites master, EN and AR, list and board', async ({ page }) => {
  await signIn(page);

  // EN: list view shows the display section.
  await page.goto('/sites');
  await expect(page.getByTestId('sites-view')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('sites-view').click();
  await expect(page.getByTestId('sites-view-panel')).toBeVisible();
  await expect(page.getByTestId('sites-view-views')).toBeVisible();
  await expect(page.getByTestId('sites-view-display')).toBeVisible();
  await page.screenshot({ path: 'test-results/walk-layout-sites-list-en.png' });
  await page.keyboard.press('Escape');

  // EN: board view shows the options section (swimlane) instead of display.
  await page.getByTestId('sites-view').click();
  await page.getByTestId('sites-layout-board').click();
  await page.getByTestId('sites-view').click();
  await expect(page.getByTestId('sites-view-options')).toBeVisible();
  await expect(page.getByTestId('sites-board-swimlane')).toBeVisible();
  await expect(page.getByTestId('sites-view-display')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/walk-layout-sites-board-en.png' });
  await page.keyboard.press('Escape');

  // AR: panel and page render right-to-left with Arabic labels.
  await page.getByTestId('topbar-lang').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.getByTestId('sites-view').click();
  await expect(page.getByTestId('sites-view-panel')).toBeVisible();
  await page.screenshot({ path: 'test-results/walk-layout-sites-board-ar.png' });
});

test('layout panel walk: the unified panel on My Work, and the display-only panels on Approvals, Daily Plan and Library Archive', async ({ page }) => {
  await signIn(page);

  // My Work: the display options moved into the panel; its list/board switcher stays until V7.
  await page.goto('/my-work');
  await expect(page.getByTestId('my-work-view')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('my-work-view').click();
  await expect(page.getByTestId('my-work-view-display')).toBeVisible();
  await expect(page.getByTestId('my-work-view-views')).toBeVisible();
  await expect(page.getByTestId('my-work-display')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/walk-layout-my-work-en.png' });
  await page.keyboard.press('Escape');

  // Approvals: same panel instead of the old display menu.
  await page.goto('/approvals');
  await expect(page.getByTestId('approvals-layout')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('approvals-layout').click();
  await expect(page.getByTestId('approvals-layout-display')).toBeVisible();
  await page.screenshot({ path: 'test-results/walk-layout-approvals-en.png' });
  await page.keyboard.press('Escape');

  // Daily Plan: the density switch grew into the full panel.
  await page.goto('/my-work/daily-plan');
  await expect(page.getByTestId('daily-plan-layout')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('daily-plan-layout').click();
  await expect(page.getByTestId('daily-plan-layout-display')).toBeVisible();
  await page.screenshot({ path: 'test-results/walk-layout-daily-plan-en.png' });
  await page.keyboard.press('Escape');

  // Library Archive: panel in the shared toolbar.
  await page.goto('/library/archive/WALK');
  await expect(page.getByTestId('lib-archive-layout')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('lib-archive-layout').click();
  await expect(page.getByTestId('lib-archive-layout-display')).toBeVisible();
  await page.screenshot({ path: 'test-results/walk-layout-archive-en.png' });
  await page.keyboard.press('Escape');

  // AR: the display-only panel renders right-to-left with Arabic labels.
  await page.getByTestId('topbar-lang').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.goto('/my-work');
  await page.getByTestId('my-work-view').click();
  await expect(page.getByTestId('my-work-view-display')).toBeVisible();
  await page.screenshot({ path: 'test-results/walk-layout-my-work-ar.png' });
});

test('layout panel walk: a register (procurement) keeps board by/lane in the panel', async ({ page }) => {
  await signIn(page);
  await page.goto('/registers/procurement');
  await expect(page.getByTestId('register-view')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('register-view').click();
  await expect(page.getByTestId('register-view-panel')).toBeVisible();
  await page.getByTestId('register-layout-board').click();
  await page.getByTestId('register-view').click();
  await expect(page.getByTestId('register-view-options')).toBeVisible();
  await expect(page.getByTestId('register-board-by')).toBeVisible();
  await expect(page.getByTestId('register-board-lane')).toBeVisible();
  await expect(page.getByTestId('register-view-display')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/walk-layout-register-board-en.png' });
});

test('layout panel walk: calendar view on Sites and a register, EN and AR', async ({ page }) => {
  await signIn(page);

  // Sites: the calendar is a view of the Layout panel; its date field is chosen in the panel options.
  await page.goto('/sites');
  await expect(page.getByTestId('sites-view')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('sites-view').click();
  await page.getByTestId('sites-layout-calendar').click();
  await expect(page.getByTestId('sites-calendar')).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('gridcell').first()).toBeVisible();
  await page.getByTestId('sites-view').click();
  await expect(page.getByTestId('sites-calendar-field')).toBeVisible();
  await expect(page.getByTestId('sites-view-display')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/walk-layout-sites-calendar-en.png' });
  await page.keyboard.press('Escape');

  // AR: the grid stays LTR inside the RTL page, with localized names.
  await page.getByTestId('topbar-lang').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('grid')).toHaveAttribute('dir', 'ltr');
  await page.getByTestId('sites-view').click();
  await expect(page.getByTestId('sites-calendar-field')).toBeVisible();
  await page.screenshot({ path: 'test-results/walk-layout-sites-calendar-ar.png' });
  await page.keyboard.press('Escape');
  await page.getByTestId('topbar-lang').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

  // A register with date fields: same view, field select in the panel, kept in the URL.
  await page.goto('/registers/procurement?layout=calendar');
  await expect(page.getByTestId('register-calendar')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('register-view').click();
  await expect(page.getByTestId('register-calendar-field')).toBeVisible();
  await page.screenshot({ path: 'test-results/walk-layout-register-calendar-en.png' });
  await page.keyboard.press('Escape');
});

test('open-record walk: the setting in Settings > Screens, and a record on its own page, EN and AR', async ({ page }) => {
  await signIn(page);

  // V5: the personal setting in Settings > Screens > Records; the drawer is the default.
  await page.goto('/admin/settings/screens/records');
  await expect(page.getByTestId('page-openrecord-settings')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('open-record-mode-drawer')).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: 'test-results/walk-openrecord-settings-en.png' });

  // One real record to open (the scratch DB starts empty and has no sites, so the Meetings register, which needs none): the
  // required fields of its definition are filled, with the session's CSRF token on the write.
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const csrf = { 'X-CSRF-Token': session.csrf_token as string };
  const defs = await (await page.request.get('/api/v1/registers')).json();
  const def = defs.items.find((d: { register_key: string }) => d.register_key === 'meetings');
  const data: Record<string, unknown> = {};
  for (const f of def.fields as { code: string; type: string; required?: boolean; options?: { value: string }[] }[]) {
    if (!f.required) continue;
    data[f.code] = f.type === 'number' ? 1 : f.type === 'date' ? '2026-11-27' : f.type === 'yes_no' ? true : (f.type === 'list' && f.options?.length ? f.options[0].value : 'WALK-1');
  }
  const made = await page.request.post('/api/v1/registers/meetings/records', { headers: csrf, data: { data, record_type: def.record_types?.[0] } });
  expect(made.status(), await made.text()).toBe(201);
  const rec = await made.json();

  // Choose the full page; a row click now lands on the record's own URL.
  await page.getByTestId('open-record-mode-page').click();
  await expect(page.getByTestId('open-record-mode-page')).toHaveAttribute('aria-checked', 'true');
  await page.goto('/registers/meetings');
  await expect(page.getByTestId('register-list-card')).toBeVisible({ timeout: 20000 });
  await page.getByTestId(`reg-row-${rec.id}`).click();
  await expect(page).toHaveURL(new RegExp(`/registers/meetings/records/${rec.id}`));
  await expect(page.getByTestId('register-record-page')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('register-drawer-body')).toBeVisible();
  await page.screenshot({ path: 'test-results/walk-openrecord-page-en.png' });

  // AR: the record page renders right-to-left with Arabic labels; the back link returns to the register.
  await page.getByTestId('topbar-lang').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('register-record-page')).toBeVisible();
  await page.screenshot({ path: 'test-results/walk-openrecord-page-ar.png' });
  await page.getByTestId('register-record-back').click();
  await expect(page).toHaveURL(/\/registers\/meetings$/);

  // Back to English and to the drawer default, so nothing is left behind for the next walk.
  await page.getByTestId('topbar-lang').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await page.goto('/admin/settings/screens/records');
  await expect(page.getByTestId('page-openrecord-settings')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('open-record-mode-drawer').click();
  await expect(page.getByTestId('open-record-mode-drawer')).toHaveAttribute('aria-checked', 'true');
});
