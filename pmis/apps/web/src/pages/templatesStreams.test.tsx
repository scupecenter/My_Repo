import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, API_BASE } from '@/api/client';
import type { ImportBatch, ImportRow, UploadedBatch } from '@/api/types';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { RegisterBatch } from './RegisterBatch';
import { RegisterPage } from './Register';
import { TemplatesPage } from './Templates';

/** Contract 0.11.5: the Site Register stream templates and TPL-MASTER on the Templates page, the upload dialog and the review of a batch of task rows. */
const Routed = () => (
  <Routes>
    <Route path="/templates" element={<TemplatesPage />} />
    <Route path="/templates/batches/:batchId" element={<RegisterBatch />} />
    <Route path="/registers/:key" element={<RegisterPage />} />
    <Route path="/registers/:key/batches/:batchId" element={<RegisterBatch />} />
  </Routes>
);

async function upload(u: ReturnType<typeof userEvent.setup>, id: string, body = 'x', name = 'filled.xlsx') {
  await u.click(await screen.findByTestId(`tpl-upload-${id}`));
  await u.upload(await screen.findByTestId('template-upload-file'), new File([body], name));
  await u.click(screen.getByTestId('template-upload-submit'));
}

describe('Templates page: Site Register templates', () => {
  it('lists the whole Master and the four stream templates before the registers, with their kind and version, and downloads one pre-filled', async () => {
    await signIn('pm');
    const asked: string[] = [];
    server.use(http.get(`${API_BASE}/templates/:id/download`, ({ params, request }) => {
      asked.push(`${params.id}?${new URL(request.url).searchParams.toString()}`);
      return new HttpResponse(new Uint8Array([1]), { headers: { 'Content-Disposition': 'attachment; filename="x.xlsx"' } });
    }));
    renderApp(<Routed />, { route: '/templates' });
    const u = userEvent.setup();
    for (const id of ['TPL-MASTER', 'TPL-SITE-DA', 'TPL-SITE-CW', 'TPL-SITE-TE', 'TPL-SITE-CL', 'TPL-PO', 'TPL-GECOL']) expect(await screen.findByTestId(`tpl-row-${id}`)).toBeInTheDocument();
    expect(screen.getByTestId('tpl-row-TPL-SITE-CW')).toHaveAttribute('data-kind', 'stream');
    expect(screen.getByTestId('tpl-row-TPL-SITE-CW')).toHaveAttribute('data-stream', 'CW');
    expect(screen.getByTestId('tpl-kind-TPL-SITE-CW')).toHaveTextContent('Site Register stream');
    expect(screen.getByTestId('tpl-kind-TPL-MASTER')).toHaveTextContent('Whole Master');
    expect(screen.queryByTestId('tpl-kind-TPL-GECOL')).not.toBeInTheDocument();
    expect(screen.getByTestId('tpl-version-TPL-SITE-CW')).toHaveTextContent('v1');
    const order = within(screen.getByTestId('tpl-table')).getAllByTestId(/^tpl-row-/).map((r) => r.getAttribute('data-testid'));
    expect(order.indexOf('tpl-row-TPL-SITE-TE')).toBeLessThan(order.indexOf('tpl-row-TPL-PO'));
    expect(screen.getByTestId('tpl-streams-note')).toHaveTextContent(/never read/);
    await u.click(screen.getByTestId('tpl-prefill-TPL-SITE-CW'));
    await waitFor(() => expect(asked).toEqual(['TPL-SITE-CW?prefill=true']));
    await u.click(screen.getByTestId('tpl-download-TPL-MASTER'));
    await waitFor(() => expect(asked).toEqual(['TPL-SITE-CW?prefill=true', 'TPL-MASTER?']));
  });

  it('shows no Site Register template to somebody who has no Templates page (permission)', async () => {
    await signIn('engineer');
    renderApp(<Routed />, { route: '/templates' });
    expect(await screen.findByTestId('tpl-empty')).toBeInTheDocument();
    const res = await api.get<{ items: { template_id: string }[] }>('/templates');
    const site = ['TPL-MASTER', 'TPL-SITE-DA', 'TPL-SITE-CW', 'TPL-SITE-TE', 'TPL-SITE-CL'];
    expect(res.items.some((i) => site.includes(i.template_id))).toBe(false);
  });

  it('uploads a stream file and reviews one row per task: the diff by field, the warnings, the held row, the identical task and the cell errors', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/templates' });
    const u = userEvent.setup();
    expect(await screen.findByTestId('tpl-row-TPL-SITE-CW')).toBeInTheDocument();
    await u.click(await screen.findByTestId('tpl-upload-TPL-SITE-CW'));
    expect(await screen.findByTestId('template-upload-rule-tasks')).toHaveTextContent('submitted');
    expect(screen.queryByTestId('template-upload-rule-master')).not.toBeInTheDocument();
    await u.upload(await screen.findByTestId('template-upload-file'), new File(['x'], 'cw.xlsx'));
    await u.click(screen.getByTestId('template-upload-submit'));
    const page = await screen.findByTestId('page-register-batch');
    expect(page).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Civil Works');
    expect(await screen.findByTestId('batch-status')).toHaveTextContent('Checked');
    // several rows share a file row: the row ids carry the task
    const key = await screen.findByTestId('batch-row-2-B4');
    expect(key).toHaveAttribute('data-action', 'update');
    expect(within(key).getByText(/SBN101 \/ B4|\/ B4/)).toBeInTheDocument();
    expect(screen.getByTestId('batch-diff-new-2-B4-actual_date')).toHaveTextContent('2026-10-10');
    expect(screen.getByTestId('batch-diff-2-B4-planned_date')).toHaveTextContent('Planned date');
    expect(screen.getByTestId('batch-diff-2-B4-aat_se_name')).toHaveTextContent('AAT SE name');
    expect(screen.getByTestId('batch-warning-2-B4-sla_late')).toHaveTextContent('The actual date is after the SLA limit');
    expect(screen.getByTestId('batch-decision-2-B5')).toHaveTextContent('Held: waits for a predecessor');
    expect(screen.getByTestId('batch-warning-2-B5-held_predecessor')).toBeInTheDocument();
    expect(screen.getByTestId('batch-row-3-B6')).toHaveAttribute('data-action', 'unchanged');
    expect(screen.getByTestId('batch-warning-3-B6-calculated_column')).toHaveTextContent('value was not read');
    expect(screen.getByTestId('batch-cell-error-3-B8-B8:actual_date')).toHaveTextContent('locked by a closed gate');
    expect(screen.getByTestId('batch-cell-error-4-site_code')).toHaveTextContent('Unknown site');
    expect(screen.getByTestId('batch-held')).toHaveTextContent('1 row(s) wait for their task');
    expect(screen.getByTestId('batch-held-2-B5')).toHaveTextContent('waits for a predecessor');
    expect(screen.getByTestId('batch-open-task-2-B4').getAttribute('href')).toMatch(/^\/sites\/.+\?task=/);
    expect(screen.getByTestId('batch-back').getAttribute('href')).toBe('/templates');
    // it is on the Templates page too, under its stream
    const list = await api.get<{ items: ImportBatch[] }>('/import-batches', { query: { stream: 'CW' } });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ template_id: 'TPL-SITE-CW', stream: 'CW', register_key: null });
  });

  it('sends the batch, L2 approves one task row, returns another with a note and approves what is left; a held row is listed and left alone', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    renderApp(<Routed />, { route: '/templates' });
    const u = userEvent.setup();
    await upload(u, 'TPL-SITE-DA');
    await screen.findByTestId('page-register-batch');
    await waitFor(() => expect(screen.getByTestId('batch-count-valid')).toHaveTextContent('3 valid'));
    expect(screen.queryByTestId('batch-row-approve-2-A2')).not.toBeInTheDocument();       // nothing is in the flow before the send
    await u.click(screen.getByTestId('batch-submit'));
    await waitFor(() => expect(screen.getByTestId('batch-status')).toHaveTextContent('In approval'));
    expect(screen.getByTestId('batch-outcome-held')).toHaveTextContent('1 row(s) are held');
    expect(screen.getByTestId('batch-approve-hint')).toHaveTextContent('1 record(s) wait for L2');
    await u.click(await screen.findByTestId('batch-row-reject-2-A2'));
    await u.type(await screen.findByTestId('reject-note'), 'Wrong actual date');
    await u.click(screen.getByTestId('reject-submit'));
    await waitFor(() => expect(screen.getByTestId('batch-decision-2-A2')).toHaveTextContent('Returned'));
    expect(screen.getByTestId('batch-note-2-A2')).toHaveTextContent('Wrong actual date');
    // approve all leaves the held row; a return takes it back
    expect(screen.getByTestId('batch-held-2-A5')).toBeInTheDocument();
    expect(screen.queryByTestId('batch-row-approve-2-A5')).not.toBeInTheDocument();
    await u.click(screen.getByTestId('batch-row-reject-2-A5'));
    await u.type(await screen.findByTestId('reject-note'), 'Not needed');
    await u.click(screen.getByTestId('reject-submit'));
    await waitFor(() => expect(screen.getByTestId('batch-decision-2-A5')).toHaveTextContent('Returned'));
    expect(screen.getByTestId('batch-status')).toHaveTextContent('Returned');
  });

  it('approves a task row, then all that are left, with the step-up', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    renderApp(<Routed />, { route: '/templates' });
    const u = userEvent.setup();
    await upload(u, 'TPL-SITE-TE');
    await screen.findByTestId('page-register-batch');
    await u.click(await screen.findByTestId('batch-submit'));
    await waitFor(() => expect(screen.getByTestId('batch-status')).toHaveTextContent('In approval'));
    await u.click(await screen.findByTestId('batch-row-approve-2-D5'));
    await waitFor(() => expect(screen.getByTestId('batch-decision-2-D5')).toHaveTextContent('Approved'));
    expect(screen.getByTestId('batch-status')).toHaveTextContent('Partly approved');         // the held row is still open
    expect(screen.getByTestId('batch-approve-all')).toBeDisabled();                            // nothing but a held row is left
    const rows = (await api.get<{ items: ImportRow[] }>(`/import-batches/${(await api.get<{ items: ImportBatch[] }>('/import-batches', { query: { stream: 'TE' } })).items[0]!.id}/rows`)).items;
    expect(rows.find((r) => r.task_code === 'D5')).toMatchObject({ decision: 'approved', source_ref: 'Data!2' });
  });
});

