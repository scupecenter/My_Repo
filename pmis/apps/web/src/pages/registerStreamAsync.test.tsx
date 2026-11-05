import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import { RUN_POLL } from '@/api/masterImport';
import { BATCH_POLL } from '@/api/registers';
import type { ImportBatch } from '@/api/types';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { ReconciliationPage } from './Reconciliation';
import { RegisterBatch } from './RegisterBatch';
import { SettingsRoutes } from './settings/Settings';

/**
 * Contract 0.14.6: register and stream batches are sent and decided in the background like New sites batches (202, `processing`, progress), the Master import apply
 * sends its big batches in the background (the run's progress on the Reconciliation screen), and Settings, Imports sets the threshold imports.async_rows.
 */
const Routed = () => (
  <Routes>
    <Route path="/registers/:key/batches/:batchId" element={<RegisterBatch />} />
    <Route path="/templates/batches/:batchId" element={<RegisterBatch />} />
    <Route path="/templates/master-import" element={<ReconciliationPage />} />
    <Route path="/admin/settings/*" element={<SettingsRoutes />} />
  </Routes>
);

const SAVED = { ...BATCH_POLL };
const SAVED_RUN = { ...RUN_POLL };
beforeEach(() => { Object.assign(BATCH_POLL, { parsing: 40, job: 40, pending: 40, processing: 40 }); RUN_POLL.ms = 40; });
afterEach(() => { Object.assign(BATCH_POLL, SAVED); Object.assign(RUN_POLL, SAVED_RUN); });

const ID = '0b3c9f3e-0000-4000-8000-0000000000cc';
const T0 = '2026-11-05T08:00:00.000Z';
const batch = (over: Partial<ImportBatch> = {}): ImportBatch => ({
  id: ID, template_id: 'TPL-ISS', template_version: 1, source: 'template', file_name: 'issues.xlsx', status: 'processing', current_level: 2, levels_required: 2, register_key: 'issues',
  note: null, counts: { create: 120, update: 0, unchanged: 0, error: 0, pending: 70, approved: 50, rejected: 0, held: 0 }, job_id: null, task_id: null, site_id: null,
  progress: { job_id: 'j2', kind: 'decide', action: 'approve', batch_kind: 'register', state: 'running', rows_total: 120, rows_done: 50, percent: 41, submitted: 0, approved: 50, decided: 50,
    rejected: 0, held: 0, saved: 0, failed: 0, started_at: T0, updated_at: T0, finished_at: null, error: null },
  uploaded_by: { id: '1', display_name: 'Entry User', employee_id: '4001' }, uploaded_at: T0, version: 4, ...over,
} as ImportBatch);
const noRows = () => HttpResponse.json({ items: [], page: { limit: 200, next_cursor: null } });

