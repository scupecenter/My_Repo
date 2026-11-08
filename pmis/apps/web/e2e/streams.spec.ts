import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Site Register streams, switched from the sidebar sub-menus (the page has no tab bars): EN/light and AR/dark (RTL, dark tokens), against the mock layer.
const CASES = [
  { locale: 'en', theme: 'light', title: 'SITE 360', cw: 'Civil Works', dismantle: 'Dismantle', na: /Show N\/A sites \(\d+\)/ },
  { locale: 'ar', theme: 'dark', title: 'SITE 360', cw: 'الأعمال المدنية', dismantle: 'الفك', na: /إظهار المواقع غير المنطبقة \(\d+\)/ },
] as const;

for (const c of CASES) {
  test(`stream filter on the Site Register (${c.locale}/${c.theme})`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [c.locale, c.theme]);
    await login(page, 'pm');
    await page.getByTestId('nav-sites').click();
    await expect(page.getByTestId('page-sites')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', c.locale === 'ar' ? 'rtl' : 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(c.title);
    await expect(page.getByTestId('nav-group-toggle-site_register')).toContainText(c.title);

    // the page has no tab bars; the sidebar sub-menus switch the stream
    await expect(page.getByTestId('stream-tabs')).toHaveCount(0);
    await expect(page.getByTestId('view-tabs')).toHaveCount(0);
    await expect(page.getByTestId('nav-sites-stream-CW')).toHaveText(c.cw);
    await expect(page.getByTestId('nav-dismantle')).toHaveText(c.dismantle);

    // pick Civil Works: the request carries ?stream=CW, the page is titled and the entry highlighted
    const req = page.waitForRequest((r) => r.url().includes('/sites?') && r.url().includes('stream=CW'));
    await page.getByTestId('nav-sites-stream-CW').click();
    await req;
    await expect(page.locator('[data-stream="CW"]')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(c.cw);
    await expect(page.getByTestId('nav-sites-stream-CW')).toHaveAttribute('aria-current', 'page');
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

    // O&M from the sidebar: the request carries view=OM and the title names the view
    const om = page.waitForRequest((r) => r.url().includes('/sites?') && r.url().includes('view=OM'));
    await page.getByTestId('nav-sites-view-OM').click();
    await om;
    await expect(page.getByRole('heading', { level: 1 })).toContainText(c.om);
    await expect(page.getByTestId('nav-sites-view-OM')).toHaveAttribute('aria-current', 'page');

    // an old ?view=TE link (history navigation inside the app) still opens the TE view
    const req = page.waitForRequest((r) => r.url().includes('/sites?') && r.url().includes('view=TE'));
    await page.evaluate(() => { window.history.pushState({}, '', '/sites?view=TE'); window.dispatchEvent(new PopStateEvent('popstate')); });
    await req;
    await expect(page.getByRole('heading', { level: 1 })).toContainText(c.te);
    await expect(page.getByTestId('view-tabs')).toHaveCount(0);

    // the site page keeps the view; the O&M view holds only B14
    await page.getByTestId('site-row-TR101').click();
    await expect(page.getByTestId('site-view-tabs-TE')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('grid-stage-te_installation')).toBeVisible();
    await page.getByTestId('site-view-tabs-OM').click();
    await expect(page.getByTestId('grid-stage-final_closure')).toBeVisible();
    await expect(page.getByTestId('grid-stage-te_installation')).toHaveCount(0);
  });
}
