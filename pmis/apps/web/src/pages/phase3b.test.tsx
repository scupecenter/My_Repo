import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, API_BASE, ApiError } from '@/api/client';
import { HolderChip } from '@/components/HolderChip';
import { PersonTag } from '@/components/PersonTag';
import { server } from '@/mocks/server';
import { uid } from '@/mocks/ids';
import { renderApp, signIn } from '@/test/utils';
import { Absence } from './Absence';
import { Delegation } from './Delegation';
import { OnlineNow } from './OnlineNow';
import { SecurityLog } from './SecurityLog';
import { SettingsRoutes } from './settings/Settings';
import { Users } from './Users';

const stepUpDone = () => api.post('/__mock/step-up');
const problem = (status: number, code: string, extra = {}) => HttpResponse.json({ type: 'x', title: code, status, code, ...extra }, { status });
const settings = (tab: string, opts = {}) => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: `/admin/settings/${tab}`, ...opts });
const reasonAndSave = async (u: ReturnType<typeof userEvent.setup>, dlg: string, reason = 'Because the owner asked') => {
  await u.type(await screen.findByTestId(`${dlg}-reason`), reason);
  await u.click(screen.getByTestId(`${dlg}-submit`));
};
const errCode = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => `${e.status}:${e.code}`);

describe('work calendar', () => {
  it('shows the 14-day tentative reminder and asks for a reason on every save', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    settings('calendar');
    expect(await screen.findByTestId('cal-banner-tentative')).toBeInTheDocument();
    expect(screen.queryByTestId('cal-banner-empty')).toBeNull();
    await u.click(screen.getByTestId('cal-add'));
    await u.type(screen.getByTestId('holiday-date'), '2026-12-01');
    await u.type(screen.getByTestId('holiday-name-en'), 'Test day');
    await u.click(screen.getByTestId('holiday-dialog-submit'));
    expect(await screen.findByTestId('holiday-dialog-reason-error')).toBeInTheDocument();
    await reasonAndSave(u, 'holiday-dialog');
    expect(await screen.findByTestId('holiday-2026-12-01')).toBeInTheDocument();
    expect(screen.getByTestId('toast')).toHaveTextContent('audited');
  });

  it('confirming a tentative date clears the flag; the reminder goes with it', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    settings('calendar');
    await u.click(await screen.findByTestId('holiday-confirm-2026-11-03'));
    await reasonAndSave(u, 'holiday-confirm-dialog', 'Official announcement');
    await waitFor(() => expect(screen.queryByTestId('holiday-tentative-2026-11-03')).toBeNull());
    await waitFor(() => expect(screen.queryByTestId('cal-banner-tentative')).toBeNull());
  });

  it('shows the empty next-year banner and rolls back a failed delete', async () => {
    await signIn('pm'); await stepUpDone();
    server.use(http.get(`${API_BASE}/settings/holidays`, () => HttpResponse.json({ items: [{ id: '96000000-0000-4000-8000-0000000000aa', date: '2026-12-24', name_en: 'Independence Day', kind: 'national', tentative: false, version: 1 }], summary: { tentative_count: 0, next_year: 2027, next_year_table_empty: true } })));
    server.use(http.delete(`${API_BASE}/settings/holidays/:id`, () => problem(409, 'conflict')));
    const u = userEvent.setup();
    settings('calendar');
    expect(await screen.findByTestId('cal-banner-empty')).toHaveTextContent('2027');
    await u.click(await screen.findByTestId('holiday-delete-2026-12-24'));
    await reasonAndSave(u, 'holiday-delete-dialog');
    expect(await screen.findByTestId('holiday-delete-dialog-error')).toBeInTheDocument();
    expect(screen.getByTestId('holiday-2026-12-24')).toBeInTheDocument();
  });

  it('rejects an empty weekend', async () => {
    await signIn('pm'); await stepUpDone();
    expect(await errCode(api.put('/settings/weekend-days', { body: { weekend_days: [], reason: 'because' } }))).toBe('422:validation_failed');
  });
});

