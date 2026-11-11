import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_BASE, api } from '@/api/client';
import { RUN_POLL } from '@/api/masterImport';
import { BATCH_POLL } from '@/api/registers';
import type { ImportBatch } from '@/api/types';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { ReconciliationPage } from './Reconciliation';
import { RegisterBatch } from './RegisterBatch';
import { TemplatesPage } from './Templates';

/**
 * Contract 0.15.3: a big upload is staged in the background. The upload dialog closes at once into the batch page, which shows "Checking the file" with the real
 * progress (rows of the file, the part being staged) and then the batches the file produced; the legacy Master comparison shows its progress on the
 * Reconciliation page and cannot be applied before it ends.
 */
const Routed = () => (
  <Routes>
    <Route path="/templates" element={<TemplatesPage />} />
    <Route path="/templates/batches/:batchId" element={<RegisterBatch />} />
    <Route path="/registers/:key/batches/:batchId" element={<RegisterBatch />} />
    <Route path="/templates/master-import" element={<ReconciliationPage />} />
  </Routes>
);

const SAVED = { ...BATCH_POLL }, SAVED_RUN = RUN_POLL.ms;
beforeEach(() => { Object.assign(BATCH_POLL, { parsing: 40, job: 40, pending: 40, processing: 40 }); RUN_POLL.ms = 40; });
afterEach(() => { Object.assign(BATCH_POLL, SAVED); RUN_POLL.ms = SAVED_RUN; });

describe('a big TPL-MASTER upload (0.15.3)', () => {
  it('closes the dialog into the batch page, follows the progress of the check, then lists the batch of each part and the warnings', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/templates' });
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('tpl-upload-TPL-MASTER'));
    await u.upload(await screen.findByTestId('template-upload-file'), new File(['bigmaster469'], 'master-all.xlsx'));
    await u.click(screen.getByTestId('template-upload-submit'));
    // the dialog is gone: the page of the upload shows the check and its progress
    const page = await screen.findByTestId('page-upload');
    expect(screen.queryByTestId('template-upload-dialog')).not.toBeInTheDocument();
    expect(page).toHaveAttribute('data-status', 'parsing');
    expect(within(page).getByTestId('batch-progress-parsing-label')).toHaveTextContent(/Checking the file: \d+% \(\d+ of 469 rows, part \d of 3\)/);
    expect(within(page).getByTestId('batch-progress-parsing-note')).toHaveTextContent('You can leave this page');
    expect(within(page).getByTestId('upload-stop')).toBeEnabled();
    // the bar moves with the reads, then the parts are listed with their links and the warnings
    const done = await screen.findByTestId('upload-done', {}, { timeout: 10_000 });
    const parts = within(done).getByTestId('template-upload-parts');
    expect(within(parts).getAllByRole('link')).toHaveLength(3);
    expect(within(done).getByTestId('upload-warning-column_not_owned')).toHaveTextContent('3 value(s) ignored');
    expect(screen.queryByTestId('batch-progress-parsing-label')).not.toBeInTheDocument();
  }, 30_000);

  it('shows the check in Arabic with Western digits; a stopped check says so', async () => {
    await signIn('pm');
    const ID = '0b3c9f3e-0000-4000-8000-0000000000ab';
    let state: 'running' | 'failed' = 'running';
    const dto = (): ImportBatch => ({
      id: ID, upload_id: ID, template_id: 'TPL-SITE-CW', template_version: 3, source: 'template', file_name: 'cw.xlsx', status: state === 'running' ? 'parsing' : 'failed', current_level: 1,
      levels_required: 2, counts: {}, register_key: null, entity: null, stream: 'CW', group_id: null, version: 0, job_id: null,
      progress: { kind: 'upload', state, rows_total: 469, rows_done: 200, percent: 42, parts_total: 1, parts_done: 0 },
      upload: { id: ID, kind: 'single', state, batch_ids: [], error: state === 'failed' ? { code: 'stopped', reason: null, detail: 'Stopped by the uploader.' } : null },
    } as unknown as ImportBatch);
    server.use(
      http.get(`${API_BASE}/import-batches/:id`, () => HttpResponse.json(dto())),
      http.post(`${API_BASE}/import-batches/:id/decisions`, () => { state = 'failed'; return HttpResponse.json(dto()); }),
    );
    renderApp(<Routed />, { route: `/templates/batches/${ID}`, locale: 'ar' });
    await waitFor(() => expect(screen.getByTestId('batch-progress-parsing-label')).toHaveTextContent('فحص الملف: 42% (200 من 469 صف)'));
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByTestId('batch-progress-parsing-bar')).toHaveAttribute('aria-valuenow', '42');
    await userEvent.setup().click(screen.getByTestId('upload-stop'));
    expect(await screen.findByTestId('upload-failed')).toHaveTextContent('أُوقف فحص الملف.');
  }, 30_000);
});

