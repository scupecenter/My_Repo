import { expect, test } from '@playwright/test';
import { login } from './helpers';

// The main dashboard (contract 0.7.2) against the mock layer: EN/light and AR/dark (RTL, dark tokens), and a phone-sized screen.
const CASES = [
  { locale: 'en', theme: 'light', title: 'Dashboard', draft: /Draft/, rfi: 'Site RFI', dismantle: 'Dismantle', basisLive: /Live/ },
  { locale: 'ar', theme: 'dark', title: 'لوحة القيادة', draft: /مسودة/, rfi: 'جاهزية الموقع للتركيب (RFI)', dismantle: 'الفك', basisLive: /مباشر/ },
] as const;

for (const c of CASES) {
  test(`main dashboard: KPIs, charts, pipeline, filters, reference date, drill-down (${c.locale}/${c.theme})`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [c.locale, c.theme]);
    await login(page, 'pm');
    await page.getByTestId('nav-dashboard').click();
    await expect(page.getByTestId('page-dashboard')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', c.locale === 'ar' ? 'rtl' : 'ltr');
    if (c.theme === 'dark') await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(c.title);

    // headline
    await expect(page.getByTestId('dash-progress-value')).toContainText('%');
    await expect(page.getByTestId('dash-basis')).toHaveText(c.basisLive);
    await expect(page.getByTestId('dash-kpi-rfi')).toContainText(c.rfi);
    // Q121: the health index is approved (no draft label); the delay attribution keeps its draft label
    await expect(page.getByTestId('dash-health-draft')).toHaveCount(0);
    await expect(page.getByTestId('dash-delay-draft')).toHaveText(c.draft);
    await expect(page.getByTestId('dash-stream-DISMANTLE')).toContainText(c.dismantle);

    // ECharts draws SVG charts (status ring, streams, SLA, owners, delay, health gauge) and they are not blank
    for (const id of ['dash-status-chart', 'dash-streams-chart', 'dash-sla-chart', 'dash-issues-chart', 'dash-delay-chart', 'dash-health-gauge']) {
      const chart = page.getByTestId(id);
      await chart.scrollIntoViewIfNeeded();
      await expect(chart.locator('svg')).toBeVisible();
      await expect(chart.locator('svg path, svg rect').first()).toBeAttached();
      const box = await chart.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThan(80);
    }

    // the pipeline reuses the dashboard pipeline: ten nodes with rings and a gradient track
    const nodes = page.locator('[data-testid="dash-pipeline"] [data-testid^="pipe-node-"]');
    await expect(nodes).toHaveCount(10);
    await expect(page.locator('[data-testid="dash-pipeline"] .pipe-line i')).toBeAttached();

    // filters go to the request and change the view
    const req = page.waitForRequest((r) => r.url().includes('/dashboard?') && r.url().includes('region_id=5'));
    await page.getByTestId('dash-filter-region').selectOption('5');
    await req;
    await expect(page).toHaveURL(/region_id=5/);
    await expect(page.getByTestId('dash-central-hidden')).toBeVisible();
    await page.getByTestId('dash-filter-stream').selectOption('TE');
    await expect(page.locator('[data-testid="dash-pipeline"] [data-testid^="pipe-node-"]')).toHaveCount(4);
    // Q126: the view filter beside the stream filter (O&M keeps Final Closure only, so with TE nothing is left)
    await page.getByTestId('dash-filter-stream').selectOption('');
    await page.getByTestId('dash-filter-view').selectOption('OM');
    await expect(page.locator('[data-testid="dash-pipeline"] [data-testid^="pipe-node-"]')).toHaveCount(1);

    // reference date: a saved snapshot, then back to today
    await page.getByTestId('dash-reset').click();
    await expect(page.getByTestId('dash-snapshot-kind-2026-10-31')).toBeVisible(); // Q127: the kind of each snapshot
    await page.getByTestId('dash-snapshot-2026-10-29').click();
    await expect(page.getByTestId('dash-basis')).toHaveAttribute('data-source', 'snapshot');
    await expect(page.getByTestId('dash-basis-note')).toBeVisible();
    await page.getByTestId('dash-today').click();
    await expect(page.getByTestId('dash-basis')).toHaveAttribute('data-source', 'live');

    // drill-down to the Site Register keeps the filters
    await page.getByTestId('dash-filter-region').selectOption('1');
    await page.getByTestId('dash-status-in_progress').click();
    await expect(page.getByTestId('page-sites')).toBeVisible();
    await expect(page).toHaveURL(/region_id=1/);
    await expect(page).toHaveURL(/overall_status=in_progress/);
  });
}

test('main dashboard on a phone: no horizontal page scroll, filters and cards stack', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.addInitScript(() => { localStorage.setItem('pmis.locale', 'en'); localStorage.setItem('pmis.theme', 'light'); });
  await login(page, 'pm');
  await page.goto('/dashboard');
  await expect(page.getByTestId('dash-progress-value')).toBeVisible();
  await expect(page.getByTestId('dash-filters')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const k = await page.getByTestId('dash-kpi-rfi').boundingBox();
  expect(k!.width).toBeGreaterThan(300);
});

test('main dashboard: a caller without the dashboard module is told so', async ({ page }) => {
  await login(page, 'reviewer');
  await page.goto('/dashboard');
  await expect(page.getByText('You cannot view the dashboard.')).toBeVisible();
  await expect(page.getByTestId('dash-retry')).toBeVisible();
});
