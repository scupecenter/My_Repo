import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api, API_BASE } from '@/api/client';
import { DelayPeriodsPanel } from '@/components/DelayPeriods';
import { tripoliToday } from '@/lib/today';
import { planPct } from '@/mocks/handlers.dashboard';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { Dashboard } from './Dashboard';
import { ManualItems } from './ManualItems';

// ECharts draws in the browser; here the chart is a placeholder with its text alternative.
vi.mock('@/components/EChart', () => ({ EChart: ({ label, testid }: { label: string; testid?: string }) => <div role="img" aria-label={label} data-testid={testid} /> }));

const page = (route = '/dashboard', locale: 'en' | 'ar' = 'en') =>
  renderApp(<Routes><Route path="/dashboard" element={<Dashboard />} /><Route path="/dashboard/manual-items" element={<ManualItems />} /></Routes>, { route, locale });

/** Work package P2 of the owner answers of 2026-11-04 (contract 0.12.7). */
describe('Dashboard P2 (owner answers of 2026-11-04)', () => {
  it('D16: the draft label sits on the factors not yet approved only (every factor except D and I)', async () => {
    await signIn('pm');
    page();
    await screen.findByTestId('dash-health-components');
    for (const c of ['P', 'B', 'S', 'F']) expect(screen.getByTestId(`dash-health-draft-${c}`)).toHaveTextContent('Draft');
    for (const c of ['D', 'I']) expect(screen.queryByTestId(`dash-health-draft-${c}`)).toBeNull();
    expect(screen.getByTestId('dash-health-draft-note')).toBeInTheDocument();
    expect(screen.queryByTestId('dash-health-draft')).toBeNull(); // no label on the index itself (Q121)
  });

  it('Q116: shows the style in force (A, rings) and previews B, the flat segmented track, without changing the setting', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    page();
    const card = await screen.findByTestId('dash-pipeline');
    await waitFor(() => expect(within(card).getByTestId('pipeline')).toHaveAttribute('data-variant', 'A'));
    expect(screen.getByTestId('dash-pipe-variant-A')).toHaveAttribute('aria-checked', 'true');
    await u.click(screen.getByTestId('dash-pipe-variant-B'));
    expect(within(card).getByTestId('pipeline')).toHaveAttribute('data-variant', 'B');
    expect(within(card).getByTestId('pipe-track-b')).toBeInTheDocument();
    expect(screen.getByTestId('dash-pipe-preview-note')).toHaveTextContent('The style in force is A');
    // the state is said in words with a sign, not by colour alone, and every node keeps its counts and its link
    const ms1 = within(card).getByTestId('pipe-node-MS1');
    expect(ms1).toHaveAttribute('data-state');
    expect(ms1.textContent).toMatch(/[✓●!○–]/);
    expect(within(card).getByTestId('dash-node-MS6').textContent).toMatch(/\d+\/\d+/);
    await u.click(screen.getByTestId('dash-pipe-variant-A'));
    expect(within(card).getByTestId('pipeline')).toHaveAttribute('data-variant', 'A');
    expect(screen.queryByTestId('dash-pipe-preview-note')).toBeNull();
  });

  it('Q116: the setting chosen by the admin decides the default; variant B renders in Arabic (RTL)', async () => {
    await signIn('pm');
    await api.put('/dashboard/pipeline-variant', { body: { variant: 'B', reason: 'the owner picked B' } });
    page('/dashboard', 'ar');
    const card = await screen.findByTestId('dash-pipeline');
    await waitFor(() => expect(within(card).getByTestId('pipeline')).toHaveAttribute('data-variant', 'B'));
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByTestId('dash-pipe-variant-B')).toHaveTextContent('ب: المسار المقسّم');
    expect(within(card).getByTestId('pipe-node-MS1')).toHaveTextContent('إطلاق الموقع');
  });

  it('Q186: a rebuilt snapshot shows blocked gates as historically unavailable, not 0; one taken on its date gives the count', async () => {
    await signIn('pm');
    page('/dashboard?ref_date=2026-10-22');
    const gates = await screen.findByTestId('dash-gates-unavailable');
    await waitFor(() => expect(gates).toHaveAttribute('data-status', 'historically_unavailable'));
    expect(gates).toHaveTextContent('Historically unavailable');
    expect(screen.getByTestId('dash-gates-total')).toHaveTextContent('–');
    expect(screen.getByTestId('dash-node-blocked-unknown-MS5')).toHaveTextContent('historically unavailable');
  });

  it('Q186: a snapshot taken on its own date keeps the count, without reasons', async () => {
    await signIn('pm');
    page('/dashboard?ref_date=2026-10-29');
    const gates = await screen.findByTestId('dash-gates-unavailable');
    await waitFor(() => expect(gates).toHaveAttribute('data-status', 'snapshot'));
    expect(gates).toHaveTextContent('1 blocked');
  });

  it('Q7, Q181: uncovered days are unattributed with the R party as a suggestion only; the shares and the data gap are said', async () => {
    await signIn('pm');
    page();
    const chart = await screen.findByTestId('dash-delay-chart');
    expect(chart).toHaveAccessibleName(/GECOL 30/);
    expect(chart).toHaveAccessibleName(/Unattributed \(suggested: A&T Global\) 190/);
    expect(chart).toHaveAccessibleName(/Unattributed \(suggested: CW contractor\) 98/);
    expect(screen.getByTestId('dash-delay-total')).toHaveTextContent('412 overdue working days in total: 7.28% attributed by approved periods, 92.72% unattributed.');
    expect(screen.getByTestId('dash-delay-proposed')).toHaveTextContent('9 working days');
    expect(screen.getByTestId('dash-delay-gap')).toHaveTextContent('6 working days are a data gap.');
  });

  it('Q175: a regional view shows the manual values on a separate central line, outside its figure', async () => {
    await signIn('pm');
    await api.post('/project-status/manual-items/8.1/values', { body: { value_pct: 40, effective_date: tripoliToday(), reason: 'training started', source: 'training log' } });
    const u = userEvent.setup();
    page();
    await screen.findByTestId('dash-progress-value');
    expect(screen.queryByTestId('dash-central-line')).toBeNull(); // project-wide: the value is in the figure
    await u.selectOptions(screen.getByTestId('dash-filter-region'), '1');
    expect(await screen.findByTestId('dash-central-line')).toHaveTextContent('1 of 14 have a value');
    expect(screen.getByTestId('dash-central-line')).toHaveTextContent('their weighted progress 40%');
  });

  it('Q177: the label is "progress vs plan index" and the partial index is shown with its coverage while Planned is not available', async () => {
    await signIn('pm');
    page();
    expect(await screen.findByTestId('dash-spi')).toHaveTextContent('Progress vs plan index: not available');
    expect(screen.getByTestId('dash-spi')).toHaveAttribute('title', expect.stringMatching(/not an EVM SPI/));
    expect(screen.getByTestId('dash-partial-index')).toHaveTextContent('Partial index 0.912 over 42% of the weight');
  });
});