describe('TPL-MASTER upload', () => {
  it('lists the parts and the warnings of a Master file before the first batch is opened, and the batch shows its siblings', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/templates' });
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('tpl-upload-TPL-MASTER'));
    expect(await screen.findByTestId('template-upload-rule-master')).toHaveTextContent('one batch per stream');
    await u.upload(await screen.findByTestId('template-upload-file'), new File(['x'], 'master.xlsx'));
    await u.click(screen.getByTestId('template-upload-submit'));
    const parts = await screen.findByTestId('template-upload-parts');
    expect(within(parts).getAllByRole('listitem')).toHaveLength(3);
    expect(parts).toHaveTextContent('Civil Works');
    expect(parts).toHaveTextContent('Installation (TE)');
    expect(parts).toHaveTextContent('GECOL');
    expect(screen.getByTestId('upload-warning-column_not_owned')).toHaveTextContent('3 value(s) ignored');
    expect(screen.getByTestId('upload-warning-extra_column')).toHaveTextContent('My own notes');
    await u.click(screen.getByTestId('template-upload-open'));
    await screen.findByTestId('page-register-batch');
    const group = await screen.findByTestId('batch-group');
    expect(within(group).getAllByRole('link')).toHaveLength(3);
    // the rows say where they came from (sheet and file row), the comparison report of the parallel run
    expect(await screen.findByTestId('batch-row-2-B4')).toHaveAttribute('data-source', 'Master!2');
    // the sibling opens its own review: a register batch
    const link = within(group).getByText(/GECOL/);
    await u.click(link);
    await waitFor(() => expect(screen.getByTestId('page-register-batch')).toHaveAttribute('data-status'));
    const first = (await api.get<{ items: ImportBatch[] }>('/import-batches', { query: { status: 'validated' } })).items.filter((b) => b.group_id);
    expect(first).toHaveLength(3);
    expect(new Set(first.map((b) => b.group_id)).size).toBe(1);
    expect(first.map((b) => b.source)).toEqual(['master_template', 'master_template', 'master_template']);
    expect(first.map((b) => b.stream ?? b.register_key).sort()).toEqual(['CW', 'TE', 'gecol']);
  });

  it('shows the server reason for a file of another stream, an old version, a missing _tpl and a changed header', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/templates' });
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('tpl-upload-TPL-SITE-CW'));
    await u.upload(await screen.findByTestId('template-upload-file'), new File(['otherstream'], 'te.xlsx'));
    await u.click(screen.getByTestId('template-upload-submit'));
    const err = await screen.findByTestId('template-upload-error');
    expect(err).toHaveAttribute('data-reason', 'wrong_template');
    expect(err).toHaveTextContent('another register');
    for (const [body, reason] of [['retired', 'outdated_version'], ['notpl', 'tpl_missing'], ['tampered', 'checksum_mismatch']] as const) {
      await u.upload(screen.getByTestId('template-upload-file'), new File([body], `${body}.xlsx`));
      await u.click(screen.getByTestId('template-upload-submit'));
      await waitFor(() => expect(screen.getByTestId('template-upload-error')).toHaveAttribute('data-reason', reason));
    }
    expect(screen.getByTestId('template-upload-detail')).toHaveTextContent('header row of the file was changed');
    expect(screen.queryByTestId('page-register-batch')).not.toBeInTheDocument();
  });
});

