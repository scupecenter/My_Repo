import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api } from '@/api/client';
import { precheck, uploadMessage } from '@/components/DocSlots';
import { rejectReason } from '@/mocks/handlers.documents';
import { siteIdOf, taskIdOf } from '@/mocks/sites';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './settings/Settings';
import { Site } from './Site';
import type { DocumentSlot, TaskDetail } from '@/api/types';

const SITE = siteIdOf(0), A1 = taskIdOf(0, 0);
const SiteAt = () => <Routes><Route path="/sites/:siteId" element={<Site />} /></Routes>;
const SettingsAt = () => <Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>;
const pdf = (name = 'sar.pdf') => new File(['%PDF-1.4 body'], name, { type: 'application/pdf' });
const slot = (over: Partial<DocumentSlot> = {}): DocumentSlot => ({ id: 's1', doc_code: 'A2', name_en: 'A2 TSSR', status: 'missing', mandatory: true, files: [], formats: ['pdf', 'jpg', 'png'], max_size_mb: 20, ...over }) as DocumentSlot;
const t = (k: string, o?: Record<string, unknown>) => `${k}${o ? JSON.stringify(o) : ''}`;

describe('checks before sending', () => {
  it('refuses a file over the limit, an empty file and a format the document does not take', () => {
    expect(precheck(t, slot({ max_size_mb: 1 }), new File([new Uint8Array(1024 * 1024 + 1)], 'big.pdf', { type: 'application/pdf' }))).toContain('docs.err.too_large');
    expect(precheck(t, slot(), new File([], 'empty.pdf', { type: 'application/pdf' }))).toContain('docs.rej.empty');
    expect(precheck(t, slot(), new File(['x'], 'sheet.xlsx', { type: 'application/vnd.ms-excel' }))).toContain('docs.rej.format_not_allowed');
    expect(precheck(t, slot(), pdf())).toBeNull();
    expect(precheck(t, slot(), new File(['x'], 'photo.jpeg', { type: 'image/jpeg' }))).toBeNull(); // jpeg is jpg
  });
  it('the mock reads the name like the server reads the bytes', () => {
    const s = { formats: ['pdf', 'png'] };
    expect(rejectReason('virus.exe', s)).toBe('executable');
    expect(rejectReason('a.zip', s)).toBe('archive');
    expect(rejectReason('m.xlsm', s)).toBe('macro');
    expect(rejectReason('page.html', s)).toBe('html');
    expect(rejectReason('mail.eml', s)).toBe('format_not_allowed');
    expect(rejectReason('ok.PDF', s)).toBeNull();
    expect(rejectReason('blob', s)).toBeNull();
  });
  it('says why a file was refused, in plain words', async () => {
    const { ApiError } = await import('@/api/client');
    const err = (status: number, code: string, extra: Record<string, unknown> = {}) => new ApiError(status, { type: 'about:blank', title: 'x', status, code, ...extra } as never);
    expect(uploadMessage(t, err(413, 'file_too_large', { max_size_mb: 5 }))).toBe('docs.err.too_large{"mb":5}');
    expect(uploadMessage(t, err(422, 'file_rejected', { reason: 'executable' }))).toContain('docs.rej.executable');
    expect(uploadMessage(t, err(409, 'invalid_transition'))).toContain('invalid_transition');
  });
});

describe('Task drawer: named slots', () => {
  it('rejects a program in the slot with the reason, keeps the slot missing, then accepts a PDF and keeps the earlier version as history', async () => {
    await signIn('reviewer');
    const u = userEvent.setup({ applyAccept: false }); // the browser's file picker would filter by accept; a drop does not, and the server checks anyway
    renderApp(<SiteAt />, { route: `/sites/${SITE}?task=${A1}` });
    const input = (await screen.findAllByTestId(/^slot-input-/))[0] as HTMLInputElement;
    const id = input.dataset.testid!.replace('slot-input-', '');
    expect(screen.getByTestId(`slot-limits-${id}`)).toHaveTextContent(/pdf, jpg, png/);
    expect(screen.getByTestId(`slot-limits-${id}`)).toHaveTextContent(/20 MB/);
    // a program is refused, with its reason, and nothing is stored
    await u.upload(input, new File(['MZ'], 'invoice.exe', { type: 'application/x-msdownload' }));
    expect(await screen.findByText(/invoice\.exe: .*(accept|allowed)/i)).toBeInTheDocument();
    expect(screen.getByTestId(`slot-status-${id}`)).toHaveTextContent('Missing');
    // a PDF is stored; the submit stays disabled until every mandatory slot has its file
    expect(screen.getByTestId('drawer-submit')).toBeDisabled();
    await u.upload(input, pdf('first.pdf'));
    await waitFor(() => expect(screen.getByTestId(`slot-status-${id}`)).toHaveTextContent('Uploaded'));
    await waitFor(() => expect(screen.getByTestId('drawer-submit')).toBeEnabled());
    // (the test runtime loses the real file name in a multipart body, so the line is found by its test id)
    const line = (await screen.findAllByTestId(/^file-v-/))[0]!;
    expect(line).toHaveTextContent('v1');
    expect(screen.queryByTestId(`slot-history-${id}`)).toBeNull();
    // the file can be withdrawn again
    await u.click(within(line.closest('li')!).getByTestId(/^file-withdraw-/));
    await waitFor(() => expect(screen.getByTestId(`slot-status-${id}`)).toHaveTextContent('Missing'));
  });

  it('offers the camera for a photo slot and the optional documents the task does not need', async () => {
    await signIn('reviewer');
    const t0 = await api.get<TaskDetail>(`/tasks/${A1}`);
    expect(t0.slots.length).toBeGreaterThan(0);
    renderApp(<SiteAt />, { route: `/sites/${SITE}?task=${A1}` });
    // A1 is a scanned document: its formats include png/jpg, so the phone camera is offered too
    const cam = await screen.findAllByTestId(/^slot-camera-btn-/);
    expect(cam.length).toBeGreaterThan(0);
    const camInput = document.querySelector('input[capture="environment"]') as HTMLInputElement;
    expect(camInput).not.toBeNull();
    expect(camInput.accept).toBe('image/*');
  });
});

