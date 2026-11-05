import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, API_BASE } from '@/api/client';
import { BATCH_POLL } from '@/api/registers';
import type { ImportBatch, ImportRow, Region } from '@/api/types';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { RegisterBatch } from './RegisterBatch';
import { Sites } from './Sites';

const Routed = () => (
  <Routes>
    <Route path="/sites" element={<Sites />} />
    <Route path="/templates/batches/:batchId" element={<RegisterBatch />} />
    <Route path="/registers/:key/batches/:batchId" element={<RegisterBatch />} />
  </Routes>
);

const ID = '0b3c9f3e-0000-4000-8000-0000000000aa';
const batch = (over: Partial<ImportBatch> = {}): ImportBatch => ({
  id: ID, template_id: 'TPL-SITE-NEW', template_version: 1, source: 'template', file_name: 'new-sites.xlsx', status: 'validated', current_level: 1, levels_required: 2, register_key: null, entity: 'site',
  note: null, counts: { create: 469, update: 0, unchanged: 0, error: 0, pending: 0, approved: 0, rejected: 0, held: 0 }, job_id: null, task_id: null, site_id: null,
  uploaded_by: { id: '1', display_name: 'Entry User', employee_id: '4001' }, uploaded_at: '2026-11-02T08:00:00.000Z', version: 1, ...over,
} as ImportBatch);

const serve = (get: () => ImportBatch, rows: ImportRow[] = []) => server.use(
  http.get(`${API_BASE}/import-batches/:id`, () => HttpResponse.json(get())),
  http.get(`${API_BASE}/import-batches/:id/rows`, () => HttpResponse.json({ items: rows, page: { limit: 200, next_cursor: null } })),
);
const bar = (id: string) => screen.getByTestId(`${id}-bar`);

const SAVED = { ...BATCH_POLL };
beforeEach(() => { Object.assign(BATCH_POLL, { parsing: 40, job: 40, pending: 40 }); });
afterEach(() => { Object.assign(BATCH_POLL, SAVED); });