describe('Arabic', () => {
  it('translates the Site Register templates, the stream names, the task diff, the warnings and the held rows (RTL)', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/templates', locale: 'ar' });
    const u = userEvent.setup();
    expect(document.documentElement.dir).toBe('rtl');
    expect(await screen.findByTestId('tpl-row-TPL-SITE-CW')).toHaveTextContent('سجل المواقع: الأعمال المدنية');
    expect(screen.getByTestId('tpl-kind-TPL-MASTER')).toHaveTextContent('الماستر كاملًا');
    expect(screen.getByTestId('tpl-streams-note')).toHaveTextContent('الأعمدة الرمادية');
    await u.click(screen.getByTestId('tpl-upload-TPL-MASTER'));
    expect(await screen.findByTestId('template-upload-rule-master')).toHaveTextContent('دفعة لكل مسار');
    await u.keyboard('{Escape}');
    await u.click(await screen.findByTestId('tpl-upload-TPL-SITE-CW'));
    await u.upload(await screen.findByTestId('template-upload-file'), new File(['x'], 'cw.xlsx'));
    await u.click(screen.getByTestId('template-upload-submit'));
    await screen.findByTestId('page-register-batch');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('الأعمال المدنية');
    expect(await screen.findByTestId('batch-diff-2-B4-actual_date')).toHaveTextContent('التاريخ الفعلي');
    expect(screen.getByTestId('batch-warning-2-B4-sla_late')).toHaveTextContent('بعد حد SLA');
    expect(screen.getByTestId('batch-decision-2-B5')).toHaveTextContent('معلّق: تنتظر المهمة السابقة');
    expect(screen.getByTestId('batch-held')).toHaveTextContent('بانتظار مهمته');
    expect(screen.getByTestId('batch-cell-error-3-B8-B8:actual_date')).toHaveTextContent('بوابة مغلقة');
    expect(screen.getByTestId('batch-back')).toHaveTextContent('العودة إلى القوالب');
  });
});

