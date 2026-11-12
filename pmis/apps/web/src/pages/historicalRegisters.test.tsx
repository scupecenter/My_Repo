import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, API_BASE, ApiError } from '@/api/client';
import type { HistoricalWaiver } from '@/api/historicalWaiver';
import ar from '@/i18n/ar.json';
import en from '@/i18n/en.json';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { ReconciliationPage } from './Reconciliation';

/**
 * Contract 0.15.7 (owner decision 2026-11-12, "Everything from the one file"): the option "Also load the register sheets" of the historical load on the Master
 * import apply dialog sends `historical_load.registers`; the applied run lists its register batches with their counts and the sheets it skipped.
 */
const stepUpDone = () => api.post('/__mock/step-up');
const openIt = () => api.put<HistoricalWaiver>('/settings/historical-waiver', { body: { open: true, cutoff_date: '2026-02-28', reason: 'One-time load of the Master' } });
const errCode = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => `${e.status}:${e.code}`);
const page = () => renderApp(<Routes><Route path="/templates/master-import" element={<ReconciliationPage />} /></Routes>, { route: '/templates/master-import' });

describe('the Master import apply dialog: the register sheets (0.15.7)', () => {
  it('is offered only with the historical option, sends registers inside historical_load, and the run lists the register batches', async () => {
    await signIn('pm'); await stepUpDone();
    await openIt();
    let body: Record<string, unknown> | null = null;
    const run = await api.get<Record<string, unknown>>('/master-import/runs/run-0001');
    const outcome = { approve_directly: true, registers: true, batches: [
      { id: 'b1', kind: 'stream', sheet: 'Master', ref: 'CW', rows: 4, approved: 3, errors: 0, skipped: 1 },
      { id: 'b2', kind: 'register', sheet: 'RF & Design', ref: 'rf_design', rows: 3, approved: 2, errors: 1, skipped: 0 },
    ], skipped: [{ sheet: 'GECOL', kind: 'register', ref: 'gecol', reason: 'sheet_missing', detail: 'The file has no sheet "GECOL".' }] };
    server.use(
      http.post(`${API_BASE}/master-import/runs/:id/apply`, async ({ request }) => {
        body = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ ...run, status: 'applied', outcome, version: 2 });
      }),
      http.get(`${API_BASE}/master-import/runs/run-0001`, () => (body ? HttpResponse.json({ ...run, status: 'applied', outcome, version: 2 }) : HttpResponse.json(run))),
    );
    const u = userEvent.setup();
    page();
    await u.click(await screen.findByTestId('mi-run-run-0001'));
    await u.click(await screen.findByTestId('mi-apply'));
    await u.type(await screen.findByTestId('mi-apply-reason'), 'Initial load of the Master');
    expect(screen.queryByTestId('mi-load-registers')).not.toBeInTheDocument();   // not without the historical option
    await u.click(screen.getByTestId('hl-toggle'));
    await u.type(screen.getByTestId('hl-reason'), 'Historical data is final');
    const box = await screen.findByTestId('mi-load-registers');
    expect(box).not.toBeChecked();
    expect(screen.getByTestId('mi-direct-option')).toHaveTextContent('Also load the register sheets (RF & Design, Acquisition, Permission Log, PR-PO, GECOL, HLC, As-Built, Risk Register)');
    await u.click(box);
    expect(screen.getByTestId('mi-load-registers-note')).toHaveTextContent('never read');
    await u.click(screen.getByTestId('mi-approve-directly'));
    await u.click(screen.getByTestId('mi-apply-confirm'));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ mode: 'submit', reason: 'Initial load of the Master',
      historical_load: { reason: 'Historical data is final', approve_directly: true, registers: true } });
    const out = await screen.findByTestId('mi-outcome');
    const rf = within(out).getByTestId('mi-outcome-rf_design');
    expect(rf).toHaveTextContent('Register sheet: RF & Design');
    expect(rf).toHaveTextContent('3' + '2' + '1' + '0');
    expect(within(out).getByTestId('mi-outcome-stream-CW')).toHaveTextContent('Master sheet: CW');
    expect(within(out).getByTestId('mi-outcome-skipped')).toHaveTextContent('GECOL was not loaded: The file has no sheet "GECOL".');
  });

  it('the mock follows the API: registers outside historical_load is refused; inside it the outcome lists the register batches', async () => {
    await signIn('pm'); await stepUpDone();
    await openIt();
    const run = await api.get<{ id: string; version: number }>('/master-import/runs/run-0001');
    expect(await errCode(api.post(`/master-import/runs/${run.id}/apply`, { version: run.version, body: { mode: 'submit', reason: 'Initial load', registers: true } }))).toBe('422:validation_failed');
    const ok = await api.post<{ outcome: { registers: boolean; batches: { kind?: string; ref: string }[]; skipped: { reason: string }[] } }>(`/master-import/runs/${run.id}/apply`,
      { version: run.version, body: { mode: 'submit', reason: 'Initial load', historical_load: { reason: 'Historical data is final', registers: true } } });
    expect(ok.outcome.registers).toBe(true);
    expect(ok.outcome.batches.filter((b) => b.kind === 'register').map((b) => b.ref)).toEqual(['rf_design', 'acquisition']);
    expect(ok.outcome.skipped.every((s) => s.reason === 'sheet_missing')).toBe(true);
  });

  it('has its texts in English and Arabic', () => {
    for (const k of ['load_registers', 'load_registers_note', 'outcome_title', 'outcome_part', 'outcome_rows', 'outcome_approved', 'outcome_errors', 'outcome_skipped',
      'outcome_stream', 'outcome_register', 'outcome_queued', 'outcome_sheet_skipped']) {
      expect((en.mi as Record<string, string>)[k]).toBeTruthy();
      expect((ar.mi as Record<string, string>)[k]).toBeTruthy();
    }
  });
});
