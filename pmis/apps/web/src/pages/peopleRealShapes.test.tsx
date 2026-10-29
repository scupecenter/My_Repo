import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { api, API_BASE, ApiError } from '@/api/client';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { Assignments } from './Assignments';
import { Profiles } from './Profiles';
import { Roles } from './Roles';

const stepUpDone = () => api.post('/__mock/step-up');
const problem = (status: number, code: string, extra = {}) => HttpResponse.json({ type: 'x', title: code, status, code, ...extra }, { status });

async function openAssign(u: ReturnType<typeof userEvent.setup>) {
  renderApp(<Assignments />);
  const sel = await screen.findByTestId('assignments-role');
  await waitFor(() => expect(sel.querySelectorAll('option').length).toBeGreaterThan(3));
  await u.selectOptions(sel, (sel.querySelectorAll('option')[3] as HTMLOptionElement).value);
  await u.click(screen.getByTestId('assignments-assign'));
  return screen.findByTestId('assign-dialog');
}

describe('bulk assign by role', () => {
  it('selects many people, previews, then confirms; the confirm button waits for a fresh preview', async () => {
    await signIn('pm'); await stepUpDone();
    const u = userEvent.setup();
    const dlg = await openAssign(u);
    await u.type(within(dlg).getByTestId('assign-people-search'), 'ar');
    await u.click(await within(dlg).findByTestId('assign-people-add-all'));
    const n = Number(/\d+/.exec(within(dlg).getByTestId('assign-people-count').textContent ?? '')?.[0]);
    expect(n).toBeGreaterThan(1);
    expect(within(dlg).getByTestId('assign-dialog-submit')).toBeDisabled();
    await u.click(within(dlg).getByTestId('assign-preview'));
    const done = await within(dlg).findByTestId('assign-preview-done');
    expect(within(dlg).getByTestId('assign-preview-skipped')).toBeInTheDocument();
    expect(Number(/\d+/.exec(done.textContent ?? '')?.[0])).toBeGreaterThan(0);
    // changing the selection makes the preview stale
    await u.selectOptions(within(dlg).getByTestId('assign-level'), 'approve');
    expect(within(dlg).queryByTestId('assign-preview-panel')).toBeNull();
    expect(within(dlg).getByTestId('assign-dialog-submit')).toBeDisabled();
    await u.click(within(dlg).getByTestId('assign-preview'));
    await within(dlg).findByTestId('assign-preview-panel');
    await u.type(within(dlg).getByTestId('assign-dialog-reason'), 'Bulk join');
    await u.click(within(dlg).getByTestId('assign-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('assign-dialog')).toBeNull());
    await waitFor(() => expect(screen.getAllByTestId(/^assignment-row-/).length).toBeGreaterThan(1));
  });

  it('shows per-row refusals: self_beneficiary leaves nothing to confirm', async () => {
    await signIn('pm'); await stepUpDone();
    const u = userEvent.setup();
    const dlg = await openAssign(u);
    await u.type(within(dlg).getByTestId('assign-people-search'), 'Ahmed');
    await u.click(await within(dlg).findByTestId('assign-people-opt-1001'));
    await u.click(within(dlg).getByTestId('assign-preview'));
    expect(await within(dlg).findByTestId('assign-preview-fails-self_beneficiary')).toBeInTheDocument();
    expect(within(dlg).getByTestId('assign-dialog-submit')).toBeDisabled();
  });

  it('too_many_rows from the server is shown in words', async () => {
    await signIn('pm'); await stepUpDone();
    server.use(http.post(`${API_BASE}/assignments/bulk-assign`, () => problem(422, 'validation_failed', { errors: [{ path: '/user_ids', code: 'too_many_rows' }] })));
    const u = userEvent.setup();
    const dlg = await openAssign(u);
    await u.type(within(dlg).getByTestId('assign-people-search'), 'Mona');
    await u.click(await within(dlg).findByTestId('assign-people-opt-1102'));
    await u.click(within(dlg).getByTestId('assign-preview'));
    expect(await within(dlg).findByTestId('assign-dialog-error')).toHaveTextContent('Too many rows');
  });
});

describe('real response shapes', () => {
  it('the mocked assignments list pages by cursor and reports the total', async () => {
    await signIn('pm');
    const first = await api.get<{ items: unknown[]; page: { next_cursor: string | null; total: number } }>('/assignments', { query: { limit: 3 } });
    expect(first.items).toHaveLength(3);
    expect(first.page.next_cursor).not.toBeNull();
    expect(first.page.total).toBeGreaterThan(3);
  });

  it('a delegation cannot be limited to modules: 422 not_supported, and module_codes reads back []', async () => {
    await signIn('pm'); await stepUpDone();
    const body = { scope: 'full', target_kind: 'group', target_id: (await api.get<{ items: { id: string }[] }>('/groups')).items[0].id, valid_from: '2026-10-25T00:00:00Z', reason: 'cover', region_codes: [], allow_redelegate: false };
    const err = await api.post('/delegations', { body: { ...body, module_codes: ['sites'] } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).problem.errors?.[0]).toMatchObject({ path: '/module_codes', code: 'not_supported' });
    await api.post('/delegations', { body: { ...body, module_codes: [] } });
    const list = await api.get<{ items: { module_codes: string[] }[] }>('/delegations');
    expect(list.items.every((d) => d.module_codes.length === 0)).toBe(true);
  });

  it('PATCH /roles and PUT /permission-profiles need If-Match (428) and refuse a stale one (412)', async () => {
    await signIn('pm'); await stepUpDone();
    const roles = (await api.get<{ items: { id: string; version: number }[] }>('/roles')).items;
    const miss = await api.patch(`/roles/${roles[0].id}`, { body: { name_en: 'X', reason: 'abc' } }).catch((e: unknown) => e);
    expect((miss as ApiError).status).toBe(428);
    const stale = await api.patch(`/roles/${roles[0].id}`, { version: 999, body: { name_en: 'X', reason: 'abc' } }).catch((e: unknown) => e);
    expect((stale as ApiError).status).toBe(412);
    const prof = (await api.get<{ items: { id: string; code: string; version: number }[] }>('/permission-profiles')).items[0];
    const put = await api.put(`/permission-profiles/${prof.id}`, { version: 999, body: { code: prof.code, name_en: 'X', grants: [], reason: 'abc' } }).catch((e: unknown) => e);
    expect((put as ApiError).status).toBe(412);
  });
});

describe('roles', () => {
  it('deactivating a role that is still assigned shows role_in_use', async () => {
    await signIn('pm'); await stepUpDone();
    const u = userEvent.setup();
    renderApp(<Roles />);
    const edit = await screen.findAllByTestId(/^role-edit-/);
    await u.click(edit[0]);
    const dlg = await screen.findByTestId('role-dialog');
    await u.click(within(dlg).getByTestId('role-active'));
    await u.type(within(dlg).getByTestId('role-dialog-reason'), 'Retire');
    await u.click(within(dlg).getByTestId('role-dialog-submit'));
    expect(await within(dlg).findByTestId('role-dialog-error')).toHaveTextContent('still assigned');
  });
});

describe('permission profiles', () => {
  it('edits the grid with If-Match, and rolls the row back when the server says 412', async () => {
    await signIn('pm'); await stepUpDone();
    const u = userEvent.setup();
    renderApp(<Profiles />);
    const row = await screen.findByTestId('profile-row-ENTRY_STD');
    const before = row.textContent;
    await u.click(within(row).getByTestId('profile-edit-ENTRY_STD'));
    let dlg = await screen.findByTestId('profile-dialog');
    await u.click(await within(dlg).findByTestId('grant-quality-view'));
    await u.type(within(dlg).getByTestId('profile-dialog-reason'), 'Add quality');
    await u.click(within(dlg).getByTestId('profile-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('profile-dialog')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('profile-row-ENTRY_STD').textContent).not.toBe(before));

    const saved = screen.getByTestId('profile-row-ENTRY_STD').textContent;
    server.use(http.put(`${API_BASE}/permission-profiles/:id`, () => problem(412, 'precondition_failed')));
    await u.click(within(screen.getByTestId('profile-row-ENTRY_STD')).getByTestId('profile-edit-ENTRY_STD'));
    dlg = await screen.findByTestId('profile-dialog');
    await u.click(await within(dlg).findByTestId('grant-risks-view'));
    await u.type(within(dlg).getByTestId('profile-dialog-reason'), 'Again');
    await u.click(within(dlg).getByTestId('profile-dialog-submit'));
    expect(await within(dlg).findByTestId('profile-dialog-error')).toHaveTextContent('Someone changed this');
    expect(screen.getByTestId('profile-row-ENTRY_STD').textContent).toBe(saved);
  });
});