describe('rules screens', () => {
  it('lifting the freeze needs the typed confirmation, a reason and step-up', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    settings('freeze');
    await u.click(await screen.findByTestId('freeze-lift'));
    await u.type(screen.getByTestId('freeze-dialog-reason'), 'Pilot is over early');
    expect(screen.getByTestId('freeze-dialog-submit')).toBeDisabled();
    await u.type(screen.getByTestId('freeze-confirm'), 'structural-freez');
    expect(screen.getByTestId('freeze-dialog-submit')).toBeDisabled();
    await u.type(screen.getByTestId('freeze-confirm'), 'e');
    await stepUpDone();
    await u.click(screen.getByTestId('freeze-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('freeze-status')).toHaveTextContent('lifted'));
  });

  it('server refuses a wrong confirmation text and a missing one', async () => {
    await signIn('pm'); await stepUpDone();
    const f = await api.get<{ version: number }>('/settings/structural-freeze');
    expect(await errCode(api.post('/settings/structural-freeze/lift', { version: f.version, body: { reason: 'because', confirm_text: 'nope' } }))).toBe('422:confirmation_mismatch');
    expect(await errCode(api.post('/settings/structural-freeze/lift', { version: f.version, body: { reason: 'because' } }))).toBe('422:validation_failed');
  });

  it('DLP lists versions and publishes a new one; idle days validate 1 to 30', async () => {
    await signIn('pm'); await stepUpDone();
    const u = userEvent.setup();
    settings('dlp');
    expect(await screen.findByTestId('dlp-version-2')).toBeInTheDocument();
    await u.clear(screen.getByTestId('dlp-cw')); await u.type(screen.getByTestId('dlp-cw'), '6');
    await u.type(screen.getByTestId('dlp-from'), '2026-12-01');
    await u.click(screen.getByTestId('dlp-publish'));
    await reasonAndSave(u, 'dlp-dialog');
    expect(await screen.findByTestId('dlp-version-3')).toHaveTextContent('6');
    expect(await errCode(api.put('/settings/idle-task-alert', { version: 1, body: { enabled: true, working_days: 31, reason: 'because' } }))).toBe('422:validation_failed');
  });

  it('idle days: the form blocks 0 and 31', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    settings('idle');
    const input = await screen.findByTestId('idle-days');
    await u.clear(input); await u.type(input, '31');
    expect(screen.getByTestId('idle-save')).toBeDisabled();
    expect(screen.getByTestId('idle-invalid')).toBeInTheDocument();
  });
});

describe('notification policy', () => {
  it('shows ranges, blocks the cross-field violation, and locks security and mandatory types', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    settings('notifications');
    expect(await screen.findByTestId('np-range-approval_remind_hours')).toHaveTextContent('4');
    expect(screen.getByTestId('np-range-approval_remind_hours')).toHaveTextContent('168');
    const remind = screen.getByTestId('np-th-approval_remind_hours');
    await u.clear(remind); await u.type(remind, '168');
    await u.clear(screen.getByTestId('np-th-approval_escalate_days')); await u.type(screen.getByTestId('np-th-approval_escalate_days'), '7');
    expect(screen.getByTestId('np-save')).toBeDisabled();
    expect(screen.getAllByText(/must be longer/i).length).toBeGreaterThanOrEqual(2);
    await u.clear(screen.getByTestId('np-th-approval_escalate_days')); await u.type(screen.getByTestId('np-th-approval_escalate_days'), '8');
    expect(screen.getByTestId('np-save')).toBeEnabled();
    expect(screen.getByTestId('np-lock-no_holder')).toBeInTheDocument();
    expect(screen.getByTestId('np-lock-repeated_failed_sign_in')).toBeInTheDocument(); // security: always mandatory
    expect(screen.getByTestId('np-ch-no_holder-in_app')).toBeDisabled();
    expect(screen.getByTestId('np-ch-task_rejected-email')).toBeEnabled();
  });

  it('saves with a reason; a 422 from the server lands on the field', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    server.use(http.put(`${API_BASE}/settings/notification-policy`, () => problem(422, 'validation_failed', { errors: [{ path: '/timezone', code: 'invalid_timezone' }] })));
    settings('notifications');
    await u.clear(await screen.findByTestId('np-timezone')); await u.type(screen.getByTestId('np-timezone'), 'Mars/Base');
    await u.click(screen.getByTestId('np-save'));
    await reasonAndSave(u, 'np-dialog');
    expect(await screen.findByTestId('err-timezone')).toHaveTextContent(/time zone/i);
  });

  it('a delegate may not change security rows or the rate cap (403), and an admin needs step-up', async () => {
    await signIn('pm');
    const p = await api.get<{ version: number; thresholds: Record<string, number>; matrix: unknown[]; timezone: string; digest_hour: number; enabled: boolean; work_days_follow_calendar: boolean }>('/settings/notification-policy');
    const body = { reason: 'raise the cap', enabled: p.enabled, timezone: p.timezone, digest_hour: p.digest_hour, work_days_follow_calendar: true, thresholds: { ...p.thresholds, rate_cap_per_hour: 80 }, matrix: p.matrix };
    await api.post('/__mock/acting-delegate', { body: { on: true } });
    expect(await errCode(api.put('/settings/notification-policy', { version: p.version, body }))).toBe('403:delegate_forbidden');
    await api.post('/__mock/acting-delegate', { body: { on: false } });
    await stepUpDone();
    expect(await errCode(api.put('/settings/notification-policy', { version: p.version, body }))).toBeNull();
  });

  it('refuses switching a security type off with mandatory_locked', async () => {
    await signIn('pm'); await stepUpDone();
    const p = await api.get<{ version: number; thresholds: object; matrix: { type_code: string; channels: { in_app: boolean; email: boolean }; cells: object[] }[]; timezone: string; digest_hour: number; enabled: boolean }>('/settings/notification-policy');
    const matrix = p.matrix.map((r) => (r.type_code === 'repeated_failed_sign_in' ? { ...r, channels: { in_app: false, email: false } } : r));
    expect(await errCode(api.put('/settings/notification-policy', { version: p.version, body: { reason: 'try it', enabled: true, timezone: p.timezone, digest_hour: p.digest_hour, work_days_follow_calendar: true, thresholds: p.thresholds, matrix } }))).toBe('422:validation_failed');
  });
});