describe('a big register or stream batch in the background', () => {
  it('a register approval: "Processing in the background" and "Records approved X of Y", every action disabled, polled until it is approved', async () => {
    await signIn('pm');
    let reads = 0;
    server.use(
      http.get(`${API_BASE}/import-batches/:id`, () => {
        reads += 1;
        return HttpResponse.json(reads < 3 ? batch() : batch({ status: 'approved', counts: { create: 120, pending: 0, approved: 120, rejected: 0, held: 0 },
          progress: { ...batch().progress!, state: 'done', rows_done: 120, percent: 100, approved: 120, decided: 120, finished_at: T0 } }));
      }),
      http.get(`${API_BASE}/import-batches/:id/rows`, noRows),
    );
    renderApp(<Routed />, { route: `/registers/issues/batches/${ID}` });
    expect(await screen.findByTestId('batch-progress-processing-label')).toHaveTextContent('Processing in the background: 50 of 120 rows (41%)');
    expect(screen.getByTestId('batch-progress-processing-kind')).toHaveTextContent('Records approved 50 of 120 (41%)');
    expect(screen.getByTestId('batch-progress-processing-kind')).toHaveAttribute('data-kind', 'register');
    expect(screen.getByTestId('batch-status')).toHaveTextContent('Processing');
    expect(screen.getByTestId('batch-processing-busy')).toBeDisabled();
    expect(screen.queryByTestId('batch-approve-all')).not.toBeInTheDocument();
    expect(screen.queryByTestId('batch-reject-all')).not.toBeInTheDocument();
    expect(screen.queryByTestId('batch-submit')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('batch-status')).toHaveTextContent('Approved'), { timeout: 10000 });
    expect(screen.queryByTestId('batch-progress-processing-kind')).not.toBeInTheDocument();
  }, 30_000);

  it('a stream send in Arabic: the tasks submitted, Western digits, right to left; a return of rows says the tasks decided', async () => {
    await signIn('pm');
    const stream = (over: Partial<ImportBatch['progress']> = {}) => batch({ template_id: 'TPL-SITE-CW', register_key: null, stream: 'CW', file_name: 'cw.xlsx',
      counts: { create: 0, update: 60, unchanged: 0, error: 0, pending: 60, approved: 0, rejected: 0, held: 0 },
      progress: { ...batch().progress!, kind: 'submit', action: null, batch_kind: 'stream', rows_total: 60, rows_done: 25, percent: 41, submitted: 25, approved: 0, decided: 0, ...over } });
    let body = stream();
    server.use(
      http.get(`${API_BASE}/import-batches/:id`, () => HttpResponse.json(body)),
      http.get(`${API_BASE}/import-batches/:id/rows`, noRows),
    );
    const view = renderApp(<Routed />, { route: `/templates/batches/${ID}`, locale: 'ar' });
    expect(await screen.findByTestId('batch-progress-processing-label')).toHaveTextContent('المعالجة في الخلفية: 25 من 60 صف (41%)');
    expect(screen.getByTestId('batch-progress-processing-kind')).toHaveTextContent('المهام المُرسَلة 25 من 60 (41%)');
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByTestId('batch-processing-busy')).toBeDisabled();
    view.unmount();
    body = stream({ kind: 'decide', action: 'reject', submitted: 0, decided: 30, rows_done: 30, percent: 50 });
    renderApp(<Routed />, { route: `/templates/batches/${ID}` });
    expect(await screen.findByTestId('batch-progress-processing-kind')).toHaveTextContent('Tasks decided 30 of 60 (50%)');
  }, 30_000);
});

describe('the Master import apply in the background (Reconciliation)', () => {
  it('shows the run progress while its batches are sent, polls, then says what was sent', async () => {
    await signIn('pm');
    const run = {
      id: 'run-big', file_name: 'GSDN_Site_Master.xlsx', file_sha256: 'c3'.repeat(32), file_size: 1000, status: 'applied', structure: { identified: true, columns_expected: 187, columns_found: 187 },
      summary: { rows: 300, sites_matched: 300, applicable: 300 }, created_by: { id: '1', display_name: 'Project Manager', employee_id: '1001' }, created_at: T0, applied_by: null, applied_at: T0,
      apply_reason: 'Initial load', apply_mode: 'submit', group_id: null, outcome: null, has_file: true, version: 2,
    };
    let reads = 0;
    const progress = (done: number) => ({ state: done >= 300 ? 'done' : 'running', batches: 1, batches_running: done >= 300 ? 0 : 1, rows_total: 300, rows_done: done,
      percent: Math.floor((100 * done) / 300), submitted: done, saved: 0, approved: 0, held: 0, failed: done >= 300 ? 2 : 0, started_at: T0, updated_at: T0, finished_at: done >= 300 ? T0 : null });
    server.use(
      http.get(`${API_BASE}/master-import/runs`, () => HttpResponse.json({ items: [run], page: { limit: 50, next_cursor: null } })),
      http.get(`${API_BASE}/master-import/runs/:id`, () => { reads += 1; return HttpResponse.json({ ...run, progress: progress(reads < 2 ? 75 : 300) }); }),
      http.get(`${API_BASE}/master-import/runs/:id/diffs`, () => HttpResponse.json({ items: [], page: { limit: 200, next_cursor: null } })),
    );
    expect(SAVED_RUN.ms).toBe(3000);
    renderApp(<Routed />, { route: '/templates/master-import?run=run-big' });
    const p = await screen.findByTestId('mi-run-progress');
    expect(p).toHaveAttribute('data-state', 'running');
    expect(screen.getByTestId('batch-progress-processing-label')).toHaveTextContent('Processing in the background: 75 of 300 rows (25%)');
    expect(screen.getByTestId('batch-progress-processing-kind')).toHaveTextContent('Tasks submitted 75 of 300 (25%)');
    expect(screen.getByTestId('mi-run-progress-batches')).toHaveTextContent('Batches still being sent: 1 of 1');
    expect(screen.queryByTestId('mi-apply')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('mi-run-progress')).toHaveAttribute('data-state', 'done'), { timeout: 8000 });
    expect(screen.getByTestId('mi-run-progress')).toHaveTextContent('Background sending finished: 300 task(s) submitted, 0 saved, 2 failed, of 300 rows.');
  }, 30_000);
});

