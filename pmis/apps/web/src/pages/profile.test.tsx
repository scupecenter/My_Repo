import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '@/App';
import { Profile } from './Profile';
import { api, ApiError, setCsrfToken } from '@/api/client';
import { cred, db, DEMO_PASSWORDS, save } from '@/mocks/db';
import { uid } from '@/mocks/ids';
import { hotp, newRecoveryCodes, newSecret, stepOf } from '@/mocks/totp';
import { renderApp, signIn } from '@/test/utils';
import { UserDetailPage } from './UserDetail';
import { Users } from './Users';

// The self-service "My profile" page (contract 0.9.2).
const fail = (p: Promise<unknown>) => p.then(() => { throw new Error('expected the call to fail'); }, (e: ApiError) => e);
const codeAt = (secret: string, offset = 0) => hotp(secret, stepOf(Date.now()) + offset);

async function localSignIn(id = '1204', password = DEMO_PASSWORDS.engineer) {
  const s = await api.post<{ csrf_token: string }>('/auth/local/login', { body: { identifier: id, password } });
  setCsrfToken(s.csrf_token);
}
const freshStepUp = () => { db().session!.stepupAt = Date.now(); save(); };

describe('My profile: reach and sections', () => {
  it('opens from the user menu and shows the four sections; an M365 session gets notes instead of the password and two-factor forms', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<App />, { route: '/my-work' });
    await u.click(await screen.findByTestId('topbar-user'));
    await u.click(await screen.findByTestId('user-menu-profile'));
    expect(await screen.findByTestId('page-profile')).toBeInTheDocument();
    for (const s of ['details', 'email', 'password', 'two-factor']) expect(screen.getByTestId(`profile-${s}`)).toBeInTheDocument();
    expect(screen.getByTestId('pf-password-m365')).toBeInTheDocument();
    expect(screen.getByTestId('pf-email-m365')).toBeInTheDocument();
    expect(screen.queryByTestId('pf-tf-enable')).toBeNull();
    expect(screen.getByTestId('pf-employee-id')).toHaveTextContent('1001');
  });

  it('works in Arabic (RTL)', async () => {
    await localSignIn();
    renderApp(<Profile />, { locale: 'ar' });
    expect(await screen.findByTestId('page-profile')).toBeInTheDocument();
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('ملفي الشخصي');
    expect(screen.getByTestId('pf-email')).toHaveAttribute('dir', 'ltr');
  });
});

describe('details', () => {
  it('saves the name and phone with the version; admin-owned fields are refused', async () => {
    await localSignIn();
    const u = userEvent.setup();
    renderApp(<Profile />);
    const name = await screen.findByTestId('pf-name');
    expect(screen.getByTestId('pf-save')).toBeDisabled();
    await u.clear(name);
    await u.type(name, 'Sami N. Renamed');
    await u.clear(screen.getByTestId('pf-phone'));
    await u.type(screen.getByTestId('pf-phone'), '0912');
    expect(screen.getByTestId('pf-phone-error')).toBeInTheDocument();
    await u.clear(screen.getByTestId('pf-phone'));
    await u.type(screen.getByTestId('pf-phone'), '+218912223344');
    await u.click(screen.getByTestId('pf-save'));
    await waitFor(() => expect(db().profiles.engineer).toMatchObject({ display_name: 'Sami N. Renamed', phone: '+218912223344', version: 2 }));
    expect(await screen.findByTestId('pf-save')).toBeDisabled();
    const e = await fail(api.patch('/me/profile', { body: { employee_id: '9999' }, version: 2 }));
    expect(e.status).toBe(403);
    expect(e.code).toBe('field_read_only');
    expect((await fail(api.patch('/me/profile', { body: { display_name: 'X' }, version: 1 }))).status).toBe(412);
  });
});

