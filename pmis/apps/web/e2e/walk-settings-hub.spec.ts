import { expect, test, type Page } from '@playwright/test';

// Real-stack walkthrough for the Settings hub (runbook docs/ops/walkthrough.md): Access tab, Template mapping and alert settings inside Settings, gears. Run only with WALK=1.
test.skip(!process.env.WALK, 'real-stack run only');
test.setTimeout(180000);

async function login(page: Page, id: string, pw: string) {
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill(id);
  await page.getByTestId('login-password').fill(pw);
  await page.getByTestId('login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
}
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/hub-${name}.png`, fullPage: true });

async function tour(page: Page, lang: 'en' | 'ar') {
  await page.evaluate((l) => localStorage.setItem('pmis.locale', l), lang);
  await page.goto('/admin/settings/access');
  await expect(page.getByTestId('settings-access')).toBeVisible();
  for (const k of ['users', 'assignments', 'roles', 'profiles', 'groups', 'delegation', 'matrix']) await expect(page.getByTestId(`settings-access-${k}`)).toBeVisible();
  await shot(page, `${lang}-access`);
  await page.goto('/admin/settings/data/mapping');
  await expect(page.getByTestId('tmap-fields')).toBeVisible();
  await shot(page, `${lang}-mapping`);
  await page.goto('/admin/settings/security/alerts');
  await expect(page.getByTestId('rules-networks')).toBeVisible();
  await shot(page, `${lang}-alerts-settings`);
  await page.goto('/admin/users');
  const gear = page.getByTestId('screen-settings-link').first();
  await expect(gear).toBeVisible();
  await expect(gear).toHaveAttribute('href', '/admin/settings/security/limits');
  await shot(page, `${lang}-users-gear`);
  await gear.click();
  await expect(page).toHaveURL(/\/admin\/settings\/security\/limits$/);
  await expect(page.getByTestId('page-ops-limits')).toBeVisible();
}

test('admin: Access tab, mapping and alerts in Settings, gears, old URL redirect, EN and AR', async ({ page }) => {
  await login(page, '9001', 'Walk-Admin-Pass-2026');
  await page.goto('/templates/mapping');
  await expect(page).toHaveURL(/\/admin\/settings\/data\/mapping$/);
  await expect(page.getByTestId('tmap-fields')).toBeVisible();
  await tour(page, 'en');
  await tour(page, 'ar');
  await page.goto('/admin/settings/access');
  expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
});
