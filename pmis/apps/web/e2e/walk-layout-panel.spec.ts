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

test('layout panel walk: display-only panels on My Work, Approvals, Daily Plan and Library Archive', async ({ page }) => {
  await signIn(page);

  // My Work: the display options moved into the panel; its list/board switcher stays until V7.
  await page.goto('/my-work');
  await expect(page.getByTestId('my-work-display')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('my-work-display').click();
  await expect(page.getByTestId('my-work-display-display')).toBeVisible();
  await expect(page.getByTestId('my-work-display-views')).toHaveCount(0);
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
  await page.getByTestId('my-work-display').click();
  await expect(page.getByTestId('my-work-display-display')).toBeVisible();
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

test('layout panel walk: a register (procurement) chart mode, EN and AR', async ({ page }) => {
  await signIn(page);
  await page.goto('/registers/procurement');
  await expect(page.getByTestId('register-view')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('register-view').click();
  await page.getByTestId('register-layout-chart').click();
  await expect(page).toHaveURL(/layout=chart/);
  await expect(page.getByTestId('register-chart-card')).toBeVisible({ timeout: 20000 });
  // the axis, the measure and the drawing live in the Layout panel options
  await page.getByTestId('register-view').click();
  await expect(page.getByTestId('register-chart-axis')).toBeVisible();
  await expect(page.getByTestId('register-chart-measure')).toBeVisible();
  await expect(page.getByTestId('register-chart-kind')).toBeVisible();
  await page.screenshot({ path: 'test-results/walk-chart-register-en.png' });
  await page.keyboard.press('Escape');

  // AR: the chart and its panel render right-to-left with Arabic labels.
  await page.getByTestId('topbar-lang').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('register-chart-card')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('register-view').click();
  await expect(page.getByTestId('register-chart-axis')).toBeVisible();
  await page.screenshot({ path: 'test-results/walk-chart-register-ar.png' });
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
