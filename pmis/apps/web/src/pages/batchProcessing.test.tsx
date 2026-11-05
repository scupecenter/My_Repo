import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, API_BASE } from '@/api/client';
import { BATCH_POLL } from '@/api/registers';
import type { ImportBatch, Page } from '@/api/types';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { RegisterBatch } from './RegisterBatch';
import { Sites } from './Sites';

/** Contract 0.14.4: a big New sites batch is sent and approved in the background (202, status `processing`, progress), the page polls until it ends. */
const Routed = () => (
  <Routes>
    <Route path="/sites" element={<Sites />} />
    <Route path="/templates/batches/:batchId" element={<RegisterBatch />} />
  </Routes>
);

const SAVED = { ...BATCH_POLL };
beforeEach(() => { Object.assign(BATCH_POLL, { parsing: 40, job: 40, pending: 40, processing: 40 }); });
afterEach(() => { Object.assign(BATCH_POLL, SAVED); });

const ID = '0b3c9f3e-0000-4000-8000-0000000000bb';
const processing = (over: Partial<ImportBatch> = {}): ImportBatch => ({
  id: ID, template_id: 'TPL-SITE-NEW', template_version: 1, source: 'template', file_name: 'new-sites.xlsx', status: 'processing', current_level: 2, levels_required: 2, register_key: null, entity: 'site',
  note: null, counts: { create: 469, update: 0, unchanged: 0, error: 0, pending: 369, approved: 100, rejected: 0, held: 0 }, job_id: null, task_id: null, site_id: null,
  progress: { job_id: 'j1', kind: 'submit', state: 'running', rows_total: 469, rows_done: 100, percent: 21, submitted: 100, approved: 100, rejected: 0, failed: 0, started_at: '2026-11-05T08:00:00.000Z', updated_at: '2026-11-05T08:00:10.000Z', finished_at: null, error: null },
  uploaded_by: { id: '1', display_name: 'Entry User', employee_id: '4001' }, uploaded_at: '2026-11-05T08:00:00.000Z', version: 3, ...over,
} as ImportBatch);

