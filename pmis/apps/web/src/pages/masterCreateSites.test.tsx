import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, API_BASE } from '@/api/client';
import ar from '@/i18n/ar.json';
import en from '@/i18n/en.json';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { ReconciliationPage } from './Reconciliation';

/**
 * Contract 0.15.73 (owner request 2026-11-25, Q350): the option "Create the sites that are not in GSDN Workspace from the Master" of the Master import apply
 * dialog. Offered by the server (`create_sites_offer`), disabled with its reason otherwise; it sends `create_sites`; the outcome lists the created and skipped
 * sites; the background apply shows the creation phase with its progress; the "Not in GSDN Workspace" rows name the option.
 */
const stepUpDone = () => api.post('/__mock/step-up');
const page = () => renderApp(<Routes><Route path="/templates/master-import" element={<ReconciliationPage />} /></Routes>, { route: '/templates/master-import' });
type Run = Record<string, unknown> & { id: string; version: number; summary: Record<string, unknown> };
const withRun = (over: Partial<Run>) => async () => {
  const run = await api.get<Run>('/master-import/runs/run-0001');
  const r = { ...run, ...over };
  server.use(
    http.get(`${API_BASE}/master-import/runs/:id`, () => HttpResponse.json(r, { headers: { ETag: `"${r.version}"` } })),
    http.get(`${API_BASE}/master-import/runs`, () => HttpResponse.json({ items: [r], page: { limit: 50, next_cursor: null } })),
  );
  return r;
};