describe('New sites batch of 469 rows (the mock pages the rows with next_cursor)', () => {
  const upload = async () => {
    await signIn('reviewer');
    renderApp(<Routed />, { route: '/sites' });
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('sites-template-upload'));
    await u.upload(await screen.findByTestId('template-upload-file'), new File(['bigsites469'], 'new-sites.xlsx'));
    await u.click(screen.getByTestId('template-upload-submit'));
    await screen.findByTestId('page-register-batch');
  };

  it('loads every row across the pages and takes every count and the banner from the server counts', async () => {
    await upload();
    const scroller = await screen.findByTestId('batch-scroller');
    await waitFor(() => expect(scroller).toHaveAttribute('data-loaded', '469'), { timeout: 10000 });
    expect(scroller).toHaveAttribute('data-total', '469');
    expect(screen.getByTestId('batch-count-valid')).toHaveTextContent('469 valid');
    expect(screen.getByTestId('batch-count-invalid')).toHaveTextContent('0 invalid');
    expect(screen.getByTestId('batch-count-diff')).toHaveTextContent('New 469');
    expect(screen.queryByTestId('batch-loading-rows')).not.toBeInTheDocument();
    expect(screen.getByText(/^469 row\(s\) can go into the approval flow/)).toBeInTheDocument();
    // the table is windowed, the last row is reached by scrolling
    expect(screen.queryByTestId('batch-row-470')).not.toBeInTheDocument();
    scroller.scrollTop = 469 * 76;
    fireEvent.scroll(scroller);
    expect(await screen.findByTestId('batch-row-470')).toHaveTextContent('BIG-0469');
    // the checked bar
    expect(screen.getByTestId('batch-progress-checked-label')).toHaveTextContent('469 rows · 469 valid (100%) · 0 invalid (0%)');
    expect(bar('batch-progress-checked')).toHaveAttribute('role', 'progressbar');
    expect(bar('batch-progress-checked')).toHaveAttribute('aria-valuenow', '100');
    expect(bar('batch-progress-checked')).toHaveAttribute('aria-valuemin', '0');
    expect(bar('batch-progress-checked')).toHaveAttribute('aria-valuemax', '100');
    expect(screen.getByTestId('batch-progress-split')).toHaveTextContent('new 469 · changed 0 · unchanged 0');
  });

  it('keeps the server counts while the rows load, and says "loading N of M"', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    server.use(http.get(`${API_BASE}/import-batches/:id/rows`, async ({ request }) => {
      if (new URL(request.url).searchParams.get('cursor')) await gate;
      const all = Array.from({ length: 469 }, (_, i) => ({ id: `r${i}`, row_no: i + 2, key: `S${i}`, action: 'create', decision: 'pending', diff: {}, errors: [] }));
      const start = Number(new URL(request.url).searchParams.get('cursor') || 0);
      return HttpResponse.json({ items: all.slice(start, start + 200), page: { limit: 200, next_cursor: start + 200 < 469 ? String(start + 200) : null } });
    }));
    await upload();
    expect(await screen.findByTestId('batch-loading-rows')).toHaveTextContent('Loading 200 of 469 rows');
    expect(screen.getByTestId('batch-count-valid')).toHaveTextContent('469 valid');
    release();
    await waitFor(() => expect(screen.queryByTestId('batch-loading-rows')).not.toBeInTheDocument());
    expect(screen.getByTestId('batch-scroller')).toHaveAttribute('data-loaded', '469');
  });

  it('shows the region, flag and scenario as labels in English and Arabic, with the code in the title', async () => {
    await upload();
    const regions = (await api.get<{ items: Region[] }>('/regions')).items;
    const r2 = regions.find((r) => r.id === 2)!;
    const li = await screen.findByTestId('batch-diff-2-region_id');
    expect(li).toHaveTextContent(r2.name_en);
    expect(li).not.toHaveTextContent(/\b2\b/);
    expect(within(li).getByTitle('2')).toHaveTextContent(r2.name_en);
    expect(screen.getByTestId('batch-diff-2-scope_tower_erection')).toHaveTextContent('No');
    expect(within(screen.getByTestId('batch-diff-2-scope_tower_erection')).getByTitle('no')).toBeInTheDocument();
    expect(screen.getByTestId('batch-diff-3-scope_tower_erection')).toHaveTextContent('N/A');
    expect(within(screen.getByTestId('batch-diff-2-delivery_scenario')).getByTitle('expansion')).toHaveTextContent('Expansion');
  });

  it('does the same in Arabic', async () => {
    await signIn('reviewer');
    server.use(
      http.get(`${API_BASE}/import-batches/:id`, () => HttpResponse.json(batch({ counts: { create: 1 } }))),
      http.get(`${API_BASE}/import-batches/:id/rows`, () => HttpResponse.json({ items: [
        { id: 'r1', row_no: 2, key: 'NEW-1', action: 'create', decision: 'pending', errors: [], diff: { region_id: { old: null, new: 5 }, scope_te_full: { old: null, new: 'na' }, delivery_scenario: { old: null, new: 'new_build' }, site_type: { old: null, new: 'tower' } } },
      ], page: { limit: 200, next_cursor: null } })),
      http.get(`${API_BASE}/list-catalogues`, () => HttpResponse.json({ items: [{ code: 'site_type', name_en: 'Site type', critical: false, status: 'confirmed', allow_other: false, is_active: true, version: 1, used_by: [], values: [{ id: 'v1', code: 'tower', label_en: 'Tower', label_ar: 'برج', aliases: [], groups: [], sort_order: 1, is_active: true, version: 1 }] }] })),
    );
    const regions = (await api.get<{ items: Region[] }>('/regions')).items;
    renderApp(<Routed />, { route: `/templates/batches/${ID}`, locale: 'ar' });
    expect(await screen.findByTestId('batch-diff-2-region_id')).toHaveTextContent(regions.find((r) => r.id === 5)!.name_ar!);
    expect(screen.getByTestId('batch-diff-2-scope_te_full')).toHaveTextContent('غير منطبق');
    expect(screen.getByTestId('batch-diff-2-delivery_scenario')).toHaveTextContent('بناء جديد');
    await waitFor(() => expect(screen.getByTestId('batch-diff-2-site_type')).toHaveTextContent('برج'));
    expect(within(screen.getByTestId('batch-diff-2-site_type')).getByTitle('tower')).toBeInTheDocument();
  });
});

