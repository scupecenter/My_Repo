import { expect, test } from '@playwright/test';
import { login } from './helpers';

// W2 of plan 2026-11-23-next-ui-cleanup: the view switcher of Site Master on a register (Procurement): list, wide table, board and map, in en
// (light) and ar (dark, RTL: the wide table and its scroller stay LTR). A saved view keeps the layout. Synthetic data of the mocks only.
const CASES = [
  { locale: 'en', theme: 'light', table: 'Table', wide: 'Wide table', board: 'Board', map: 'Map' },
  { locale: 'ar', theme: 'dark', table: 'جدول', wide: 'جدول عريض', board: 'لوحة', map: 'خريطة' },
] as const;

for (const c of CASES) {
  test(`W2 register views: Procurement list, wide, board, map (${c.locale}/${c.theme})`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [c.locale, c.theme]);
    await login(page, 'pm');
    await expect(page.locator('html')).toHaveAttribute('dir', c.locale === 'ar' ? 'rtl' : 'ltr');
    await page.getByTestId('nav-procurement').click();
    await expect(page.getByTestId('register-list-card')).toBeVisible();
    const sw = { map: page.getByTestId('register-layout-map'), board: page.getByTestId('register-layout-board'), wide: page.getByTestId('register-layout-wide') };
    await expect(sw.map).toContainText(c.map);
    await expect(sw.board).toContainText(c.board);
    await expect(sw.wide).toContainText(c.wide);

    // wide table: LTR, # and Site ID frozen, an editable cell of a record in entry
    await sw.wide.click();
    await expect(page).toHaveURL(/layout=wide/);
    await expect(page.getByTestId('register-wide-table')).toBeVisible();
    await expect(page.getByTestId('register-wide-table')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByTestId('register-wide-scroll')).toHaveAttribute('dir', 'ltr');
    await expect(sw.wide).toHaveAttribute('aria-pressed', 'true');
    await expect(sw.wide).toContainText(c.table);
    await expect(page.locator('[data-testid^="wide-edit-"]').first()).toBeVisible();

    // board: columns by Order Status, then by approval state
    await sw.board.click();
    await expect(page).toHaveURL(/layout=board/);
    await expect(page.getByTestId('register-board')).toHaveAttribute('data-by', 'order_status');
    await expect(page.getByTestId('board-col-Open')).toBeVisible();
    await page.getByTestId('register-board-by').selectOption('state');
    await expect(page.getByTestId('board-col-approved')).toBeVisible();
    // a card opens the record drawer
    await page.locator('[data-testid^="board-record-"]').first().click();
    await expect(page.getByTestId('register-drawer-body')).toBeVisible();
    await page.getByTestId('reg-close').click();

    // map: the Site Master map, narrowed to the sites of the records
    await sw.map.click();
    await expect(page).toHaveURL(/layout=map/);
    await expect(page.getByTestId('register-map')).toBeVisible();
    await expect(page.getByTestId('register-map-note')).toBeVisible();

    // a saved view keeps the layout
    await sw.board.click();
    await expect(page.getByTestId('register-board')).toBeVisible();
    await page.getByTestId('views-save').click();
    await page.getByTestId('views-name').fill(`W2 board ${c.locale}`);
    await page.getByTestId('views-name-ok').click();
    await sw.board.click(); // back to the list
    await expect(page.getByTestId('register-list-card')).toBeVisible();
    await page.getByTestId('views-select').selectOption({ label: `W2 board ${c.locale}` });
    await expect(page.getByTestId('register-board')).toBeVisible();
    await expect(page).toHaveURL(/board_by=state/);
  });
}