describe('the Master import apply dialog: create the missing sites (0.15.73)', () => {
  it('is offered with the count of missing sites, explains itself, and sends create_sites; the outcome lists the created sites', async () => {
    await signIn('pm'); await stepUpDone();
    let body: Record<string, unknown> | null = null;
    const run = await api.get<Run>('/master-import/runs/run-0001');
    server.use(http.post(`${API_BASE}/master-import/runs/:id/apply`, async ({ request }) => {
      body = await request.json() as Record<string, unknown>;
      return HttpResponse.json({ ...run, status: 'applied', version: 2, apply_mode: 'submit', apply_reason: 'Load after the reset',
        outcome: { batches: [], create_sites: { batch_id: 'b-sites', created: [{ row_no: 7, site_code: 'XX-9999', site_id: 's1', region_id: 1, self_approval: true }],
          skipped: [{ row_no: 8, site_code: 'XX-0008', code: 'required', reason: 'The delivery scenario is required.', column: 'Delivery Scenario', errors: [] }],
          created_count: 1, skipped_count: 1 } } });
    }));
    const u = userEvent.setup();
    page();
    await u.click(await screen.findByTestId('mi-run-run-0001'));
    await u.click(await screen.findByTestId('mi-apply'));
    const box = await screen.findByTestId('mi-create-sites');
    expect(screen.getByTestId('mi-create-sites-option')).toHaveTextContent('Create the sites that are not in GSDN Workspace from the Master');
    expect(box).toBeEnabled();
    expect(box).not.toBeChecked();
    expect(screen.getByTestId('mi-create-sites-note')).toHaveTextContent('1 Site ID of this file is not in GSDN Workspace');
    expect(screen.queryByTestId('mi-create-sites-who')).not.toBeInTheDocument();
    await u.click(box);
    expect(screen.getByTestId('mi-create-sites-who')).toHaveTextContent('As a System Admin');
    await u.type(screen.getByTestId('mi-apply-reason'), 'Load after the reset');
    await u.click(screen.getByTestId('mi-apply-confirm'));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ mode: 'submit', reason: 'Load after the reset', create_sites: true });
    const out = await screen.findByTestId('mi-outcome-sites');
    expect(within(out).getByTestId('mi-outcome-sites-counts')).toHaveTextContent('1 created, 1 skipped.');
    expect(within(out).getByTestId('mi-outcome-sites-skipped')).toHaveTextContent('Row 8 (XX-0008): The delivery scenario is required.');
  });

  it('without the box ticked, sends the apply exactly as before', async () => {
    await signIn('pm'); await stepUpDone();
    let body: Record<string, unknown> | null = null;
    const run = await api.get<Run>('/master-import/runs/run-0001');
    server.use(http.post(`${API_BASE}/master-import/runs/:id/apply`, async ({ request }) => {
      body = await request.json() as Record<string, unknown>;
      return HttpResponse.json({ ...run, status: 'applied', outcome: { batches: [] }, version: 2 });
    }));
    const u = userEvent.setup();
    page();
    await u.click(await screen.findByTestId('mi-run-run-0001'));
    await u.click(await screen.findByTestId('mi-apply'));
    await u.type(await screen.findByTestId('mi-apply-reason'), 'Initial load of the Master');
    await u.click(screen.getByTestId('mi-apply-confirm'));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ mode: 'submit', reason: 'Initial load of the Master' });
  });

  it('is disabled with the reason when the server does not offer it, and when every site of the file exists', async () => {
    await signIn('pm'); await stepUpDone();
    await withRun({ create_sites_offer: { allowed: false, admin: false, regions: [], reason: 'Only a System Admin, or a person who holds both L1 and L2 of the Site creation row of the Matrix, can create sites from the Master without a second person.' } })();
    const u = userEvent.setup();
    const v = page();
    await u.click(await screen.findByTestId('mi-run-run-0001'));
    await u.click(await screen.findByTestId('mi-apply'));
    expect(await screen.findByTestId('mi-create-sites')).toBeDisabled();
    expect(screen.getByTestId('mi-create-sites-note')).toHaveTextContent('Not available: Only a System Admin, or a person who holds both L1 and L2');
    v.unmount();
    const r2 = await withRun({ summary: { rows: 2, sites_matched: 2, missing_in_pmis: 0, applicable: 2 }, create_sites_offer: { allowed: true, admin: true, regions: [1], reason: null } })();
    expect(r2.summary.missing_in_pmis).toBe(0);
    page();
    await u.click(await screen.findByTestId('mi-run-run-0001'));
    await u.click(await screen.findByTestId('mi-apply'));
    expect(await screen.findByTestId('mi-create-sites')).toBeDisabled();
    expect(screen.getByTestId('mi-create-sites-note')).toHaveTextContent('Every Site ID of this file is already in GSDN Workspace.');
  });

  it('a holder of both levels sees the regions where the creation is a self-approval', async () => {
    await signIn('pm'); await stepUpDone();
    await withRun({ create_sites_offer: { allowed: true, admin: false, regions: [1], reason: null } })();
    const u = userEvent.setup();
    page();
    await u.click(await screen.findByTestId('mi-run-run-0001'));
    await u.click(await screen.findByTestId('mi-apply'));
    await u.click(await screen.findByTestId('mi-create-sites'));
    expect(screen.getByTestId('mi-create-sites-who')).toHaveTextContent('You hold both L1 and L2 of Site creation in: Tripoli');
  });

  it('shows the creation phase of a background apply with its progress, and the "Not in GSDN Workspace" rows name the option', async () => {
    await signIn('pm'); await stepUpDone();
    await withRun({ status: 'applying', applying: { job_id: 'j1', state: 'running', sites_total: 480, started_at: '2026-11-25T08:00:00Z', updated_at: '2026-11-25T08:00:10Z',
      finished_at: null, error_code: null, error: null, create_sites: true, create_total: 480, create_done: 120, phase: 'create_sites' } })();
    const u = userEvent.setup();
    page();
    await u.click(await screen.findByTestId('mi-run-run-0001'));
    expect(await screen.findByTestId('mi-applying-label')).toHaveTextContent('Creating the sites of the file: 120 of 480');
    expect(screen.getByTestId('mi-applying-bar')).toHaveAttribute('aria-valuenow', '25');
    const row = await screen.findByTestId('mi-diff-diff-3');
    expect(row).toHaveAttribute('data-reason', 'site_not_in_pmis');
    expect(within(row).getByTestId('mi-diff-create-hint')).toHaveTextContent('Create the sites that are not in GSDN Workspace from the Master');
  });

  it('the mock follows the API, and the texts exist in English and Arabic', async () => {
    await signIn('pm'); await stepUpDone();
    const run = await api.get<Run>('/master-import/runs/run-0001');
    const ok = await api.post<{ outcome: { create_sites: { created_count: number } } }>(`/master-import/runs/${run.id}/apply`,
      { version: run.version, body: { mode: 'submit', reason: 'Load after the reset', create_sites: true } });
    expect(ok.outcome.create_sites.created_count).toBe(1);
    for (const k of ['create_sites', 'create_sites_hint', 'create_sites_who_admin', 'create_sites_who_holder', 'create_sites_disabled', 'create_sites_none',
      'applying_create_sites', 'applying_create_sites_staging', 'outcome_sites_title', 'outcome_sites_counts', 'outcome_sites_skipped', 'outcome_sites_batch',
      'sites_created_toast', 'reason_site_not_in_pmis_hint']) {
      expect((en.mi as Record<string, string>)[k] ?? (en.mi as Record<string, string>)[`${k}_other`]).toBeTruthy();
      expect((ar.mi as Record<string, string>)[k] ?? (ar.mi as Record<string, string>)[`${k}_other`]).toBeTruthy();
    }
    expect((ar.mi as Record<string, string>).create_sites).toBe('أنشئ المواقع غير الموجودة في النظام من الماستر');
  });
});
