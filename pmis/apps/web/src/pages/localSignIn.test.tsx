import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '@/App';
import { api, API_BASE, ApiError, setCsrfToken } from '@/api/client';
import { REAL_API_AUTH_USERS, realApiHandlers } from '@/mocks/realApi';
import { ruleKey } from '@/lib/passwordRules';
import { DEMO_PASSWORDS } from '@/mocks/db';
import { passwordRules } from '@/mocks/handlers.auth';
import { uid } from '@/mocks/ids';
import { server } from '@/mocks/server';
import { renderApp } from '@/test/utils';
import { UserDetailPage } from './UserDetail';
import { Users } from './Users';

/** Signs in through the local endpoint, like the login screen does. */
async function localSignIn(identifier = '1001', password = DEMO_PASSWORDS.pm) {
  const s = await api.post<{ csrf_token: string }>('/auth/local/login', { body: { identifier, password } });
  setCsrfToken(s.csrf_token);
}
/** Resolves with the ApiError of a call that must fail. */
const fail = (p: Promise<unknown>) => p.then(() => { throw new Error('expected the call to fail'); }, (e: ApiError) => e);
const fillLogin = async (u: ReturnType<typeof userEvent.setup>, id: string, pw: string) => {
  await u.type(screen.getByTestId('login-identifier'), id);
  await u.type(screen.getByTestId('login-password'), pw);
  await u.click(screen.getByTestId('login-submit'));
};

describe('login errors', () => {
  it('shows the same message for an unknown ID and a wrong password', async () => {
    const u = userEvent.setup();
    renderApp(<App />, { route: '/login' });
    await fillLogin(u, '9999', 'whatever-password');
    const unknown = (await screen.findByTestId('login-error')).textContent;
    await u.clear(screen.getByTestId('login-identifier'));
    await fillLogin(u, '1001', 'not-the-password');
    await waitFor(() => expect(screen.getByTestId('login-password')).toHaveValue(''));
    expect(screen.getByTestId('login-error').textContent).toBe(unknown);
    expect(unknown).not.toMatch(/unknown|not found|no such|locked/i);
    expect(screen.queryByTestId('page-my-work')).toBeNull();
  });

  it('says to wait a minute on 429', async () => {
    server.use(http.post(`${API_BASE}/auth/local/login`, () => HttpResponse.json({ type: 'x', title: 'Slow down', status: 429, code: 'rate_limited' }, { status: 429 })));
    const u = userEvent.setup();
    renderApp(<App />, { route: '/login' });
    await fillLogin(u, '1001', 'x-password-x');
    expect(await screen.findByTestId('login-error')).toHaveTextContent(/wait a minute/i);
  });

  it('locks the account after 5 failures, even for the right password, with the same 401', async () => {
    const bad = () => fail(api.post('/auth/local/login', { body: { identifier: '1001', password: 'wrong-password-1' } }));
    const first = await bad();
    for (let i = 0; i < 4; i++) await bad();
    const locked = await fail(api.post('/auth/local/login', { body: { identifier: '1001', password: DEMO_PASSWORDS.pm } }));
    expect(locked.status).toBe(401);
    expect(locked.problem.code).toBe('invalid_credentials');
    expect(locked.problem.title).toBe(first.problem.title);
  });

  it('signs in with an email, an employee ID or a phone, and lands on My Work', async () => {
    const u = userEvent.setup();
    renderApp(<App />, { route: '/login' });
    await fillLogin(u, '+218 90 000 0001', DEMO_PASSWORDS.pm);
    expect(await screen.findByTestId('page-my-work')).toBeInTheDocument();
  });
});

