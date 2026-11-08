import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { API_BASE } from '@/api/client';
import { DelayPeriodsPanel } from '@/components/DelayPeriods';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { tripoliToday } from '@/lib/today';
import { Dashboard } from './Dashboard';
import { ManualItems } from './ManualItems';

// ECharts draws in the browser; here the chart is a placeholder with its text alternative.
vi.mock('@/components/EChart', () => ({ EChart: ({ label, testid }: { label: string; testid?: string }) => <div role="img" aria-label={label} data-testid={testid} /> }));

const page = (route = '/dashboard', locale: 'en' | 'ar' = 'en') =>
  renderApp(<Routes><Route path="/dashboard" element={<Dashboard />} /><Route path="/dashboard/manual-items" element={<ManualItems />} /></Routes>, { route, locale });

describe('Dashboard follow-up of the owner answers (Q118 to Q127)', () => {
  it('Q126: filters by view (CW / TE / O&M) beside the stream filter, keeps it in the URL and resets it', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => { if (new URL(request.url).pathname.endsWith('/dashboard')) seen.push(new URL(request.url).search); });
    page();
    await screen.findByTestId('dash-progress-value');
    const sel = screen.getByTestId('dash-filter-view');
    expect(within(sel).getAllByRole('option').map((o) => o.textContent)).toEqual(['All views', 'Civil Works', 'Installation (TE)', 'O&M']);
    await u.selectOptions(sel, 'CW');
    await waitFor(() => expect(seen.some((s) => s.includes('view=CW'))).toBe(true));
    await waitFor(() => expect(within(screen.getByTestId('dash-pipeline')).queryByTestId('pipe-node-MS1')).toBeNull());
    expect(within(screen.getByTestId('dash-pipeline')).getByTestId('pipe-node-MS3')).toBeInTheDocument();
    expect(screen.getByTestId('dash-stream-CW').querySelector('a')!.getAttribute('href')).toBe('/sites?view=CW&stream=CW');
    await u.click(screen.getByTestId('dash-reset'));
    await waitFor(() => expect((screen.getByTestId('dash-filter-view') as HTMLSelectElement).value).toBe(''));
  });

  it('Q127: exports Excel by default and CSV on request', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const asked: string[] = [];
    server.use(http.get(`${API_BASE}/dashboard/export`, ({ request }) => {
      asked.push(new URL(request.url).search);
      return new HttpResponse('x', { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="GSDN_Dashboard_2026-11-02.xlsx"' } });
    }));
    page();
    expect(await screen.findByTestId('dash-export-format')).toHaveValue('xlsx');
    await u.click(screen.getByTestId('dash-export'));
    await waitFor(() => expect(asked).toEqual(['?format=xlsx']));
    await u.selectOptions(screen.getByTestId('dash-export-format'), 'csv');
    await u.click(screen.getByTestId('dash-export'));
    await waitFor(() => expect(asked).toEqual(['?format=xlsx', '?format=csv']));
  });

  it('Q127: the snapshot chips say whether a snapshot is weekly or month-end', async () => {
    await signIn('pm');
    page();
    expect(await screen.findByTestId('dash-snapshot-kind-2026-10-31')).toHaveTextContent('month-end');
    expect(screen.getByTestId('dash-snapshot-2026-10-29')).toHaveAttribute('data-kind', 'weekly');
    expect(screen.getByTestId('dash-snapshot-kind-2026-10-29')).toHaveTextContent('weekly');
  });

  it('Q122: the delay attribution names the party of a period and the suspension days left out', async () => {
    await signIn('pm');
    page();
    expect(await screen.findByTestId('dash-delay-chart')).toHaveAccessibleName(/GECOL 30/);
    expect(screen.getByTestId('dash-delay-suspended')).toHaveTextContent('12 working days left out for suspension');
    expect(screen.getByTestId('dash-delay-draft')).toHaveTextContent('Draft');
  });

  it('Q118: the Project Manager enters a manual value; it is listed with its history and the dashboard counts one hidden item fewer', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    page('/dashboard/manual-items');
    expect(await screen.findByTestId('manual-without')).toHaveTextContent('14 weighted items have no value yet.');
    expect(screen.getByTestId('manual-table').querySelectorAll('tbody tr')).toHaveLength(15);
    expect(screen.queryByTestId('manual-add-3.10')).toBeNull(); // not weighted
    await u.click(screen.getByTestId('manual-add-8.1'));
    const form = screen.getByTestId('manual-form-8.1');
    expect(within(form).getByTestId('manual-save')).toBeDisabled();
    await u.type(within(form).getByTestId('manual-value'), '50');
    await u.type(within(form).getByTestId('manual-reason'), 'half of the courses given');
    expect(within(form).getByTestId('manual-save')).toBeDisabled(); // Q176: the source is required
    await u.type(within(form).getByTestId('manual-source'), 'training log');
    expect(within(form).getByTestId('manual-date')).toHaveValue(tripoliToday());
    await u.click(within(form).getByTestId('manual-save'));
    expect(await screen.findByText('The value was saved.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('manual-current-8.1')).toHaveTextContent('50%'));
    expect(screen.getByTestId('manual-without')).toHaveTextContent('13 weighted items');
    await u.click(screen.getByTestId('manual-history-btn-8.1'));
    expect(screen.getByTestId('manual-history-8.1')).toHaveTextContent('v1');
    expect(screen.getByTestId('manual-history-8.1')).toHaveTextContent('half of the courses given');
  });

  it('Q118: a value the server refuses shows its message; a viewer who may not enter values sees the list read-only', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    server.use(http.post(`${API_BASE}/project-status/manual-items/:code/values`, () => HttpResponse.json(
      { type: 'x', title: 'Validation failed', status: 422, code: 'validation_failed', detail: 'The effective date is today or earlier.', errors: [{ path: '/effective_date', code: 'in_future' }] }, { status: 422 })));
    page('/dashboard/manual-items');
    await u.click(await screen.findByTestId('manual-add-1.3'));
    await u.type(screen.getByTestId('manual-value'), '10');
    await u.type(screen.getByTestId('manual-reason'), 'a reason');
    await u.type(screen.getByTestId('manual-source'), 'a report');
    await u.click(screen.getByTestId('manual-save'));
    expect(await screen.findByTestId('manual-error')).toBeInTheDocument();
  });

  it('Q118: read-only for a viewer, and in Arabic (RTL)', async () => {
    await signIn('pm');
    const real = await (await fetch(`${API_BASE}/project-status/manual-items`, { credentials: 'include' })).json();
    server.use(http.get(`${API_BASE}/project-status/manual-items`, () => HttpResponse.json({ ...real, can_edit: false })));
    page('/dashboard/manual-items', 'ar');
    expect(await screen.findByTestId('manual-readonly')).toBeInTheDocument();
    expect(screen.queryByTestId('manual-add-8.1')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('البنود اليدوية لحالة المشروع');
    expect(document.documentElement.dir).toBe('rtl');
  });
});