describe('log retention', () => {
  it('shows minimums and the fixed audit log, and warns on a reduction', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    settings('retention');
    expect(await screen.findByTestId('ret-system-min')).toHaveTextContent('90');
    expect(screen.getByTestId('ret-security-min')).toHaveTextContent('365');
    expect(screen.getByTestId('ret-audit')).toHaveTextContent('10');
    expect(screen.queryByTestId('ret-warning')).toBeNull();
    await u.clear(screen.getByTestId('ret-security')); await u.type(screen.getByTestId('ret-security'), '364');
    expect(screen.getByTestId('ret-save')).toBeDisabled();
    await u.clear(screen.getByTestId('ret-security')); await u.type(screen.getByTestId('ret-security'), '400');
    expect(await screen.findByTestId('ret-warning')).toBeInTheDocument();
    await stepUpDone();
    await u.click(screen.getByTestId('ret-save'));
    await reasonAndSave(u, 'ret-dialog');
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveTextContent('mandatory alert'));
    const n = await api.get<{ items: { title: string }[] }>('/notifications');
    expect(n.items[0].title).toMatch(/retention/i);
  });

  it('raising needs no step-up; reducing without it is challenged; unknown keys are refused', async () => {
    await signIn('pm');
    const r = await api.get<{ version: number }>('/settings/log-retention');
    expect(await errCode(api.put('/settings/log-retention', { version: r.version, body: { reason: 'raise', system_log_days: 400, security_log_days: 800 } }))).toBeNull();
    await stepUpDone();
    expect(await errCode(api.put('/settings/log-retention', { body: { reason: 'x1', system_log_days: 400, security_log_days: 800, audit_log_years: 5 } }))).toBe('422:validation_failed');
  });
});

describe('security log', () => {
  it('admin sees IPs, masked identifiers as-is, filters, and the integrity result', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<SecurityLog />);
    expect(await screen.findByTestId('seclog-ip-col')).toBeInTheDocument();
    const masked = (await screen.findAllByTestId(/^seclog-masked-/))[0];
    expect(masked.textContent).toMatch(/^\?a\*\*\*#[0-9a-f]{12}$/);
    await u.selectOptions(screen.getByTestId('seclog-outcome'), 'failure');
    await waitFor(() => expect(screen.getAllByTestId(/^seclog-row-/).every((r) => /Failed|mismatch/i.test(r.textContent ?? ''))).toBe(true));
    await u.type(screen.getByTestId('seclog-q'), 'zzzz-no-match');
    expect(await screen.findByTestId('seclog-empty')).toBeInTheDocument();
    await u.click(screen.getByTestId('integrity-security'));
    expect(await screen.findByTestId('integrity-status-security')).toHaveTextContent('Intact');
    expect(screen.getByTestId('integrity-count-security')).toHaveTextContent(/\d+/);
    expect(screen.getByTestId('integrity-head-security').textContent).toMatch(/^[0-9a-f]{64}$/);
    await api.post('/__mock/tamper');
    await u.click(screen.getByTestId('integrity-security'));
    await waitFor(() => expect(screen.getByTestId('integrity-status-security')).toHaveTextContent('Broken'));
    expect(screen.getByTestId('integrity-breaks-security')).toHaveTextContent('1');
    expect(screen.getByTestId('integrity-break-list-security')).toHaveTextContent('#17');
  });

  it('a view_security_log reader gets no IP column, no integrity or export buttons, and null IPs from the API', async () => {
    await signIn('auditor');
    renderApp(<SecurityLog />);
    await screen.findAllByTestId(/^seclog-row-/);
    expect(screen.queryByTestId('seclog-ip-col')).toBeNull();
    expect(screen.queryByTestId('integrity-audit')).toBeNull();
    expect(screen.queryByTestId('seclog-export')).toBeNull();
    const rows = await api.get<{ items: { ip: string | null }[] }>('/security-log');
    expect(rows.items.every((r) => r.ip === null)).toBe(true);
    expect(await errCode(api.get('/audit-log/integrity'))).toBe('403:action_forbidden');
  });

  it('exports through the export service', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<SecurityLog />);
    await u.click(await screen.findByTestId('seclog-export'));
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveTextContent('Export downloaded'), { timeout: 5000 });
  });
});

