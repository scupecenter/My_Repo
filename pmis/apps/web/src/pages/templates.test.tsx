import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import { api } from '@/api/client';
import type { ImportBatch } from '@/api/types';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { RegisterBatch } from './RegisterBatch';
import { RegisterPage } from './Register';
import { TemplatesPage } from './Templates';

const Routed = () => (
  <Routes>
    <Route path="/templates" element={<TemplatesPage />} />
    <Route path="/registers/:key" element={<RegisterPage />} />
    <Route path="/registers/:key/batches/:batchId" element={<RegisterBatch />} />
  </Routes>
);

describe('Templates page', () => {
  it('lists the approved template of each register with its version and downloads it blank or pre-filled', async () => {
    await signIn('pm');
    const asked: string[] = [];
    server.use(http.get(`${API_BASE}/templates/:id/download`, ({ params, request }) => {
      asked.push(`${params.id}?${new URL(request.url).searchParams.toString()}`);
      return new HttpResponse(new Uint8Array([1]), { headers: { 'Content-Disposition': 'attachment; filename="x.xlsx"' } });
    }));
    renderApp(<Routed />, { route: '/templates' });
    const u = userEvent.setup();
    for (const id of ['TPL-PO', 'TPL-GECOL', 'TPL-HLC', 'TPL-PRM']) expect(await screen.findByTestId(`tpl-row-${id}`)).toBeInTheDocument();
    expect(screen.getByTestId('tpl-version-TPL-GECOL')).toHaveTextContent('v1');
    expect(screen.getByTestId('tpl-streams-note')).toHaveTextContent(/stream templates/);
    await u.click(screen.getByTestId('tpl-download-TPL-GECOL'));
    await waitFor(() => expect(asked).toEqual(['TPL-GECOL?']));
    await u.click(screen.getByTestId('tpl-prefill-TPL-GECOL'));
    await waitFor(() => expect(asked).toEqual(['TPL-GECOL?', 'TPL-GECOL?prefill=true']));
    await waitFor(() => expect(screen.getAllByTestId('toast').at(-1)).toHaveTextContent('Downloaded'));
  });

  it('uploads from the page, opens the batch review, and lists the batch with a status filter', async () => {
    await signIn('pm');
    const first = renderApp(<Routed />, { route: '/templates' });
    const u = userEvent.setup();
    expect(await screen.findByTestId('batches-empty')).toBeInTheDocument();
    await u.click(await screen.findByTestId('tpl-upload-TPL-PO'));
    await u.upload(await screen.findByTestId('template-upload-file'), new File(['x'], 'orders.xlsx'));
    await u.click(screen.getByTestId('template-upload-submit'));
    await screen.findByTestId('page-register-batch');
    expect(await screen.findByTestId('batch-status')).toHaveTextContent('Checked');
    const list = await api.get<{ items: ImportBatch[] }>('/import-batches', { query: { status: 'validated', register_key: 'procurement' } });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ template_id: 'TPL-PO', register_key: 'procurement', status: 'validated', levels_required: 2 });
    // the list page
    await signIn('pm');
    first.unmount();
    const { unmount } = renderApp(<Routed />, { route: '/templates' });
    const row = await screen.findByTestId(`batch-list-row-${list.items[0]!.id}`);
    expect(row).toHaveAttribute('data-status', 'validated');
    await userEvent.selectOptions(screen.getByTestId('batches-filter-status'), 'approved');
    expect(await screen.findByTestId('batches-empty')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByTestId('batches-filter-status'), 'validated');
    await waitFor(() => expect(screen.getByTestId(`batch-list-row-${list.items[0]!.id}`)).toBeInTheDocument());
    await userEvent.click(screen.getByTestId(`batch-link-${list.items[0]!.id}`));
    await screen.findByTestId('page-register-batch');
    unmount();
  });

  it('shows no template to somebody who holds no register module (permission)', async () => {
    await signIn('engineer');
    renderApp(<Routed />, { route: '/templates' });
    expect(await screen.findByTestId('tpl-empty')).toBeInTheDocument();
    const res = await api.get<{ items: unknown[] }>('/templates');
    expect(res.items.some((i) => (i as { register_key: string | null }).register_key)).toBe(false);
  });

  it('is in Arabic (RTL), with the catalogue and the upload dialog translated', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/templates', locale: 'ar' });
    expect(document.documentElement.dir).toBe('rtl');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('القوالب والرفع');
    await userEvent.click(await screen.findByTestId('tpl-upload-TPL-GECOL'));
    expect(await screen.findByTestId('template-upload-dialog')).toHaveTextContent('رفع');
    expect(screen.getByTestId('template-upload-dialog')).toHaveTextContent('يُرفض الملف المأخوذ من إصدار أقدم');
  });
});

