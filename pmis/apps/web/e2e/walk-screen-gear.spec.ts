import { expect, test, type Page } from '@playwright/test';

// Real-stack walkthrough of the settings gear (runbook docs/ops/walkthrough.md). Run with WALK=1.
test.skip(!process.env.WALK, 'real-stack run only');

const SCREENS: { path: string; page: string; to: string }[] = [
  { path: '/dashboard', page: 'page-dashboard', to: '/admin/settings/screens/dashboard' },
  { path: '/my-work/daily-plan', page: 'daily-plan-header', to: '/admin/settings/screens/daily-plan' },
  { path: '/inbox', page: 'page-inbox', to: '/admin/settings/alerts/policy' },
  { path: '/approvals', page: 'page-approvals', to: '/admin/settings/workflow/editor' },
  { path: '/sites', page: 'page-sites', to: '/admin/settings/workflow/columns' },
  { path: '/registers/procurement', page: 'page-register-procurement', to: '/admin/settings/registers/columns' },
  { path: '/registers/gecol', page: 'page-register-gecol', to: '/admin/settings/registers/gecol' },
  { path: '/templates', page: 'page-templates', to: '/admin/settings/data/imports' },
  { path: '/library/forms', page: 'page-library-forms', to: '/admin/settings/documents/forms' },
  { path: '/library/archive', page: 'page-library-archive', to: '/admin/settings/documents/archive' },
  { path: '/audit', page: 'page-audit-log', to: '/admin/settings/security/retention' },
];

async function login(page: Page, locale: 'en' | 'ar') {
  await page.addInitScript((l) => localStorage.setItem('pmis.locale', l), locale);
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill('9001');
  await page.getByTestId('login-password').fill('Walk-Admin-Pass-2026');
  await page.getByTestId('login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
}

for (const locale of ['en', 'ar'] as const) {
  test(`gear on every covered screen, ${locale}`, async ({ page }) => {
    test.setTimeout(150_000);
    await login(page, locale);
    for (const s of SCREENS) {
      await page.goto(s.path);
      const gear = page.getByTestId('screen-settings-link').first();
      await expect(gear, s.path).toBeVisible({ timeout: 20000 });
      expect(await gear.getAttribute('href')).toBe(s.to);
      expect(await gear.getAttribute('aria-label')).toContain(': ');
      const name = s.path.replace(/\W+/g, '_');
      await gear.hover();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `test-results/gear-${locale}${name}.png` });
    }
    // deep link: click lands on the Settings page
    await page.goto('/sites');
    await page.getByTestId('screen-settings-link').first().click();
    await page.waitForURL('**/admin/settings/workflow/columns');
    await expect(page.getByTestId('page-settings')).toBeVisible();
    await page.screenshot({ path: `test-results/gear-${locale}-landing.png` });
    // narrow header: the gear moves into the More menu as its last item
    await page.setViewportSize({ width: 560, height: 900 });
    await page.goto('/sites');
    await page.getByTestId('more-menu').click();
    const item = page.getByTestId('more-screen-settings');
    await expect(item).toBeVisible();
    await page.screenshot({ path: `test-results/gear-${locale}-narrow-more.png` });
    await item.click();
    await page.waitForURL('**/admin/settings/workflow/columns');
  });
}

// Permission-denied case: employee 9002 is a Site Engineer (CW) with no `admin.settings` in the menu (created through the API, see the PR). No gear anywhere.
test('no gear for a person who cannot open Settings', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill('9002');
  await page.getByTestId('login-password').fill('Walk-Staff-Pass-2026-y');
  await page.getByTestId('login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
  for (const path of ['/sites', '/dashboard', '/approvals', '/registers/procurement', '/inbox']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(800);
    await expect(page.getByTestId('screen-settings-link')).toHaveCount(0);
  }
  await page.goto('/sites');
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/gear-denied-sites.png' });
});