describe('a big legacy Master (0.15.3)', () => {
  it('opens the run at once with the comparison progress, hides the apply until it ends, then shows the comparison', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/templates/master-import' });
    const u = userEvent.setup();
    expect(await screen.findByTestId('mi-run-run-0001')).toBeInTheDocument();
    await u.upload(screen.getByTestId('mi-file'), new File(['Master sheet bigmaster469'], 'GSDN_Site_Master.xlsx'));
    await u.click(screen.getByTestId('mi-upload'));
    const staging = await screen.findByTestId('mi-staging');
    expect(within(staging).getByTestId('mi-staging-label')).toHaveTextContent(/Comparing the Master: \d+% \(\d+ of 469 rows\)/);
    expect(within(staging).getByTestId('mi-staging-bar')).toHaveAttribute('aria-valuemax', '100');
    expect(screen.queryByTestId('mi-apply')).not.toBeInTheDocument();
    // the comparison ends: the bar goes, the apply comes
    await waitFor(() => expect(screen.queryByTestId('mi-staging')).not.toBeInTheDocument(), { timeout: 10_000 });
    expect(await screen.findByTestId('mi-apply')).toBeInTheDocument();
  }, 30_000);

  it('0.15.5: applies a big Master in the background: the run shows "applying", then the applied result, and cannot be applied twice meanwhile', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    renderApp(<Routed />, { route: '/templates/master-import' });
    const u = userEvent.setup();
    expect(await screen.findByTestId('mi-run-run-0001')).toBeInTheDocument();
    await u.upload(screen.getByTestId('mi-file'), new File(['Master sheet bigmaster469'], 'GSDN_Site_Master.xlsx'));
    await u.click(screen.getByTestId('mi-upload'));
    await u.click(await screen.findByTestId('mi-apply', {}, { timeout: 10_000 }));
    await u.click(screen.getByTestId('mi-mode-draft'));
    await u.type(screen.getByTestId('mi-apply-reason'), 'Initial load');
    await u.click(screen.getByTestId('mi-apply-confirm'));
    const applying = await screen.findByTestId('mi-applying');
    expect(within(applying).getByTestId('mi-applying-label')).toHaveTextContent('Applying 469 sites in the background');
    expect(screen.queryByTestId('mi-apply')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('mi-applied')).toHaveTextContent('Save Draft / Planning'), { timeout: 10_000 });
    expect(screen.queryByTestId('mi-applying')).not.toBeInTheDocument();
  }, 30_000);

  it('0.15.5: in Arabic, the background apply says so', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    renderApp(<Routed />, { route: '/templates/master-import', locale: 'ar' });
    const u = userEvent.setup();
    await u.upload(await screen.findByTestId('mi-file'), new File(['Master sheet bigmaster120'], 'GSDN_Site_Master.xlsx'));
    await u.click(screen.getByTestId('mi-upload'));
    await u.click(await screen.findByTestId('mi-apply', {}, { timeout: 10_000 }));
    await u.click(screen.getByTestId('mi-mode-draft'));
    await u.type(screen.getByTestId('mi-apply-reason'), 'Initial load');
    await u.click(screen.getByTestId('mi-apply-confirm'));
    expect(within(await screen.findByTestId('mi-applying')).getByTestId('mi-applying-label')).toHaveTextContent('يُطبَّق 120 موقعًا في الخلفية');
  }, 30_000);
});