describe('a big New sites batch in the background', () => {
  it('L1 sends 120 rows: 202, the bar shows the rows sent while it polls, nothing can be sent twice, then it waits for L2; L2 approves all: "Sites created X of Y", then approved', async () => {
    await signIn('reviewer');
    const view = renderApp(<Routed />, { route: '/sites' });
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('sites-template-upload'));
    await u.upload(await screen.findByTestId('template-upload-file'), new File(['bigsites120'], 'new-sites.xlsx'));
    await u.click(screen.getByTestId('template-upload-submit'));
    await screen.findByTestId('page-register-batch');
    // slow the polling down so that the processing phase can be seen
    Object.assign(BATCH_POLL, { processing: 400 });
    await u.click(await screen.findByTestId('batch-submit'));
    expect(await screen.findByText('The batch is being processed in the background. The bar shows the progress.')).toBeInTheDocument();
    expect(await screen.findByTestId('batch-status')).toHaveTextContent('Processing');
    expect(screen.getByTestId('batch-progress')).toHaveAttribute('data-phase', 'processing');
    expect(screen.getByTestId('batch-progress-processing-label')).toHaveTextContent(/Processing in the background: \d+ of 120 rows \(\d+%\)/);
    expect(screen.getByTestId('batch-progress-processing-bar')).toHaveAttribute('role', 'progressbar');
    expect(screen.getByTestId('batch-progress-processing-note')).toHaveTextContent(/part by part/);
    expect(screen.queryByTestId('batch-submit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('batch-discard')).not.toBeInTheDocument();
    expect(screen.getByTestId('batch-processing-busy')).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId('batch-status')).toHaveTextContent('In approval'), { timeout: 10000 });
    expect(screen.getByTestId('batch-progress-sent-label')).toHaveTextContent('Sites created: 0 of 120 (0%)');
    const id = (await api.get<Page<ImportBatch>>('/import-batches', { query: { status: 'in_approval' } })).items[0]!.id;

    await signIn('pm');
    view.unmount();
    renderApp(<Routed />, { route: `/templates/batches/${id}` });
    await api.post('/__mock/step-up');
    Object.assign(BATCH_POLL, { processing: 400 });
    await u.click(await screen.findByTestId('batch-approve-all'));
    expect(await screen.findByTestId('batch-progress-processing-label')).toHaveTextContent(/Sites created \d+ of 120 \(\d+%\)/);
    expect(screen.queryByTestId('batch-approve-all')).not.toBeInTheDocument();
    expect(screen.queryByTestId('batch-reject-all')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('batch-status')).toHaveTextContent('Approved'), { timeout: 10000 });
    expect(screen.getByTestId('batch-progress-sent-label')).toHaveTextContent('Sites created: 120 of 120 (100%)');
    expect(screen.getByTestId('batch-done')).toBeInTheDocument();
  }, 30_000); // several polls of the mock and user steps: over the 5 s default under CI's parallel workers

  it('a second send while it runs is answered 409 batch_processing, in plain words', async () => {
    await signIn('reviewer');
    server.use(
      http.get(`${API_BASE}/import-batches/:id`, () => HttpResponse.json(processing({ status: 'validated', progress: null, counts: { create: 469, error: 0, pending: 469, approved: 0 } }))),
      http.get(`${API_BASE}/import-batches/:id/rows`, () => HttpResponse.json({ items: [], page: { limit: 200, next_cursor: null } })),
      http.post(`${API_BASE}/import-batches/:id/submit`, () => HttpResponse.json({ type: 'about:blank', title: 'The batch is being processed', status: 409, code: 'batch_processing' }, { status: 409 })),
    );
    renderApp(<Routed />, { route: `/templates/batches/${ID}` });
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('batch-submit'));
    expect(await screen.findByText('This batch is being processed. Wait until it ends, then try again.')).toBeInTheDocument();
  }, 30_000);

  it('processing in Arabic: the labels, the note, Western digits, the bar filling from the right', async () => {
    await signIn('pm');
    server.use(
      http.get(`${API_BASE}/import-batches/:id`, () => HttpResponse.json(processing())),
      http.get(`${API_BASE}/import-batches/:id/rows`, () => HttpResponse.json({ items: [], page: { limit: 200, next_cursor: null } })),
    );
    renderApp(<Routed />, { route: `/templates/batches/${ID}`, locale: 'ar' });
    expect(await screen.findByTestId('batch-progress-processing-label')).toHaveTextContent('المواقع المُنشأة 100 من 469 (21%)');
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByTestId('batch-status')).toHaveTextContent('قيد المعالجة');
    expect(screen.getByTestId('batch-progress-processing-note')).toHaveTextContent(/جزءاً بعد جزء/);
    expect(screen.getByTestId('batch-progress-processing-bar')).toHaveAttribute('aria-valuenow', '21');
    expect(screen.getByTestId('batch-processing-busy')).toBeDisabled();
  }, 30_000);

  it('a run that stopped shows its message under the bar of the sent batch, with the count of failed rows', async () => {
    await signIn('pm');
    server.use(
      http.get(`${API_BASE}/import-batches/:id`, () => HttpResponse.json(processing({
        status: 'partially_approved', counts: { create: 469, error: 1, pending: 368, approved: 100, rejected: 0, held: 0 },
        progress: { job_id: 'j1', kind: 'submit', state: 'failed', rows_total: 469, rows_done: 101, percent: 21, submitted: 100, approved: 100, rejected: 0, failed: 1, started_at: '2026-11-05T08:00:00.000Z', updated_at: '2026-11-05T08:01:00.000Z', finished_at: '2026-11-05T08:01:00.000Z', error: 'stopped' },
      }))),
      http.get(`${API_BASE}/import-batches/:id/rows`, () => HttpResponse.json({ items: [], page: { limit: 200, next_cursor: null } })),
    );
    renderApp(<Routed />, { route: `/templates/batches/${ID}` });
    expect(await screen.findByTestId('batch-progress-run-failed')).toHaveTextContent('The background processing stopped after 101 of 469 rows.');
    expect(screen.getByTestId('batch-progress-run-errors')).toHaveTextContent('1 row(s) failed');
  }, 30_000);
});