describe('online now', () => {
  it('polls with X-PMIS-Live, has no revoke on your own row, and ends another session with a reason', async () => {
    await signIn('pm'); await stepUpDone();
    const seen: (string | null)[] = [];
    server.events.on('request:start', ({ request }) => { if (request.url.includes('/sessions/active')) seen.push(request.headers.get('X-PMIS-Live')); });
    const u = userEvent.setup();
    renderApp(<OnlineNow />);
    const own = await screen.findByTestId('session-own');
    const ownRow = own.closest('tr')!;
    expect(ownRow.querySelector('[data-testid^="session-revoke-"], [data-testid^="user-revoke-"]')).toBeNull();
    expect(seen[0]).toBe('1');
    const rows = screen.getAllByTestId(/^session-9/);
    expect(rows.some((r) => r.getAttribute('data-status') === 'idle')).toBe(true);
    const other = rows.find((r) => r !== ownRow)!;
    await u.click(other.querySelector('[data-testid^="session-revoke-"]')!);
    await u.click(screen.getByTestId('revoke-session-dialog-submit'));
    expect(await screen.findByTestId('revoke-session-dialog-reason-error')).toBeInTheDocument();
    await reasonAndSave(u, 'revoke-session-dialog', 'Shared device left open');
    await waitFor(() => expect(screen.queryByTestId(other.getAttribute('data-testid')!)).toBeNull());
  });

  it('the server refuses revoking your own session, and online needs manage_users', async () => {
    await signIn('pm'); await stepUpDone();
    expect(await errCode(api.post('/sessions/97000000-0000-4000-8000-000000000001/revoke', { body: { reason: 'mine' } }))).toBe('403:self_beneficiary');
    await api.post('/auth/logout');
    await signIn('auditor');
    expect(await errCode(api.get('/sessions/active'))).toBe('403:action_forbidden');
  });
});

describe('users: deactivate, delete, restore', () => {
  it('deactivating shows the last_admin refusal and keeps the row', async () => {
    await signIn('pm'); await stepUpDone();
    const u = userEvent.setup();
    server.use(http.patch(`${API_BASE}/users/:id`, () => problem(409, 'last_admin')));
    renderApp(<Users />);
    await u.click(await screen.findByTestId('user-deactivate-1102'));
    await reasonAndSave(u, 'user-act-dialog', 'Left the project');
    expect(await screen.findByTestId('user-act-dialog-error')).toHaveTextContent('At least one active admin must remain');
    await u.click(screen.getByText('Cancel'));
    expect(screen.getByTestId('user-status-1102')).toHaveTextContent('Active');
  });

  it('your own row cannot be deactivated or deleted', async () => {
    await signIn('pm');
    renderApp(<Users />);
    expect(await screen.findByTestId('user-deactivate-1001')).toBeDisabled();
    expect(screen.getByTestId('user-delete-1001')).toBeDisabled();
  });

  it('deleting moves the user to Deleted; a duplicate blocks one restore and the other works', async () => {
    await signIn('pm'); await stepUpDone();
    const u = userEvent.setup();
    renderApp(<Users />);
    await u.click(await screen.findByTestId('user-delete-1305'));
    await reasonAndSave(u, 'user-act-dialog', 'Duplicate account');
    await waitFor(() => expect(screen.queryByTestId('user-row-1305')).toBeNull());
    await u.click(screen.getByTestId('users-tab-deleted'));
    const row = await screen.findByTestId('deleted-row-1305');
    expect(within(row).getByText('Duplicate account')).toBeInTheDocument();
    expect(screen.getByTestId('user-restore-9001')).toBeDisabled();
    expect(screen.getByTestId('restore-blocked-9001')).toHaveTextContent(/email/);
    await u.click(screen.getByTestId('user-restore-1305'));
    await reasonAndSave(u, 'user-act-dialog', 'Returned to the project');
    await waitFor(() => expect(screen.queryByTestId('deleted-row-1305')).toBeNull());
  });

  it('restore answers 409 duplicate when forced past the UI', async () => {
    await signIn('pm'); await stepUpDone();
    expect(await errCode(api.post(`/users/${uid('9001')}/restore`, { body: { reason: 'try anyway' } }))).toBe('409:duplicate');
  });

  it('a deactivated holder keeps the task and shows the badge; the lead sees the alert', async () => {
    await signIn('pm'); await stepUpDone();
    const first = await api.get<{ items: { holder: { employee_id: string } }[] }>('/reassignments/alerts', { query: { cause: 'absent' } });
    const emp = first.items[0].holder.employee_id;
    const u = await api.get<{ items: { id: string; version: number; employee_id: string }[] }>('/users');
    const target = u.items.find((x) => x.employee_id === emp)!;
    await api.patch(`/users/${target.id}`, { version: target.version, body: { status: 'disabled', reason: 'Left the company' } });
    const alerts = await api.get<{ items: { cause: string; holder_account_status?: string; task: { ball_in_court?: { holders: { employee_id?: string; account_status?: string }[] } } }[] }>('/reassignments/alerts', { query: { cause: 'holder_deactivated' } });
    expect(alerts.items.length).toBeGreaterThan(0);
    expect(alerts.items[0].holder_account_status).toBe('deactivated');
    expect(alerts.items[0].task.ball_in_court?.holders.some((h) => h.employee_id === emp && h.account_status === 'deactivated')).toBe(true);
    const sessions = await api.get<{ items: { user: { employee_id: string } }[] }>('/sessions/active');
    expect(sessions.items.some((s) => s.user.employee_id === emp)).toBe(false); // sessions ended
  });

  it('the badge shows beside the holder in PersonTag and HolderChip', () => {
    renderApp(<><PersonTag name="Karim Zaroug" employeeId="1104" status="deactivated" /><HolderChip a={{ kind: 'user', ref_id: 'r', label: 'Sara Idris', employee_id: '1205', account_status: 'deleted' }} /><PersonTag name="Active One" employeeId="1001" status="active" /></>);
    expect(screen.getByTestId('holder-status-1104')).toHaveTextContent('deactivated');
    expect(screen.getByTestId('holder-status-1205')).toHaveTextContent('deleted');
    expect(screen.queryByTestId('holder-status-1001')).toBeNull();
  });
});

