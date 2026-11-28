import { expect, test, type Page } from '@playwright/test';

// Probe for the #488 walk: does the remembered view mode apply on a fresh visit in the production build?
test.skip(!process.env.WALK, 'real-stack run only');

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill('9001');
  await page.getByTestId('login-password').fill('Walk-Admin-Pass-2026');
  await page.getByTestId('login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
}

test('prod build: a mode picked in the Layout panel is remembered and applied on a fresh visit', async ({ page }) => {
  await signIn(page);
  await page.goto('/library/media');
  await expect(page.getByTestId('page-library-media')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('media-view').click();
  await expect(page.getByTestId('media-view-panel')).toBeVisible();
  await page.getByTestId('media-layout-list').click();
  await expect(page.getByTestId('media-list')).toBeVisible();
  await page.waitForTimeout(1500); // let the preference write land
  const draft = await (await page.request.get('/api/v1/me/drafts/form.viewpref.library-media')).json();
  console.log('prod: draft after panel pick:', JSON.stringify(draft.payload));
  expect(draft.payload?.layout).toBe('list');
  await page.goto('/library/media');
  await expect(page.getByTestId('page-library-media')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('media-list')).toBeVisible({ timeout: 10000 });
  console.log('prod: remembered mode applied on fresh visit: YES | url:', page.url());
});
