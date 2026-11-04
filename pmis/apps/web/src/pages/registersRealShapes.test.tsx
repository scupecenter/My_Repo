import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, API_BASE } from '@/api/client';
import type { Matrix, RegisterDefinition, RegisterRecord } from '@/api/types';
import { cellLevel, levelCode, levelKind, positionKind, usedLevels } from '@/lib/matrixLevels';
import { hasExpiry, patchData, sectionsFor, validateRecord, visibleData } from '@/lib/registerForms';
import { recId, REGISTER_DEFS } from '@/mocks/registersData';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { MatrixPage } from './Matrix';
import { RegisterPage } from './Register';

const Routed = () => <Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes>;
const at = (key: string, q = '') => ({ route: `/registers/${key}${q}` });
const def = (key: string): RegisterDefinition => REGISTER_DEFS.find((d) => d.register_key === key)!;

describe('matrix levels (owner decision 2026-11-01): two fixed levels, L1 = cell 1 and L2 = cell 3', () => {
  it('maps the positions of a path to the cells', () => {
    expect(usedLevels()).toEqual([1, 3]);
    expect([1, 2, 3].map(levelCode)).toEqual(['L1', 'L2', 'L2']);
    // a task or record submitted before the change finishes on its frozen 3-level snapshot (B7): its middle position is cell 2
    expect([cellLevel(1, 3), cellLevel(2, 3), cellLevel(3, 3)]).toEqual([1, 2, 3]);
    expect([cellLevel(1, 2), cellLevel(2, 2)]).toEqual([1, 3]);   // the last position of a 2-level path is Approve (cell 3), not cell 2
    expect(cellLevel(1, 1)).toBe(1);
    expect([1, 2, 3].map(levelKind)).toEqual(['entry', 'review', 'approve']);
    expect(positionKind(2, 2)).toBe('approve');
  });
});