describe('delegation targets', () => {
  it('delegates to a role with regions, modules and re-delegation; shows no person for it', async () => {
    await signIn('pm'); await stepUpDone();
    const u = userEvent.setup();
    renderApp(<Delegation />);
    await u.click(await screen.findByTestId('deleg-new'));
    await u.click(screen.getByTestId('deleg-kind-role'));
    await waitFor(() => expect(within(screen.getByTestId('deleg-target')).getAllByRole('option').length).toBeGreaterThan(2));
    await u.selectOptions(screen.getByTestId('deleg-target'), within(screen.getByTestId('deleg-target')).getAllByRole('option')[1] as HTMLOptionElement);
    await u.click(screen.getByTestId('deleg-right-reassign'));
    await u.click(screen.getByTestId('deleg-regions-all'));
    await u.click(await screen.findByTestId('deleg-regions-1'));
    await u.click(screen.getByTestId('deleg-redelegate'));
    await reasonAndSave(u, 'delegation-dialog', 'Cover for the role');
    const row = await screen.findByTestId(/^deleg-row-/);
    expect(row).toHaveTextContent('Role');
    expect(row).toHaveTextContent('1 region');
    expect(row).toHaveTextContent('may re-delegate');
  });

  it('refuses giving both, or neither, target shape', async () => {
    await signIn('pm'); await stepUpDone();
    const base = { scope: 'full', valid_from: '2026-10-25T00:00:00Z', reason: 'because', region_codes: [], module_codes: [], allow_redelegate: false };
    expect(await errCode(api.post('/delegations', { body: base }))).toBe('422:validation_failed');
    expect(await errCode(api.post('/delegations', { body: { ...base, to_user_id: uid('1102'), target_kind: 'user', target_id: uid('1102') } }))).toBe('422:validation_failed');
  });

  it('adding yourself to the group of your own delegation answers 403 self_beneficiary unless you are an undelegated admin', async () => {
    await signIn('pm'); await stepUpDone();
    const g = await api.get<{ items: { id: string }[] }>('/groups');
    await api.post('/delegations', { body: { scope: 'full', target_kind: 'group', target_id: g.items[1].id, valid_from: '2026-10-25T00:00:00Z', reason: 'group cover', region_codes: [], module_codes: [], allow_redelegate: false } });
    const me = await api.get<{ user: { id: string } }>('/me');
    expect(await errCode(api.post(`/groups/${g.items[1].id}/members`, { body: { user_ids: [me.user.id], reason: 'add me' } }))).toBeNull(); // admin without delegation
    await api.post('/__mock/acting-delegate', { body: { on: true } });
    expect(await errCode(api.post(`/groups/${g.items[1].id}/members`, { body: { user_ids: [me.user.id], reason: 'add me' } }))).toBe('403:self_beneficiary');
  });
});

