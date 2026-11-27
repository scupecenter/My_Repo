import { expect, test } from '@playwright/test';
import { login } from './helpers';

// These specs drive the list grid; the site page opens on the Excel-like row by default (2026-11-08).
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { if (!localStorage.getItem('pmis.site.layout')) localStorage.setItem('pmis.site.layout', '"list"'); }); });

// Site Register streams (owner decision 2026-11-15: the sidebar shows only the six Site Master sub-menus under Site Master; the stream filter is reached by its old URL, ?stream=).
// EN/light and AR/dark (RTL, dark tokens), against the mock layer.
const CASES = [
  { locale: 'en', theme: 'light', title: 'Site Master', cw: 'Civil Works', cwMenu: 'CW', dismantle: 'Dismantle', na: /Show N\/A sites \(\d+\)/,
    phases: ['All', 'Design & Acquisition', 'Civil Works', 'Installation (TE)', 'O&M', 'Handover & Closure', 'Dismantle'] },
  { locale: 'ar', theme: 'dark', title: 'ماستر المواقع', cw: 'الأعمال المدنية', cwMenu: 'الأعمال المدنية', dismantle: 'الفك', na: /إظهار المواقع غير المنطبقة \(\d+\)/,
    phases: ['الكل', 'التصميم والاستحواذ', 'الأعمال المدنية', 'التركيبات', 'التشغيل والصيانة', 'التسليم والإغلاق', 'الفك'] },
] as const;

for (const c of CASES) {
  test(`stream filter on the Site Register (${c.locale}/${c.theme})`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [c.locale, c.theme]);
    await login(page, 'pm');
    await page.getByTestId('nav-sites').click();
    await expect(page.getByTestId('page-sites')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', c.locale === 'ar' ? 'rtl' : 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(c.title);
    await expect(page.getByTestId('nav-group-toggle-site_register')).toHaveCount(1); // Site Master is a group (Site 360 then the six sub-menus), expanded by default
    await expect(page.getByTestId('nav-sites')).toHaveText(c.title);

    // the page has no tab bars; the sidebar shows the six Site Master sub-menus and no stream links
    await expect(page.getByTestId('stream-tabs')).toHaveCount(0);
    await expect(page.getByTestId('view-tabs')).toHaveCount(0);
    await expect(page.getByTestId('nav-site-master-cw')).toHaveText(c.cwMenu);
    await expect(page.locator('[data-testid^="nav-sites-stream-"]')).toHaveCount(0);
    await expect(page.getByTestId('nav-dismantle')).toHaveText(c.dismantle);

    // the old stream URL (typed or pushed inside the app) still opens the stream: the page is titled and the Site Register entry stays active
    const req = page.waitForRequest((r) => r.url().includes('/sites?') && r.url().includes('stream=CW'));
    await page.evaluate(() => { window.history.pushState({}, '', '/sites?stream=CW'); window.dispatchEvent(new PopStateEvent('popstate')); });
    await req;
    await expect(page.locator('[data-stream="CW"]')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(c.cw);
    await expect(page.getByTestId('nav-sites')).toHaveAttribute('aria-current', 'page');
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

    // the site page keeps the stream as its phase (one tab row, W1) and shows its grid and pipeline
    await row.click();
    await expect(page.getByTestId('site-phase-tab-CW')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('site-phase-tabs').getByRole('tab')).toHaveText(c.phases);
    await expect(page.getByTestId('site-stream-summary')).toBeVisible();
    await expect(page.locator('[data-testid^="pipe-node-"]')).toHaveCount(3);
    await expect(page.getByTestId('grid-stage-cw')).toBeVisible();

    // the Dismantle sub-menu opens the Dismantle register
    await page.getByTestId('nav-dismantle').click();
    await expect(page.getByTestId('page-register-dismantle')).toBeVisible();
    await expect(page.getByTestId('nav-dismantle')).toHaveAttribute('aria-current', 'page');
  });
}

// Work views (Q98, contract 0.4.7): O&M from its sidebar sub-menu; an old ?view=TE link still opens, with no tab bar.
const VIEW_CASES = [
  { locale: 'en', theme: 'light', te: 'Installation (TE)', om: 'O&M' },
  { locale: 'ar', theme: 'dark', te: 'التركيبات', om: 'التشغيل والصيانة' },
] as const;

for (const c of VIEW_CASES) {
  test(`work views on the Site Register and the site grid (${c.locale}/${c.theme})`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [c.locale, c.theme]);
    await login(page, 'pm');
    await page.getByTestId('nav-sites').click();
    await expect(page.getByTestId('view-tabs')).toHaveCount(0);

    // O&M from the sidebar: the menu opens its Site Master section (the normal list, no grid since 2026-11-22), is highlighted and named in the title
    await page.getByTestId('nav-site-master-om').click();
    await expect(page.getByTestId('sites-list')).toBeVisible();
    await expect(page.getByTestId('site-master-grid')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(c.om);
    await expect(page.getByTestId('nav-site-master-om')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('nav-site-master-om')).toHaveText(c.om);
    await expect(page.locator('[data-testid^="nav-sites-view-"]')).toHaveCount(0);

    // an old ?view=TE link (history navigation inside the app) still opens the TE view
    const req = page.waitForRequest((r) => r.url().includes('/sites?') && r.url().includes('view=TE'));
    await page.evaluate(() => { window.history.pushState({}, '', '/sites?view=TE'); window.dispatchEvent(new PopStateEvent('popstate')); });
    await req;
    await expect(page.getByRole('heading', { level: 1 })).toContainText(c.te);
    await expect(page.getByTestId('view-tabs')).toHaveCount(0);

    // the site page opens the matching phase of its one phase row (W1); the O&M phase holds only B14
    await page.getByTestId('site-row-TR101').click();
    await expect(page.getByTestId('site-phase-tab-TE')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('site-view-tabs')).toHaveCount(0);
    await expect(page.getByTestId('grid-stage-te_installation')).toBeVisible();
    await page.getByTestId('site-phase-tab-OM').click();
    await expect(page.getByTestId('grid-stage-final_closure')).toBeVisible();
    await expect(page.getByTestId('grid-stage-te_installation')).toHaveCount(0);
  });
}