describe('The import progress bar follows the batch status', () => {
  it('parsing: shows the percentage of the job, an indeterminate bar without progress, and refreshes the batch when the job ends', async () => {
    await signIn('pm');
    let b = batch({ status: 'parsing', job_id: 'job-1', counts: {} });
    let job: Record<string, unknown> = { id: 'job-1', kind: 'import_parse', status: 'running', progress: 0.42, result: { rows_done: 197, rows_total: 469 } };
    serve(() => b);
    server.use(http.get(`${API_BASE}/jobs/:id`, () => HttpResponse.json(job)));
    renderApp(<Routed />, { route: `/templates/batches/${ID}` });
    await waitFor(() => expect(screen.getByTestId('batch-progress-parsing-label')).toHaveTextContent('Checking the file: 42% (197 of 469 rows)'));
    expect(bar('batch-progress-parsing')).toHaveAttribute('aria-valuenow', '42');
    expect(bar('batch-progress-parsing')).toHaveAttribute('aria-valuemax', '100');
    job = { ...job, progress: undefined, result: undefined };
    await waitFor(() => expect(screen.getByTestId('batch-progress-parsing-label')).toHaveTextContent('Checking the file…'));
    expect(bar('batch-progress-parsing')).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByTestId('batch-progress-indeterminate')).toBeInTheDocument();
    job = { id: 'job-1', kind: 'import_parse', status: 'done', progress: 1 };
    b = batch({ status: 'validated' });
    expect(await screen.findByTestId('batch-progress-checked-label')).toHaveTextContent('469 rows · 469 valid (100%)');
  });

  it('parsing in Arabic, with Western digits and the bar filling from the right', async () => {
    await signIn('pm');
    serve(() => batch({ status: 'parsing', job_id: 'job-1', counts: {} }));
    server.use(http.get(`${API_BASE}/jobs/:id`, () => HttpResponse.json({ id: 'job-1', kind: 'import_parse', status: 'running', progress: 0.42 })));
    renderApp(<Routed />, { route: `/templates/batches/${ID}`, locale: 'ar' });
    await waitFor(() => expect(screen.getByTestId('batch-progress-parsing-label')).toHaveTextContent('فحص الملف: 42%'));
    expect(document.documentElement.dir).toBe('rtl');
    expect(bar('batch-progress-parsing')).toHaveAttribute('aria-valuenow', '42');
    expect(bar('batch-progress-parsing').className).not.toMatch(/\bflex-row-reverse\b/); // no special case: logical direction fills from the right in RTL
  });

  it('checked: one bar split into valid and invalid with counts and percentages, and the split by action', async () => {
    await signIn('pm');
    serve(() => batch({ template_id: 'TPL-GECOL', entity: null, register_key: 'gecol', counts: { create: 300, update: 50, unchanged: 50, error: 69 } }));
    renderApp(<Routed />, { route: `/registers/gecol/batches/${ID}` });
    expect(await screen.findByTestId('batch-progress-checked-label')).toHaveTextContent('469 rows · 400 valid (85%) · 69 invalid (15%)');
    expect(bar('batch-progress-checked')).toHaveAttribute('aria-valuenow', '85');
    expect(screen.getByTestId('batch-progress-checked-legend-valid')).toHaveTextContent('Valid 400 (85%)');
    expect(screen.getByTestId('batch-progress-checked-legend-invalid')).toHaveTextContent('Invalid 69 (15%)');
    expect(screen.getByTestId('batch-progress-checked-seg-invalid')).toHaveAttribute('title', 'Invalid: 69 (15%)');
    expect(screen.getByTestId('batch-progress-split')).toHaveTextContent('new 300 · changed 50 · unchanged 50');
    expect(screen.getByTestId('batch-count-valid')).toHaveTextContent('400 valid');
    expect(screen.getByTestId('batch-count-invalid')).toHaveTextContent('69 invalid');
    expect(screen.getByTestId('batch-steps')).toBeInTheDocument();
  });

  it('checked, in Arabic', async () => {
    await signIn('pm');
    serve(() => batch({ counts: { create: 300, update: 50, unchanged: 50, error: 69 } }));
    renderApp(<Routed />, { route: `/templates/batches/${ID}`, locale: 'ar' });
    expect(await screen.findByTestId('batch-progress-checked-label')).toHaveTextContent('469 صف · 400 صالح (85%) · 69 غير صالح (15%)');
  });

  const sent = { create: 469, update: 0, unchanged: 0, error: 0, pending: 300, approved: 100, rejected: 50, held: 19 };
  it('sent to L2: headline and stacked bar of approved, returned, held and waiting', async () => {
    await signIn('pm');
    serve(() => batch({ status: 'partially_approved', template_id: 'TPL-GECOL', entity: null, register_key: 'gecol', counts: sent }));
    renderApp(<Routed />, { route: `/registers/gecol/batches/${ID}` });
    expect(await screen.findByTestId('batch-progress-sent-label')).toHaveTextContent('Done 32% (approved + returned of sent)');
    expect(bar('batch-progress-sent')).toHaveAttribute('aria-valuenow', '32');
    expect(screen.getByTestId('batch-progress-sent-legend-approved')).toHaveTextContent('Approved 100 (21%)');
    expect(screen.getByTestId('batch-progress-sent-legend-rejected')).toHaveTextContent('Returned 50 (11%)');
    expect(screen.getByTestId('batch-progress-sent-legend-held')).toHaveTextContent('Held 19 (4%)');
    expect(screen.getByTestId('batch-progress-sent-legend-pending')).toHaveTextContent('Waiting 300 (64%)');
    expect(screen.getByTestId('batch-approve-hint')).toHaveTextContent('300 record(s) wait for L2');
    expect(screen.getByTestId('batch-count-held')).toHaveTextContent('19 held');
  });

  it('sent to L2, in Arabic', async () => {
    await signIn('pm');
    serve(() => batch({ status: 'partially_approved', counts: sent }));
    renderApp(<Routed />, { route: `/templates/batches/${ID}`, locale: 'ar' });
    expect(await screen.findByTestId('batch-progress-sent-label')).toHaveTextContent('المواقع المُنشأة: 100 من 469 (21%)');
    expect(screen.getByTestId('batch-progress-sent-legend-pending')).toHaveTextContent('بالانتظار 300 (64%)');
  });

  it('sent to L2 in Arabic for a register batch: the headline of approved + returned', async () => {
    await signIn('pm');
    serve(() => batch({ status: 'partially_approved', template_id: 'TPL-GECOL', entity: null, register_key: 'gecol', counts: sent }));
    renderApp(<Routed />, { route: `/registers/gecol/batches/${ID}`, locale: 'ar' });
    expect(await screen.findByTestId('batch-progress-sent-label')).toHaveTextContent('تم 32% (المعتمد + المُعاد من المُرسَل)');
  });

  it('a New sites batch reads "Sites created: X of Y (Z%)"', async () => {
    await signIn('pm');
    serve(() => batch({ status: 'partially_approved', counts: sent }));
    renderApp(<Routed />, { route: `/templates/batches/${ID}` });
    expect(await screen.findByTestId('batch-progress-sent-label')).toHaveTextContent('Sites created: 100 of 469 (21%)');
    expect(bar('batch-progress-sent')).toHaveAttribute('aria-valuenow', '21');
  });

  it('discarded and failed show the state and no bar', async () => {
    await signIn('pm');
    serve(() => batch({ status: 'discarded' }));
    const view = renderApp(<Routed />, { route: `/templates/batches/${ID}` });
    expect(await screen.findByTestId('batch-progress')).toHaveAttribute('data-phase', 'discarded');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    view.unmount();
    serve(() => batch({ status: 'failed', counts: {} }));
    renderApp(<Routed />, { route: `/templates/batches/${ID}` });
    await waitFor(() => expect(screen.getByTestId('batch-progress')).toHaveAttribute('data-phase', 'failed'));
    expect(screen.getByTestId('batch-progress')).toHaveTextContent('The check of the file failed');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('polls the batch while rows wait and stops when nothing is pending', async () => {
    await signIn('pm');
    let calls = 0, b = batch({ status: 'in_approval', counts: { ...sent, approved: 0, rejected: 0, held: 0, pending: 469 } });
    server.use(
      http.get(`${API_BASE}/import-batches/:id`, () => { calls += 1; if (calls === 3) b = batch({ status: 'approved', counts: { ...sent, approved: 469, rejected: 0, held: 0, pending: 0 } }); return HttpResponse.json(b); }),
      http.get(`${API_BASE}/import-batches/:id/rows`, () => HttpResponse.json({ items: [], page: { limit: 200, next_cursor: null } })),
    );
    renderApp(<Routed />, { route: `/templates/batches/${ID}` });
    expect(await screen.findByTestId('batch-progress-sent-label')).toHaveTextContent('Sites created: 0 of 469 (0%)');
    await waitFor(() => expect(screen.getByTestId('batch-progress-sent-label')).toHaveTextContent('Sites created: 469 of 469 (100%)'));
    const settled = calls;
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toBe(settled);
    expect(screen.getByTestId('batch-status')).toHaveTextContent('Approved');
  });
});
