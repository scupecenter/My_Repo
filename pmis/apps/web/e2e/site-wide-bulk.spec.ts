import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

// The wide Site Master table: frozen columns, one cell edit, a bulk edit on two sites, and the screens in light/dark and en/ar.
// The screenshots are attached to the test (artifacts of the run), nothing is written outside the report folder.
const ROUTE = '/sites?section=te&layout=wide';

const open = async (page: Page, locale: 'en' | 'ar', theme: 'light' | 'dark') => {
  await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [locale, theme]);
  await login(page, 'pm');
  await page.goto(ROUTE);
  await expect(page.getByTestId('sites-wide-table')).toBeVisible();
  await expect(page.getByTestId('wide-select-S360-001')).toBeVisible();
};

const box = async (page: Page, id: string) => {
  const b = await page.getByTestId(id).boundingBox();
  if (!b) throw new Error(`${id} has no box`);
  return b;
};

for (const [locale, theme] of [['en', 'light'], ['ar', 'dark'], ['en', 'dark'], ['ar', 'light']] as const) {
  test(`wide table: frozen columns, cell edit, bulk edit on two sites (${locale} ${theme})`, async ({ page }, testInfo) => {
    const shot = async (name: string) => {
      await page.waitForTimeout(300);
      await testInfo.attach(`${name}-${locale}-${theme}`, { body: await page.screenshot({ fullPage: false }), contentType: 'image/png' });
    };
    await open(page, locale, theme);
    await shot('wide-initial');

    // 1. the frozen columns (# and Site ID) stay in view after a horizontal scroll
    const scroller = page.getByTestId('sites-wide-scroll');
    const before = { num: await box(page, 'wide-col-num'), site: await box(page, 'wide-col-site') };
    await scroller.evaluate((el) => { el.scrollLeft = el.scrollWidth; }); // the table is dir=ltr in both locales
    await expect.poll(async () => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    const after = { num: await box(page, 'wide-col-num'), site: await box(page, 'wide-col-site') };
    expect(Math.abs(after.num.x - before.num.x)).toBeLessThan(2);
    expect(Math.abs(after.site.x - before.site.x)).toBeLessThan(2);
    await expect(page.getByTestId('wide-col-num')).toBeInViewport();
    await expect(page.getByTestId('wide-col-site')).toBeInViewport();
    await expect(page.getByTestId('wide-select-S360-001')).toBeInViewport();
    await shot('wide-scrolled');
    await scroller.evaluate((el) => { el.scrollLeft = 0; });

    // 2. one cell edit
    await page.getByTestId('wide-edit-S360-001-78').click();
    const input = page.getByTestId('wide-input-S360-001-78');
    await input.fill('2026-06-15');
    await shot('wide-cell-edit');
    await page.getByTestId('wide-save-S360-001-78').click();
    await expect(page.getByTestId('wide-input-S360-001-78')).toHaveCount(0);
    await page.getByTestId('wide-edit-S360-001-78').click();
    await expect(page.getByTestId('wide-input-S360-001-78')).toHaveValue('2026-06-15');
    await page.keyboard.press('Escape');

    // 3. bulk edit on two sites: select both, pick the column, type the value, check the preview, confirm
    await page.getByTestId('wide-select-S360-001').check();
    await page.getByTestId('wide-select-S360-002').check();
    await expect(page.getByTestId('sites-bulk-count')).toContainText('2');
    await shot('wide-selected');
    await page.getByTestId('sites-bulk-edit').click();
    const dlg = page.getByTestId('bulk-edit');
    await expect(dlg).toBeVisible();
    await dlg.getByTestId('bulk-edit-field').selectOption('78');
    await dlg.getByTestId('bulk-edit-value').fill('2026-07-01');
    await expect(dlg.getByTestId('bulk-edit-preview')).toBeVisible();
    await shot('bulk-preview');
    await dlg.getByTestId('bulk-edit-confirm').click();
    await expect(dlg.getByTestId('bulk-edit-result')).toBeVisible();
    await expect(dlg.getByTestId('bulk-edit-saved')).toContainText('2');
    await expect(dlg.getByTestId('bulk-edit-failed')).toContainText('0');
    await shot('bulk-result');
    await dlg.getByTestId('bulk-edit-close').click();
    await expect(dlg).toHaveCount(0);

    // the rows were read again: both sites show the new value
    for (const code of ['S360-001', 'S360-002']) {
      await page.getByTestId(`wide-edit-${code}-78`).click();
      await expect(page.getByTestId(`wide-input-${code}-78`)).toHaveValue('2026-07-01');
      await page.keyboard.press('Escape');
    }
    await shot('wide-after-bulk');
  });
}