describe('Matrix page with two fixed levels', () => {
  it('shows the L1 and L2 columns (cells 1 and 3) and no level-count choice, and saves the L2 holder as cell level 3', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    renderApp(<MatrixPage />, { route: '/admin/matrix' });
    const u = userEvent.setup();
    await screen.findByTestId('matrix-row-cw');
    expect(screen.queryByTestId('matrix-levels-cw')).not.toBeInTheDocument();    // the number of levels is not configurable
    expect(screen.getByTestId('matrix-col-l1')).toHaveTextContent('L1');
    expect(screen.getByTestId('matrix-col-l2')).toHaveTextContent('L2');
    expect(screen.getByTestId('matrix-cell-cw-1')).toHaveAttribute('data-level-code', 'L1');
    expect(screen.getByTestId('matrix-cell-cw-3')).toHaveAttribute('data-level-code', 'L2');
    const approve = screen.getByTestId('matrix-cell-cw-3');                       // L2 is cell 3, not cell 2
    expect(screen.queryByTestId('matrix-cell-cw-2')).not.toBeInTheDocument();
    await u.click(within(approve).getByTestId('matrix-add'));
    await u.type(await screen.findByTestId('matrix-picker-q'), 'Hana');
    await u.click(await screen.findByTestId('matrix-opt-user-1210'));
    await u.click(screen.getByTestId('matrix-publish'));
    await u.type(screen.getByTestId('matrix-reason'), 'CW L2 holder');
    await u.click(screen.getByTestId('matrix-publish-confirm'));
    await waitFor(() => expect(screen.getByTestId('matrix-dirty')).toHaveTextContent('0'));
    const m = await api.get<Matrix>('/matrix');
    const cw = m.stages.find((s) => s.code === 'cw')!;
    expect(cw.approval_levels).toBe(2);
    expect(cw.used_levels).toEqual([1, 3]);
    expect(cw.cells.find((c) => c.level === 3)!.assignees.map((a) => a.employee_id)).toContain('1210');
    expect(cw.cells.find((c) => c.level === 2)!.used).toBe(false);               // kept for tasks in flight
    expect(screen.queryByTestId('matrix-cell-cw-2')).not.toBeInTheDocument();
    expect(await screen.findByTestId('matrix-cell-cw-3')).toBeInTheDocument();
  }, 30_000); // ~3.5 s of user steps when idle; over the 5 s default under CI's parallel workers

  it('shows the self-approval when the same person holds L1 and L2, from the server and live while editing', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    renderApp(<MatrixPage />, { route: '/admin/matrix' });
    const u = userEvent.setup();
    // the server copy: one person holds L1 and L2 of Final Closure
    expect(await screen.findByTestId('matrix-skip-final_closure')).toHaveTextContent(/hold L1 and L2/);
    expect(screen.getByTestId('matrix-skip-final_closure')).toHaveTextContent(/final approval/);
    expect(screen.getByTestId('matrix-skip-site_release')).toHaveTextContent('—');
    // live: put 1102 on L2 of CW, which has her on neither level yet
    expect(screen.getByTestId('matrix-skip-cw')).toHaveTextContent('—');
    await u.click(within(screen.getByTestId('matrix-cell-cw-1')).getByTestId('matrix-add'));
    await u.type(await screen.findByTestId('matrix-picker-q'), 'Mona');
    await u.click(await screen.findByTestId('matrix-opt-user-1102'));
    await u.click(within(screen.getByTestId('matrix-cell-cw-3')).getByTestId('matrix-add'));
    await u.type(await screen.findByTestId('matrix-picker-q'), 'Mona');
    await u.click(await screen.findByTestId('matrix-opt-user-1102'));
    await waitFor(() => expect(screen.getByTestId('matrix-skip-cw')).toHaveTextContent(/Mona Fathi hold L1 and L2/));
    expect(screen.getByTestId('matrix-warn-self-cw')).toBeInTheDocument();
  }, 30_000);

  it('grants one person both levels with one click, and saves both cells', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    renderApp(<MatrixPage />, { route: '/admin/matrix' });
    const u = userEvent.setup();
    await screen.findByTestId('matrix-row-te_installation');
    await u.click(within(screen.getByTestId('matrix-cell-te_installation-1')).getByTestId('matrix-add'));
    await u.type(await screen.findByTestId('matrix-picker-q'), 'Hana');
    await u.click(await screen.findByTestId('matrix-both-user-1210'));
    await waitFor(() => expect(within(screen.getByTestId('matrix-cell-te_installation-1')).getByTestId('person-id-1210')).toBeInTheDocument());
    expect(within(screen.getByTestId('matrix-cell-te_installation-3')).getByTestId('person-id-1210')).toBeInTheDocument();
    expect(screen.getByTestId('matrix-dirty')).toHaveTextContent('2');
    expect(screen.getByTestId('matrix-warn-self-te_installation')).toBeInTheDocument();
    await u.click(screen.getByTestId('matrix-publish'));
    await u.type(screen.getByTestId('matrix-reason'), 'Grant both levels');
    await u.click(screen.getByTestId('matrix-publish-confirm'));
    await waitFor(() => expect(screen.getByTestId('matrix-dirty')).toHaveTextContent('0'));
    const row = (await api.get<Matrix>('/matrix')).stages.find((x) => x.code === 'te_installation')!;
    for (const level of [1, 3]) expect(row.cells.find((c) => c.level === level)!.assignees.map((a) => a.employee_id)).toContain('1210');
    expect(row.cells.find((c) => c.level === 1)!.skip_preview?.map((x) => x.display_name)).toContain('Hana Zidan');
  }, 30_000);

  it('names the level that has no holder from Problem.cells of the 422 empty_cell answer, not from errors[]', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    server.use(http.patch(`${API_BASE}/matrix`, () => HttpResponse.json({
      type: 'x', title: 'A level in use has no holder', status: 422, code: 'empty_cell', detail: 'Every level in use needs at least one holder.',
      cells: [{ stage_code: 'cw', task_code: null, level: 3, level_kind: 'approve', region_id: null }],
    }, { status: 422, headers: { 'Content-Type': 'application/problem+json' } })));
    renderApp(<MatrixPage />, { route: '/admin/matrix' });
    const u = userEvent.setup();
    await u.click(within(await screen.findByTestId('matrix-cell-cw-1')).getByTestId('matrix-add'));
    await u.type(await screen.findByTestId('matrix-picker-q'), 'Hana');
    await u.click(await screen.findByTestId('matrix-opt-user-1210'));
    await u.click(screen.getByTestId('matrix-publish'));
    await u.type(screen.getByTestId('matrix-reason'), 'Edit L1');
    await u.click(screen.getByTestId('matrix-publish-confirm'));
    expect(await screen.findByTestId('matrix-error')).toHaveTextContent('CW: L2 (Reviewer & Approver) has no holder');
    expect(screen.getByTestId('matrix-cell-cw-3')).toHaveAttribute('data-refused', 'true');
  }, 30_000);
});