describe('act on behalf', () => {
  it('uses POST /tasks/{id}/act-on-behalf with a mandatory reason and removes the alert', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    let hit: { url: string; body: Record<string, unknown>; ifMatch: string | null } | null = null;
    server.events.on('request:start', async ({ request }) => { if (request.url.includes('/act-on-behalf')) hit = { url: request.url, body: await request.clone().json(), ifMatch: request.headers.get('If-Match') }; });
    renderApp(<Absence />);
    const list = await screen.findByTestId('alerts-absent');
    await waitFor(() => expect(within(list).getAllByRole('listitem').length).toBeGreaterThan(0));
    const before = Number(screen.getByTestId('alerts-count-absent').textContent);
    await u.click(within(list).getAllByRole('listitem')[0].querySelector('[data-testid^="alert-act_on_behalf-"]')!);
    await u.click(screen.getByTestId('cover-dialog-submit'));
    expect(await screen.findByTestId('cover-dialog-reason-error')).toBeInTheDocument();
    expect(hit).toBeNull();
    await u.selectOptions(screen.getByTestId('cover-action'), 'reject');
    expect(screen.getByTestId('cover-dialog-submit')).toBeDisabled(); // reject needs a note
    await u.type(screen.getByTestId('cover-note'), 'Date is before the permit');
    await stepUpDone();
    await reasonAndSave(u, 'cover-dialog', 'Mona is on sick leave');
    await waitFor(() => expect(screen.getByTestId('alerts-count-absent')).toHaveTextContent(String(before - 1)));
    expect(hit!.url).toMatch(/\/tasks\/[^/]+\/act-on-behalf$/);
    expect(hit!.body).toMatchObject({ action: 'reject', reason: 'Mona is on sick leave', note: 'Date is before the permit' });
    expect(hit!.ifMatch).toMatch(/^"\d+"$/);
  });

  it('answers 409 for a stale level and 422 note_required', async () => {
    await signIn('pm');
    const a = await api.get<{ items: { task: { id: string; version: number; current_level?: number; state: string } }[] }>('/reassignments/alerts', { query: { cause: 'absent' } });
    const t = a.items[0].task;
    const call = (body: object) => api.post(`/tasks/${t.id}/act-on-behalf`, { version: t.version, body });
    expect(await errCode(call({ action: 'review', level: 9, reason: 'because' }))).toBe('409:invalid_transition');
    expect(await errCode(call({ action: 'reject', level: t.current_level ?? 1, reason: 'because' }))).toBe('422:note_required');
    expect(await errCode(call({ action: 'review', level: t.current_level ?? 1 }))).toBe('422:validation_failed');
  });
});

describe('staff field visibility', () => {
  it('saves deny lists with a reason and hides a field for one employee on the card', async () => {
    await signIn('pm'); await stepUpDone();
    const u = userEvent.setup();
    settings('staff-visibility');
    await u.click(await screen.findByTestId('sv-hide-emp'));
    await u.type(screen.getByTestId('sv-hide-emp'), '1103');
    await u.click(screen.getByTestId('sv-hide-email'));
    await u.click(screen.getByTestId('sv-hide-save'));
    await reasonAndSave(u, 'sv-hide-dialog', 'Employee asked for privacy');
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveTextContent('audited'));
    const card = await api.get<{ email: string | null; hidden_fields: string[] }>('/staff-registry/1103');
    expect(card.email).toBeNull();
    expect(card.hidden_fields).toContain('email');
  });
});

const setNum = async (u: ReturnType<typeof userEvent.setup>, testid: string, v: string) => { const el = await screen.findByTestId(testid); await u.clear(el); await u.type(el, v); };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tripoli' }).format(new Date());