/** The answers of the real API (contract 0.7.0), as the Supertest suite sees them: the review page must read these shapes. */
describe('Batch review with the shapes of the real API', () => {
  const batch = (over: Partial<ImportBatch> = {}): ImportBatch => ({
    id: '0b3c9f3e-0000-4000-8000-000000000001', template_id: 'TPL-GECOL', template_version: 3, source: 'template', file_name: 'gecol.xlsx', status: 'in_approval', current_level: 2, levels_required: 2,
    register_key: 'gecol', note: null, counts: { create: 1, update: 1, unchanged: 1, error: 2, pending: 1, approved: 0, rejected: 0, held: 1 }, job_id: null, task_id: null, site_id: null,
    uploaded_by: { id: '1', display_name: 'Entry User', employee_id: '4001' }, uploaded_at: '2026-11-02T08:00:00.000Z', version: 2, ...over,
  } as ImportBatch);
  const rows = [
    { id: 'r1', sheet: 'Data', row_no: 2, key: 'TR101', site_code: 'TR101', record_type: null, record_id: 'a0000000-0000-4000-8000-000000000050', action: 'update', decision: 'pending', diff: { remark: { old: 'old remark', new: 'new remark' } }, errors: [], note: null },
    { id: 'r2', sheet: 'Data', row_no: 3, key: 'TR102', site_code: 'TR102', record_type: null, record_id: null, action: 'update', decision: 'pending_previous_approval', hold_reason: 'open_version', diff: { remark: { old: null, new: 'held' } }, errors: [], note: null },
    { id: 'r3', sheet: 'Data', row_no: 4, key: 'TR103', site_code: 'TR103', record_type: null, record_id: null, action: 'create', decision: 'pending', diff: { pr_no: { old: null, new: 'GP-9' } }, errors: [], note: null },
    { id: 'r4', sheet: 'Data', row_no: 5, key: 'FAR-1', site_code: 'FAR-1', record_type: null, record_id: null, action: 'error', decision: 'pending', diff: {},
      errors: [{ column: 'Site ID', field: 'site_code', code: 'site_not_in_scope', message: 'Unknown site, or a site outside your regions.' }], note: null },
    { id: 'r5', sheet: 'Data', row_no: 6, key: 'TR104', site_code: 'TR104', record_type: null, record_id: null, action: 'error', decision: 'pending', diff: {},
      errors: [{ column: 'GECOL Request Date', field: 'request_date', code: 'invalid_date', message: 'A date.' }, { column: 'Survey Date', field: 'survey_date', code: 'formula_not_allowed', message: 'Cells must hold values, not formulas.' }], note: null },
  ];
  it('shows the diff per cell, the reasons per cell, the held row and the outcome of "approve all"', async () => {
    await signIn('pm');
    let b = batch();
    server.use(
      http.get(`${API_BASE}/import-batches/:id`, () => HttpResponse.json(b, { headers: { ETag: `"${b.version}"` } })),
      http.get(`${API_BASE}/import-batches/:id/rows`, () => HttpResponse.json({ items: rows, page: { limit: 200, next_cursor: null } })),
      http.post(`${API_BASE}/import-batches/:id/decisions`, () => {
        b = batch({ status: 'partially_approved', version: 3, counts: { ...b.counts, approved: 1, pending: 0 } });
        return HttpResponse.json({ ...b, outcome: { decided: 1, approved: 1, rejected: 0, held: [{ row_id: 'r2', row_no: 3, key: 'TR102', reason: 'open_version', record_id: 'a0000000-0000-4000-8000-000000000051' }], failed: [{ row_id: 'r3', row_no: 4, key: 'TR103', code: 'not_eligible_holder', message: 'You do not hold the level.' }] } });
      }),
    );
    renderApp(<Routed />, { route: `/registers/gecol/batches/${b.id}` });
    const u = userEvent.setup();
    expect(await screen.findByTestId('batch-status')).toHaveTextContent('In approval');
    expect(await screen.findByTestId('batch-diff-old-2-remark')).toHaveTextContent('old remark');
    expect(screen.getByTestId('batch-diff-new-2-remark')).toHaveTextContent('new remark');
    expect(screen.getByTestId('batch-diff-4-pr_no')).toHaveTextContent('GP-9');
    expect(screen.getByTestId('batch-cell-error-5-site_code')).toHaveTextContent('Site ID: Unknown site, or a site outside your regions.');
    expect(screen.getByTestId('batch-cell-error-6-request_date')).toHaveTextContent('GECOL Request Date');
    expect(screen.getByTestId('batch-cell-error-6-survey_date')).toHaveTextContent('Cells must hold values, not formulas.');
    expect(screen.getByTestId('batch-decision-3')).toHaveTextContent('Held: previous version open');
    expect(screen.getByTestId('batch-held')).toHaveTextContent('1 row(s) wait for the previous version');
    expect(screen.getByTestId('batch-open-record-2').getAttribute('href')).toBe('/registers/gecol?record=a0000000-0000-4000-8000-000000000050');
    expect(screen.getByTestId('batch-count-held')).toHaveTextContent('1 held');
    await u.click(screen.getByTestId('batch-approve-all'));
    expect(await screen.findByTestId('batch-outcome-failed')).toHaveTextContent('You do not hold the level');
    expect(screen.getByTestId('batch-status')).toHaveTextContent('Partly approved');
  });

  it('is readable in Arabic (RTL)', async () => {
    await signIn('pm');
    const b = batch();
    server.use(
      http.get(`${API_BASE}/import-batches/:id`, () => HttpResponse.json(b)),
      http.get(`${API_BASE}/import-batches/:id/rows`, () => HttpResponse.json({ items: rows, page: { limit: 200, next_cursor: null } })),
    );
    renderApp(<Routed />, { route: `/registers/gecol/batches/${b.id}`, locale: 'ar' });
    expect(await screen.findByTestId('batch-status')).toHaveTextContent('قيد الاعتماد');
    expect(document.documentElement.dir).toBe('rtl');
    expect(await screen.findByTestId('batch-held')).toHaveTextContent('بانتظار الإصدار السابق');
    expect(screen.getByTestId('batch-decision-3')).toHaveTextContent('معلّق: الإصدار السابق مفتوح');
    expect(screen.getByTestId('batch-cell-error-5-site_code')).toHaveTextContent('موقع غير معروف');
  });
});