describe('register forms follow the real field definitions', () => {
  it('uses the server sections (RegisterField.section) in the order the fields come, and the real codes', () => {
    const g = def('gecol');
    expect(sectionsFor(g, {}).map((s) => s.id)).toEqual(['request', 'survey', 'notice', 'acceptance', 'meter', 'remark']);
    expect(sectionsFor(g, {}).flatMap((s) => s.fields.map((f) => f.code))).toEqual(expect.arrayContaining(
      ['request_date', 'installation_finish', 'aat_acceptance_date', 'docs_approval_date', 'power_on_date', 'billing_conversion_date']));
    expect(def('hlc').fields.map((f) => f.code)).toEqual(expect.arrayContaining(['installation_date', 'tx_link_tested_date']));
    // a section name the web does not know is shown as the server gives it; a custom field (no section) lands in "details"
    const custom = { ...def('hlc'), fields: [...def('hlc').fields, { code: 'x', label_en: 'X', type: 'text' as const, section: 'Fresh section' }, { code: 'y', label_en: 'Y', type: 'text' as const, is_custom: true }] };
    const ss = sectionsFor(custom, {});
    expect(ss.find((s) => s.title === 'Fresh section')?.id).toBe('fresh_section');
    expect(ss.at(-1)).toMatchObject({ id: 'details' });
  });

  it('shows the N/A and PTW sections of a permit only when they apply, by the real values (status "N/A", permit type "PTW - ...")', () => {
    const p = def('permits_hse');
    const ids = (d: Record<string, unknown>) => sectionsFor(p, d).map((s) => s.id);
    expect(ids({})).not.toContain('ptw');
    expect(ids({ permit_type: 'PTW - TE' })).toEqual(expect.arrayContaining(['ptw', 'stop']));
    expect(ids({ status: 'N/A' })).toContain('na');
    expect(ids({ status: 'Applied' })).not.toContain('na');
    expect(hasExpiry({})).toBe(true);
  });

  it('never sends a system-filled field, and clears with null what the user emptied or hid', () => {
    const p = def('permits_hse');
    const before = { permit_type: 'Access - CW', status: 'N/A', na_reason: 'x', na_approved_by: 'Someone', valid_to: '2027-01-01', remark: 'old' };
    expect(visibleData(p, { ...before, status: 'N/A' })).not.toHaveProperty('na_approved_by');
    const after = { ...before, status: 'Applied', remark: '', has_expiry: false };
    const patch = patchData(p, before, after);
    expect(patch).toMatchObject({ status: 'Applied', has_expiry: false, na_reason: null, valid_to: null, remark: null });
    expect(patch).not.toHaveProperty('na_approved_by');   // derived: the server fills it
  });

  it('checks the rules the server enforces, on the real values', () => {
    const codes = (key: string, data: Record<string, unknown>) => Object.keys(validateRecord(def(key), data, 'site', '2026-10-30'));
    expect(codes('procurement', { scope: 'TE Installation', order_status: 'Open', pr_no: 'P' })).toContain('scope');
    expect(codes('procurement', { scope: 'CW', order_status: 'Open', delivery: 'In-House', pr_no: 'P' })).toContain('pr_no');
    expect(codes('procurement', { scope: 'CW', order_status: 'Open', delivery: 'Outsourced', po_wo_no: 'PO' })).toContain('pr_no');
    expect(codes('gecol', { pr_no: 'G', request_date: '2026-09-10', installation_finish: '2026-09-01' })).toContain('installation_finish');
    expect(codes('hlc', { installation_date: '2026-09-20', tx_link_tested_date: '2026-09-10' })).toContain('tx_link_tested_date');
    expect(codes('hlc', { tx_link_tested_date: '2026-09-10', in_service_date: '2026-09-09' })).toEqual(['in_service_date']);    // 0042: operation not before the test
    expect(codes('hlc', { link_received_date: '2026-09-20', installation_date: '2026-09-10' })).toEqual([]);                   // any other order only warns (Q96)
    expect(codes('procurement', { scope: 'HLC', order_status: 'Open' })).toEqual(expect.arrayContaining(['pr_no', 'pr_date']));   // 0042: an HLC request needs its PR
    expect(codes('permits_hse', { permit_type: 'Access - CW', status: 'Approved' })).toEqual(expect.arrayContaining(['valid_from', 'valid_to']));
    expect(codes('permits_hse', { permit_type: 'Access - CW', status: 'Applied' })).toEqual([]);
    expect(codes('gecol', { pr_no: 'G', request_date: '2026-12-31' })).toContain('request_date');   // an actual date in the future
  });
});

