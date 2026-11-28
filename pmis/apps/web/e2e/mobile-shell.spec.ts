import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Item 12: on a phone-sized screen the shell is a mobile layout (bottom bar, compact top bar), the app banner is dismissible and remembered, and the
// first-use tour opens once by itself and can be replayed from My profile > Appearance. EN and AR.
for (const c of [{ locale: 'en' }, { locale: 'ar' }] as const) {
  test.describe(`mobile shell (${c.locale})`, () => {
    test.use({ viewport: { width: 390, height: 780 } });
    test(`bottom bar, banner remembered, tour once and replay (${c.locale})`, async ({ page }) => {
      await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); }, c.locale);
      await login(page, 'pm');
      await page.goto('/my-work');
      await expect(page.getByTestId('mobile-bar')).toBeVisible();
      await expect(page.getByTestId('breadcrumb')).toBeHidden();
      // first use: the tour card opens by itself and does not block the page
      await expect(page.getByTestId('quick-tour')).toHaveAttribute('data-mode', 'first-use');
      await page.screenshot({ path: `test-results/mobile-${c.locale}.png` });
      await page.getByTestId('tour-skip').click();
      await expect(page.getByTestId('quick-tour')).toHaveCount(0);
      await page.reload();
      await expect(page.getByTestId('mobile-bar')).toBeVisible();
      await expect(page.getByTestId('quick-tour')).toHaveCount(0);
      // the banner: dismiss, and it stays away after a reload
      await expect(page.getByTestId('app-banner')).toBeVisible();
      await page.getByTestId('app-banner-dismiss').click();
      await page.reload();
      await expect(page.getByTestId('mobile-bar')).toBeVisible();
      await expect(page.getByTestId('app-banner')).toHaveCount(0);
      // the bar navigates, More opens the drawer
      await page.getByTestId('mobile-bar-inbox').click();
      await expect(page).toHaveURL(/\/inbox/);
      await page.getByTestId('mobile-bar-more').click();
      await expect(page.getByTestId('sidebar-drawer')).toBeVisible();
      await page.getByTestId('drawer-close').click();
      // replay from the settings
      await page.goto('/profile');
      await page.getByTestId('pf-ap-replay-tour').click();
      await expect(page.getByTestId('quick-tour')).toHaveAttribute('data-mode', 'replay');
      await page.getByTestId('tour-skip').click();
    });
  });
}
