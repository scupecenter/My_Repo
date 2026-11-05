import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, API_BASE, ApiError } from '@/api/client';
import type { HistoricalWaiver } from '@/api/historicalWaiver';
import type { ImportBatch, TaskDetail } from '@/api/types';
import { OverrideBadge } from '@/components/OverrideBadge';
import { TaskDrawer } from '@/components/TaskDrawer';
import { TaskGrid } from '@/components/TaskGrid';
import { TemplateUploadDialog } from '@/components/TemplateUploadDialog';
import ar from '@/i18n/ar.json';
import en from '@/i18n/en.json';
import { siteIdOf } from '@/mocks/sites';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { ReconciliationPage } from './Reconciliation';
import { RegisterBatch } from './RegisterBatch';
import { SettingsRoutes } from './settings/Settings';

/** Contract 0.14.3 (Q462): the one-time historical-load document waiver. The settings screen, the option of the batch screens (a System Admin only, while it is open) and the badge. */
const stepUpDone = () => api.post('/__mock/step-up');
const settings = (opts = {}) => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/historical-waiver', ...opts });
const errCode = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => `${e.status}:${e.code}`);
const openIt = (cutoff = '2026-02-28') => api.put<HistoricalWaiver>('/settings/historical-waiver', { body: { open: true, cutoff_date: cutoff, reason: 'One-time load of the Master' } });
const stream = (cb: (b: ImportBatch) => void = () => undefined) =>
  renderApp(<TemplateUploadDialog open onClose={() => undefined} templateId="TPL-SITE-CW" templateName="CW" kind="stream" onDone={cb} />);

