import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_BASE } from '@/api/client';
import { mapItem, MAP_MILESTONES, SITE_COUNT, STREAMS } from '@/mocks/sites';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { applyFilters, buildMapOption, facet, lightOf, marks, readFilters, type SiteMapItem } from '@/lib/siteMap';
import { Sites } from '@/pages/Sites';
import { hasValidCoords } from '@/mocks/sites';
import { SiteMap } from './SiteMap';

// ECharts draws in the browser; here the chart is a placeholder with its text alternative. The option itself is tested through buildMapOption.
vi.mock('@/components/EChart', () => ({ EChart: ({ label, testid }: { label: string; testid?: string }) => <div role="img" aria-label={label} data-testid={testid} /> }));

const T = 30_000;
const Where = () => { const l = useLocation(); return <output data-testid="where">{l.search}</output>; };
const page = (route = '/dashboard', locale: 'en' | 'ar' = 'en') =>
  renderApp(<><Routes><Route path="/dashboard" element={<><SiteMap /><Where /></>} /><Route path="/sites" element={<Where />} /></Routes></>, { route, locale });

/** Synthetic rows (the mock sites, with chosen states), so every light is present. */
const base = (i: number, o: Partial<SiteMapItem>): SiteMapItem => ({ ...mapItem(i), latitude: 32.8, longitude: 13.2, has_coordinates: true, late: false, late_task_count: 0, behind_baseline: false, tower_owner: null, ...o } as SiteMapItem);
const ROWS: SiteMapItem[] = [
  base(1, { site_code: 'MAP-P1', overall_status: 'in_progress', on_air_reached: false, stream_code: 'CW', milestone_code: 'cw', region_id: 1, tower_owner: 'TowerCo Alpha (synthetic)', sub_region: 'Ain Zara' }),
  base(2, { site_code: 'MAP-P2', overall_status: 'in_progress', on_air_reached: false, stream_code: 'TE', milestone_code: 'te_installation', region_id: 5, late: true, late_task_count: 2, tower_owner: 'TowerCo Beta (synthetic)' }),
  base(3, { site_code: 'MAP-AIR', overall_status: 'in_progress', on_air_reached: true, stream_code: 'TE', milestone_code: 'te_pac', region_id: 5, tower_owner: 'Own tower' }),
  base(4, { site_code: 'MAP-HOLD', overall_status: 'on_hold', on_air_reached: false, stream_code: 'CW', milestone_code: 'pre_cw', region_id: 1 }),
  base(5, { site_code: 'MAP-IDLE', overall_status: 'not_started', on_air_reached: false, stream_code: 'DESIGN_ACQ', milestone_code: 'site_release', region_id: 7 }),
  base(6, { site_code: 'MAP-CXL', overall_status: 'cancelled', on_air_reached: false, region_id: 1 }),
  base(7, { site_code: 'MAP-NOXY', overall_status: 'in_progress', on_air_reached: false, stream_code: 'CW', milestone_code: 'cw', latitude: null, longitude: null, has_coordinates: false, region_id: 1 }),
];
const useRows = () => server.use(http.get(`${API_BASE}/dashboard/site-map`, () => HttpResponse.json({
  as_of: new Date().toISOString(), scope_regions: null, counts: { total: 7, cancelled: 1, with_coordinates: 5, without_coordinates: 1 }, streams: STREAMS, milestones: MAP_MILESTONES, items: ROWS,
})));
const ctx = { by: 'stream' as const, streams: STREAMS.map((s) => ({ ...s, stream_code: null })), milestones: MAP_MILESTONES, reducedMotion: false };
const colour = (n: string) => `#${n}`;

let mm: ((q: string) => MediaQueryList) | undefined;
afterEach(() => { if (mm) window.matchMedia = mm as typeof window.matchMedia; mm = undefined; });
const reduceMotion = () => {
  mm = window.matchMedia;
  window.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener: () => {}, removeEventListener: () => {}, onchange: null, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia;
};