describe('Manual items P2 (Q176 to Q178)', () => {
  it('Q177: the Project Manager sets a plan by target date; falling points cannot be saved', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    page('/dashboard/manual-items');
    expect(await screen.findByTestId('manual-without-plan')).toHaveTextContent('14 weighted items have no plan yet');
    expect(screen.getByTestId('manual-plan-8.1')).toHaveTextContent('No plan yet');
    await u.click(screen.getByTestId('plan-add-8.1'));
    const form = screen.getByTestId('plan-form-8.1');
    await u.click(within(form).getByTestId('plan-mode-points'));
    await u.type(within(form).getByTestId('plan-point-date-0'), '2026-01-01');
    await u.type(within(form).getByTestId('plan-point-pct-0'), '50');
    await u.click(within(form).getByTestId('plan-add-point'));
    await u.type(within(form).getByTestId('plan-point-date-1'), '2026-02-01');
    await u.type(within(form).getByTestId('plan-point-pct-1'), '40');
    await u.type(within(form).getByTestId('plan-reason'), 'falls');
    await u.type(within(form).getByTestId('plan-source'), 'plan');
    expect(within(form).getByTestId('plan-save')).toBeDisabled(); // a plan is cumulative
    await u.click(within(form).getByTestId('plan-mode-target'));
    await u.type(within(form).getByTestId('plan-start'), '2026-01-01');
    await u.type(within(form).getByTestId('plan-target'), '2036-01-01');
    await u.click(within(form).getByTestId('plan-save'));
    expect(await screen.findByText('The plan was saved.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('manual-plan-8.1')).toHaveTextContent('v1'));
    expect(screen.getByTestId('manual-plan-8.1')).toHaveTextContent('2026-01-01 0% → 2036-01-01 100%');
    expect(screen.getByTestId('manual-without-plan')).toHaveTextContent('13 weighted items');
  });

  it('Q177: the planned % of a plan follows the rule of the database (fixed dates)', () => {
    const pts = [{ date: '2026-01-01', planned_pct: 0 }, { date: '2026-01-31', planned_pct: 60 }, { date: '2026-03-01', planned_pct: 100 }];
    expect(planPct(pts, '2025-12-31')).toBe(0);
    expect(planPct(pts, '2026-01-16')).toBe(30);
    expect(planPct(pts, '2026-02-15')).toBeCloseTo(80.69, 2);
    expect(planPct(pts, '2027-01-01')).toBe(100);
  });

  it('Q176, Q178: the source is required, a closed month is not offered without the correction right, and corrections are flagged', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const first = `${tripoliToday().slice(0, 7)}-01`;
    const real = await (await fetch(`${API_BASE}/project-status/manual-items`, { credentials: 'include' })).json();
    server.use(http.get(`${API_BASE}/project-status/manual-items`, () => HttpResponse.json({ ...real, can_correct_history: false })));
    page('/dashboard/manual-items');
    await u.click(await screen.findByTestId('manual-add-1.3'));
    const form = screen.getByTestId('manual-form-1.3');
    expect(within(form).getByTestId('manual-date')).toHaveAttribute('min', first);
    expect(within(form).getByTestId('manual-closed-month')).toHaveTextContent(`Dates before ${first} correct a closed month`);
    await u.type(within(form).getByTestId('manual-value'), '10');
    await u.type(within(form).getByTestId('manual-reason'), 'a reason');
    expect(within(form).getByTestId('manual-save')).toBeDisabled();
    await u.type(within(form).getByTestId('manual-source'), 'design log');
    expect(within(form).getByTestId('manual-save')).toBeEnabled();
  });

  it('Q178: a correction entered by the admin is flagged in the history, in Arabic too', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    await api.post('/project-status/manual-items/1.5/values', { body: { value_pct: 10, effective_date: '2026-01-15', reason: 'missed in January', source: 'monthly report' } });
    page('/dashboard/manual-items', 'ar');
    await u.click(await screen.findByTestId('manual-history-btn-1.5'));
    const h = screen.getByTestId('manual-history-1.5');
    expect(h).toHaveTextContent('تصحيح تاريخي');
    expect(h).toHaveTextContent('monthly report');
  });
});