describe('Settings, Imports: the background threshold', () => {
  const open = (locale?: 'ar') => renderApp(<Routed />, { route: '/admin/settings/imports', ...(locale ? { locale } : {}) });

  it('a System Admin reads 50 (default 50), cannot save a value out of range, and saves 20 with a reason; who and when are shown', async () => {
    await signIn('pm');
    open();
    const u = userEvent.setup();
    expect(await screen.findByTestId('page-imports-settings')).toHaveTextContent('Imports / Background processing');
    expect(screen.getByTestId('settings-tab-imports')).toHaveTextContent('Imports');
    const input = screen.getByTestId('imports-async-rows');
    expect(input).toHaveValue(50);
    expect(screen.getByLabelText('Process in the background from N rows')).toBe(input);
    expect(screen.getByTestId('imports-current')).toHaveTextContent('batches with more than 50 rows run in the background (default 50)');
    expect(screen.getByTestId('imports-updated')).toHaveTextContent('Not changed since installation.');
    expect(screen.getByTestId('imports-save')).toBeDisabled();
    await u.clear(input);
    await u.type(input, '9');
    expect(screen.getByTestId('imports-async-rows-error')).toHaveTextContent('Type a whole number from 10 to 500.');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('imports-save')).toBeDisabled();
    await u.clear(input);
    await u.type(input, '501');
    expect(screen.getByTestId('imports-save')).toBeDisabled();
    await u.clear(input);
    await u.type(input, '20');
    expect(screen.queryByTestId('imports-async-rows-error')).not.toBeInTheDocument();
    await u.click(screen.getByTestId('imports-save'));
    expect(screen.getByTestId('imports-confirm')).toHaveTextContent('Change the threshold from 50 to 20 rows.');
    await u.click(screen.getByTestId('imports-dialog-submit'));
    expect(screen.getByTestId('imports-dialog-reason-error')).toBeInTheDocument();       // a reason is required
    await u.type(screen.getByTestId('imports-dialog-reason'), 'Smaller batches go to the background');
    await u.click(screen.getByTestId('imports-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('imports-current')).toHaveTextContent('more than 20 rows'));
    expect(screen.getByTestId('imports-updated')).toHaveTextContent(/Last changed by .+ on /);
  }, 30_000);

  it('the server refuses a value out of range with a field error on async_rows', async () => {
    await signIn('pm');
    server.use(http.put(`${API_BASE}/settings/imports`, () => HttpResponse.json({ type: 'about:blank', title: 'Validation failed', status: 422, code: 'validation_failed',
      errors: [{ path: '/async_rows', code: 'out_of_range', message: 'A whole number from 10 to 500.' }] }, { status: 422 })));
    open();
    const u = userEvent.setup();
    const input = await screen.findByTestId('imports-async-rows');
    await u.clear(input);
    await u.type(input, '30');
    await u.click(screen.getByTestId('imports-save'));
    await u.type(screen.getByTestId('imports-dialog-reason'), 'Try a value');
    await u.click(screen.getByTestId('imports-dialog-submit'));
    expect(await screen.findByTestId('err-async_rows')).toBeInTheDocument();
  }, 30_000);

  it('another user sees the value read-only; in Arabic the labels are translated and the page is right to left', async () => {
    await signIn('reviewer');
    open('ar');
    expect(await screen.findByTestId('page-imports-settings')).toHaveTextContent('الاستيراد / المعالجة في الخلفية');
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByLabelText('المعالجة في الخلفية ابتداءً من N صف')).toBeDisabled();
    expect(screen.getByTestId('imports-readonly')).toHaveTextContent('لا يغيّر هذه القيمة إلا مسؤول النظام');
    expect(screen.queryByTestId('imports-save')).not.toBeInTheDocument();
    expect(screen.getByTestId('imports-async-rows-hint')).toHaveTextContent('عدد صحيح من 10 إلى 500. القيمة الافتراضية 50.');
  }, 30_000);
});