describe('site map rules (lib/siteMap)', () => {
  it('lights: in progress pulses in its stream colour; On-Air is steady green (also on hold); on hold amber; not started grey; cancelled dark grey', () => {
    expect(ROWS.map(lightOf)).toEqual(['progress', 'progress', 'on_air', 'hold', 'idle', 'cancelled', 'progress']);
    expect(lightOf({ overall_status: 'on_hold', on_air_reached: true, milestone_code: 'kpi_acceptance' })).toBe('on_air');
    const m = marks(ROWS, { ...ctx, colour });
    expect(m.map((x) => x.site.site_code)).not.toContain('MAP-NOXY'); // no valid coordinates: not drawn
    expect(m.find((x) => x.site.site_code === 'MAP-AIR')).toMatchObject({ colour: '#done', pulse: false });
    expect(m.find((x) => x.site.site_code === 'MAP-P1')).toMatchObject({ colour: '#stream-cw', pulse: true });
    expect(m.find((x) => x.site.site_code === 'MAP-HOLD')).toMatchObject({ colour: '#map-hold', pulse: false });
    expect(m.find((x) => x.site.site_code === 'MAP-IDLE')).toMatchObject({ colour: '#map-idle', pulse: false });
    expect(marks(ROWS, { ...ctx, by: 'milestone', colour }).find((x) => x.site.site_code === 'MAP-P1')?.colour).toBe('#ms-3');
  });

  it('the option: pulsing lights are an effect-scatter ripple, On-Air is a plain dot, a late site has a red ring; reduced motion gives a steady halo; no tile layer', () => {
    const opt = (reducedMotion: boolean) => buildMapOption(marks(ROWS, { ...ctx, reducedMotion, colour }), { ...ctx, reducedMotion, rtl: false, tip: (s) => s.site_code, cityName: (k) => k, colour });
    const o = opt(false) as { series: { id: string; type: string; data: { name: string; itemStyle?: { borderColor?: string; color?: string }; symbolSize?: number }[]; rippleEffect?: unknown }[]; geo: { map: string; roam: boolean } };
    const sid = (id: string) => o.series.find((s) => s.id === id)!;
    expect(o.geo).toMatchObject({ map: 'libya', roam: true });
    expect(sid('pulse').type).toBe('effectScatter');
    expect(sid('pulse').rippleEffect).toBeTruthy();
    expect(sid('pulse').data.map((d) => d.name).sort()).toEqual(['MAP-P1', 'MAP-P2']);
    expect(sid('lights').data.map((d) => d.name)).toContain('MAP-AIR');
    expect(sid('lights').data.find((d) => d.name === 'MAP-AIR')!.itemStyle!.color).toBe('#done');
    const late = sid('pulse').data.find((d) => d.name === 'MAP-P2')!;
    expect(late.itemStyle!.borderColor).toBe('#late');
    expect(late.symbolSize).toBeGreaterThan(sid('pulse').data.find((d) => d.name === 'MAP-P1')!.symbolSize!);
    expect(sid('towers').data).toHaveLength(6); // marks draws what it is given (the filters leave the cancelled one out before)
    expect(sid('cities').data.length).toBeGreaterThanOrEqual(9);
    expect(JSON.stringify(o)).not.toMatch(/https?:|tile|bmap/i);
    const r = opt(true) as typeof o;
    expect(r.series.some((s) => s.type === 'effectScatter')).toBe(false);
    expect(r.series.find((s) => s.id === 'halo')!.data.map((d) => d.name).sort()).toEqual(['MAP-P1', 'MAP-P2']);
  });

  it('filters: cancelled only when the status filter asks; faceted counts; the URL form', () => {
    const f = readFilters(new URLSearchParams('map_region=1&map_late=1'));
    expect(applyFilters(ROWS, readFilters(new URLSearchParams())).map((s) => s.site_code)).not.toContain('MAP-CXL');
    expect(applyFilters(ROWS, readFilters(new URLSearchParams('map_status=cancelled'))).map((s) => s.site_code)).toEqual(['MAP-CXL']);
    expect(applyFilters(ROWS, f)).toHaveLength(0);
    expect(applyFilters(ROWS, readFilters(new URLSearchParams('map_late=1'))).map((s) => s.site_code)).toEqual(['MAP-P2']);
    expect(applyFilters(ROWS, readFilters(new URLSearchParams('map_owner=Own tower'))).map((s) => s.site_code)).toEqual(['MAP-AIR']);
    expect(applyFilters(ROWS, readFilters(new URLSearchParams('map_q=hold'))).map((s) => s.site_code)).toEqual(['MAP-HOLD']);
    expect(applyFilters(ROWS, readFilters(new URLSearchParams()), { region_id: '5' }).map((s) => s.site_code)).toEqual(['MAP-P2', 'MAP-AIR']);
    const regions = facet(ROWS, readFilters(new URLSearchParams('map_region=5')), {}, 'region');
    expect(regions.get('1')).toBe(3); // the region facet ignores the region filter itself (cancelled left out)
    expect(facet(ROWS, readFilters(new URLSearchParams()), {}, 'status').get('cancelled')).toBe(1);
  });
});

