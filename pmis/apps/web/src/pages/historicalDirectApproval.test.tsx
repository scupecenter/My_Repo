import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, API_BASE, ApiError } from '@/api/client';
import type { HistoricalWaiver } from '@/api/historicalWaiver';
import type { TaskDetail } from '@/api/types';
import { TaskGrid } from '@/components/TaskGrid';
import ar from '@/i18n/ar.json';
import en from '@/i18n/en.json';
import { siteIdOf } from '@/mocks/sites';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { ReconciliationPage } from './Reconciliation';

/**
 * Contract 0.15.11 (owner decision 2026-11-12, "Direct approval"): the option "Approve directly (no L2) — admin override" of the historical load on the Master import
 * apply dialog. Shown only when the historical option is on; it carries a warning; it sends `historical_load.approve_directly`. The task shows the badge.
 */
const stepUpDone = () => api.post('/__mock/step-up');
const openIt = () => api.put<HistoricalWaiver>('/settings/historical-waiver', { body: { open: true, cutoff_date: '2026-02-28', reason: 'One-time load of the Master' } });
const errCode = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => `${e.status}:${e.code}`);
const page = () => renderApp(<Routes><Route path="/templates/master-import" element={<ReconciliationPage />} /></Routes>, { route: '/templates/master-import' });

describe('the Master import apply dialog: approve directly (0.15.11)', () => {
  it('is shown only with the historical option on, warns, and sends approve_directly inside historical_load', async () => {
    await signIn('pm'); await stepUpDone();
    await openIt();
    let body: Record<string, unknown> | null = null;
    const run = await api.get<Record<string, unknown>>('/master-import/runs/run-0001');
    server.use(http.post(`${API_BASE}/master-import/runs/:id/apply`, async ({ request }) => {
      body = await request.json() as Record<string, unknown>;
      return HttpResponse.json({ ...run, status: 'applied', outcome: { approve_directly: true, batches: [{ id: 'b1', approved: 3 }] }, version: 2 });
    }));
    const u = userEvent.setup();
    page();
    await u.click(await screen.findByTestId('mi-run-run-0001'));
    await u.click(await screen.findByTestId('mi-apply'));
    expect(await screen.findByTestId('hl-option')).toBeInTheDocument();
    expect(screen.queryByTestId('mi-approve-directly')).not.toBeInTheDocument();   // not without the historical option
    await u.type(screen.getByTestId('mi-apply-reason'), 'Initial load of the Master');
    await u.click(screen.getByTestId('hl-toggle'));
    await u.type(screen.getByTestId('hl-reason'), 'Historical tasks are final');
    const box = await screen.findByTestId('mi-approve-directly');
    expect(box).not.toBeChecked();
    expect(screen.getByTestId('mi-direct-option')).toHaveTextContent('Approve directly (no L2) — admin override');
    expect(screen.queryByTestId('mi-approve-directly-warn')).not.toBeInTheDocument();
    await u.click(box);
    expect(screen.getByTestId('mi-approve-directly-warn')).toHaveTextContent('no L2 review');
    // turning the historical option off hides the choice and does not send it
    await u.click(screen.getByTestId('hl-toggle'));
    expect(screen.queryByTestId('mi-approve-directly')).not.toBeInTheDocument();
    await u.click(screen.getByTestId('hl-toggle'));
    expect(screen.getByTestId('mi-approve-directly')).toBeChecked();
    await u.click(screen.getByTestId('mi-apply-confirm'));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ mode: 'submit', reason: 'Initial load of the Master',
      historical_load: { reason: 'Historical tasks are final', approve_directly: true } });
  });

  it('without the box ticked, sends the historical option exactly as before', async () => {
    await signIn('pm'); await stepUpDone();
    await openIt();
    let body: Record<string, unknown> | null = null;
    const run = await api.get<Record<string, unknown>>('/master-import/runs/run-0001');
    server.use(http.post(`${API_BASE}/master-import/runs/:id/apply`, async ({ request }) => {
      body = await request.json() as Record<string, unknown>;
      return HttpResponse.json({ ...run, status: 'applied', outcome: { batches: [] }, version: 2 });
    }));
    const u = userEvent.setup();
    page();
    await u.click(await screen.findByTestId('mi-run-run-0001'));
    await u.click(await screen.findByTestId('mi-apply'));
    await u.type(await screen.findByTestId('mi-apply-reason'), 'Initial load of the Master');
    await u.click(await screen.findByTestId('hl-toggle'));
    await u.type(screen.getByTestId('hl-reason'), 'Historical tasks have no documents');
    await u.click(screen.getByTestId('mi-apply-confirm'));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ mode: 'submit', reason: 'Initial load of the Master', historical_load: { reason: 'Historical tasks have no documents' } });
  });

  it('the mock follows the API: approve_directly outside historical_load is refused; inside it the outcome says so', async () => {
    await signIn('pm'); await stepUpDone();
    await openIt();
    const run = await api.get<{ id: string; version: number }>('/master-import/runs/run-0001');
    expect(await errCode(api.post(`/master-import/runs/${run.id}/apply`, { version: run.version, body: { mode: 'submit', reason: 'Initial load', approve_directly: true } }))).toBe('422:validation_failed');
    const ok = await api.post<{ outcome: { approve_directly: boolean } }>(`/master-import/runs/${run.id}/apply`,
      { version: run.version, body: { mode: 'submit', reason: 'Initial load', historical_load: { reason: 'Historical tasks are final', approve_directly: true } } });
    expect(ok.outcome.approve_directly).toBe(true);
  });

  it('shows the "Admin override" badge on a task approved directly, and has its texts in English and Arabic', async () => {
    await signIn('pm');
    const grid = await api.get<{ stages: { tasks: TaskDetail[] }[] }>(`/sites/${siteIdOf(0)}/tasks`);
    const [a] = grid.stages.flatMap((s) => s.tasks);
    renderApp(<TaskGrid siteId={siteIdOf(0)} stages={[{ code: 'MS2', name_en: 'PRE-CW', tasks: [{ ...a!, state: 'approved', historical_direct_approved: true }] }]} selected={null} onVisible={() => undefined} onOpen={() => undefined} />);
    const badge = await screen.findByTestId(`override-${a!.id}`);
    expect(badge).toHaveTextContent('Admin override');
    expect(badge).toHaveAttribute('data-kind', 'historical_direct');
    expect(badge).toHaveAttribute('title', expect.stringContaining('no L2 step'));
    for (const k of ['approve_directly', 'approve_directly_warn', 'approved_directly_toast']) {
      expect((en.mi as Record<string, string>)[k]).toBeTruthy();
      expect((ar.mi as Record<string, string>)[k]).toBeTruthy();
    }
    expect((ar.override as Record<string, string>).direct_title).toBeTruthy();
  });
});
