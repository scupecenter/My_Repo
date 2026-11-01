import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Site Register stream filter: EN/light and AR/dark (RTL, dark tokens), against the mock layer.
const CASES = [
  { locale: 'en', theme: 'light', title: 'Site Register', all: 'All', cw: 'Civil Works', dismantle: 'Dismantle', na: /Show N\/A sites \(\d+\)/ },
  { locale: 'ar', theme: 'dark', title: 'سجل المواقع', all: 'الكل', cw: 'الأعمال المدنية', dismantle: 'الفك', na: /إظهار المواقع غير المنطبقة \(\d+\)/ },
] as const;

for (const c of CASES) {
  test(`stream filter on the Site Register (${c.locale}/${c.theme})`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [c.locale, c.theme]);
    await login(page, 'pm');
    await page.getByTestId('nav-sites').click();
    await expect(page.getByTestId('page-sites')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', c.locale === 'ar' ? 'rtl' : 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(c.title);
    await expect(page.getByTestId('nav-sites')).toContainText(c.title);

    // tabs: All, four streams, Dismantle
    const tabs = page.getByTestId('stream-tabs').getByRole('tab');
    await expect(tabs).toHaveCount(6);
    await expect(page.getByTestId('stream-tab-ALL')).toHaveText(c.all);
    await expect(page.getByTestId('stream-tab-DISMANTLE')).toHaveText(c.dismantle);

    // pick Civil Works: the request carries ?stream=CW and the stream columns show
    const req = page.waitForRequest((r) => r.url().includes('/sites?') && r.url().includes('stream=CW'));
    await page.getByTestId('stream-tab-CW').click();
    await expect(page.getByTestId('stream-tab-CW')).toHaveText(c.cw);
    await req;
    const row = page.getByTestId('site-row-TR101');
    await expect(row).toBeVisible();
    await expect(page.getByTestId('stream-progress-TR101')).toHaveText(/^\d+\/\d+$/);
    await expect(page.getByTestId('stream-state-TR101')).toBeVisible();
    const before = Number((await page.getByTestId('sites-count').textContent())?.match(/\d+/)?.[0]);

    // N/A sites are hidden until the toggle is switched on
    await expect(page.getByTestId('sites-show-na-label')).toHaveText(c.na);
    const na = Number((await page.getByTestId('sites-show-na-label').textContent())?.match(/\((\d+)\)/)?.[1]);
    expect(na).toBeGreaterThan(0);
    await page.getByTestId('sites-show-na').check();
    await expect(page.getByTestId('sites-count')).toHaveText(new RegExp(String(before + na)));

    // the site page keeps the stream and shows its grid and pipeline
    await row.click();
    await expect(page.getByTestId('site-stream-summary')).toBeVisible();
    await expect(page.locator('[data-testid^="pipe-node-"]')).toHaveCount(3);
    await expect(page.getByTestId('grid-stage-cw')).toBeVisible();

    // Dismantle has no API stream yet
    await page.getByTestId('nav-sites').click();
    await page.getByTestId('stream-tab-DISMANTLE').click();
    await expect(page.getByTestId('stream-dismantle-todo')).toBeVisible();
  });
}

// View tabs (Q98, contract 0.4.7): All work, CW, TE, O&M beside the streams.
const VIEW_CASES = [
  { locale: 'en', theme: 'light', all: 'All work', names: ['CW Register', 'TE Register', 'O&M'] },
  { locale: 'ar', theme: 'dark', all: 'كل الأعمال', names: ['سجل الأعمال المدنية', 'سجل التركيبات', 'التشغيل والصيانة'] },
] as const;

for (const c of VIEW_CASES) {
  test(`view tabs on the Site Register and the site grid (${c.locale}/${c.theme})`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [c.locale, c.theme]);
    await login(page, 'pm');
    await page.getByTestId('nav-sites').click();
    const tabs = page.getByTestId('view-tabs').getByRole('tab');
    await expect(tabs).toHaveCount(4);
    await expect(tabs).toHaveText([c.all, ...c.names]);

    // the request carries view=TE; keyboard: arrow keys move between tabs (mirrored in RTL)
    const req = page.waitForRequest((r) => r.url().includes('/sites?') && r.url().includes('view=TE'));
    await page.getByTestId('view-tabs-ALL').focus();
    await page.keyboard.press(c.locale === 'ar' ? 'ArrowLeft' : 'ArrowRight');
    await page.keyboard.press(c.locale === 'ar' ? 'ArrowLeft' : 'ArrowRight');
    await req;
    await expect(page.getByTestId('view-tabs-TE')).toHaveAttribute('aria-selected', 'true');

    // the site page keeps the view; the O&M view holds only B14
    await page.getByTestId('site-row-TR101').click();
    await expect(page.getByTestId('site-view-tabs-TE')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('grid-stage-te_installation')).toBeVisible();
    await page.getByTestId('site-view-tabs-OM').click();
    await expect(page.getByTestId('grid-stage-final_closure')).toBeVisible();
    await expect(page.getByTestId('grid-stage-te_installation')).toHaveCount(0);
  });
}
