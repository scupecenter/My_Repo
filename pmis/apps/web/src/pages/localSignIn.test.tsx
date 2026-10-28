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
    await fillLogin(u, '+218 91 200 1000', DEMO_PASSWORDS.pm);
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
    await u.type(screen.getByTestId('new-user-name'), 'Sara Test');
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
    await u.type(screen.getByTestId('new-user-email'), 'ahmed.salem@example.com');
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
      'POST /auth/local/login', 'POST /auth/local/password', 'POST /auth/local/step-up', 'GET /auth/session', 'POST /auth/logout', 'GET /me',
      'GET /users', 'GET /users/picker', 'POST /users', 'GET /users/:id', 'PATCH /users/:id', 'POST /users/:id/password-reset', 'GET /groups', 'GET /groups/:id',
      'POST /groups/:id/members', 'DELETE /groups/:id/members/:userId',
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