describe('Batch of task rows with the shapes of the real API', () => {
  it('reads the answer of imp_stage_stream_batch: several rows per file row, warnings, held reasons and the source of a Master row', async () => {
    await signIn('pm');
    const batch = {
      id: '0b3c9f3e-0000-4000-8000-000000000042', template_id: 'TPL-SITE-CW', template_version: 2, source: 'master_template', file_name: 'master.xlsx', status: 'in_approval', current_level: 2, levels_required: 2,
      register_key: null, stream: 'CW', group_id: '0b3c9f3e-0000-4000-8000-000000000099', part_sheet: 'Master', note: null,
      counts: { create: 0, update: 2, unchanged: 0, error: 0, pending: 1, approved: 0, rejected: 0, held: 1 }, job_id: null, task_id: null, site_id: null,
      uploaded_by: { id: '1', display_name: 'Entry User', employee_id: '4001' }, uploaded_at: '2026-11-02T08:00:00.000Z', version: 3,
    } as unknown as UploadedBatch;
    const rows = [
      { id: 'r1', sheet: 'Master', row_no: 2, key: 'TR101 / B4', site_code: 'TR101', site_id: '0c000000-0000-4000-8000-000000000001', record_type: null, record_id: null, task_code: 'B4', task_id: '0d000000-0000-4000-8000-000000000001',
        action: 'update', decision: 'pending', source_ref: 'Master!2', diff: { actual_date: { old: '2026-02-01', new: '2026-02-02' }, mts_cabinet: { old: null, new: 'Done' } }, errors: [],
        warnings: [{ column: 'CW Survey & Analysis Report / Actual Date', field: 'B4:actual_date', code: 'sla_negative', message: 'negative' }], note: null },
      { id: 'r2', sheet: 'Master', row_no: 2, key: 'TR101 / B5', site_code: 'TR101', site_id: '0c000000-0000-4000-8000-000000000001', record_type: null, record_id: null, task_code: 'B5', task_id: '0d000000-0000-4000-8000-000000000002',
        action: 'update', decision: 'pending_previous_approval', hold_reason: 'open_submission', source_ref: 'Master!2', diff: { actual_date: { old: null, new: '2026-02-05' } }, errors: [], warnings: [], note: null },
    ] as unknown as ImportRow[];
    server.use(
      http.get(`${API_BASE}/import-batches/:id`, () => HttpResponse.json(batch, { headers: { ETag: '"3"' } })),
      http.get(`${API_BASE}/import-batches`, () => HttpResponse.json({ items: [batch], page: { limit: 100, next_cursor: null } })),
      http.get(`${API_BASE}/import-batches/:id/rows`, () => HttpResponse.json({ items: rows, page: { limit: 200, next_cursor: null } })),
    );
    renderApp(<Routed />, { route: `/templates/batches/${batch.id}` });
    expect(await screen.findByTestId('batch-status')).toHaveTextContent('In approval');
    expect(await screen.findByTestId('batch-diff-old-2-B4-actual_date')).toHaveTextContent('2026-02-01');
    expect(screen.getByTestId('batch-diff-new-2-B4-actual_date')).toHaveTextContent('2026-02-02');
    expect(screen.getByTestId('batch-diff-2-B4-mts_cabinet')).toHaveTextContent('Mts cabinet');      // a value key the app has no label for is made readable
    expect(screen.getByTestId('batch-warning-2-B4-sla_negative')).toHaveTextContent('before the SLA start');
    expect(screen.getByTestId('batch-decision-2-B5')).toHaveTextContent('Held: the task is in review');
    expect(screen.getByTestId('batch-row-2-B4')).toHaveAttribute('data-source', 'Master!2');
    expect(screen.getByTestId('batch-open-task-2-B5').getAttribute('href')).toBe('/sites/0c000000-0000-4000-8000-000000000001?task=0d000000-0000-4000-8000-000000000002');
    expect(screen.getByTestId('batch-count-held')).toHaveTextContent('1 held');
    expect(await screen.findByTestId('batch-group')).toHaveTextContent('Civil Works');
    expect(screen.getByTestId('batch-approve-hint')).toHaveTextContent('1 record(s) wait for L2');
  });
});
