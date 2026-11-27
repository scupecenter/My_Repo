import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, API_BASE } from '@/api/client';
import type { HistoricalWaiver } from '@/api/historicalWaiver';
import type { MasterImportRun } from '@/api/masterImport';
import i18n from '@/i18n';
import ar from '@/i18n/ar.json';
import en from '@/i18n/en.json';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { ReconciliationPage } from './Reconciliation';

/**
 * Contract 0.15.36 (owner decision 2026-11-17, "Re-apply the file with direct approval"): on the Master import run screen, a run whose file another run already
 * applied says so, and a System Admin (while the historical-load waiver is open) can re-apply it with direct approval: the reason and the step-up of the apply,
 * the direct approval forced, the register sheets on, `historical_load.reapply` sent. English and Arabic.
 */
const stepUpDone = () => api.post('/__mock/step-up');
const openIt = () => api.put<HistoricalWaiver>('/settings/historical-waiver', { body: { open: true, cutoff_date: '2026-02-28', reason: 'One-time load of the Master' } });
const page = () => renderApp(<Routes><Route path="/templates/master-import" element={<ReconciliationPage />} /></Routes>, { route: '/templates/master-import' });
const upload = () => { const fd = new FormData(); fd.append('file', new File(['Master sheet'], 'GSDN_Site_Master.xlsx')); return api.post<MasterImportRun>('/master-import/runs', { body: fd }); };

/** A file applied by a first run, then uploaded again: the second run is the one to re-apply. */
async function appliedTwice(): Promise<MasterImportRun> {
  const first = await upload();
  await api.post(`/master-import/runs/${first.id}/apply`, { version: first.version, body: { mode: 'submit', reason: 'First load', historical_load: { reason: 'History of the Master' } } });
  return upload();
}

describe('the Master import run screen: re-apply with direct approval (0.15.36)', () => {
  it('says the file was already applied and, for a System Admin, re-applies it with direct approval and the register sheets', async () => {
    await signIn('pm'); await stepUpDone();
    await openIt();
    const second = await appliedTwice();
    expect(second.applied_before).toMatchObject({ run_id: expect.any(String) });
    let body: Record<string, unknown> | null = null;
    server.use(http.post(`${API_BASE}/master-import/runs/:id/apply`, async ({ request }) => {
      body = await request.json() as Record<string, unknown>;
      return HttpResponse.json({ ...second, status: 'applied', applied_before: null, outcome: { reapply: true, approve_directly: true, discarded: [{ id: 'b0' }], batches: [{ id: 'b1', approved: 4 }] }, version: 2 });
    }));
    const u = userEvent.setup();
    page();
    await u.click(await screen.findByTestId(`mi-run-${second.id}`));
    expect(await screen.findByTestId('mi-applied-before')).toHaveTextContent('This file was already applied');
    await u.click(await screen.findByTestId('mi-reapply'));
    expect(await screen.findByTestId('mi-reapply-note')).toHaveTextContent('open batches of the earlier Master loads are discarded');
    expect(screen.getByTestId('mi-approve-directly')).toBeChecked();
    expect(screen.getByTestId('mi-approve-directly')).toBeDisabled();
    expect(screen.getByTestId('mi-load-registers')).toBeChecked();
    expect(screen.getByTestId('mi-mode-draft')).toBeDisabled();
    expect(screen.getByTestId('mi-apply-confirm')).toBeDisabled();   // the reasons first
    await u.type(screen.getByTestId('mi-apply-reason'), 'Load the Master again');
    await u.type(screen.getByTestId('hl-reason'), 'Historical tasks are final');
    expect(screen.getByTestId('mi-apply-confirm')).toHaveTextContent('Re-apply with direct approval');
    await u.click(screen.getByTestId('mi-apply-confirm'));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ mode: 'submit', reason: 'Load the Master again',
      historical_load: { reason: 'Historical tasks are final', approve_directly: true, registers: true, reapply: true } });
    expect(await screen.findByText(/Re-applied: 4 tasks approved directly, 1 earlier batch\(es\) discarded/)).toBeInTheDocument();
  });

  it('a plain apply refused because the file was already applied offers the re-apply in the dialog', async () => {
    await signIn('pm'); await stepUpDone();
    await openIt();
    const second = await appliedTwice();
    const sent: Record<string, unknown>[] = [];
    server.use(http.post(`${API_BASE}/master-import/runs/:id/apply`, async ({ request }) => {
      const b = await request.json() as { historical_load?: { reapply?: boolean } };
      sent.push(b as Record<string, unknown>);
      if (!b.historical_load?.reapply) {
        return HttpResponse.json({ type: 'about:blank', title: 'Not possible now', status: 409, code: 'invalid_transition', detail: 'This file was already applied (run run-2).',
          already_applied: true, applied_run_id: 'run-2' }, { status: 409 });
      }
      return HttpResponse.json({ ...second, status: 'applied', outcome: { reapply: true, approve_directly: true, discarded: [], batches: [] }, version: 2 });
    }));
    const u = userEvent.setup();
    page();
    await u.click(await screen.findByTestId(`mi-run-${second.id}`));
    await u.click(await screen.findByTestId('mi-apply'));
    await u.type(await screen.findByTestId('mi-apply-reason'), 'Load the Master again');
    await u.click(screen.getByTestId('mi-apply-confirm'));
    expect(await screen.findByTestId('mi-apply-error')).toHaveTextContent('already applied');
    await u.click(await screen.findByTestId('mi-reapply-offer'));
    expect(await screen.findByTestId('mi-reapply-note')).toBeInTheDocument();
    await u.type(screen.getByTestId('hl-reason'), 'Historical tasks are final');
    await u.click(screen.getByTestId('mi-apply-confirm'));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ mode: 'submit', historical_load: { approve_directly: true, registers: true, reapply: true } });
  });

  it('is not offered without the open waiver, and has its texts in English and Arabic (RTL)', async () => {
    await signIn('pm'); await stepUpDone();
    await openIt();
    const second = await appliedTwice();
    await api.put('/settings/historical-waiver', { body: { open: false, reason: 'The load is finished' } });
    const u = userEvent.setup();
    page();
    await u.click(await screen.findByTestId(`mi-run-${second.id}`));
    expect(await screen.findByTestId('mi-applied-before')).toBeInTheDocument();
    expect(screen.queryByTestId('mi-reapply')).not.toBeInTheDocument();   // the waiver is closed
    for (const k of ['applied_before', 'reapply', 'reapply_title', 'reapply_note', 'reapply_offer', 'reapplied_toast']) {
      expect((en.mi as Record<string, string>)[k] ?? (en.mi as Record<string, string>)[`${k}_other`]).toBeTruthy();
      expect((ar.mi as Record<string, string>)[k] ?? (ar.mi as Record<string, string>)[`${k}_other`]).toBeTruthy();
    }
    await i18n.changeLanguage('ar');
    try {
      expect(await screen.findByText(/طُبِّق هذا الملف من قبل/)).toBeInTheDocument();
      expect(i18n.dir()).toBe('rtl');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