describe('SiteMap', () => {
  it('shows the legend with counts per colour, the drawn count and the link to the sites without coordinates', async () => {
    await signIn('pm');
    useRows();
    page();
    await screen.findByTestId('map-legend-on_air');
    const legend = screen.getByTestId('map-legend');
    expect(within(legend).getByTestId('map-legend-stream:CW')).toHaveTextContent('1');
    expect(within(legend).getByTestId('map-legend-stream:TE')).toHaveTextContent('1');
    expect(within(legend).getByTestId('map-legend-on_air')).toHaveTextContent('On-Air');
    expect(within(legend).getByTestId('map-legend-on_air')).toHaveAttribute('data-pulse', 'false');
    expect(within(legend).getByTestId('map-legend-stream:CW')).toHaveAttribute('data-pulse', 'true');
    expect(within(legend).queryByTestId('map-legend-cancelled')).toBeNull();
    expect(screen.getByTestId('map-count')).toHaveTextContent('5 drawn of 6 sites');
    expect(screen.getByTestId('map-no-coords-link')).toHaveAttribute('href', '/sites?coordinates=missing');
    expect(screen.getByTestId('map-chart')).toHaveAttribute('aria-label', expect.stringContaining('5 site towers'));
  }, T);

  it('filter chips change the counts and are kept in the URL; "late only" and the search too', async () => {
    await signIn('pm');
    useRows();
    page();
    await screen.findByTestId('map-legend-on_air');
    fireEvent.click(screen.getByTestId('map-filter-region'));
    fireEvent.click(await screen.findByTestId('map-opt-region-5'));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('map_region=5'));
    expect(screen.getByTestId('map-count')).toHaveTextContent('2 drawn of 2 sites');
    expect(screen.getByTestId('map-filter-region')).toHaveAccessibleName(/Region: Benghazi/);
    fireEvent.click(screen.getByTestId('map-late'));
    await waitFor(() => expect(screen.getByTestId('map-count')).toHaveTextContent('1 drawn of 1 sites'));
    expect(screen.getByTestId('where')).toHaveTextContent('map_late=1');
    fireEvent.click(screen.getByTestId('map-clear'));
    await waitFor(() => expect(screen.getByTestId('map-count')).toHaveTextContent('5 drawn of 6 sites'));
    fireEvent.change(screen.getByTestId('map-search'), { target: { value: 'MAP-AIR' } });
    await waitFor(() => expect(screen.getByTestId('map-count')).toHaveTextContent('1 drawn of 1 sites'));
  }, T);

  it('the status filter shows cancelled sites in dark grey; the owner filter is labelled "Site owner / Tower owner"', async () => {
    await signIn('pm');
    useRows();
    page('/dashboard?map_status=cancelled');
    expect(await screen.findByTestId('map-legend-cancelled')).toBeInTheDocument();
    expect(screen.getByTestId('map-filter-owner')).toHaveTextContent('Site owner / Tower owner');
  }, T);

  it('a legend click hides that colour (and shows it again); colour by milestone switches the legend', async () => {
    await signIn('pm');
    useRows();
    page();
    fireEvent.click(await screen.findByTestId('map-layout'));
    expect(await screen.findByTestId('map-row-MAP-P1')).toHaveAttribute('data-light', 'progress');
    fireEvent.click(screen.getByTestId('map-legend-stream:CW'));
    await waitFor(() => expect(screen.queryByTestId('map-row-MAP-P1')).toBeNull());
    expect(screen.getByTestId('map-legend-stream:CW')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByTestId('map-legend-stream:CW'));
    expect(await screen.findByTestId('map-row-MAP-P1')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('map-by-milestone'));
    expect(await screen.findByTestId('map-legend-ms:cw')).toHaveTextContent('1');
    expect(screen.queryByTestId('map-legend-stream:CW')).toBeNull();
  }, T);

  it('the list shows On-Air as steady and in-progress as pulsing; with reduced motion nothing pulses', async () => {
    await signIn('pm');
    useRows();
    const v = page();
    fireEvent.click(await screen.findByTestId('map-layout'));
    expect(await screen.findByTestId('map-row-MAP-AIR')).toHaveAttribute('data-light', 'on_air');
    expect(screen.getByTestId('map-row-MAP-AIR')).toHaveAttribute('data-pulse', 'false');
    expect(screen.getByTestId('map-row-MAP-P2')).toHaveAttribute('data-pulse', 'true');
    expect(screen.getByTestId('map-row-MAP-P2')).toHaveAttribute('data-late', 'true');
    v.unmount();
    reduceMotion();
    page();
    fireEvent.click(await screen.findByTestId('map-layout'));
    expect(await screen.findByTestId('map-row-MAP-P2')).toHaveAttribute('data-pulse', 'false');
    expect(screen.getByTestId('map-legend-stream:CW')).toHaveAttribute('data-pulse', 'false');
  }, T);

  it('the site card shows the site information, the current task with its holder and a link to the site page; no personal data', async () => {
    await signIn('pm');
    // a mock site that is in progress with a current milestone
    const i = Array.from({ length: SITE_COUNT }, (_, k) => k).find((k) => { const x = mapItem(k); return x.has_coordinates && x.overall_status === 'in_progress' && !!x.milestone_code && x.milestone_code !== 'site_release'; })!;
    const it0 = mapItem(i);
    page();
    fireEvent.click(await screen.findByTestId('map-layout'));
    fireEvent.click(await screen.findByTestId(`map-open-${it0.site_code}`));
    const card = await screen.findByTestId('map-card');
    expect(card).toHaveTextContent(it0.site_code);
    expect(within(card).getByTestId('card-owner')).toHaveTextContent(it0.tower_owner ?? '—');
    expect(within(card).getByTestId('card-coords')).toHaveTextContent(String(it0.latitude!.toFixed(5)));
    expect(await within(card).findByTestId('card-owner_site_id')).toHaveTextContent(/OWN-/);
    await waitFor(() => expect(within(card).getByTestId('card-tower')).toHaveTextContent(' m'));
    await waitFor(() => expect(within(card).getByTestId('card-task')).not.toHaveTextContent('Loading'));
    expect(within(card).getByTestId('card-open-site')).toHaveAttribute('href', `/sites/${it0.id}`);
    expect(card.textContent).not.toMatch(/landlord|@example\.com|\+218/i);
  }, T);

  it('in Arabic the map, the filters and the legend are in Arabic and right to left', async () => {
    await signIn('pm');
    useRows();
    page('/dashboard', 'ar');
    await screen.findByTestId('map-legend-on_air');
    expect(screen.getByText('المواقع على الخريطة')).toBeInTheDocument();
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByTestId('map-filter-owner')).toHaveTextContent('مالك الموقع / مالك البرج');
    expect(screen.getByTestId('map-legend-on_air')).toHaveTextContent('في الخدمة');
    expect(screen.getByTestId('map-by-milestone')).toHaveTextContent('المرحلة');
  }, T);

  it('the Site Register lists the sites without coordinates (the link of the map) and shows the same map (SC-10)', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/sites" element={<Sites />} /></Routes>, { route: '/sites?coordinates=missing' });
    expect(await screen.findByTestId('chip-coordinates')).toHaveTextContent('Coordinates: missing');
    const missing = Array.from({ length: SITE_COUNT }, (_, k) => k).filter((k) => !hasValidCoords(k)).length;
    await waitFor(() => expect(screen.getByTestId('sites-count')).toHaveTextContent(String(missing)));
    fireEvent.click(screen.getByTestId('sites-layout'));
    expect(await screen.findByTestId('sites-map')).toBeInTheDocument();
    expect(await screen.findByTestId('map-legend-on_air')).toBeInTheDocument();
  }, T);
});