describe('register drawer with the real record shape', () => {
  it('links the source task from RegisterRecord.task, not from the data', async () => {
    await signIn('pm');
    const real: RegisterRecord = { ...(await api.get<RegisterRecord>(`/registers/procurement/records/${recId(1)}`)), task: { id: '60000000-0000-4000-8000-000000000999', task_code: 'B2' } };
    server.use(http.get(`${API_BASE}/registers/procurement/records/${recId(1)}`, () => HttpResponse.json({ ...real, data: { ...real.data, source_task_id: 'old-field-must-be-ignored' } })));
    renderApp(<Routed />, at('procurement', `?record=${recId(1)}`));
    const link = await screen.findByTestId('reg-source-link');
    expect(link).toHaveTextContent('B2');
    expect(link.getAttribute('href')).toBe(`/sites/${real.site_id}?task=60000000-0000-4000-8000-000000000999`);
  });

  it('shows no source link for a record without a task', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('procurement', `?record=${recId(2)}`));
    await screen.findByTestId('register-drawer-body');
    expect(screen.queryByTestId('reg-source')).not.toBeInTheDocument();
  });

  it('shows the history steps of the real endpoint, and claim and release call the real paths with If-Match', async () => {
    await signIn('pm');
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => { if (/\/registers\/procurement\/records\/.+\/(claim|release|history)$/.test(request.url)) seen.push(`${request.method} ${new URL(request.url).pathname.split('/').slice(-1)[0]} ${request.headers.get('If-Match') ?? ''}`); });
    renderApp(<Routed />, at('procurement', `?record=${recId(2)}`));
    const hist = await screen.findByTestId('reg-history');
    await waitFor(() => expect(seen.some((x) => x.startsWith('GET history'))).toBe(true));
    expect(hist).toBeInTheDocument();
    const r = await api.get<RegisterRecord>(`/registers/procurement/records/${recId(2)}`);
    await api.post(`/registers/procurement/records/${recId(2)}/claim`, { version: r.version });
    expect(seen.some((x) => x.startsWith('POST claim "'))).toBe(true);
    const claimed = await api.get<RegisterRecord>(`/registers/procurement/records/${recId(2)}`);
    expect(claimed.ball_in_court?.claimed_by).toBeTruthy();
    await api.post(`/registers/procurement/records/${recId(2)}/release`, { version: claimed.version });
    expect(seen.some((x) => x.startsWith('POST release "'))).toBe(true);
    server.events.removeAllListeners();
  });

  it('creates a new version of an approved record (versions endpoints) and lists them newest first', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('procurement', `?record=${recId(1)}`));
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('reg-new-version'));
    await waitFor(() => expect(screen.getByTestId('reg-state')).toHaveTextContent('Entry'));
    const list = await api.get<{ items: RegisterRecord[] }>(`/registers/procurement/records/${recId(1)}/versions`);
    expect(list.items.map((v) => v.version_no)).toEqual([2, 1]);
    expect(list.items[0]!.supersedes_id).toBe(recId(1));
    expect(list.items[1]!.is_current).toBe(true);                                // the approved one stays in force until the new one is approved
    const latest = await api.get<{ items: RegisterRecord[] }>('/registers/procurement/records');
    expect(latest.items.filter((r) => r.entity_id === recId(1)).map((r) => r.version_no)).toEqual([2]);   // the list shows the latest version of each logical record
  });
});