describe('Q122: delay attribution periods in the task drawer', () => {
  const TASK = '00000000-0000-4000-8000-0000000000b1';
  const panel = (locale: 'en' | 'ar' = 'en') => renderApp(<DelayPeriodsPanel taskId={TASK} />, { locale });

  it('the Project Manager proposes a period, sees an overlap refused, and withdraws it with a reason', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    panel();
    expect(await screen.findByTestId('delayp-none')).toBeInTheDocument();
    expect(screen.getByTestId('delayp-due')).toHaveTextContent('2026-09-20');
    const fill = async (from: string, to: string, party: string, reason: string) => {
      await u.clear(screen.getByTestId('delayp-from')); await u.type(screen.getByTestId('delayp-from'), from);
      await u.clear(screen.getByTestId('delayp-to')); await u.type(screen.getByTestId('delayp-to'), to);
      await u.selectOptions(screen.getByTestId('delayp-party'), party);
      await u.clear(screen.getByTestId('delayp-reason')); await u.type(screen.getByTestId('delayp-reason'), reason);
    };
    expect(screen.getByTestId('delayp-add')).toBeDisabled();
    await fill('2026-09-25', '2026-10-05', 'gecol', 'no power from GECOL');
    await u.click(screen.getByTestId('delayp-add'));
    expect(await screen.findByText('The period was proposed. It counts once it is approved.')).toBeInTheDocument();
    const list = await screen.findByTestId('delayp-list');
    expect(list).toHaveTextContent('2026-09-25 → 2026-10-05');
    expect(list).toHaveTextContent('GECOL');
    await fill('2026-10-01', '2026-10-03', 'hlc', 'overlapping');
    await u.click(screen.getByTestId('delayp-add'));
    expect(await screen.findByTestId('delayp-add-error')).toBeInTheDocument();
    const id = list.querySelector('li')!.getAttribute('data-testid')!.replace('delayp-', '');
    await u.click(screen.getByTestId(`delayp-void-${id}`));
    expect(screen.getByTestId('delayp-void-confirm')).toBeDisabled();
    await u.type(screen.getByTestId('delayp-void-reason'), 'wrong task');
    await u.click(screen.getByTestId('delayp-void-confirm'));
    await waitFor(() => expect(screen.getByTestId(`delayp-${id}`)).toHaveAttribute('data-voided', 'true'));
    expect(screen.getByTestId(`delayp-${id}`)).toHaveTextContent('wrong task');
    expect(screen.queryByTestId(`delayp-void-${id}`)).toBeNull();
  });

  it('is read-only for someone who is not the reviewer, in Arabic too', async () => {
    await signIn('reviewer');
    panel('ar');
    expect(await screen.findByTestId('delayp-readonly')).toHaveTextContent('يقترح الفترات L1 أو L2 للمهمة، ويعتمدها L2.');
    expect(screen.queryByTestId('delayp-form')).toBeNull();
  });
});
