import { expect, test } from '@playwright/test';
import { login } from './helpers';

// W8 of plan 2026-11-23-next-ui-cleanup: the wide table's three header rows, the site Tasks list (default) with the Timeline as the second
// option, the pasted-list search and the Display menu, in en and ar. Synthetic data of the mocks only.
for (const locale of ['en', 'ar'] as const) {
  test(`W8 table standard: wide headers, task list, pasted search, Display (${locale})`, async ({ page }) => {
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); localStorage.removeItem('pmis.site.layout'); }, locale);
    await login(page, 'pm');
    // wide table: section, group and column rows; the # cell spans the three
    await page.goto('/sites?section=master&layout=wide');
    await expect(page.getByTestId('sites-wide-table')).toBeVisible();
    await expect(page.getByTestId('wide-col-num')).toHaveAttribute('rowspan', '3');
    await expect(page.getByTestId('wide-subgroup').first()).toBeVisible();
    // pasted list: one row per Site ID, the chip and the count
    await page.goto('/sites?layout=list');
    await page.getByTestId('sites-search').fill('TR101 MI102 ZZ999');
    await expect(page.getByTestId('pasted-chip')).toBeVisible();
    await expect(page.getByTestId('site-row-TR101')).toBeVisible();
    await expect(page.getByTestId('site-row-MI102')).toBeVisible();
    await expect(page.getByTestId('sites-count-filtered')).toHaveText('2');
    // Display: large text, remembered after a reload (the Display options live in the Layout panel, V1)
    await page.getByTestId('sites-view').click();
    await page.getByTestId('display-size-lg').click();
    await expect(page.getByTestId('sites-list-card')).toHaveAttribute('data-tsize', 'lg');
    await page.reload();
    await expect(page.getByTestId('sites-list-card')).toHaveAttribute('data-tsize', 'lg');
    // site page: the list by default, the Timeline as the second option
    await page.goto('/sites?layout=list');
    await page.getByTestId('site-row-TR101').click();
    await expect(page.getByTestId('task-grid-toolbar')).toBeVisible();
    await expect(page.getByTestId('site-layout-list')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('site-layout-timeline').click();
    await expect(page.getByTestId('task-row')).toBeVisible();
  });
}