describe('Dismantle register (migration 0021): CW / TE parts and the server rules shown as they come', () => {
  const site = (code: string) => api.get<{ items: { id: string }[] }>('/sites', { query: { q: code } }).then((r) => r.items[0]!.id);

  it('serves the two parts and the 0021 fields; the page lists the seeded rows with their part', async () => {
    await signIn('pm');
    const defs = await api.get<{ items: RegisterDefinition[] }>('/registers');
    const d = defs.items.find((x) => x.register_key === 'dismantle')!;
    expect(d.record_types).toEqual(['cw', 'te']);
    expect(d.fields.map((f) => f.code)).toEqual(['rfd_date', 'rfd_document_ref', 'dismantle_reason', 'execution_mode', 'procurement_order_id', 'internal_team', 'supervising_engineer', 'work_start_date', 'work_end_date', 'closing_rn_ref', 'closed']);
    renderApp(<Routed />, at('dismantle'));
    expect(await screen.findByTestId('page-register-dismantle')).toBeInTheDocument();
    expect(await screen.findByTestId(`reg-row-${recId(12)}`)).toHaveTextContent('CW');
    expect(screen.getByTestId(`reg-row-${recId(13)}`)).toHaveTextContent('TE');
  });

  it('answers the 422 rules with /data/<code> paths: RFD first, end after start, closed needs the RN', async () => {
    await signIn('pm');
    const site_id = await site('TR101');
    const fail = (data: Record<string, unknown>) => api.post('/registers/dismantle/records', { body: { site_id, record_type: 'te', data } }).then(() => [], (e) => (e.problem.errors as { path: string; code: string }[]).map((x) => `${x.path}:${x.code}`));
    expect(await fail({ work_start_date: '2026-10-01' })).toEqual(['/data/work_start_date:rfd_required']);
    expect(await fail({ rfd_date: '2026-09-01', work_start_date: '2026-10-05', work_end_date: '2026-10-01' })).toEqual(['/data/work_end_date:end_before_start']);
    expect(await fail({ rfd_date: '2026-09-01', closed: true })).toEqual(['/data/closing_rn_ref:rn_required']);
  });

  it('shows the server sentence under the field, translated when the code is known and as sent when it is not', async () => {
    await signIn('pm');
    server.use(http.post(`${API_BASE}/registers/dismantle/records`, () => HttpResponse.json({ type: 'x', title: 'Bad', status: 422, code: 'validation_failed', errors: [
      { path: '/data/work_end_date', code: 'end_before_start', message: 'The work end is before the work start.' },
      { path: '/data/work_start_date', code: 'before_rfd', message: 'Work cannot start before the RFD date.' },
    ] }, { status: 422 })));
    renderApp(<Routed />, at('dismantle'));
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('register-new'));
    await u.type(await screen.findByTestId('reg-site-search'), 'WM103');
    await u.click(await screen.findByTestId('reg-site-opt-WM103'));
    await u.selectOptions(screen.getByTestId('reg-record-type'), 'cw');
    await u.type(screen.getByTestId('reg-field-rfd_date'), '2026-09-01');
    await u.click(screen.getByTestId('reg-save'));
    expect(await screen.findByTestId('reg-error-work_end_date')).toHaveTextContent('The work end is before the work start.');
    expect(screen.getByTestId('reg-error-work_start_date')).toHaveTextContent('Work cannot start before the RFD date.');
  });

  it('refuses a second first-version CW part on a site that has one (TR101 is seeded) with 409 duplicate', async () => {
    await signIn('pm');
    const site_id = await site('TR101');
    const body = { site_id, record_type: 'cw', data: { rfd_date: '2026-09-01' } };
    const code = await api.post('/registers/dismantle/records', { body }).then(() => '', (e) => `${e.status}:${e.code}`);
    expect(code).toBe('409:duplicate');
  });
});