describe('must change password', () => {
  it('routes to the change-password screen and nothing else is reachable', async () => {
    const u = userEvent.setup();
    renderApp(<App />, { route: '/login' });
    await fillLogin(u, 'new.employee@example.com', DEMO_PASSWORDS.newbie);
    expect(await screen.findByTestId('change-password-forced')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar')).toBeNull();
    // A weak password is refused by the server and shown on the field.
    await u.type(screen.getByTestId('cp-current'), DEMO_PASSWORDS.newbie);
    await u.type(screen.getByTestId('cp-new'), 'password12345');
    await u.type(screen.getByTestId('cp-confirm'), 'password12345');
    await u.click(screen.getByTestId('cp-submit'));
    expect(await screen.findByTestId('cp-new-error')).toHaveTextContent(/too common/i);
    // The mismatch is caught before sending.
    await u.clear(screen.getByTestId('cp-confirm'));
    await u.type(screen.getByTestId('cp-confirm'), 'other');
    await u.click(screen.getByTestId('cp-submit'));
    expect(await screen.findByTestId('cp-confirm-error')).toBeInTheDocument();
    // A good one lets the user in (the first sign-in account then asks for the employee ID).
    await u.clear(screen.getByTestId('cp-new'));
    await u.clear(screen.getByTestId('cp-confirm'));
    await u.type(screen.getByTestId('cp-new'), 'A-fresh-long-passphrase-7');
    await u.type(screen.getByTestId('cp-confirm'), 'A-fresh-long-passphrase-7');
    await u.click(screen.getByTestId('cp-submit'));
    expect(await screen.findByTestId('employee-id-input')).toBeInTheDocument();
  });

  it('the mock API refuses other calls with 403 password_change_required until the change', async () => {
    await localSignIn('new.employee@example.com', DEMO_PASSWORDS.newbie);
    const err = await fail(api.get('/notifications'));
    expect(err.status).toBe(403);
    expect(err.code).toBe('password_change_required');
    expect((await api.get<{ user: unknown }>('/me')).user).toBeTruthy();
  });

  it('any 403 password_change_required sends the user to the change-password screen', async () => {
    await localSignIn();
    server.use(http.get(`${API_BASE}/me/tasks`, () => HttpResponse.json({ type: 'x', title: 'Change it', status: 403, code: 'password_change_required' }, { status: 403 })));
    renderApp(<App />, { route: '/my-work' });
    expect(await screen.findByTestId('change-password-form')).toBeInTheDocument();
    expect(screen.getByTestId('change-password-forced')).toBeInTheDocument();
  });

  it('a voluntary change is reachable from the user menu', async () => {
    await localSignIn();
    const u = userEvent.setup();
    renderApp(<App />, { route: '/my-work' });
    await u.click(await screen.findByTestId('topbar-user'));
    await u.click(await screen.findByTestId('user-menu-change-password'));
    expect(await screen.findByTestId('page-change-password')).toBeInTheDocument();
    expect(screen.queryByTestId('change-password-forced')).toBeNull();
    await u.type(screen.getByTestId('cp-current'), 'wrong-current-pass');
    await u.type(screen.getByTestId('cp-new'), 'A-fresh-long-passphrase-7');
    await u.type(screen.getByTestId('cp-confirm'), 'A-fresh-long-passphrase-7');
    await u.click(screen.getByTestId('cp-submit'));
    expect(await screen.findByTestId('cp-current-error')).toBeInTheDocument();
  });
});

describe('step-up by password', () => {
  it('asks for the password, stays open on a wrong one, then resumes the call', async () => {
    await localSignIn();
    const u = userEvent.setup();
    renderApp(<div />);
    const call = api.post<{ temporary_password: string }>(`/users/${uid('1204')}/password-reset`, { body: { reason: 'Forgot it' } });
    const dlg = await screen.findByTestId('stepup-dialog');
    expect(within(dlg).getByTestId('stepup-password')).toBeInTheDocument();
    await u.type(screen.getByTestId('stepup-password'), 'not-my-password');
    await u.click(screen.getByTestId('stepup-continue'));
    expect(await screen.findByTestId('stepup-error')).toBeInTheDocument();
    expect(screen.getByTestId('stepup-dialog')).toBeInTheDocument();
    await u.type(screen.getByTestId('stepup-password'), DEMO_PASSWORDS.pm);
    await u.click(screen.getByTestId('stepup-continue'));
    const r = await call;
    expect(r.temporary_password).toHaveLength(16);
    await waitFor(() => expect(screen.queryByTestId('stepup-dialog')).toBeNull());
  });

  it('cancel rejects the call', async () => {
    await localSignIn();
    const u = userEvent.setup();
    renderApp(<div />);
    const call = fail(api.post(`/users/${uid('1204')}/password-reset`, { body: { reason: 'Forgot it' } }));
    await u.click(await screen.findByTestId('stepup-cancel'));
    expect((await call).code).toBe('step_up_required');
  });
});

describe('create user', () => {
  it('shows the temporary password once, then it is gone', async () => {
    await localSignIn();
    const u = userEvent.setup();
    renderApp(<Users />);
    await u.click(await screen.findByTestId('users-new'));
    await u.type(screen.getByTestId('new-user-name'), 'Demo Test');
    await u.type(screen.getByTestId('new-user-email'), 'sara.test@example.com');
    await u.type(screen.getByTestId('new-user-employee-id'), '4821');
    await u.type(screen.getByTestId('new-user-phone'), '+218 91 555 0100');
    await u.type(screen.getByTestId('new-user-dialog-reason'), 'New site engineer');
    await u.click(screen.getByTestId('new-user-dialog-submit'));
    const pw = (await screen.findByTestId('temp-password')).textContent!;
    expect(pw).toHaveLength(16);
    expect(screen.getByTestId('temp-password-warning')).toHaveTextContent(/only once/i);
    expect(screen.getByTestId('temp-password-copy')).toBeInTheDocument();
    await u.click(screen.getByTestId('temp-password-done'));
    await waitFor(() => expect(screen.queryByTestId('temp-password-dialog')).toBeNull());
    expect(document.body.textContent).not.toContain(pw);
    // The new row carries the badges.
    const row = await screen.findByTestId('user-row-4821');
    expect(within(row).getByTestId('local-badge-4821')).toBeInTheDocument();
    expect(within(row).getByTestId('must-change-badge-4821')).toBeInTheDocument();
    // The temporary password works once, then must be changed.
    await api.post('/auth/logout');
    await localSignIn('4821', pw);
    expect((await api.get<{ must_change_password: boolean }>('/auth/session')).must_change_password).toBe(true);
  });

  it('maps a 409 duplicate to the field', async () => {
    await localSignIn();
    const u = userEvent.setup();
    renderApp(<Users />);
    await u.click(await screen.findByTestId('users-new'));
    await u.type(screen.getByTestId('new-user-name'), 'Copy Cat');
    await u.type(screen.getByTestId('new-user-email'), 'demo.user.01@example.com');
    await u.type(screen.getByTestId('new-user-employee-id'), '1001');
    await u.type(screen.getByTestId('new-user-dialog-reason'), 'Testing duplicates');
    await u.click(screen.getByTestId('new-user-dialog-submit'));
    expect(await screen.findByTestId('new-user-email-error')).toHaveTextContent(/already used/i);
    expect(screen.getByTestId('new-user-employee_id-error')).toBeInTheDocument();
    expect(screen.queryByTestId('temp-password-dialog')).toBeNull();
  });

  it('maps 422 weak_password for a typed temporary password', async () => {
    await localSignIn();
    const u = userEvent.setup();
    renderApp(<Users />);
    await u.click(await screen.findByTestId('users-new'));
    await u.type(screen.getByTestId('new-user-name'), 'Weak Pw');
    await u.type(screen.getByTestId('new-user-email'), 'weak.pw@example.com');
    await u.click(screen.getByTestId('new-user-mode-type'));
    await u.type(screen.getByTestId('new-user-password'), 'weak.pw@example.com');
    await u.type(screen.getByTestId('new-user-dialog-reason'), 'Testing weak');
    await u.click(screen.getByTestId('new-user-dialog-submit'));
    expect(await screen.findByTestId('new-user-password-error')).toBeInTheDocument();
  });
});

describe('reset password', () => {
  it('asks for step-up, then shows the new temporary password once and flags the user', async () => {
    await localSignIn();
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/admin/users/:userId" element={<UserDetailPage />} /></Routes>, { route: `/admin/users/${uid('1204')}` });
    await u.click(await screen.findByTestId('user-reset-password'));
    await u.type(screen.getByTestId('reset-password-dialog-reason'), 'User forgot the password');
    await u.click(screen.getByTestId('reset-password-dialog-submit'));
    await u.type(await screen.findByTestId('stepup-password'), DEMO_PASSWORDS.pm);
    await u.click(screen.getByTestId('stepup-continue'));
    expect((await screen.findByTestId('temp-password')).textContent).toHaveLength(16);
    await u.click(screen.getByTestId('temp-password-done'));
    expect(await screen.findByTestId('must-change-badge-1204')).toBeInTheDocument();
  });
});

describe('hybrid mode list', () => {
  it('passes exactly the agreed method + path patterns through, and nothing without the switch', () => {
    expect(REAL_API_AUTH_USERS.map(([m, p]) => `${m.toUpperCase()} ${p}`)).toEqual([
      'POST /auth/local/login', 'POST /auth/local/password', 'POST /auth/local/password-reset/request', 'POST /auth/local/password-reset/confirm', 'POST /auth/local/step-up',
      // contract 0.5.0: two-factor
      'POST /auth/local/2fa', 'POST /auth/local/2fa/device-code', 'POST /auth/local/2fa/passkey/options', 'POST /auth/local/2fa/passkey', 'POST /auth/local/2fa/enrol/start', 'POST /auth/local/2fa/enrol/confirm', 'POST /auth/local/2fa/recovery-codes',
      'GET /auth/session', 'POST /auth/logout', 'GET /me',
      'GET /users', 'GET /users/picker', 'GET /users/deleted', 'POST /users', 'GET /users/:id', 'PATCH /users/:id', 'POST /users/:id/password-reset', 'PUT /users/:id/two-factor', 'POST /users/:id/two-factor/reset', 'POST /users/:id/two-factor/enrol-code', 'POST /users/:id/delete', 'POST /users/:id/restore', 'GET /groups', 'GET /groups/:id',
      'POST /groups/:id/members', 'DELETE /groups/:id/members/:userId',
      // contract 0.4.0
      'GET /departments', 'POST /departments', 'PATCH /departments/:id', 'PUT /users/:id/org',
      'GET /messages/contacts', 'GET /messages/threads', 'POST /messages/threads', 'GET /messages/threads/:id', 'POST /messages/threads/:id/replies', 'POST /messages/threads/:id/read',
      'GET /announcements', 'POST /announcements', 'GET /announcements/:id', 'GET /announcements/:id/responses', 'GET /announcements/:id/responses/export', 'POST /announcements/:id/respond',
      'GET /me/announcements/pending',
      // contract 0.4.0: regions, roles, permission profiles, assignments, delegations
      'GET /regions', 'GET /roles', 'POST /roles', 'GET /roles/:id', 'PATCH /roles/:id', 'GET /permissions/catalogue',
      'GET /permission-profiles', 'POST /permission-profiles', 'GET /permission-profiles/:id', 'PUT /permission-profiles/:id',
      'GET /users/:id/assignments', 'GET /assignments', 'POST /assignments/bulk-assign', 'POST /assignments/bulk-update', 'POST /assignments/bulk-end', 'POST /assignments/copy',
      'GET /delegations', 'POST /delegations', 'POST /delegations/:id/revoke',
      // contract 0.4.1: Site Register, tasks, approvals
      'GET /sites', 'GET /sites/:id', 'GET /sites/:id/tasks',
      'GET /tasks/:id', 'PATCH /tasks/:id', 'POST /tasks/:id/start', 'POST /tasks/:id/submit', 'POST /tasks/:id/review', 'POST /tasks/:id/approve', 'POST /tasks/:id/reject',
      'POST /tasks/:id/claim', 'POST /tasks/:id/release', 'GET /tasks/:id/history', 'GET /tasks/:id/comments', 'POST /tasks/:id/comments',
      'GET /approvals', 'POST /approvals/bulk',
      // contract 0.4.6: the Responsibility Matrix
      'GET /matrix', 'PATCH /matrix', 'GET /matrix/coverage', 'GET /matrix/simulate',
      // contract 0.4.5: registers
      'GET /recycle-bin', 'PUT /recycle-bin/retention', 'POST /recycle-bin/:id/restore',
      'GET /registers', 'GET /registers/:key/records', 'POST /registers/:key/records', 'GET /registers/:key/records/:id', 'PATCH /registers/:key/records/:id',
      'POST /registers/:key/records/:id/submit', 'POST /registers/:key/records/:id/review', 'POST /registers/:key/records/:id/approve', 'POST /registers/:key/records/:id/reject',
      'POST /registers/:key/records/:id/claim', 'POST /registers/:key/records/:id/release', 'POST /registers/:key/records/:id/void',
      'GET /registers/:key/records/:id/history', 'GET /registers/:key/records/:id/versions', 'POST /registers/:key/records/:id/versions',
      'POST /registers/:key/records/:id/triage',
      // contract 0.7.0: approved-template entry (templates and import batches)
      'GET /templates', 'GET /templates/:id/changes', 'GET /templates/:id/download', 'GET /import-batches', 'GET /data-hub/summary', 'GET /finance-hub/summary', 'GET /custom-registers', 'POST /custom-registers', 'GET /custom-registers/:key', 'PATCH /custom-registers/:key', 'POST /custom-registers/:key/enable', 'POST /import-batches', 'GET /import-batches/:id', 'GET /import-batches/:id/rows', 'GET /import-batches/:id/error-report',
      'POST /import-batches/:id/submit', 'POST /import-batches/:id/decisions',
      // contract 0.12.8 (P3): the legacy Master import and its comparison report, the template mapping screen and the import aliases
      'GET /master-import/runs', 'POST /master-import/runs', 'GET /master-import/runs/:id', 'GET /master-import/runs/:id/diffs', 'GET /master-import/runs/:id/export',
      'GET /master-import/runs/:id/file', 'POST /master-import/runs/:id/apply', 'PATCH /master-import/diffs/:id',
      'GET /template-mapping', 'POST /template-mapping', 'GET /import-aliases', 'PUT /import-aliases',
      // contract 0.4.10 and 0.7.1: phase 4b (inbox, follow, register comments, time in state, workload, blocked-by, status updates)
      'GET /notifications', 'POST /notifications/read-all', 'POST /notifications/:id/read', 'POST /notifications/:id/unread', 'POST /notifications/:id/snooze',
      'GET /me/follows', 'PUT /sites/:id/follow', 'DELETE /sites/:id/follow', 'PUT /registers/:key/records/:id/follow', 'DELETE /registers/:key/records/:id/follow',
      'GET /registers/:key/records/:id/comments', 'POST /registers/:key/records/:id/comments',
      // contract 0.15.247: a reaction and a resolved flag on any comment
      'PUT /comments/:id/reactions', 'DELETE /comments/:id/reactions', 'PUT /comments/:id/resolved', 'DELETE /comments/:id/resolved', 'GET /plan-freezes', 'POST /plan-freezes', 'DELETE /plan-freezes/:id', 'GET /plan-freezes/:id/report',
      'GET /tasks/:id/time-in-state', 'GET /tasks/:id/blocked-by',
      'GET /reports/time-in-state', 'GET /reports/workload', 'GET /status-updates', 'GET /status-updates/region-health', 'POST /status-updates', 'PATCH /status-updates/:id',
      // contract 0.7.2: the main dashboard, Project Status, weight sets
      'GET /dashboard', 'GET /dashboard/export', 'GET /project-status', 'GET /project-status/snapshots',
      'GET /settings/weight-sets', 'POST /settings/weight-sets', 'GET /settings/weight-sets/:id', 'PUT /settings/weight-sets/:id', 'POST /settings/weight-sets/:id/preview', 'POST /settings/weight-sets/:id/publish',
      // contract 0.11.0: dashboard follow-up (manual Project Status values, delay periods)
      'GET /project-status/manual-items', 'POST /project-status/manual-items/:code/values', 'GET /tasks/:id/delay-periods', 'POST /tasks/:id/delay-periods', 'POST /tasks/:id/delay-periods/:periodId/void',
      // contract 0.8.0: documents (slots, files, the Documents list, the bulk zip, the Document Library)
      'GET /tasks/:id/slots', 'POST /tasks/:id/slots', 'POST /tasks/:id/slots/suggest', 'POST /tasks/:id/slots/:slotId/files', 'DELETE /tasks/:id/slots/:slotId/files/:fileId',
      'GET /files/:id/download', 'GET /documents', 'POST /exports/zip', 'GET /exports/zip/:id/download', 'GET /jobs/:id',
      'GET /document-library', 'POST /document-library', 'GET /document-library/:id', 'PATCH /document-library/:id', 'POST /document-library/:id/publish',
      'GET /document-library/:id/versions', 'GET /document-library/:id/blank-form', 'POST /document-library/:id/blank-form',
      // contract 0.9.1: the team / scope match of Procurement (Q97)
      'GET /settings/team-scope-match', 'PUT /settings/team-scope-match',
      // contract 0.12.9: P4b contractor rules and the two reports
      'GET /settings/contractor-rules', 'PUT /settings/contractor-rules', 'GET /reports/team-scope-mismatch', 'GET /reports/contractors-completeness', 'GET /reports/gecol-hlc-counts', 'GET /reports/contractor-performance', 'GET /settings/contractor-performance', 'PUT /settings/contractor-performance',
      // contract 0.15.242: the generic alert rules (apps/api: settings; migration 0342)
      'GET /settings/partial-credit', 'PUT /settings/partial-credit',
      'GET /settings/alert-rules', 'GET /settings/alert-rules/link-orphans', 'POST /settings/alert-rules', 'PUT /settings/alert-rules/:id',
      // contract 0.9.2: the self-service profile (details, email change and its decision, password, two-factor self-service, enforced mark)
      'GET /me/profile', 'GET /me/sessions', 'POST /me/sessions/revoke-others', 'POST /me/sessions/:id/revoke', 'PATCH /me/profile', 'GET /admin/document-search-index', 'GET /me/push', 'POST /me/push/subscribe', 'POST /me/push/unsubscribe', 'GET /me/notification-prefs', 'PUT /me/notification-prefs', 'POST /me/notification-prefs/snooze', 'POST /me/notification-prefs/test', 'GET /me/notification-prefs/decisions', 'GET /admin/notification-personal', 'PUT /admin/notification-personal', 'GET /admin/web-push', 'PATCH /me/preferences', 'POST /me/password', 'POST /me/email-change', 'DELETE /me/email-change',
      'POST /me/two-factor/enrol/start', 'POST /me/two-factor/enrol/confirm', 'POST /me/two-factor/disable',
      'GET /email-change-requests', 'POST /email-change-requests/:id/decide', 'PUT /users/:id/two-factor/enforced',
      // contract 0.10.0: the logs core
      'GET /audit-log', 'POST /audit-log/exports', 'GET /audit-log/exports/:id/download', 'GET /audit-log/field-changes', 'GET /audit-log/field-history', 'GET /audit-log/integrity', 'GET /security-log', 'POST /security-log/exports', 'GET /security-log/exports/:id/download', 'GET /security-log/integrity', 'GET /system-log', 'GET /sessions/active', 'POST /sessions/:id/revoke', 'POST /users/:id/sessions/revoke', 'GET /admin/sessions', 'POST /admin/sessions/:id/end', 'GET /admin/job-runs', 'GET /admin/deployments', 'GET /admin/security-alerts', 'POST /admin/security-alerts/:id/ack', 'GET /settings/log-retention', 'PUT /settings/log-retention', 'GET /settings/security-alerts', 'PUT /settings/security-alerts', 'GET /reports/activity',
      'GET /admin/mail/status', 'POST /admin/mail/test', 'GET /admin/mail/outbox', 'POST /admin/mail/outbox/:id/retry', 'GET /admin/log-integrity/runs', 'POST /admin/log-integrity/runs', 'GET /admin/log-integrity/runs/:id', 'GET /health', 'POST /csp-report',
      // contract 0.11.1: the documents follow-up (Q130 to Q132)
      'PATCH /sites/:id', 'GET /registers/:key/records/:id/slots', 'POST /registers/:key/records/:id/slots', 'POST /registers/:key/records/:id/slots/:slotId/files',
      'DELETE /registers/:key/records/:id/slots/:slotId/files/:fileId', 'GET /snag-types', 'POST /snag-types', 'PATCH /snag-types/:id', 'GET /sites/:id/snags', 'POST /sites/:id/snags',
      'GET /snags/:id', 'PATCH /snags/:id', 'POST /snags/:id/photos', 'DELETE /snags/:id/photos/:photoId', 'POST /snags/:id/submit', 'POST /snags/:id/review', 'POST /snags/:id/approve',
      'POST /snags/:id/reject',
      // contract 0.12.0 (P1): scenario applicability, scope exceptions, gate history, scenario rules, SLA sheet columns
      'GET /sites/:id/applicability', 'POST /sites/:id/applicability/apply', 'POST /sites/:id/scope-exceptions', 'POST /sites/:id/scope-exceptions/:exceptionId/revoke',
      'GET /sites/:id/gate-events', 'GET /settings/scenario-rules', 'PUT /settings/scenario-rules', 'GET /settings/sla-master-columns',
      // contract 0.12.1: P7 warehouse (TE dispatch, region WL vendors, missing configuration, numbering)
      'GET /warehouse/dispatch-status',
      'GET /warehouse/dispatch-status/:id',
      'GET /warehouse/region-vendors',
      'PUT /warehouse/region-vendors/:id',
      'GET /warehouse/reorder-limits',
      'PUT /warehouse/reorder-limits/:id',
      'GET /warehouse/rma',
      'POST /warehouse/rma',
      'POST /warehouse/rma/:id/status',
      'GET /warehouse/config-gaps',
      'POST /warehouse/quarantine-exits',
      'GET /number-sequences',
      'POST /number-sequences',
      'PATCH /number-sequences/:id',
      'POST /snags/:id/photos/:photoId/evidence',
      'GET /snag-severities',
      'PUT /snag-severities',
      'GET /settings/documents-qc',
      'PUT /settings/documents-qc',
      // contract 0.12.5 (P5): the list catalogue and the conversion of the old text of a meeting
      'GET /list-catalogues', 'POST /list-catalogues', 'GET /list-catalogues/:code', 'PATCH /list-catalogues/:code', 'POST /list-catalogues/:code/values',
      'PATCH /list-catalogues/:code/values/:valueId', 'DELETE /list-catalogues/:code/values/:valueId', 'GET /registers/:key/records/:id/legacy-conversion', 'POST /registers/:key/records/:id/legacy-conversion',
      // contract 0.12.6 (P8): email code, phone change and its decision
      'POST /me/email-change/verify', 'POST /me/email-change/resend', 'POST /me/phone-change', 'DELETE /me/phone-change',
      'GET /phone-change-requests', 'POST /phone-change-requests/:id/decide',
      // contract 0.12.10: P4a (Q225 site change proposals)
      'POST /sites/:id/change-proposals',
      'GET /saved-views', 'POST /saved-views', 'POST /saved-views/import', 'GET /saved-views/filter-fields', 'GET /saved-views/filter-fields/:field/values', 'GET /saved-views/:id', 'PATCH /saved-views/:id', 'POST /saved-views/:id/deactivate',
      'POST /saved-views/:id/restore', 'POST /saved-views/:id/transfer', 'GET /saved-views/:id/versions',
      // contract 0.15.246 (item 17, migration 0345): the soft "... is editing this record" notice
      'POST /presence/editing', 'POST /presence/editing/stop', 'GET /presence/editing',
      // contract 0.15.245 (0344): pin a saved view as a personal home card
      'GET /me/home-pins', 'POST /saved-views/:id/pin', 'POST /saved-views/:id/unpin',
      // contract 0.15.582 (0655): a default saved view per screen
      'GET /me/default-views', 'POST /saved-views/:id/set-default', 'POST /saved-views/:id/clear-default',
      'GET /me/drafts', 'GET /me/drafts/:key', 'PUT /me/drafts/:key',
      'DELETE /me/drafts/:key',
      // contract 0.13.2: follow-up group C (Q267 cancel of a mistaken Quality snag record)
      'POST /registers/quality/records/:id/cancel-snag',
      // contract 0.14.0: site creation (Q460): the draft and its life
      'POST /sites', 'GET /site-drafts', 'GET /site-drafts/:id', 'PATCH /site-drafts/:id', 'DELETE /site-drafts/:id', 'POST /site-drafts/:id/submit', 'POST /site-drafts/:id/decide',
      // contract 0.14.2: the official calendar confirmation (Q440) and the mail notification kinds (Q441)
      'GET /settings/calendar-confirmation', 'PUT /settings/calendar-confirmation', 'GET /settings/mail-policy', 'PUT /settings/mail-policy', 'GET /settings/mail-notification-kinds', 'PUT /settings/mail-notification-kinds',
      // contract 0.14.3: the one-time historical-load document waiver (Q462)
      'GET /settings/historical-waiver', 'PUT /settings/historical-waiver',
      // contract 0.14.5: the site map of the dashboard (OV-12)
      'GET /dashboard/site-map',
      // contract 0.14.6: the background threshold of batches (Settings, Imports)
      'GET /settings/imports', 'PUT /settings/imports', 'GET /settings/duplicate-rows', 'PUT /settings/duplicate-rows', 'GET /settings/imports/upload-policy', 'PUT /settings/imports/upload-policy', 'GET /settings/template-change-notice', 'PUT /settings/template-change-notice',
      // contract 0.15.1: the shared layout of the side menu
      'GET /settings/nav-layout', 'PUT /settings/nav-layout',
      // contract 0.15.41: Settings, Identity & themes
      'GET /settings/identity', 'PUT /settings/identity',
      // contract 0.15.97: Settings, Screens, Login page and its public read
      'GET /settings/login-page', 'PUT /settings/login-page', 'GET /settings/ops-limits', 'PUT /settings/ops-limits', 'GET /settings/login-page/public',
      // contract 0.15.292: the media gallery
      'GET /media/settings', 'PUT /media/settings', 'GET /media/items', 'GET /media/facets', 'GET /media/items/:kind/:id/thumbnail',
      'GET /settings/dashboard-target-policy', 'PUT /settings/dashboard-target-policy', 'GET /settings/security-locks', 'PUT /settings/security-locks', 'GET /settings/download-locks', 'PUT /settings/download-locks',
      'GET /settings/support-access', 'PUT /settings/support-access', 'GET /support-access', 'POST /support-access', 'POST /support-access/revoke-all', 'POST /support-access/:id/revoke', 'GET /settings/new-device-code', 'PUT /settings/new-device-code', 'POST /settings/new-device-code/bypass', 'GET /settings/passkeys', 'PUT /settings/passkeys', 'GET /me/passkeys', 'POST /me/passkeys/register/options', 'POST /me/passkeys/register/verify', 'DELETE /me/passkeys/:id', 'POST /users/:id/passkeys/revoke',
      // contract 0.15.232 (migration 0243): the workspace logo and where it shows outside the app
      'PUT /settings/identity/logo', 'PATCH /settings/identity/logo', 'PATCH /settings/identity/logo/display', 'GET /ui/public/identity', 'GET /ui/public/logo/:purpose', 'GET /ui/assets/:key',
      // contract 0.15.206: who sees the restricted financial summary of the dashboard
      'GET /settings/dashboard-finance-readers', 'PUT /settings/dashboard-finance-readers',
      // contract 0.15.4: the per-site workflow locks and the status of the sites of an import
      'POST /sites/workflow-locks', 'PUT /sites/:id/workflow-locks', 'GET /master-import/runs/:id/sites', 'GET /import-batches/:id/sites', 'GET /settings/calendars', 'GET /settings/holidays', 'POST /settings/holidays', 'PATCH /settings/holidays/:id', 'DELETE /settings/holidays/:id', 'POST /settings/holidays/:id/confirm', 'PUT /settings/weekend-days', 'POST /tasks/:task_id/delay-periods/:period_id/decision', 'DELETE /matrix/cells/:id', 'PUT /registers/hlc/records/:id/purchase-requests', 'GET /registers/dismantle/order-options', 'GET /registers/dismantle/rn-options', 'GET /registers/warehouse/order-options', 'GET /registers/car_dispatcher/order-options', 'GET /registers/financial_advances/order-options', 'GET /registers/issues/order-options', 'GET /registers/change_control/order-options', 'GET /registers/quality/order-options', 'GET /registers/financial_advances/advance-options', 'GET /registers/:key/links', 'GET /registers/:key/link-options/:field', 'GET /registers/invoices/order-options', 'GET /registers/invoices/supplier-options', 'GET /settings/register-rules', 'PUT /settings/register-rules/:key', 'GET /settings/register-links', 'PUT /settings/register-links', 'GET /settings/register-state', 'PUT /settings/register-state/:key', 'GET /registers/issues/risk-options', 'GET /registers/risks/:entity_id/issues', 'GET /registers/procurement/:entity_id/receipts', 'GET /registers/:key/:entity_id/related', 'GET /registers/contractor-companies', 'POST /registers/hlc/legacy-migration', 'GET /registers/:key/fields', 'POST /registers/:key/fields', 'PUT /registers/:key/fields-order', 'GET /registers/:key/fields/:code/impact', 'PATCH /registers/:key/fields/:code', 'PUT /registers/:key/fields/:code/default', 'DELETE /registers/:key/fields/:code', 'POST /registers/:key/sections', 'PATCH /registers/:key/sections/:id', 'DELETE /registers/:key/sections/:id', 'PATCH /registers/:key', 'POST /registers/:key/records/:id/transfer', 'POST /registers/:key/records/:id/lock', 'DELETE /registers/:key/records/:id/lock', 'POST /registers/:key/columns/:field/lock', 'DELETE /registers/:key/columns/:field/lock', 'GET /search', 'POST /search/site-ids', 'GET /settings/gecol-order-warnings', 'PUT /settings/gecol-order-warnings', 'GET /settings/derive-rules', 'PUT /settings/derive-rules', 'GET /settings/structural-freeze', 'PUT /settings/structural-freeze', 'POST /settings/structural-freeze/lift', 'GET /site-master/sections', 'GET /site-master/:menu/rows', 'PATCH /site-master/columns/:ord/sections', 'GET /site-master/columns', 'POST /site-master/columns', 'GET /site-master/columns/:ord', 'PATCH /site-master/columns/:ord', 'DELETE /site-master/columns/:ord', 'POST /site-master/columns/:ord/type-preview', 'POST /site-master/columns/:ord/deactivate', 'POST /site-master/columns/:ord/reactivate', 'GET /custom-fields', 'GET /custom-fields/:id', 'POST /custom-fields', 'PATCH /custom-fields/:id', 'GET /site-master/sites/:siteId/sources', 'POST /sites/:id/admin-edits', 'GET /sites/:id/admin-edits', 'GET /settings/sla-rules', 'GET /settings/sla-tasks', 'PUT /settings/sla-tasks/:task_code/no-sla', 'GET /issues/stopped-rows', 'GET /settings/issue-task-map', 'PUT /settings/issue-task-map/:task_code', 'GET /settings/sla-rule-sets', 'POST /settings/sla-rule-sets', 'GET /settings/sla-rule-sets/:id', 'PATCH /settings/sla-rule-sets/:id', 'POST /settings/sla-rule-sets/:id/preview', 'POST /settings/sla-rule-sets/:id/publish', 'POST /users/:id/purge', 'GET /workflow/versions', 'POST /workflow/versions', 'GET /workflow/versions/:version', 'PUT /workflow/versions/:version', 'PUT /workflow/versions/:version/lock-mode', 'POST /workflow/versions/:version/remove', 'GET /workflow/version-archive', 'POST /workflow/version-archive/:id/restore', 'POST /workflow/versions/:version/delete', 'POST /workflow/versions/:version/discard', 'POST /workflow/versions/:version/migrations', 'POST /workflow/site-migrations/:id/revert', 'POST /workflow/versions/:version/publish', 'POST /workflow/versions/:version/tasks', 'POST /workflow/versions/:version/tasks/insert-preview', 'POST /workflow/versions/:version/tasks/insert', 'GET /workflow/versions/:version/sla-weight', 'GET /workflow/versions/:version/weight-totals', 'PUT /workflow/versions/:version/tasks/:task/sla-rule', 'POST /workflow/versions/:version/tasks/:task/sla-rules/:rule/remove', 'PUT /workflow/versions/:version/tasks/:task/estimate', 'PUT /workflow/versions/:version/tasks/:task/weight', 'PUT /workflow/versions/:version/tasks/:task/closing', 'PUT /workflow/versions/:version/tasks/:task/successors', 'PATCH /workflow/versions/:version/tasks/:task', 'PUT /workflow/versions/:version/tasks/:task/predecessors', 'PUT /workflow/versions/:version/milestones/:code/task-order', 'PATCH /workflow/versions/:version/milestones/:code', 'PATCH /workflow/versions/:version/gates/:code', 'POST /workflow/versions/:version/migration-preview', 'GET /workflow/site-migrations', 'GET /settings/task-definitions',
      // 0.15.32 (F5)
      'GET /boards/sites', 'GET /boards/tasks', 'GET /settings/kanban-wip', 'PUT /settings/kanban-wip', 'GET /settings/dashboard', 'PUT /settings/dashboard', 'GET /settings/dashboard/snapshot-schedule', 'PUT /settings/dashboard/snapshot-schedule', 'GET /settings/dashboard/progress-rag', 'PUT /settings/dashboard/progress-rag', 'GET /settings/dashboard/forecast-window', 'PUT /settings/dashboard/forecast-window', 'GET /settings/dashboard/health-bands', 'PUT /settings/dashboard/health-bands', 'GET /settings/goals', 'PUT /settings/goals', 'GET /goals/progress', 'GET /settings/pm-schedules', 'PUT /settings/pm-schedules', 'POST /pm-schedules/:id/generate', 'GET /dashboard/extras', 'GET /dashboard/ops', 'PUT /dashboard/pipeline-variant', 'POST /project-status/manual-items/:item_code/plan', 'GET /documents/grid', 'GET /documents/grid/view', 'PUT /documents/grid/view', 'POST /sites/:site_id/document-overrides', 'POST /document-overrides/:override_id/revert', 'POST /files/:file_id/move', 'POST /document-library/:doc_type_id/delete', 'GET /registers/:key/records/:id/time-in-state', 'GET /reports/state-durations', 'GET /users/invitations', 'POST /users/invitations', 'POST /users/invitations/:id/resend', 'POST /users/invitations/:id/revoke', 'GET /invitations/:token', 'POST /invitations/:token/accept', 'POST /registers/car_dispatcher/records/:id/extend', 'POST /registers/financial_advances/records/:id/top-up', 'GET /fleet/availability', 'GET /registers/procurement/records/:id/readiness', 'POST /list-catalogues/:code/values/import', 'GET /warehouse/item-columns', 'POST /warehouse/item-columns', 'PATCH /warehouse/item-columns/:code', 'GET /warehouse/items', 'POST /warehouse/items', 'GET /warehouse/items/:id', 'PATCH /warehouse/items/:id', 'DELETE /warehouse/items/:id', 'GET /warehouse/stock', 'GET /warehouse/movements', 'POST /warehouse/movements', 'GET /warehouse/movements/:id', 'POST /warehouse/movements/:id/cancel', 'GET /as-built/items', 'POST /as-built/items', 'GET /as-built/items/:id', 'PATCH /as-built/items/:id', 'POST /tasks/:id/overrides', 'POST /overrides/:override_id/revert', 'GET /me/tasks', 'GET /me/tasks.ics', 'GET /exports/parts', 'POST /exports/master', 'GET /exports/master', 'GET /exports/master/:id/download', 'GET /exports/schedules', 'PUT /exports/schedules', 'DELETE /exports/schedules/:id',
      'GET /settings/dlp', 'POST /settings/dlp/versions', 'GET /settings/table-display', 'PUT /settings/table-display', 'GET /settings/ui-features', 'PUT /settings/ui-features', 'GET /settings/idle-task-alert', 'PUT /settings/idle-task-alert', 'GET /settings/notification-policy/catalogue', 'GET /settings/notification-policy', 'PUT /settings/notification-policy', 'POST /settings/holidays/import',
      // 0.15.54 (migration 0140): absences and the lead decisions (B12b)
      // 0.15.67 (migration 0149): My Work > Daily Plan
      'GET /daily-plans', 'GET /daily-plans/export', 'POST /daily-plans/import', 'GET /daily-plans/:date/regions/:regionId/history', 'GET /daily-plans/:date/regions/:regionId/triage', 'POST /daily-plans/:date/regions/:regionId/claim', 'DELETE /daily-plans/:date/regions/:regionId/claim', 'POST /daily-plans/:date/regions/:regionId/triage', 'GET /warehouse/items/:id/history', 'POST /daily-plans/:date/regions/:regionId/sites', 'PATCH /daily-plans/:date/regions/:regionId/sites/:siteId',
      'DELETE /daily-plans/:date/regions/:regionId/sites/:siteId', 'POST /daily-plans/:date/regions/:regionId/lock', 'POST /daily-plans/:date/regions/:regionId/unlock',
      'GET /settings/daily-plan', 'PUT /settings/daily-plan',
      'GET /absences', 'POST /absences', 'GET /absences/:id', 'PATCH /absences/:id', 'DELETE /absences/:id', 'GET /reassignments/alerts', 'GET /reassignments/eligible-users',
      'POST /tasks/reassign', 'POST /tasks/:id/act-on-behalf',
      // 0.15.56 (migration 0142): the staff registry card, its visibility settings and the edit of a row
      'GET /staff-registry/visibility', 'PUT /staff-registry/visibility', 'GET /staff-registry/:employeeId', 'PATCH /staff-registry/:employeeId',
      // contract 0.15.60
      'GET /users/:id/mfa-exemption', 'PUT /users/:id/mfa-exemption', 'POST /users/:id/mfa-exemption/revoke', 'POST /groups', 'POST /me/notify-admins', 'POST /auth/employee-id',
      // contract 0.15.62 (migration 0146): the project data reset in Settings
      'GET /settings/data-reset', 'PUT /settings/data-reset/settings', 'POST /settings/data-reset/requests', 'GET /settings/data-reset/plan', 'GET /settings/data-reset/narrow-options', 'GET /settings/data-reset/requests/:id',
      'POST /settings/data-reset/requests/:id/approve', 'POST /settings/data-reset/requests/:id/cancel', 'POST /settings/data-reset/requests/:id/run',
      'POST /settings/data-reset/requests/:id/retry-files', 'POST /settings/data-reset/requests/:id/archive', 'GET /settings/data-reset/requests/:id/archive/download',
      // contract 0.15.70 (migration 0151): the Library menu (W5)
      'GET /library/forms', 'POST /library/forms/:id/preview', 'POST /library/forms/:id/generate', 'GET /library/generated/:id/download', 'POST /library/generated/:id/void', 'GET /library/archive', 'GET /library/archive/rows', 'POST /library/archive/zip', 'GET /library/form-templates', 'POST /library/form-templates', 'GET /library/form-templates/:id/html', 'POST /library/form-templates/:id/approve', 'POST /library/form-templates/:id/retire', 'GET /settings/library-archive', 'PUT /settings/library-archive', 'GET /settings/document-marks', 'PUT /settings/document-marks/:code',
      // contract 0.15.401: structure proposals
      // contract 0.15.403: the rules of structure changes
      'GET /settings/structure-policy', 'PUT /settings/structure-policy',
      'GET /structure-proposals', 'POST /structure-proposals', 'POST /structure-proposals/upload', 'GET /structure-proposals/:id', 'GET /structure-proposals/:id/differences', 'POST /structure-proposals/:id/decision', 'POST /structure-proposals/:id/revert',
    ]);
    expect(realApiHandlers(false)).toHaveLength(0);
    expect(realApiHandlers(true)).toHaveLength(REAL_API_AUTH_USERS.length);
  });
});

describe('password helpers', () => {
  it('applies the ADR 0012 policy', () => {
    const who = { email: 'sara.test@example.com', employee_id: '4821', phone: '+218915550100' };
    expect(passwordRules('short', null, who)).toContain('too_short');
    expect(passwordRules('xx-sara.test-xx-xx', null, who)).toContain('contains_email');
    expect(passwordRules('abc4821defghijk', null, who)).toContain('contains_employee_id');
    expect(passwordRules('abc218915550100xyz', null, who)).toContain('contains_phone');
    expect(passwordRules('Password12345', null, who)).toContain('common_password');
    expect(passwordRules('Same-long-pass-1', 'Same-long-pass-1', who)).toContain('same_as_current');
    expect(passwordRules('A-fresh-long-passphrase-7', 'old', who)).toEqual([]);
  });
  it('maps rule spellings to message keys', () => {
    expect(ruleKey('min_length')).toBe('too_short');
    expect(ruleKey('common_password')).toBe('common_password');
    expect(ruleKey('contains_email')).toBe('contains_email');
    expect(ruleKey('weird')).toBe('weak');
  });
});

describe('Users & Roles tabs', () => {
  it('opens the first tab the person may use and keeps the order of the tabs', async () => {
    const { firstPeopleTab, PEOPLE_TABS } = await import('@/components/PeopleAdmin');
    expect(PEOPLE_TABS.map((p) => p.key)).toEqual(['admin.users', 'admin.online', 'admin.assignments', 'admin.roles', 'admin.profiles', 'admin.groups', 'admin.delegation', 'admin.matrix']);
    const me = (nav: string[], grants: string[] = []) =>
      ({ is_system_admin: false, effective: { nav, grants: grants.map((action) => ({ module_key: 'admin.users', action, region_ids: 'all' })) } }) as never;
    expect(firstPeopleTab(me(['admin.users', 'admin.matrix']))).toBe('/admin/users');
    expect(firstPeopleTab(me(['sites', 'admin.matrix']))).toBe('/admin/matrix');
    expect(firstPeopleTab(me(['sites'], ['manage_users']))).toBe('/admin/online'); // Online now (a sub-tab of Users) is opened by its grant
    expect(PEOPLE_TABS.find((p) => p.key === 'admin.online')?.under).toBe('admin.users');
    expect(PEOPLE_TABS.find((p) => p.key === 'admin.assignments')?.under).toBe('admin.users'); // merge 2026-11-25
    expect(PEOPLE_TABS.find((p) => p.key === 'admin.profiles')?.under).toBe('admin.roles');
    expect(firstPeopleTab(me(['sites']))).toBeNull();
  });
});