describe('Settings, historical load', () => {
  it('is closed by default; a System Admin opens it with a cutoff date and a reason (step-up), sees the state, and closes it with a reason', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    settings();
    expect(await screen.findByTestId('hw-status')).toHaveTextContent('Closed');
    expect(screen.getByTestId('page-historical-waiver')).toHaveAttribute('data-open', 'false');
    await u.click(screen.getByTestId('hw-open'));
    await u.type(screen.getByTestId('hw-open-dialog-reason'), 'Initial load of the Master');
    expect(screen.getByTestId('hw-open-dialog-submit')).toBeDisabled();                     // no cutoff date yet
    fireEvent.change(screen.getByTestId('hw-cutoff-input'), { target: { value: '2026-02-28' } });
    expect(screen.getByTestId('hw-open-dialog-submit')).toBeEnabled();
    await stepUpDone();
    await u.click(screen.getByTestId('hw-open-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('hw-status')).toHaveTextContent('Open'));
    expect(screen.getByTestId('hw-cutoff')).toHaveTextContent('2026-02-28');
    expect(screen.getByTestId('hw-expires')).toHaveTextContent('30 day(s) left');
    expect(screen.getByTestId('hw-reason')).toHaveTextContent('Initial load of the Master');
    expect(screen.queryByTestId('hw-open')).not.toBeInTheDocument();

    await u.click(screen.getByTestId('hw-close'));
    await u.click(screen.getByTestId('hw-close-dialog-submit'));                            // a reason is required
    expect(await screen.findByTestId('hw-close-dialog-reason-error')).toBeInTheDocument();
    expect(screen.getByTestId('hw-status')).toHaveTextContent('Open');
    await u.type(screen.getByTestId('hw-close-dialog-reason'), 'The load is finished');
    await u.click(screen.getByTestId('hw-close-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('hw-status')).toHaveTextContent('Closed'));
    expect(screen.getByTestId('hw-last-closed')).toHaveTextContent('Closed by hand');
  });

  it('shows the server refusal of a cutoff date in the future, in the dialog', async () => {
    await signIn('pm'); await stepUpDone();
    const u = userEvent.setup();
    settings();
    await u.click(await screen.findByTestId('hw-open'));
    fireEvent.change(screen.getByTestId('hw-cutoff-input'), { target: { value: '2999-01-01' } });
    await u.type(screen.getByTestId('hw-open-dialog-reason'), 'A cutoff in the future');
    await u.click(screen.getByTestId('hw-open-dialog-submit'));
    expect(await screen.findByTestId('hw-open-dialog-error')).toHaveTextContent('The cutoff date cannot be in the future.');
    expect(screen.getByTestId('page-historical-waiver')).toHaveAttribute('data-open', 'false');
  });

  it('is read-only for anyone who is not a System Admin, and the server refuses the change (a delegate included)', async () => {
    await signIn('engineer'); await stepUpDone();
    settings();
    expect(await screen.findByTestId('hw-admin-only')).toBeInTheDocument();
    expect(screen.queryByTestId('hw-open')).not.toBeInTheDocument();
    expect(await errCode(openIt())).toBe('403:action_forbidden');
    expect(await api.get<HistoricalWaiver>('/settings/historical-waiver')).toMatchObject({ open: false, can_manage: false });
  });

  it('needs a step-up, a reason, and refuses opening twice or closing a closed waiver', async () => {
    await signIn('pm');
    expect(await errCode(openIt())).toBe('401:step_up_required');
    await stepUpDone();
    expect(await errCode(api.put('/settings/historical-waiver', { body: { open: true, cutoff_date: '2026-02-28', reason: 'x' } }))).toBe('422:validation_failed');
    expect(await errCode(api.put('/settings/historical-waiver', { body: { open: true, reason: 'No cutoff date' } }))).toBe('422:validation_failed');
    expect(await errCode(api.put('/settings/historical-waiver', { body: { open: false, reason: 'Close the closed' } }))).toBe('409:invalid_transition');
    expect(await openIt()).toMatchObject({ open: true, cutoff_date: '2026-02-28', window_days: 30, can_manage: true });
    expect(await errCode(openIt('2026-02-15'))).toBe('409:invalid_transition');
  });

  it('has its tab and every new text in English and Arabic', () => {
    expect((en.settings as Record<string, string>)['tab_historical-waiver']).toBeTruthy();
    expect((ar.settings as Record<string, string>)['tab_historical-waiver']).toBeTruthy();
    for (const ns of ['hw', 'override'] as const) {
      expect(Object.keys((ar as unknown as Record<string, Record<string, string>>)[ns]).sort()).toEqual(Object.keys((en as unknown as Record<string, Record<string, string>>)[ns]).sort());
    }
    expect((ar.batchWarn as Record<string, string>).historical_no_documents).toBeTruthy();
    expect((ar.fieldError as Record<string, string>).in_the_future).toBeTruthy();
  });
});

describe('the option "historical load: accept without documents" on the batch screens', () => {
  it('is offered to a System Admin only while the waiver is open, on a stream template in submit mode', async () => {
    await signIn('pm'); await stepUpDone();
    const { unmount } = stream();
    await screen.findByTestId('template-upload-mode');
    expect(screen.queryByTestId('hl-option')).not.toBeInTheDocument();                       // the waiver is closed
    unmount();

    await openIt();
    const u = userEvent.setup();
    const second = stream();
    expect(await screen.findByTestId('hl-option')).toBeInTheDocument();
    expect(screen.getByTestId('hl-hint')).toHaveTextContent('on or before 2026-02-28');
    await u.click(screen.getByTestId('template-upload-mode-draft'));                         // a draft has no document check
    await waitFor(() => expect(screen.queryByTestId('hl-option')).not.toBeInTheDocument());
    second.unmount();

    renderApp(<TemplateUploadDialog open onClose={() => undefined} templateId="TPL-GECOL" templateName="GECOL" kind="register" onDone={() => undefined} />);
    expect(screen.queryByTestId('hl-option')).not.toBeInTheDocument();                       // a register template
  });

  it('is not offered to a user who is not a System Admin, even while the waiver is open', async () => {
    await signIn('pm'); await stepUpDone();
    await openIt();
    await signIn('reviewer');
    stream();
    await screen.findByTestId('template-upload-mode');
    expect(screen.queryByTestId('hl-option')).not.toBeInTheDocument();
  });

  it('asks for a reason, sends it with the file, and the batch shows the mark; without the option nothing extra is sent', async () => {
    await signIn('pm'); await stepUpDone();
    await openIt();
    const seen: (string | null)[] = [];
    server.use(http.post(`${API_BASE}/import-batches`, async ({ request }) => {
      seen.push((await request.clone().formData()).get('historical_load_reason') as string | null);
      return HttpResponse.json({ id: 'b-9', template_id: 'TPL-SITE-CW', template_version: 2, status: 'validated', counts: {}, version: 1,
        historical_load: seen.at(-1) ? { cutoff_date: '2026-02-28', reason: seen.at(-1), marked_by: null, marked_at: '2026-11-05T09:00:00Z' } : null }, { status: 202 });
    }));
    let done: ImportBatch | null = null;
    const u = userEvent.setup();
    const first = stream((b) => { done = b; });
    await u.upload(await screen.findByTestId('template-upload-file'), new File(['x'], 'cw.xlsx'));
    await u.click(await screen.findByTestId('hl-toggle'));
    expect(screen.getByTestId('template-upload-submit')).toBeDisabled();                     // the reason is missing
    await u.type(screen.getByTestId('hl-reason'), 'History of the Master');
    expect(screen.getByTestId('template-upload-submit')).toBeEnabled();
    await u.click(screen.getByTestId('template-upload-submit'));
    await waitFor(() => expect(done).not.toBeNull());
    expect(seen).toEqual(['History of the Master']);
    expect((done as unknown as ImportBatch).historical_load).toMatchObject({ cutoff_date: '2026-02-28', reason: 'History of the Master' });

    // the option left off: the field is not sent
    done = null;
    first.unmount();
    const again = stream((b) => { done = b; });
    await u.upload(await screen.findByTestId('template-upload-file'), new File(['x'], 'cw2.xlsx'));
    await u.click(screen.getByTestId('template-upload-submit'));
    await waitFor(() => expect(done).not.toBeNull());
    expect(seen).toEqual(['History of the Master', null]);
    again.unmount();
  });

  it('the stream upload of the mock follows the API: refused for a non-admin and while the waiver is closed, marks the batch otherwise', async () => {
    await signIn('pm'); await stepUpDone();
    const send = async (reason: string | null) => {
      const fd = new FormData();
      fd.append('file', new File(['x'], 'cw.xlsx')); fd.append('template_id', 'TPL-SITE-CW');
      if (reason !== null) fd.append('historical_load_reason', reason);
      return api.post<ImportBatch>('/import-batches', { body: fd });
    };
    expect(await errCode(send('History of the Master'))).toBe('409:invalid_transition');   // closed
    await openIt();
    expect((await send('History of the Master')).historical_load).toMatchObject({ cutoff_date: '2026-02-28' });
    expect((await send(null)).historical_load).toBeNull();
    expect(await errCode(send('x'))).toBe('422:validation_failed');
    await signIn('reviewer'); await stepUpDone();
    expect(await errCode(send('History of the Master'))).toBe('403:action_forbidden');
  });

  it('is on the Master import apply dialog: it sends historical_load with its reason in submit mode, and hides it for a draft', async () => {
    await signIn('pm'); await stepUpDone();
    await openIt();
    let body: Record<string, unknown> | null = null;
    const run = await api.get<Record<string, unknown>>('/master-import/runs/run-0001');
    server.use(http.post(`${API_BASE}/master-import/runs/:id/apply`, async ({ request }) => {
      body = await request.json() as Record<string, unknown>;
      return HttpResponse.json({ ...run, status: 'applied', outcome: { batches: [] }, version: 2 });
    }));
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/templates/master-import" element={<ReconciliationPage />} /></Routes>, { route: '/templates/master-import' });
    await u.click(await screen.findByTestId('mi-run-run-0001'));
    await u.click(await screen.findByTestId('mi-apply'));
    expect(await screen.findByTestId('hl-option')).toBeInTheDocument();
    await u.click(screen.getByTestId('mi-mode-draft'));
    await waitFor(() => expect(screen.queryByTestId('hl-option')).not.toBeInTheDocument());
    await u.click(screen.getByTestId('mi-mode-submit'));
    await u.type(screen.getByTestId('mi-apply-reason'), 'Initial load of the Master');
    await u.click(await screen.findByTestId('hl-toggle'));
    expect(screen.getByTestId('mi-apply-confirm')).toBeDisabled();
    await u.type(screen.getByTestId('hl-reason'), 'Historical tasks have no documents');
    await u.click(screen.getByTestId('mi-apply-confirm'));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ mode: 'submit', reason: 'Initial load of the Master', historical_load: { reason: 'Historical tasks have no documents' } });
  });
});

describe('the batch review', () => {
  it('shows the mark of a historical-load batch and the warning of the row that is accepted without documents', async () => {
    await signIn('pm'); await stepUpDone();
    await openIt();
    const fd = new FormData();
    fd.append('file', new File(['x'], 'cw.xlsx')); fd.append('template_id', 'TPL-SITE-CW'); fd.append('historical_load_reason', 'History of the Master');
    const b = await api.post<ImportBatch>('/import-batches', { body: fd });
    renderApp(<Routes><Route path="/templates/batches/:batchId" element={<RegisterBatch />} /></Routes>, { route: `/templates/batches/${b.id}` });
    const chip = await screen.findByTestId('batch-historical');
    expect(chip).toHaveTextContent('Historical load up to 2026-02-28');
    expect(chip).toHaveAttribute('title', 'History of the Master');
    expect(await screen.findByTestId(/^batch-warning-.*-historical_no_documents$/)).toHaveTextContent('accepted without them under the historical load');
  });

  it('shows nothing of the kind on a batch that is not marked', async () => {
    await signIn('pm');
    const fd = new FormData();
    fd.append('file', new File(['x'], 'cw.xlsx')); fd.append('template_id', 'TPL-SITE-CW');
    const b = await api.post<ImportBatch>('/import-batches', { body: fd });
    renderApp(<Routes><Route path="/templates/batches/:batchId" element={<RegisterBatch />} /></Routes>, { route: `/templates/batches/${b.id}` });
    await screen.findByTestId('batch-counts');
    expect(screen.queryByTestId('batch-historical')).not.toBeInTheDocument();
  });
});

describe('the "Admin override" badge', () => {
  it('shows on the task grid and in the task drawer for a task accepted without documents, and nowhere else', async () => {
    await signIn('pm');
    const grid = await api.get<{ stages: { tasks: TaskDetail[] }[] }>(`/sites/${siteIdOf(0)}/tasks`);
    const [a, b] = grid.stages.flatMap((s) => s.tasks);
    const flagged = { ...a!, historical_no_documents: true };
    renderApp(<TaskGrid siteId={siteIdOf(0)} stages={[{ code: 'MS4', name_en: 'Site RFI', tasks: [flagged, { ...b!, historical_no_documents: false }] }]} selected={null} onVisible={() => undefined} onOpen={() => undefined} />);
    const badge = await screen.findByTestId(`override-${a!.id}`);
    expect(badge).toHaveTextContent('Admin override');
    expect(badge).toHaveAttribute('title', expect.stringContaining('historical load'));
    expect(screen.queryByTestId(`override-${b!.id}`)).not.toBeInTheDocument();
  });

  it('shows in the task drawer with the missing documents, the cutoff date and the reason, and says how it clears', async () => {
    await signIn('pm');
    const grid = await api.get<{ stages: { tasks: { id: string }[] }[] }>(`/sites/${siteIdOf(0)}/tasks`);
    const id = grid.stages[0]!.tasks[0]!.id;
    const detail = await api.get<TaskDetail>(`/tasks/${id}`);
    server.use(http.get(`${API_BASE}/tasks/${id}`, () => HttpResponse.json({ ...detail, historical_no_documents: true,
      historical_load: { batch_id: 'b-1', cutoff_date: '2026-02-28', flagged_at: '2026-11-05T09:00:00Z', missing_documents: ['B6', 'B7'], reason: 'History of the Master' } })));
    renderApp(<TaskDrawer taskId={id} onClose={() => undefined} />);
    expect(await screen.findByTestId(`override-${id}`)).toHaveTextContent('Admin override');
    const note = screen.getByTestId('drawer-historical');
    expect(note).toHaveTextContent('B6, B7');
    expect(note).toHaveTextContent('2026-02-28');
    expect(note).toHaveTextContent('History of the Master');
    expect(note).toHaveTextContent('clears when the documents are uploaded');
  });

  it('is written in Arabic', async () => {
    renderApp(<OverrideBadge taskId="t-1" />, { locale: 'ar' });
    expect(screen.getByTestId('override-t-1')).toHaveTextContent('تجاوز إداري');
  });
});