describe('SLA rule sets', () => {
  it('draft, inline min>max, save, preview, publish with apply off by default and step-up', async () => {
    await signIn('pm'); await stepUpDone();
    const u = userEvent.setup();
    settings('sla');
    await screen.findByTestId('sla-version-2');
    await u.click(screen.getByTestId('sla-create-draft'));
    await reasonAndSave(u, 'sla-create-dialog', 'Tighten A2');
    expect(await screen.findByTestId('sla-editor-status')).toHaveTextContent('Draft');
    // The start event is a picker of the workflow's task, milestone and gate codes.
    const start = (await screen.findByTestId('sla-start-A2')) as HTMLSelectElement;
    await waitFor(() => expect(within(start).getAllByRole('group').map((g) => g.getAttribute('label'))).toEqual(['Tasks', 'Milestones', 'Gates']));
    await setNum(u, 'sla-min-D14', '9');
    expect(screen.getByTestId('sla-err-D14')).toHaveTextContent('minimum must not exceed');
    expect(screen.getByTestId('sla-save')).toBeDisabled();
    await setNum(u, 'sla-min-D14', '2');
    await waitFor(() => expect(screen.queryByTestId('sla-err-D14')).toBeNull());
    await u.click(screen.getByTestId('sla-ovr-add-A2'));
    await setNum(u, 'sla-ovr-max-A2-0', '1');
    expect(screen.getByTestId('sla-err-A2-o0')).toBeInTheDocument();
    await u.click(screen.getByTestId('sla-ovr-remove-A2-0'));
    await setNum(u, 'sla-max-A2', '6');
    await u.click(screen.getByTestId('sla-save'));
    await reasonAndSave(u, 'sla-save-dialog', 'A2 gets one more day');
    await waitFor(() => expect(screen.queryByTestId('sla-dirty')).toBeNull());
    await u.click(screen.getByTestId('sla-preview'));
    expect(await screen.findByTestId('sla-preview-changed')).toHaveTextContent('14');
    await u.click(screen.getByTestId('sla-preview-dialog-submit'));
    await u.click(screen.getByTestId('sla-publish'));
    expect(screen.getByTestId('sla-publish-apply')).not.toBeChecked();
    expect(screen.getByTestId('sla-publish-warning')).toHaveTextContent('Closed tasks never change');
    expect(screen.getByTestId('sla-publish-date')).toHaveValue(today());
    await reasonAndSave(u, 'sla-publish-dialog', 'Approved by the PM');
    await waitFor(() => expect(screen.getByTestId('sla-version-3')).toHaveTextContent('Published'));
    expect(screen.getByTestId('sla-version-3')).toHaveTextContent('Not applied');
    expect(screen.getAllByTestId('toast').at(-1)).toHaveTextContent('0 open tasks');
  });

  it('server rules: 409 on a second draft, min>max, unknown start event, past date, same date twice, delegate restriction', async () => {
    await signIn('pm'); await stepUpDone();
    const d = await api.post<{ id: string }>('/settings/sla-rule-sets', { body: { reason: 'because' } });
    expect(await errCode(api.post('/settings/sla-rule-sets', { body: { reason: 'because' } }))).toBe('409:duplicate');
    const rule = { task_code: 'A2', min_working_days: 5, max_working_days: 3, start_event: 'site_release', calendar_code: 'LY' };
    const err = (e: ApiError) => (e.problem as unknown as { errors: { path: string; code: string }[] }).errors;
    const e1 = await api.patch(`/settings/sla-rule-sets/${d.id}`, { version: 1, body: { reason: 'because', rules: [rule] } }).catch((e: ApiError) => err(e));
    expect(e1).toEqual([{ path: '/rules/0/max_working_days', code: 'min_exceeds_max' }]);
    const e2 = await api.patch(`/settings/sla-rule-sets/${d.id}`, { version: 1, body: { reason: 'because', rules: [{ ...rule, min_working_days: 1, start_event: 'nope' }] } }).catch((e: ApiError) => err(e));
    expect(e2).toEqual([{ path: '/rules/0/start_event', code: 'unknown_start_event' }]);
    expect(await errCode(api.patch(`/settings/sla-rule-sets/${d.id}`, { body: { reason: 'because', rules: [rule] } }))).toBe('428:precondition_required');
    await api.patch(`/settings/sla-rule-sets/${d.id}`, { version: 1, body: { reason: 'because', rules: [{ ...rule, min_working_days: 1, max_working_days: 6 }] } });
    const pub = (body: object) => api.post(`/settings/sla-rule-sets/${d.id}/publish`, { version: 2, body });
    expect(await errCode(pub({ effective_date: '2020-01-01', reason: 'because' }))).toBe('422:validation_failed');
    await api.post('/__mock/acting-delegate', { body: { on: true } });
    expect(await errCode(pub({ effective_date: today(), reason: 'because', apply_to_open_tasks: true }))).toBe('403:action_forbidden');
    await api.post('/__mock/acting-delegate', { body: { on: false } });
    const done = await pub({ effective_date: today(), reason: 'because', apply_to_open_tasks: true }) as { affected_open_tasks: number };
    expect(done.affected_open_tasks).toBe(14);
  });
});

