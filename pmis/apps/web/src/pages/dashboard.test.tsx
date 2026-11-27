import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { API_BASE } from '@/api/client';
import { buildDashboard } from '@/mocks/dashboardData';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { tripoliToday } from '@/lib/today';
import { Dashboard } from './Dashboard';

// ECharts draws in the browser (the Playwright case checks it); here the chart is a placeholder with its text alternative.
vi.mock('@/components/EChart', () => ({ EChart: ({ label, testid }: { label: string; testid?: string }) => <div role="img" aria-label={label} data-testid={testid} /> }));

const Where = () => { const l = useLocation(); return <output data-testid="where">{l.pathname}{l.search}</output>; };
const page = (route = '/dashboard', locale: 'en' | 'ar' = 'en') =>
  renderApp(<><Routes><Route path="/dashboard" element={<Dashboard />} /><Route path="*" element={<Where />} /></Routes></>, { route, locale });

describe('Dashboard', () => {
  it('puts the site map first, above the headline KPIs (owner request 2026-11-06)', async () => {
    await signIn('pm');
    page();
    const kpi = await screen.findByTestId('dash-kpi-progress');
    const map = await screen.findByTestId('dash-site-map');
    expect(map.compareDocumentPosition(kpi) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }, 30_000);

  it('shows the headline KPIs: weighted progress with plan and SPI "not available", sites by Overall Status, milestones, Final Closure', async () => {
    await signIn('pm');
    page();
    expect(await screen.findByTestId('dash-progress-value')).toHaveTextContent('%');
    expect(screen.getByTestId('dash-planned')).toHaveTextContent('not available');
    expect(screen.getByTestId('dash-spi')).toHaveTextContent('not available');
    expect(screen.getByTestId('dash-basis')).toHaveAttribute('data-source', 'live');
    for (const s of ['not_started', 'in_progress', 'on_hold', 'completed', 'cancelled']) expect(screen.getByTestId(`dash-status-${s}`)).toBeInTheDocument();
    expect(screen.getByTestId('dash-kpi-rfi')).toHaveTextContent('Site RFI');
    expect(screen.getByTestId('dash-kpi-onair')).toBeInTheDocument();
    expect(screen.getByTestId('dash-kpi-hoto')).toBeInTheDocument();
    expect(screen.getByTestId('dash-closure-detail')).toHaveTextContent('Pending CW FAC');
    expect(Number(screen.getByTestId('dash-fac-cw').textContent)).toBeGreaterThanOrEqual(0);
  });

  it('draws the pipeline with a node per milestone, progress rings and the done / applicable counts', async () => {
    await signIn('pm');
    page();
    const pipe = await screen.findByTestId('dash-pipeline');
    expect(within(pipe).getAllByRole('button').filter((b) => b.dataset.testid?.startsWith('pipe-node-'))).toHaveLength(10);
    expect(within(pipe).getByTestId('dash-node-MS6').textContent).toMatch(/\d+\/\d+/);
  });

  it('shows the approved health index (no draft label, Q121) with the bands and the factors, with the excluded one named', async () => {
    await signIn('pm');
    page();
    await screen.findByTestId('dash-health');
    expect(screen.queryByTestId('dash-health-draft')).toBeNull();
    expect(screen.getByTestId('dash-health-band')).toHaveAttribute('data-band', 'amber');
    expect(screen.getByTestId('dash-health-bands')).toHaveTextContent('Green from 85, amber from 70');
    expect(within(screen.getByTestId('dash-health-D')).getByText('no data')).toBeInTheDocument();
  });

  it('lists the streams including Dismantle, the SLA, the top late tasks, the blocked gates with reasons and the issues counted per owner', async () => {
    await signIn('pm');
    page();
    await screen.findByTestId('dash-streams');
    expect(screen.getByTestId('dash-stream-DISMANTLE')).toBeInTheDocument();
    expect(screen.getByTestId('dash-stream-CW-done')).toBeInTheDocument();
    expect(screen.getByTestId('dash-sla-totals')).toHaveTextContent('Late');
    expect(screen.getByTestId('dash-top-late')).toHaveTextContent('TR101');
    expect(screen.getByTestId('dash-gate-TR101-G5')).toHaveTextContent('Access - TE must be approved');
    expect(screen.getByTestId('dash-issues-open')).toBeInTheDocument();
    expect(screen.getByTestId('dash-issues-sites')).toBeInTheDocument();
    expect(screen.getByTestId('dash-issues-chart')).toHaveAccessibleName(/Sami Nuri 8/);
    expect(screen.getByTestId('dash-issues-cat-chart')).toHaveAccessibleName(/Fiber: 7 issues, 6 sites/);
    expect(screen.getByTestId('dash-issues-cat-chart')).toHaveAccessibleName(/No category: 2 issues, 2 sites/);
    expect(screen.getByTestId('dash-issues-reason-chart')).toHaveAccessibleName(/Uplink Site Not Ready: 6 issues, 5 sites/);
    expect(screen.getByTestId('dash-delay')).toHaveTextContent('Delay attribution');
  });

  it('switches the Issues card between owner, category and reason, and names the data basis of each card', async () => {
    await signIn('pm');
    page();
    await screen.findByTestId('dash-issues');
    expect(screen.getByTestId('dash-issues-by-owner')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('dash-issues-cat-chart').closest('.hidden')).not.toBeNull();
    expect(screen.getByTestId('dash-issues-chart').closest('.hidden')).toBeNull();
    await userEvent.click(screen.getByTestId('dash-issues-by-category'));
    expect(screen.getByTestId('dash-issues-cat-chart').closest('.hidden')).toBeNull();
    expect(screen.getByTestId('dash-issues-chart').closest('.hidden')).not.toBeNull();
    expect(screen.getByTestId('dash-issues-basis')).toHaveTextContent('Live, as of today');
    expect(screen.getByTestId('dash-delay-basis')).toBeInTheDocument();
  });

  it('drills down to the Site Register with the filters of the view', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    page('/dashboard?region_id=1&scenario=new_build');
    const link = await screen.findByTestId('dash-status-in_progress');
    // 0.15.33 (audit E section 2): a status chip opens the sites of the derived status the card counts, a milestone card the sites that reached it
    expect(link.getAttribute('href')).toBe('/sites?region_id=1&scenario=new_build&dashboard_status=in_progress');
    expect(screen.getByTestId('dash-kpi-rfi').getAttribute('href')).toBe('/sites?region_id=1&scenario=new_build&milestone_reached=MS4');
    expect(screen.getByTestId('dash-kpi-hoto').getAttribute('href')).toBe('/sites?region_id=1&scenario=new_build&milestone_reached=MS9');
    expect(screen.getByTestId('dash-stream-CW').querySelector('a')!.getAttribute('href')).toBe('/sites?region_id=1&scenario=new_build&stream=CW');
    await u.click(screen.getByTestId('dash-pipeline').querySelector('[data-testid="pipe-node-MS4"]')!);
    expect(await screen.findByTestId('where')).toHaveTextContent('/sites?region_id=1&scenario=new_build&stage_code=MS4');
  });

  it('keeps the cluster and the reference date in the drill-downs of the cards (audit E section 2)', { timeout: 30_000 }, async () => {
    await signIn('pm');
    page('/dashboard?cluster_code=CL-TR-01&ref_date=2026-10-29');
    const link = await screen.findByTestId('dash-status-on_hold');
    expect(link.getAttribute('href')).toBe('/sites?cluster_code=CL-TR-01&dashboard_status=on_hold&ref_date=2026-10-29');
    expect(screen.getByTestId('dash-kpi-onair').getAttribute('href')).toBe('/sites?cluster_code=CL-TR-01&milestone_reached=MS6&ref_date=2026-10-29');
    expect(screen.getByTestId('dash-kpi-closure').getAttribute('href')).toBe('/sites?cluster_code=CL-TR-01&milestone_reached=MS10&ref_date=2026-10-29');
    // a list that is not a card's own set has no reference date (the Site Register is live)
    expect(screen.getByTestId('dash-sites-total').getAttribute('href')).toBe('/sites?cluster_code=CL-TR-01');
  });

  it('filters by region and stream through the URL (the region shows as a chip of the unified filter), and resets', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => { if (new URL(request.url).pathname.endsWith('/dashboard')) seen.push(new URL(request.url).search); });
    page('/dashboard?region_id=5');
    await screen.findByTestId('dash-progress-value');
    expect(await screen.findByTestId('filter-chip-x-region_id')).toBeInTheDocument();
    expect(screen.queryByTestId('dash-filter-region')).toBeNull(); // the separate selects are gone
    await waitFor(() => expect(seen.some((s) => s.includes('region_id=5'))).toBe(true));
    await u.selectOptions(await screen.findByTestId('dash-filter-stream'), 'TE');
    await waitFor(() => expect(seen.some((s) => s.includes('stream=TE') && s.includes('region_id=5'))).toBe(true));
    await waitFor(() => expect(within(screen.getByTestId('dash-pipeline')).queryByTestId('pipe-node-MS1')).toBeNull());
    expect(screen.getByTestId('dash-central-hidden')).toHaveTextContent('14');
    await u.click(screen.getByTestId('dash-reset'));
    await waitFor(() => expect(screen.queryByTestId('dash-reset')).toBeNull());
    expect(screen.queryByTestId('filter-chip-x-region_id')).toBeNull();
  });

  it('keeps the cluster and scenario links as chips and sends them with the request', async () => {
    await signIn('pm');
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => { if (new URL(request.url).pathname.endsWith('/dashboard')) seen.push(new URL(request.url).search); });
    page('/dashboard?scenario=expansion&cluster_code=CL-TR-01');
    expect(await screen.findByTestId('filter-chip-x-scenario')).toHaveTextContent('Scenario: Expansion');
    expect(screen.getByTestId('filter-chip-x-cluster_code')).toHaveTextContent('Cluster: CL-TR-01');
    await waitFor(() => expect(seen.some((s) => s.includes('scenario=expansion') && s.includes('cluster_code=CL-TR-01'))).toBe(true));
  });

  it('changes the reference date: a date with a snapshot says so, another says it is computed, and Today goes back to live', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    page();
    await screen.findByTestId('dash-progress-value');
    expect(screen.getByTestId('dash-ref-date')).toHaveAttribute('max', tripoliToday());
    expect(screen.getByTestId('dash-today')).toBeDisabled();
    await u.click(screen.getByTestId('dash-snapshot-2026-10-29'));
    await waitFor(() => expect(screen.getByTestId('dash-basis')).toHaveAttribute('data-source', 'snapshot'));
    expect(screen.getByTestId('dash-basis-note')).toHaveTextContent('weekly snapshot of 2026-10-29');
    fireEvent.change(screen.getByTestId('dash-ref-date'), { target: { value: '2026-09-01' } });
    await waitFor(() => expect(screen.getByTestId('dash-basis')).toHaveAttribute('data-source', 'as_of_computed'));
    expect(screen.getByTestId('dash-basis-note')).toHaveTextContent('computed as of that date');
    expect(screen.getByTestId('dash-gates-unavailable')).toBeInTheDocument();
    await u.click(screen.getByTestId('dash-today'));
    await waitFor(() => expect(screen.getByTestId('dash-basis')).toHaveAttribute('data-source', 'live'));
  });

  it('exports the view through the API (the server audits it) and says so', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const asked: string[] = [];
    server.use(http.get(`${API_BASE}/dashboard/export`, ({ request }) => { asked.push(new URL(request.url).search); return new HttpResponse('section,item,metric,value\r\n', { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="GSDN_Dashboard_2026-10-25.csv"' } }); }));
    page('/dashboard?region_id=1');
    await u.click(await screen.findByTestId('dash-export'));
    await waitFor(() => expect(asked).toEqual(['?region_id=1&format=xlsx']));
    expect(await screen.findByText('The file was downloaded.')).toBeInTheDocument();
  });

  it('shows a clear message when the caller may not view the dashboard, and can retry', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    server.use(http.get(`${API_BASE}/dashboard`, () => HttpResponse.json({ type: 'x', title: 'Module not available', status: 403, code: 'module_forbidden' }, { status: 403 }), { once: true }));
    page();
    expect(await screen.findByText('You cannot view the dashboard.')).toBeInTheDocument();
    await u.click(screen.getByTestId('dash-retry'));
    expect(await screen.findByTestId('dash-progress-value')).toBeInTheDocument();
  });

  it('hides the issues section when the Issue Log is not in the caller access, and the export button without the export right', async () => {
    await signIn('reviewer');
    const base = buildDashboard(new URLSearchParams());
    server.use(http.get(`${API_BASE}/dashboard`, () => HttpResponse.json({ ...base, issues: null })));
    page();
    expect(await screen.findByTestId('dash-issues-hidden')).toBeInTheDocument();
    expect(screen.queryByTestId('dash-export')).toBeNull();
  });

  it('renders in Arabic (RTL), with Arabic names for milestones, regions, views and snapshot kinds, and the draft label of the delay attribution only', async () => {
    await signIn('pm');
    page('/dashboard', 'ar');
    expect(await screen.findByTestId('dash-delay-draft')).toHaveTextContent('مسودة');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('لوحة القيادة');
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.queryByTestId('dash-health-draft')).toBeNull();
    expect(within(screen.getByTestId('dash-filter-view')).getByRole('option', { name: 'التشغيل والصيانة' })).toBeInTheDocument();
    expect(screen.getByTestId('dash-snapshot-kind-2026-10-31')).toHaveTextContent('نهاية الشهر');
    expect(screen.getByTestId('dash-kpi-rfi')).toHaveTextContent('جاهزية الموقع للتركيب');
    expect(screen.getByTestId('dash-region-1')).toHaveTextContent('طرابلس');
    expect(screen.getByTestId('dash-stream-DISMANTLE')).toHaveTextContent('الفك');
    expect(screen.getByTestId('dash-basis')).toHaveTextContent('مباشر');
  });
});