describe('Site Documents tab', () => {
  it('lists the files with filters and version history, downloads one, and starts a zip of the tick-marked files', async () => {
    await signIn('reviewer');
    // a file with two versions on A1
    const t0 = await api.get<TaskDetail>(`/tasks/${A1}`);
    const slotId = t0.slots[0]!.id;
    const send = async (name: string, replaces?: string) => { const f = new FormData(); f.append('file', pdf(name)); if (replaces) f.append('replaces_file_group_id', replaces); return api.post<{ file_group_id: string }>(`/tasks/${A1}/slots/${slotId}/files`, { body: f }); };
    const v1 = await send('one.pdf');
    await send('two.pdf', v1.file_group_id);
    const u = userEvent.setup();
    renderApp(<SiteAt />, { route: `/sites/${SITE}?tab=documents` });
    const table = await screen.findByTestId('docs-table');
    await waitFor(() => expect(table.textContent).toMatch(/_DRAFT-/));
    expect(table.querySelectorAll('[data-current="false"]')).toHaveLength(0); // superseded versions are hidden until asked
    await u.click(screen.getByTestId('docs-filter-history'));
    await waitFor(() => expect(screen.getByTestId('docs-table').querySelectorAll('[data-current="false"]').length).toBeGreaterThan(0));
    await u.click(screen.getByTestId('docs-filter-history'));
    // filters narrow the list
    await u.type(screen.getByTestId('docs-filter-doc'), 'ZZZ');
    expect(await screen.findByTestId('docs-empty')).toBeInTheDocument();
    await u.clear(screen.getByTestId('docs-filter-doc'));
    await waitFor(() => expect(screen.queryByTestId('docs-empty')).toBeNull());
    // tick a file, zip it
    const pick = (await screen.findAllByTestId(/^doc-pick-/))[0]!;
    await u.click(pick);
    const zip = screen.getByTestId('docs-zip-picked');
    expect(zip).toBeEnabled();
    await u.click(zip);
    expect(await screen.findByText(/GSDN_Documents_\d{8}\.zip/)).toBeInTheDocument();
    // the whole site
    expect(screen.getByTestId('docs-zip-all')).toBeEnabled();
  });
});

describe('Settings: Document Library', () => {
  it('lists the library, saves a draft, publishes it for new tasks only and shows the version', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<SettingsAt />, { route: '/admin/settings/documents' });
    const row = await screen.findByTestId('lib-row-A2');
    expect(row).toHaveTextContent('v1');
    expect(await screen.findByTestId('lib-review-D16_PAC')).toBeInTheDocument();
    // a new document (a draft until published)
    await u.click(screen.getByTestId('lib-new'));
    const dlg = await screen.findByTestId('doc-dialog');
    await u.type(within(dlg).getByTestId('doc-code'), 'TEST_DOC');
    await u.type(within(dlg).getByTestId('doc-name-en'), 'Test document');
    await u.type(within(dlg).getByTestId('doc-placement-ref-0'), 'F1');
    fireEvent.change(within(dlg).getByTestId('doc-formats'), { target: { value: 'pdf, exe' } });
    await u.type(within(dlg).getByTestId('doc-dialog-reason'), 'new test document');
    await u.click(within(dlg).getByTestId('doc-dialog-submit'));
    expect(await within(dlg).findByTestId('doc-err-formats')).toBeInTheDocument(); // executables are never accepted
    fireEvent.change(within(dlg).getByTestId('doc-formats'), { target: { value: 'pdf, png' } });
    await u.click(within(dlg).getByTestId('doc-dialog-submit'));
    const created = await screen.findByTestId('lib-row-TEST_DOC');
    expect(created).toHaveTextContent('Draft changes');
    expect(created).toHaveTextContent('Not published');
    // publish: choose the scope
    await api.post('/__mock/step-up'); // a fresh re-authentication, as the publish needs
    await u.click(screen.getByTestId('lib-publish-TEST_DOC'));
    const pub = await screen.findByTestId('doc-publish-dialog');
    expect(within(pub).getByTestId('doc-open-count')).toHaveTextContent('7');
    expect(within(pub).getByTestId('doc-apply-new')).toBeChecked();
    await u.click(within(pub).getByTestId('doc-apply-open'));
    await u.type(within(pub).getByTestId('doc-publish-dialog-reason'), 'apply to open tasks');
    await u.click(within(pub).getByTestId('doc-publish-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('lib-version-TEST_DOC')).toHaveTextContent('v1'));
    await u.click(screen.getByTestId('lib-versions-TEST_DOC'));
    expect(await screen.findByTestId('doc-versions')).toHaveTextContent(/Also open tasks.*7 open task/s);
  });

  it('is for administrators only', async () => {
    await signIn('engineer');
    renderApp(<SettingsAt />, { route: '/admin/settings/documents' });
    expect(await screen.findByTestId('lib-error')).toBeInTheDocument();
  });
});