describe('email change', () => {
  it('a request needs the password, waits for approval, and can be cancelled', async () => {
    await localSignIn();
    const u = userEvent.setup();
    renderApp(<Profile />);
    await u.type(await screen.findByTestId('pf-new-email'), 'sami.new@example.com');
    await u.type(screen.getByTestId('pf-email-password'), 'wrong-password-1');
    await u.click(screen.getByTestId('pf-email-submit'));
    expect(await screen.findByTestId('pf-email-error')).toHaveTextContent(/password is not correct/i);
    await u.type(screen.getByTestId('pf-email-password'), DEMO_PASSWORDS.engineer);
    await u.click(screen.getByTestId('pf-email-submit'));
    expect(await screen.findByTestId('pf-email-pending')).toHaveTextContent('sami.new@example.com');
    expect(screen.getByTestId('pf-email')).toHaveTextContent('sami.nuri@example.com');
    expect(screen.queryByTestId('pf-email-form')).toBeNull();
    await u.click(screen.getByTestId('pf-email-cancel'));
    expect(await screen.findByTestId('pf-email-form')).toBeInTheDocument();
    expect(db().emailChanges[0].status).toBe('cancelled');
  });

  it('an admin approves it from Users & Roles with a reason; the user sees the new email', async () => {
    await localSignIn();
    await api.post('/me/email-change', { body: { new_email: 'sami.approved@example.com', password: DEMO_PASSWORDS.engineer } });
    await api.post('/auth/logout');
    await localSignIn('1001', DEMO_PASSWORDS.pm);
    freshStepUp();
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/admin/users" element={<Users />} /></Routes>, { route: '/admin/users?email_changes=pending' });
    const row = await screen.findByTestId('email-change-row-1204');
    expect(row).toHaveTextContent('sami.approved@example.com');
    await u.click(within(row).getByTestId('email-change-approve-1204'));
    await u.type(screen.getByTestId('email-change-dialog-reason'), 'Checked by phone');
    await u.click(screen.getByTestId('email-change-dialog-submit'));
    expect(await screen.findByTestId('email-changes-empty')).toBeInTheDocument();
    expect(db().emailChanges[0]).toMatchObject({ status: 'approved', decision_reason: 'Checked by phone' });
    // the admin cannot decide their own
    await api.post('/me/email-change', { body: { new_email: 'ahmed.new@example.com', password: DEMO_PASSWORDS.pm } });
    const own = db().emailChanges.find((x) => x.account === 'pm')!;
    const e = await fail(api.post(`/email-change-requests/${own.id}/decide`, { body: { decision: 'approve', reason: 'mine' } }));
    expect(e.code).toBe('self_beneficiary');
    await api.post('/auth/logout');
    await localSignIn();
    const p = await api.get<{ email: string; email_change: { status: string } }>('/me/profile');
    expect(p).toMatchObject({ email: 'sami.approved@example.com', email_change: { status: 'approved' } });
  });
});

describe('password', () => {
  it('a wrong current password is shown; the policy is the sign-in policy; success clears the form', async () => {
    await localSignIn();
    const u = userEvent.setup();
    renderApp(<Profile />);
    await u.type(await screen.findByTestId('pf-cur'), 'not-the-password');
    await u.type(screen.getByTestId('pf-next'), 'Brand-New-Phrase-2026');
    await u.type(screen.getByTestId('pf-again'), 'Brand-New-Phrase-2026');
    await u.click(screen.getByTestId('pf-password-submit'));
    expect(await screen.findByTestId('pf-cur-error')).toBeInTheDocument();
    await u.type(screen.getByTestId('pf-cur'), DEMO_PASSWORDS.engineer);
    await u.click(screen.getByTestId('pf-password-submit'));
    await waitFor(() => expect(cred('engineer')!.password).toBe('Brand-New-Phrase-2026'));
    expect(screen.getByTestId('pf-cur')).toHaveValue('');
  });
});

