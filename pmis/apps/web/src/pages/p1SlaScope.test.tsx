import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, ApiError } from '@/api/client';
import type { SiteApplicability } from '@/api/scenario';
import type { SiteTasks } from '@/api/types';
import { TaskGrid } from '@/components/TaskGrid';
import { siteIdOf } from '@/mocks/sites';
import { renderApp, signIn } from '@/test/utils';
import { Site } from './Site';
import { SettingsRoutes } from './settings/Settings';

/** Contract 0.12.0 (P1, migration 0052): scope by scenario (Q15, Q3), the Swap D-1 exclusion (Q2), the gate history (Q9), Pending SLA Confirmation (Q135) and the tentative-date badge (D4b). */
const SiteAt = () => <Routes><Route path="/sites/:siteId" element={<Site />} /></Routes>;
// site 3 is a Cold Swap with GECOL = Yes in the mock (the Q3 conflict); site 2 is a Hot Swap without it; site 1 has a gate history
const CONFLICT = siteIdOf(3), SWAP = siteIdOf(2), HISTORY = siteIdOf(1);
const errCode = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => `${e.status}:${e.code}`);
const stepUpDone = () => api.post('/__mock/step-up');

describe('Q15 and Q3: the Scope section of a site', () => {
  it('shows the Site RFI decision beside the Master formula and blocks applying while the scenario and the flags disagree', async () => {
    await signIn('pm');
    renderApp(<SiteAt />, { route: `/sites/${CONFLICT}?tab=scope` });
    expect(await screen.findByTestId('site-scope')).toBeInTheDocument();
    expect(screen.getByTestId('site-section-scope')).toHaveTextContent('Scope');
    expect(screen.getByTestId('scope-rfi-applies')).toHaveTextContent('N/A');
    expect(screen.getByTestId('scope-rfi-master')).toHaveTextContent('Applies');
    expect(screen.getByTestId('scope-rfi-differs')).toBeInTheDocument();
    expect(screen.getByTestId('scope-conflict-MS4')).toHaveTextContent(/Cold Swap/);
    expect(screen.getByTestId('scope-apply')).toBeDisabled();
    expect(screen.getByTestId('scope-task-A1')).toHaveAttribute('data-applies', 'false');
    expect(within(screen.getByTestId('scope-task-D1')).getByText('SLA not measured')).toBeInTheDocument();
    await stepUpDone();
    expect(await errCode(api.post(`/sites/${CONFLICT}/applicability/apply`, { body: { reason: 'scope reviewed' } }))).toBe('422:scope_scenario_conflict');
  });

  it('approves a scope exception with a reason and a step-up, which resolves the conflict', async () => {
    await signIn('pm'); await stepUpDone();
    const u = userEvent.setup();
    renderApp(<SiteAt />, { route: `/sites/${CONFLICT}?tab=scope` });
    await u.click(await screen.findByTestId('scope-exception-MS4'));
    await u.type(screen.getByTestId('scope-exc-dlg-reason'), 'GECOL power is needed on this Swap');
    await u.click(screen.getByTestId('scope-exc-dlg-submit'));
    await waitFor(() => expect(screen.queryByTestId('scope-conflicts')).not.toBeInTheDocument());
    expect(screen.getByTestId('scope-rfi-applies')).toHaveTextContent('Applies');
    expect(screen.getByTestId('scope-apply')).toBeEnabled();
    const a = await api.get<SiteApplicability>(`/sites/${CONFLICT}/applicability`);
    expect(a.exceptions[0]).toMatchObject({ task_code: 'MS4', reason: 'GECOL power is needed on this Swap', revoked_at: null });
    expect(screen.getByTestId(`scope-revoke-${a.exceptions[0]!.id}`)).toBeInTheDocument();
  });

  it('applies the scope of a Hot Swap and says how many tasks changed', async () => {
    await signIn('pm'); await stepUpDone();
    const u = userEvent.setup();
    renderApp(<SiteAt />, { route: `/sites/${SWAP}?tab=scope` });
    await u.click(await screen.findByTestId('scope-apply'));
    await u.type(screen.getByTestId('scope-apply-dlg-reason'), 'scope reviewed with the PM');
    await u.click(screen.getByTestId('scope-apply-dlg-submit'));
    expect(await screen.findByText(/task\(s\) changed/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('scope-apply-dlg')).not.toBeInTheDocument());
  });

  it('shows the gate history (Q9), an earlier opening kept after a closing', async () => {
    await signIn('pm');
    renderApp(<SiteAt />, { route: `/sites/${HISTORY}?tab=scope` });
    const list = await screen.findByTestId('gate-history');
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(3));
    expect(within(list).getAllByRole('listitem').map((x) => x.getAttribute('data-event'))).toEqual(['opened', 'closed', 'opened']);
    expect(list).toHaveTextContent('moved by a suspension');
  });

  it('is in Arabic in the Arabic interface', async () => {
    await signIn('pm');
    renderApp(<SiteAt />, { route: `/sites/${CONFLICT}?tab=scope`, locale: 'ar' });
    expect(await screen.findByTestId('site-scope')).toBeInTheDocument();
    expect(screen.getByTestId('site-section-scope')).toHaveTextContent('النطاق');
    expect(screen.getByTestId('scope-apply')).toHaveTextContent('تطبيق النطاق');
    expect(screen.getByText('سجل البوابات')).toBeInTheDocument();
  });
});