describe('Delay periods P2 (Q182, Q184)', () => {
  const TASK = '00000000-0000-4000-8000-0000000000b2';
  const panel = (locale: 'en' | 'ar' = 'en') => renderApp(<DelayPeriodsPanel taskId={TASK} />, { locale });

  it('L1 proposes (with evidence); L2 must name the contractor to approve; the proposer does not decide', async () => {
    await signIn('engineer');
    const u = userEvent.setup();
    const first = panel();
    expect(await screen.findByTestId('delayp-form')).toBeInTheDocument();
    await u.type(screen.getByTestId('delayp-from'), '2026-09-25');
    await u.type(screen.getByTestId('delayp-to'), '2026-10-05');
    await u.selectOptions(screen.getByTestId('delayp-party'), 'contractor');
    await u.type(screen.getByTestId('delayp-reason'), 'crew not on site');
    await u.type(screen.getByTestId('delayp-evidence'), 'site diary p. 12');
    await u.click(screen.getByTestId('delayp-add'));
    expect(await screen.findByText('The period was proposed. It counts once it is approved.')).toBeInTheDocument();
    const li = (await screen.findByTestId('delayp-list')).querySelector('li')!;
    const id = li.getAttribute('data-testid')!.replace('delayp-', '');
    expect(screen.getByTestId(`delayp-status-${id}`)).toHaveTextContent('Proposed');
    expect(li).toHaveTextContent('site diary p. 12');
    expect(screen.queryByTestId(`delayp-decide-${id}`)).toBeNull(); // L1 does not decide
    first.unmount();

    await signIn('pm');
    panel();
    const box = await screen.findByTestId(`delayp-decide-${id}`);
    expect(within(box).getByTestId('delayp-approve')).toBeDisabled(); // the contractor must be named (Q184)
    expect(within(box).getByTestId('delayp-reject')).toBeDisabled();  // a rejection needs a note
    await u.selectOptions(within(box).getByTestId('delayp-decide-party'), 'Sahara Civil Works');
    await u.click(within(box).getByTestId('delayp-approve'));
    expect(await screen.findByText('The period was approved.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId(`delayp-status-${id}`)).toHaveTextContent('Approved'));
    expect(screen.getByTestId(`delayp-${id}`)).toHaveTextContent('Sahara Civil Works');
  });

  it('the decider rejects with a note; their own proposal says someone else decides; read-only in Arabic for a viewer', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const own = await api.post<{ id: string }>(`/tasks/${TASK}/delay-periods`, { body: { from_date: '2026-10-10', to_date: '2026-10-12', party: 'gecol', reason: 'no power' } });
    const r = panel();
    expect(await screen.findByTestId(`delayp-own-${own.id}`)).toHaveTextContent('You proposed it: someone else decides.');
    r.unmount();
    await signIn('engineer');
    const other = await api.post<{ id: string }>(`/tasks/${TASK}/delay-periods`, { body: { from_date: '2026-10-14', to_date: '2026-10-15', party: 'hlc', reason: 'no fiber' } });
    await signIn('pm');
    const r2 = panel();
    const box = await screen.findByTestId(`delayp-decide-${other.id}`);
    await u.type(within(box).getByTestId('delayp-decide-note'), 'the link was ready');
    await u.click(within(box).getByTestId('delayp-reject'));
    await waitFor(() => expect(screen.getByTestId(`delayp-${other.id}`)).toHaveAttribute('data-status', 'rejected'));
    expect(screen.getByTestId(`delayp-${other.id}`)).toHaveTextContent('the link was ready');
    expect(screen.queryByTestId(`delayp-void-${other.id}`)).toBeNull(); // a rejected period stays as it is
    r2.unmount();
    await signIn('reviewer');
    panel('ar');
    expect(await screen.findByTestId('delayp-readonly')).toHaveTextContent('يقترح الفترات L1 أو L2 للمهمة، ويعتمدها L2.');
    expect(screen.getByTestId(`delayp-status-${other.id}`)).toHaveTextContent('مرفوضة');
  });
});