describe('two-factor self-service', () => {
  it('turns it on after the password step-up (no admin code): QR code, first code, recovery codes; then off with the password and a code', async () => {
    await localSignIn();
    const u = userEvent.setup();
    renderApp(<Profile />);
    expect(await screen.findByTestId('pf-tf-state')).toHaveAttribute('data-state', 'off');
    await u.click(screen.getByTestId('pf-tf-enable'));
    await u.type(await screen.findByTestId('stepup-password'), DEMO_PASSWORDS.engineer);
    await u.click(screen.getByTestId('stepup-continue'));
    expect(await screen.findByTestId('enrol-qr')).toBeInTheDocument();
    const secret = cred('engineer')!.tf!.selfPending!;
    expect(screen.getByTestId('pf-tf-key').textContent?.replace(/\s/g, '')).toBe(secret);
    await u.type(screen.getByTestId('pf-tf-code'), await codeAt(secret));
    await u.click(screen.getByTestId('pf-tf-confirm'));
    expect(await screen.findByTestId('recovery-codes')).toBeInTheDocument();
    expect(screen.getAllByTestId('recovery-code')).toHaveLength(10);
    await u.click(screen.getByTestId('recovery-saved'));
    await u.click(screen.getByTestId('recovery-continue'));
    expect(await screen.findByTestId('pf-tf-state')).toHaveAttribute('data-state', 'on');
    expect(cred('engineer')!.tf).toMatchObject({ on: true, enforced: false });

    await u.click(screen.getByTestId('pf-tf-disable'));
    await u.type(screen.getByTestId('pf-tf-password'), DEMO_PASSWORDS.engineer);
    await u.type(screen.getByTestId('pf-tf-off-code'), await codeAt(secret, 1));
    await u.click(screen.getByTestId('pf-tf-disable-submit'));
    await waitFor(() => expect(screen.getByTestId('pf-tf-state')).toHaveAttribute('data-state', 'off'));
    expect(cred('engineer')!.tf).toBeUndefined();
  });

  it('when an admin enforces it the page explains it, offers no turn-off, and the API answers 403 two_factor_enforced', async () => {
    const secret = newSecret();
    const c = cred('engineer')!;
    c.tf = { on: true, secret, pending: null, codes: newRecoveryCodes(), lastStep: null, failures: 0, enforced: true };
    save();
    const first = await api.post<{ authenticated: boolean }>('/auth/local/login', { body: { identifier: '1204', password: DEMO_PASSWORDS.engineer } });
    expect(first.authenticated).toBe(false);
    const s = await api.post<{ csrf_token: string }>('/auth/local/2fa', { body: { code: await codeAt(secret) } });
    setCsrfToken(s.csrf_token);
    renderApp(<Profile />);
    expect(await screen.findByTestId('pf-tf-enforced')).toBeInTheDocument();
    expect(screen.queryByTestId('pf-tf-disable')).toBeNull();
    const e = await fail(api.post('/me/two-factor/disable', { body: { password: DEMO_PASSWORDS.engineer, code: await codeAt(secret, 1) } }));
    expect(e.status).toBe(403);
    expect(e.code).toBe('two_factor_enforced');
  });

  it('an admin marks and unmarks enforced on the user page', async () => {
    const c = cred('engineer')!;
    c.tf = { on: true, secret: newSecret(), pending: null, codes: newRecoveryCodes(), lastStep: null, failures: 0, enforced: false };
    save();
    await localSignIn('1001', DEMO_PASSWORDS.pm);
    freshStepUp();
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/admin/users/:userId" element={<UserDetailPage />} /></Routes>, { route: `/admin/users/${uid('1204')}` });
    expect(await screen.findByTestId('two-factor-enforced-state')).toHaveAttribute('data-enforced', 'false');
    await u.click(screen.getByTestId('two-factor-enforce'));
    await u.type(screen.getByTestId('two-factor-enforce-dialog-reason'), 'Finance role');
    await u.click(screen.getByTestId('two-factor-enforce-dialog-submit'));
    await waitFor(() => expect(cred('engineer')!.tf!.enforced).toBe(true));
    expect(await screen.findByTestId('two-factor-enforced-state')).toHaveAttribute('data-enforced', 'true');
  });
});