describe('Q2, Q135, D4b: SLA badges on the task grid', () => {
  it('marks D-1 not measured on a Swap and a tentative due date, and C-3 Pending SLA Confirmation', async () => {
    await signIn('pm');
    const grid = await api.get<SiteTasks>(`/sites/${SWAP}/tasks`);
    const tasks = grid.stages.flatMap((s) => s.tasks);
    const d1 = tasks.find((t) => t.task_code === 'D1')!;
    expect(d1.sla).toMatchObject({ measured: false });
    const tent = tasks.find((t) => t.sla?.due_date_tentative && t.sla.max_wd != null && t.sla.measured !== false);
    expect(tent).toBeDefined();
    renderApp(<TaskGrid siteId={SWAP} stages={[{ code: 'MS5', name_en: 'TE', tasks: [d1, tent!] }]} selected={null} onVisible={() => undefined} onOpen={() => undefined} />);
    expect(await screen.findByTestId(`sla-not-measured-${d1.id}`)).toHaveTextContent('SLA not measured');
    expect(screen.getByTestId(`sla-tentative-${tent!.id}`)).toHaveTextContent('Tentative date');
    expect(screen.getByTestId(`sla-tentative-${tent!.id}`)).toHaveAttribute('title', expect.stringContaining(tent!.sla!.tentative_holidays![0]!));
  });

  it('shows Pending SLA Confirmation on a task whose rule waits for the owner (Q135)', async () => {
    await signIn('pm');
    const grid = await api.get<SiteTasks>(`/sites/${siteIdOf(0)}/tasks`);
    expect(grid.stages.flatMap((s) => s.tasks).every((t) => t.sla?.pending_confirmation === (t.task_code === 'C3'))).toBe(true);
    const base = grid.stages.flatMap((s) => s.tasks).find((t) => t.sla?.max_wd != null)!;
    const c3 = { ...base, id: 'c3-synthetic', task_code: 'C3', sla: { ...base.sla!, pending_confirmation: true, due_date_tentative: false, tentative_holidays: [] } };
    renderApp(<TaskGrid siteId={siteIdOf(0)} stages={[{ code: 'MS4', name_en: 'Site RFI', tasks: [c3] }]} selected={null} onVisible={() => undefined} onOpen={() => undefined} />, { locale: 'ar' });
    expect(await screen.findByTestId('sla-pending-c3-synthetic')).toHaveTextContent('بانتظار تأكيد SLA');
  });
});

describe('Q4 and Q13, Q136, Q135 in Settings', () => {
  it('shows the official-calendar banner while the calendar is not confirmed', async () => {
    await signIn('pm');
    const r = await api.get<{ summary: { official_calendar_pending?: boolean } }>('/settings/holidays');
    expect(r.summary.official_calendar_pending).toBe(true);
    renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/calendar' });
    expect(await screen.findByTestId('cal-banner-official')).toHaveTextContent(/tentative date/);
  });

  it('lists the 45 SLA sheet columns with B-10a and B-10b on B10 and B-6 inherited, and the scenario rules with an ETag', async () => {
    await signIn('pm');
    const cols = await api.get<{ items: { sla_code: string; task_code: string | null; inherited: boolean }[] }>('/settings/sla-master-columns');
    expect(cols.items).toHaveLength(45);
    expect(cols.items.filter((c) => c.task_code === 'B10').map((c) => c.sla_code)).toEqual(['B-10a', 'B-10b']);
    expect(cols.items.filter((c) => c.inherited).map((c) => c.sla_code)).toEqual(['B-6']);
    const rules = await api.get<{ version: number; items: { task_code: string; scenario: string | null; rule: string }[] }>('/settings/scenario-rules');
    expect(rules.items).toEqual(expect.arrayContaining([expect.objectContaining({ task_code: 'D1', scenario: 'hot_swap', rule: 'sla_not_measured' })]));
    expect(await errCode(api.put('/settings/scenario-rules', { body: { reason: 'x', rules: rules.items } }))).toBe('428:precondition_required');
  });
});