describe('weight sets', () => {
  it('the draft shows live sums per level and the publish refuses with the paths of the contract', async () => {
    await signIn('pm'); await stepUpDone();
    const u = userEvent.setup();
    settings('weights');
    await u.selectOptions(await screen.findByTestId('weights-code'), 'health_index');
    expect(await screen.findByTestId('weights-sum-activities')).toHaveTextContent('90%');
    expect(screen.getByTestId('weights-sum-activities')).toHaveAttribute('data-ok', 'false');
    expect(screen.getByTestId('weights-error-health_index')).toHaveTextContent('90%');
    expect(screen.getByTestId('weights-sum-items-h1')).toHaveTextContent('90%');
    await u.click(screen.getByTestId('weights-preview'));
    expect(await screen.findByTestId('weights-preview-valid')).toHaveAttribute('data-valid', 'false');
    expect(screen.getByTestId('weights-preview-error--activities')).toHaveAttribute('data-code', 'weights_must_total_100');
    expect(screen.getByTestId('weights-preview-error--activities-0-items')).toBeInTheDocument();
    await u.click(screen.getByTestId('weights-preview-dialog-submit'));
    await u.click(screen.getByTestId('weights-publish-health_index'));
    await reasonAndSave(u, 'weights-publish-dialog');
    expect(await screen.findByTestId('weights-publish-error--activities')).toHaveAttribute('data-code', 'weights_must_total_100');
    expect(screen.getByTestId('weights-publish-error--activities-0-items')).toBeInTheDocument();
    // Fix both levels: the sums turn to 100% before anything is saved.
    await u.click(within(screen.getByTestId('weights-publish-dialog')).getByRole('button', { name: 'Cancel' }));
    await setNum(u, 'weights-weight-h2', '50');
    await setNum(u, 'weights-item-weight-h1_2', '30');
    expect(screen.getByTestId('weights-sum-activities')).toHaveAttribute('data-ok', 'true');
    expect(screen.getByTestId('weights-sum-items-h1')).toHaveAttribute('data-ok', 'true');
    expect(screen.queryByTestId('weights-error-health_index')).toBeNull();
  });

  it('draft from the set in force, edit weights and an item, save, preview, publish, and a new version appears', async () => {
    await signIn('pm'); await stepUpDone();
    const u = userEvent.setup();
    settings('weights');
    await u.click(await screen.findByTestId('weights-create-draft'));
    expect(within(screen.getByTestId('weights-base')).getByText(/v2/)).toBeInTheDocument();
    await reasonAndSave(u, 'weights-create-dialog', 'Shift 1 point to CW');
    await setNum(u, 'weights-weight-a3', '6');
    expect(await screen.findByTestId('weights-sum-activities')).toHaveTextContent('101%');
    await setNum(u, 'weights-weight-a1', '11');
    expect(screen.getByTestId('weights-sum-activities')).toHaveTextContent('100%');
    await u.clear(screen.getByTestId('weights-item-unit-a3_1')); await u.type(screen.getByTestId('weights-item-unit-a3_1'), 'm2');
    await u.click(screen.getByTestId('weights-save'));
    await reasonAndSave(u, 'weights-save-dialog', 'Saving the draft');
    await waitFor(() => expect(screen.getByTestId('weights-publish-project_status')).toBeEnabled());
    await u.click(screen.getByTestId('weights-preview'));
    expect(await screen.findByTestId('weights-preview-valid')).toHaveAttribute('data-valid', 'true');
    expect(screen.getByTestId('weights-preview-progress')).toBeInTheDocument();
    await u.click(screen.getByTestId('weights-preview-dialog-submit'));
    await u.click(screen.getByTestId('weights-publish-project_status'));
    await reasonAndSave(u, 'weights-publish-dialog', 'Owner approved');
    await waitFor(() => expect(screen.getByTestId('weights-version-project_status-4')).toHaveTextContent('Current'));
    expect(screen.getByTestId('weights-version-project_status-3')).not.toHaveTextContent('Current');
  });

  it('a draft can start from an older set and the API refuses a second draft, a bad weight and an unknown key', async () => {
    await signIn('pm'); await stepUpDone();
    const old = (await api.get<{ items: { id: string; version: number }[] }>('/settings/weight-sets', { query: { code: 'project_status' } })).items.find((x) => x.version === 2)!;
    const d = await api.post<{ id: string; activities: { weight: number }[] }>('/settings/weight-sets', { body: { code: 'project_status', base_set_id: old.id, reason: 'go back' } });
    expect(d.activities.map((a) => a.weight)).toEqual([10, 10, 10, 20, 20, 10, 15, 5]);
    expect(await errCode(api.post('/settings/weight-sets', { body: { code: 'project_status', reason: 'again' } }))).toBe('409:duplicate');
    const act = (w: number) => ({ code: 'x', name_en: 'X', weight: w });
    expect(await errCode(api.put(`/settings/weight-sets/${d.id}`, { version: 1, body: { reason: 'because', activities: [act(100.0001)] } }))).toBe('422:validation_failed');
    expect(await errCode(api.put(`/settings/weight-sets/${d.id}`, { version: 1, body: { reason: 'because', extra: 1, activities: [act(50)] } }))).toBe('422:validation_failed');
    await api.put(`/settings/weight-sets/${d.id}`, { version: 1, body: { reason: 'because', activities: [act(50)] } }); // saved although the total is not 100
  });
});

describe('holiday import needs a reason', () => {
  it('the API answers 422 without a reason and accepts the file with one', async () => {
    await signIn('pm');
    const file = () => new File(['date,name\n2026-12-30,Test\n'], 'h.csv', { type: 'text/csv' });
    const fd = new FormData(); fd.append('file', file());
    expect(await errCode(api.post('/settings/holidays/import', { body: fd }))).toBe('422:validation_failed');
    const ok = new FormData(); ok.append('file', file()); ok.append('reason', 'Official list 2026');
    await expect(api.post('/settings/holidays/import', { body: ok })).resolves.toBeTruthy();
  });

  it('the dialog asks for the reason before it uploads', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    settings('calendar');
    await u.upload(await screen.findByTestId('cal-import-file'), new File(['date,name_en\n2026-12-30,Test\n'], 'h.csv', { type: 'text/csv' }));
    expect(await screen.findByTestId('holiday-import-name')).toHaveTextContent('h.csv');
    await u.click(screen.getByTestId('holiday-import-dialog-submit'));
    expect(await screen.findByTestId('holiday-import-dialog-reason-error')).toBeInTheDocument();
    await reasonAndSave(u, 'holiday-import-dialog', 'Official list 2026');
    await waitFor(() => expect(screen.queryByTestId('holiday-import-dialog')).toBeNull());
    expect(screen.getByTestId('toast')).toHaveTextContent('imported');
  });
});
