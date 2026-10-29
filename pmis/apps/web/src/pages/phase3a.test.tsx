import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, API_BASE, ApiError } from '@/api/client';
import { ExportDialog, ExportViewButton } from '@/components/ExportDialog';
import { uid } from '@/mocks/ids';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { Absence } from './Absence';
import { Delegation } from './Delegation';
import { UserDetailPage } from './UserDetail';
import { Users } from './Users';

const stepUpDone = () => api.post('/__mock/step-up');
const detailAt = (emp: string, opts = {}) => renderApp(<Routes><Route path="/admin/users/:userId" element={<UserDetailPage />} /></Routes>, { route: `/admin/users/${uid(emp)}`, ...opts });
const type = async (id: string, text: string) => userEvent.type(screen.getByTestId(id), text);

describe('assignment edit', () => {
  it('changes the level of an assignment and rolls back when the server refuses', async () => {
    await signIn('pm'); await stepUpDone();
    const u = userEvent.setup();
    detailAt('1204');
    const row = await screen.findByTestId(/^assignment-(?!select|level|list)/);
    const code = row.getAttribute('data-testid')!.replace('assignment-', '');
    const before = screen.getByTestId(`assignment-level-${code}`).textContent;
    await u.click(screen.getByTestId(`assignment-select-${code}`));
    await u.click(screen.getByTestId('detail-edit'));
    await u.selectOptions(screen.getByTestId('edit-level'), 'approve');
    // reason is mandatory
    await u.click(screen.getByTestId('edit-assignment-submit'));
    expect(await screen.findByTestId('edit-assignment-reason-error')).toBeInTheDocument();
    await type('edit-assignment-reason', 'Promoted to approver');
    await u.click(screen.getByTestId('edit-assignment-submit'));
    await waitFor(() => expect(screen.getByTestId(`assignment-level-${code}`)).toHaveTextContent('Approve'));

    // a refusal puts the old value back
    server.use(http.post(`${API_BASE}/assignments/bulk-update`, () => HttpResponse.json({ type: 'x', title: 'No', status: 403, code: 'action_forbidden' }, { status: 403 })));
    await u.click(screen.getByTestId(`assignment-select-${code}`));
    await u.click(screen.getByTestId('detail-edit'));
    await u.selectOptions(screen.getByTestId('edit-level'), 'view');
    await type('edit-assignment-reason', 'Try again');
    await u.click(screen.getByTestId('edit-assignment-submit'));
    expect(await screen.findByTestId('edit-assignment-error')).toBeInTheDocument();
    expect(screen.getByTestId(`assignment-level-${code}`)).toHaveTextContent('Approve');
    expect(before).not.toBe('Approve');
  });

  it('assigns a role to a pending user, who then becomes active', async () => {
    await signIn('pm'); await stepUpDone();
    const u = userEvent.setup();
    renderApp(<Users />);
    await waitFor(() => expect(screen.getByTestId('user-status-1211')).toHaveTextContent('Pending assignment'));
    await u.click(screen.getByTestId('user-select-1211'));
    await u.click(screen.getByTestId('users-assign'));
    const dlg = await screen.findByTestId('assign-dialog');
    await u.click(within(dlg).getByTestId('assign-mode-role'));
    await waitFor(() => expect(within(dlg).getByTestId('assign-role-select').querySelectorAll('option').length).toBeGreaterThan(3));
    await u.selectOptions(within(dlg).getByTestId('assign-role-select'), (within(dlg).getByTestId('assign-role-select').querySelectorAll('option')[3] as HTMLOptionElement).value);
    await u.type(within(dlg).getByTestId('assign-people-search'), 'Wael');
    await u.click(await within(dlg).findByTestId('assign-people-opt-1211'));
    // Confirm stays off until a preview of the same selection has run.
    expect(within(dlg).getByTestId('assign-dialog-submit')).toBeDisabled();
    await u.click(within(dlg).getByTestId('assign-preview'));
    expect(await within(dlg).findByTestId('assign-preview-done')).toHaveTextContent('1');
    await u.type(within(dlg).getByTestId('assign-dialog-reason'), 'New joiner');
    await u.click(within(dlg).getByTestId('assign-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('user-status-1211')).toHaveTextContent('Active'));
  });
});

describe('MFA exemption', () => {
  it('is disabled for yourself', async () => {
    await signIn('pm');
    detailAt('1001');
    expect(await screen.findByTestId('mfa-self-note')).toBeInTheDocument();
    expect(screen.getByTestId('mfa-set')).toBeDisabled();
    // and the server refuses it too
    await stepUpDone();
    await expect(api.put(`/users/${uid('1001')}/mfa-exemption`, { body: { reason: 'self' } })).rejects.toMatchObject({ status: 403, code: 'self_beneficiary' });
  });

  it('asks for step-up, then sets the exemption and shows the badge', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    detailAt('1204');
    await u.click(await screen.findByTestId('mfa-set'));
    await type('mfa-dialog-reason', 'Field laptop without authenticator');
    await u.click(screen.getByTestId('mfa-dialog-submit'));
    await u.click(await screen.findByTestId('stepup-cancel'));
    expect(await screen.findByTestId('mfa-dialog-error')).toBeInTheDocument();
    await stepUpDone();
    await u.click(screen.getByTestId('mfa-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('mfa-state')).toHaveTextContent('Exempt until revoked'));
    await waitFor(() => expect(screen.getByTestId('mfa-badge-1204')).toBeInTheDocument());
  });
});

describe('delegation', () => {
  it('blocks granting to yourself', async () => {
    await signIn('pm'); await stepUpDone();
    const u = userEvent.setup();
    renderApp(<Delegation />);
    await u.click(await screen.findByTestId('deleg-new'));
    await u.type(screen.getByTestId('deleg-to-search'), 'Ahmed');
    const own = await screen.findByTestId('deleg-to-opt-1001');
    expect(own).toBeDisabled();
    expect(screen.getByTestId('delegation-dialog-submit')).toBeDisabled();
    await expect(api.post('/delegations', { body: { to_user_id: uid('1001'), scope: 'full', valid_from: '2026-10-25T00:00:00Z', reason: 'self' } })).rejects.toMatchObject({ status: 403, code: 'self_beneficiary' });
  });

  it('grants to another person and lists it, then revokes', async () => {
    await signIn('pm'); await stepUpDone();
    const u = userEvent.setup();
    renderApp(<Delegation />);
    await u.click(await screen.findByTestId('deleg-new'));
    await u.type(screen.getByTestId('deleg-to-search'), 'Ali');
    await u.click(await screen.findByTestId('deleg-to-opt-1103'));
    await u.click(screen.getByTestId('deleg-right-reassign'));
    await type('delegation-dialog-reason', 'Cover during my leave');
    await u.click(screen.getByTestId('delegation-dialog-submit'));
    const row = await screen.findByTestId('deleg-row-1103');
    expect(row).toHaveTextContent('Reassign tasks');
    await u.click(screen.getByTestId('deleg-revoke-1103'));
    await type('revoke-dialog-reason', 'Back at work');
    await u.click(screen.getByTestId('revoke-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('deleg-row-1103')).not.toBeInTheDocument());
  });
});

describe('absence and cover', () => {
  it('needs a reason to reassign, offers only eligible people and keeps the SLA note', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Absence />);
    const list = await screen.findByTestId('alerts-absent');
    await waitFor(() => expect(within(list).getAllByRole('listitem').length).toBeGreaterThan(0));
    const before = Number(screen.getByTestId('alerts-count-absent').textContent);
    const first = within(list).getAllByRole('listitem')[0];
    const id = first.getAttribute('data-testid')!.replace('alert-', '');
    await u.click(screen.getByTestId(`alert-reassign-${id}`));
    expect(screen.getByTestId('cover-sla-note')).toHaveTextContent('not reset or paused');
    await u.click(screen.getByTestId('cover-dialog-submit'));
    expect(screen.getByTestId('cover-dialog-submit')).toBeDisabled(); // nobody picked yet
    await u.type(screen.getByTestId('cover-to-search'), 'Mona');
    await waitFor(() => expect(screen.queryByTestId('cover-to-opt-1102')).not.toBeInTheDocument()); // the absent holder is not eligible
    await u.clear(screen.getByTestId('cover-to-search'));
    await u.type(screen.getByTestId('cover-to-search'), 'Ali');
    await u.click(await screen.findByTestId('cover-to-opt-1103'));
    await u.click(screen.getByTestId('cover-dialog-submit'));
    expect(await screen.findByTestId('cover-dialog-reason-error')).toBeInTheDocument(); // reason required
    expect(screen.getByTestId('alerts-count-absent')).toHaveTextContent(String(before));
    await type('cover-dialog-reason', 'Sick leave until Thursday');
    await u.click(screen.getByTestId('cover-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('alerts-count-absent')).toHaveTextContent(String(before - 1)));
  });

  it('refuses a reassignment to someone who is absent', async () => {
    await signIn('pm');
    const r = await api.get<{ items: { task: { id: string } }[] }>('/reassignments/alerts', { query: { cause: 'absent' } });
    const err = await api.post('/tasks/reassign', { body: { scope: 'task', task_id: r.items[0].task.id, decision: 'reassign', to_user_id: uid('1102'), reason: 'test' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('not_eligible_holder');
  });

  it('shows the idle list', async () => {
    await signIn('pm');
    renderApp(<Absence />);
    await waitFor(() => expect(screen.getByTestId('alerts-count-idle')).toHaveTextContent('1'));
  });
});

describe('export', () => {
  it('starts a whole-project export and shows the job with a download', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<ExportDialog open onClose={() => {}} />);
    await u.click(await screen.findByTestId('export-start'));
    const row = await screen.findByTestId(/^export-row-/);
    await waitFor(() => expect(within(row).getByTestId(/^export-status-/)).toHaveTextContent('Ready'), { timeout: 5000 });
    expect(within(row).getByTestId(/^export-download-/)).toBeInTheDocument();
  });

  it('sends parts, never a view, and shows 403 denied parts', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    let body: Record<string, unknown> = {};
    server.use(http.post(`${API_BASE}/exports/master`, async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ type: 'x', title: 'No', status: 403, code: 'action_forbidden', errors: [{ path: '/parts/warehouse', code: 'export_denied' }] }, { status: 403 });
    }));
    renderApp(<ExportDialog open onClose={() => {}} />);
    await u.click(await screen.findByTestId('export-kind-parts'));
    await u.click(await screen.findByTestId('export-part-warehouse'));
    await u.click(screen.getByTestId('export-part-gecol'));
    await u.click(screen.getByTestId('export-start'));
    expect(await screen.findByTestId('export-error')).toHaveTextContent('Warehouse');
    expect(body.parts).toEqual(['warehouse', 'gecol']);
    expect(body.view).toBeUndefined();
  });

  it('shows the 422 problem and sends view (no parts) from Export current view', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    // both together are refused by the server
    await expect(api.post('/exports/master', { body: { parts: ['sites'], view: { source: 'sites', filters: {}, columns: ['site_code'] } } })).rejects.toMatchObject({ status: 422 });
    let body: Record<string, unknown> = {};
    server.use(http.post(`${API_BASE}/exports/master`, async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ id: 'job-1', kind: 'master_export', status: 'queued' }, { status: 202 });
    }));
    renderApp(<ExportViewButton testid="ev" source="sites" filters={{ region_id: '1' }} columns={['site_code', 'site_name']} />);
    await u.click(screen.getByTestId('ev'));
    await waitFor(() => expect(body.view).toEqual({ source: 'sites', filters: { region_id: '1' }, columns: ['site_code', 'site_name'] }));
    expect(body.parts).toBeUndefined();
    // and the dialog surfaces a 422
    server.use(http.post(`${API_BASE}/exports/master`, () => HttpResponse.json({ type: 'x', title: 'Bad', status: 422, code: 'validation_failed', errors: [{ path: '/as_of', code: 'future_date' }] }, { status: 422 })));
    renderApp(<ExportDialog open onClose={() => {}} />);
    await u.type(await screen.findByTestId('export-as-of'), '2026-10-25');
    await u.click(screen.getByTestId('export-start'));
    expect(await screen.findByTestId('export-error')).toHaveTextContent('/as_of future_date');
  });

  it('denies parts the caller may not export (reviewer, server side)', async () => {
    await signIn('reviewer');
    const err = await api.post('/exports/master', { body: { parts: ['procurement'] } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).problem.errors?.[0].path).toBe('/parts/procurement');
  });
});
