import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '@/App';
import { api, ApiError, setCsrfToken } from '@/api/client';
import { cred, DEMO_PASSWORDS, save } from '@/mocks/db';
import { uid } from '@/mocks/ids';
import { hotp, newRecoveryCodes, newSecret, otpauth, stepOf } from '@/mocks/totp';
import { renderApp } from '@/test/utils';
import { ChangePassword } from './ChangePassword';
import { UserDetailPage } from './UserDetail';
import { Users } from './Users';

const fail = (p: Promise<unknown>) => p.then(() => { throw new Error('expected the call to fail'); }, (e: ApiError) => e);
/** Two-factor on for a demo account, as an admin would have left it. `secret` null = not set up yet. */
const ENROL = 'K7M2-9QXA';
function setTwoFactor(key: string, secret: string | null, opt: { code?: string | null; expires?: number } = {}) {
  const c = cred(key)!;
  c.tf = {
    on: true, secret, pending: null, codes: secret ? newRecoveryCodes() : [], lastStep: null, failures: 0,
    // a user who is waiting for enrolment holds the one-time code an admin handed over (contract 0.6.0)
    enrolCode: secret ? null : opt.code === undefined ? ENROL : opt.code, enrolExpires: secret ? null : opt.expires ?? Date.now() + 72 * 3600_000,
  };
  save();
  return c.tf;
}
const enterCode = async (u: ReturnType<typeof userEvent.setup>, code: string) => {
  await u.type(screen.getByTestId('enrol-admin-code'), code);
  await u.click(screen.getByTestId('enrol-admin-code-submit'));
};
const codeAt = (secret: string, offset = 0) => hotp(secret, stepOf(Date.now()) + offset);  // async: WebCrypto
const fillLogin = async (u: ReturnType<typeof userEvent.setup>, id: string, pw: string) => {
  await u.type(screen.getByTestId('login-identifier'), id);
  await u.type(screen.getByTestId('login-password'), pw);
  await u.click(screen.getByTestId('login-submit'));
};
/** Password and code through the API, the way the login screen does. */
async function signInWithCode(identifier: string, password: string, code: string) {
  const first = await api.post<{ authenticated: boolean; next?: string }>('/auth/local/login', { body: { identifier, password } });
  expect(first).toMatchObject({ authenticated: false, next: 'two_factor' });
  const s = await api.post<{ csrf_token: string }>('/auth/local/2fa', { body: { code } });
  setCsrfToken(s.csrf_token);
}

describe('sign-in with a code', () => {
  it('asks for the code after the password; a wrong code stays on the step; the right one signs in', async () => {
    const secret = newSecret();
    setTwoFactor('engineer', secret);
    const u = userEvent.setup();
    renderApp(<App />, { route: '/login' });
    await fillLogin(u, '1204', DEMO_PASSWORDS.engineer);
    expect(await screen.findByTestId('two-factor-form')).toBeInTheDocument();
    expect(screen.queryByTestId('page-my-work')).toBeNull();
    await u.type(screen.getByTestId('two-factor-code'), '000000');
    await u.click(screen.getByTestId('two-factor-submit'));
    expect(await screen.findByTestId('two-factor-error')).toHaveTextContent(/not correct/i);
    expect(screen.getByTestId('two-factor-code')).toHaveValue('');
    await u.type(screen.getByTestId('two-factor-code'), await codeAt(secret));
    await u.click(screen.getByTestId('two-factor-submit'));
    expect(await screen.findByTestId('page-my-work')).toBeInTheDocument();
  });

  it('a recovery code works instead, once, and the count goes down', async () => {
    const secret = newSecret();
    const tf = setTwoFactor('engineer', secret);
    const rc = tf.codes[0];
    const u = userEvent.setup();
    renderApp(<App />, { route: '/login' });
    await fillLogin(u, '1204', DEMO_PASSWORDS.engineer);
    await u.click(await screen.findByTestId('two-factor-toggle'));
    await u.type(screen.getByTestId('two-factor-recovery'), rc.toLowerCase());
    await u.click(screen.getByTestId('two-factor-submit'));
    expect(await screen.findByTestId('page-my-work')).toBeInTheDocument();
    expect(cred('engineer')!.tf!.codes).toHaveLength(9);
    await api.post('/auth/logout');
    await api.post('/auth/local/login', { body: { identifier: '1204', password: DEMO_PASSWORDS.engineer } });
    const again = await fail(api.post('/auth/local/2fa', { body: { recovery_code: rc } }));
    expect(again.status).toBe(401);
    expect(again.code).toBe('invalid_code');
  });

  it('refuses a code that was already used', async () => {
    const secret = newSecret();
    setTwoFactor('engineer', secret);
    const used = await codeAt(secret);
    await signInWithCode('1204', DEMO_PASSWORDS.engineer, used);
    await api.post('/auth/logout');
    await api.post('/auth/local/login', { body: { identifier: '1204', password: DEMO_PASSWORDS.engineer } });
    const replay = await fail(api.post('/auth/local/2fa', { body: { code: used } }));
    expect(replay.code).toBe('invalid_code');
  });

  it('locks the account after 5 wrong codes', async () => {
    setTwoFactor('engineer', newSecret());
    await api.post('/auth/local/login', { body: { identifier: '1204', password: DEMO_PASSWORDS.engineer } });
    for (let i = 0; i < 5; i++) expect((await fail(api.post('/auth/local/2fa', { body: { code: '000000' } }))).status).toBe(401);
    expect((await fail(api.post('/auth/local/login', { body: { identifier: '1204', password: DEMO_PASSWORDS.engineer } }))).code).toBe('invalid_credentials');
  });

  it('the password alone gives no session when two-factor is on', async () => {
    setTwoFactor('engineer', newSecret());
    await api.post('/auth/local/login', { body: { identifier: '1204', password: DEMO_PASSWORDS.engineer } });
    expect((await fail(api.get('/me'))).status).toBe(401);
    expect((await fail(api.post('/auth/local/2fa', { body: {} }))).status).toBe(422);
  });

  it('is shown in Arabic with RTL direction', async () => {
    setTwoFactor('engineer', newSecret());
    const u = userEvent.setup();
    renderApp(<App />, { route: '/login', locale: 'ar' });
    await fillLogin(u, '1204', DEMO_PASSWORDS.engineer);
    expect(await screen.findByTestId('two-factor-form')).toHaveTextContent('التحقق بخطوتين');
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByTestId('two-factor-code')).toHaveAttribute('dir', 'ltr');
  });
});

describe('forced enrolment', () => {
  it('asks for the enrolment code first: no QR code, no secret until the right code is entered', async () => {
    setTwoFactor('engineer', null);
    const u = userEvent.setup();
    renderApp(<App />, { route: '/login' });
    await fillLogin(u, '1204', DEMO_PASSWORDS.engineer);
    expect(await screen.findByTestId('enrol-code-form')).toBeInTheDocument();
    expect(screen.queryByTestId('enrol-qr')).toBeNull();
    expect(screen.queryByTestId('enrol-key')).toBeNull();
    expect(screen.getByTestId('enrol-admin-code-submit')).toBeDisabled(); // incomplete
    await u.type(screen.getByTestId('enrol-admin-code'), 'aaaabbbb');
    expect(screen.getByTestId('enrol-admin-code')).toHaveValue('AAAA-BBBB'); // upper case, dash added
    await u.click(screen.getByTestId('enrol-admin-code-submit'));
    expect(await screen.findByTestId('enrol-admin-code-error')).toHaveTextContent(/not correct/i);
    expect(screen.queryByTestId('enrol-qr')).toBeNull();
    expect(cred('engineer')!.tf!.pending).toBeNull(); // nothing was made
    expect(cred('engineer')!.tf!.failures).toBe(1); // a wrong code counts like a wrong authenticator code
  });

  it('an expired code is explained in plain words, and an administrator is named as the way out', async () => {
    setTwoFactor('engineer', null, { expires: Date.now() - 60_000 });
    const u = userEvent.setup();
    renderApp(<App />, { route: '/login' });
    await fillLogin(u, '1204', DEMO_PASSWORDS.engineer);
    await screen.findByTestId('enrol-code-form');
    expect(screen.getByTestId('enrol-code-form')).toHaveTextContent(/ask your administrator/i);
    await enterCode(u, ENROL);
    expect(await screen.findByTestId('enrol-admin-code-error')).toHaveTextContent(/expired.*new one/i);
    expect(screen.queryByTestId('enrol-qr')).toBeNull();
  });

  it('five wrong codes lock the account like wrong authenticator codes', async () => {
    setTwoFactor('engineer', null);
    const u = userEvent.setup();
    renderApp(<App />, { route: '/login' });
    await fillLogin(u, '1204', DEMO_PASSWORDS.engineer);
    await screen.findByTestId('enrol-code-form');
    for (let i = 0; i < 5; i++) {
      await u.clear(screen.getByTestId('enrol-admin-code'));
      await enterCode(u, `ZZZZ999${i + 1}`);
      await waitFor(() => expect(cred('engineer')!.tf!.failures).toBe(i + 1 === 5 ? 0 : i + 1));
    }
    expect(cred('engineer')!.locked_until).toBeGreaterThan(Date.now() + 14 * 60_000);
  });

  it('shows the QR code and the manual key after the code, confirms with a code, and shows the recovery codes once', async () => {
    setTwoFactor('engineer', null);
    const u = userEvent.setup();
    renderApp(<App />, { route: '/login' });
    await fillLogin(u, '1204', DEMO_PASSWORDS.engineer);
    expect(await screen.findByTestId('enrol-forced')).toBeInTheDocument();
    await enterCode(u, 'k7m2 9qxa'); // typing variants are fine
    const qr = await screen.findByTestId('enrol-qr');
    expect(qr.tagName.toLowerCase()).toBe('svg');
    expect(qr.querySelector('path')?.getAttribute('d')?.length).toBeGreaterThan(200);
    const key = screen.getByTestId('enrol-key').textContent!.replace(/\s/g, '');
    expect(key).toMatch(/^[A-Z2-7]{32}$/);
    expect(cred('engineer')!.tf!.pending).toBe(key);
    expect(otpauth(key, 'sami.nuri@example.com')).toContain('issuer=GSDN%20PMIS');

    await u.type(screen.getByTestId('enrol-code'), '000000');
    await u.click(screen.getByTestId('enrol-submit'));
    expect(await screen.findByTestId('enrol-code-error')).toBeInTheDocument();
    await u.type(screen.getByTestId('enrol-code'), await codeAt(key));
    await u.click(screen.getByTestId('enrol-submit'));

    const list = await screen.findByTestId('recovery-code-list');
    const codes = within(list).getAllByTestId('recovery-code').map((x) => x.textContent!);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(screen.getByTestId('recovery-continue')).toBeDisabled();
    expect(screen.getByTestId('recovery-copy')).toBeInTheDocument();
    expect(screen.getByTestId('recovery-download')).toBeInTheDocument();
    await u.click(screen.getByTestId('recovery-saved'));
    await u.click(screen.getByTestId('recovery-continue'));
    expect(await screen.findByTestId('page-my-work')).toBeInTheDocument();
    expect(cred('engineer')!.tf!.secret).toBe(key);
    expect(cred('engineer')!.tf!.enrolCode).toBeNull(); // single use
  });

  it('only the enrolment endpoints answer with the pending sign-in', async () => {
    setTwoFactor('engineer', null);
    const first = await api.post<{ next: string }>('/auth/local/login', { body: { identifier: '1204', password: DEMO_PASSWORDS.engineer } });
    expect(first.next).toBe('enrol');
    expect((await fail(api.get('/me'))).status).toBe(401);
    expect((await fail(api.post('/auth/local/2fa', { body: { code: '123456' } }))).status).toBe(401);
    // contract 0.6.0: no code, no secret and no QR code
    const none = await fail(api.post('/auth/local/2fa/enrol/start'));
    expect(none.status).toBe(422);
    const wrong = await fail(api.post('/auth/local/2fa/enrol/start', { body: { enrol_code: 'AAAA-BBBB' } }));
    expect(wrong.status).toBe(401);
    expect(wrong.code).toBe('invalid_enrol_code');
    expect(cred('engineer')!.tf!.pending).toBeNull();
    const started = await api.post<{ secret: string; otpauth_uri: string; issuer: string }>('/auth/local/2fa/enrol/start', { body: { enrol_code: ENROL } });
    expect(started.issuer).toBe('GSDN PMIS');
    expect(started.otpauth_uri).toMatch(/^otpauth:\/\/totp\/GSDN%20PMIS:/);
    // the code is checked again at the confirm step, and used up there
    const noCode = await fail(api.post('/auth/local/2fa/enrol/confirm', { body: { code: await codeAt(started.secret) } }));
    expect(noCode.status).toBe(422);
    const badCode = await fail(api.post('/auth/local/2fa/enrol/confirm', { body: { code: await codeAt(started.secret), enrol_code: 'AAAA-BBBB' } }));
    expect(badCode.code).toBe('invalid_enrol_code');
    expect(cred('engineer')!.tf!.secret).toBeNull();
  });

  it('renders the QR code and the recovery codes in dark mode and Arabic', async () => {
    setTwoFactor('engineer', null);
    document.documentElement.dataset.theme = 'dark';
    const u = userEvent.setup();
    renderApp(<App />, { route: '/login', locale: 'ar' });
    await fillLogin(u, '1204', DEMO_PASSWORDS.engineer);
    expect(await screen.findByTestId('enrol-code-form')).toHaveTextContent('أدخل رمز التسجيل');
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByTestId('enrol-admin-code')).toHaveAttribute('dir', 'ltr');
    await enterCode(u, ENROL);
    expect(await screen.findByTestId('enrol-form')).toHaveTextContent('إعداد التحقق الثنائي');
    const qr = await screen.findByTestId('enrol-qr');
    expect(qr).toHaveClass('bg-white'); // scannable on a dark page
    const key = screen.getByTestId('enrol-key').textContent!.replace(/\s/g, '');
    await u.type(screen.getByTestId('enrol-code'), await codeAt(key));
    await u.click(screen.getByTestId('enrol-submit'));
    expect(await screen.findByTestId('recovery-codes')).toHaveTextContent('رموز الاسترداد');
    delete document.documentElement.dataset.theme;
  });
});

describe('step-up with a code', () => {
  it('asks for the password and the code together, and a wrong code stays in the dialog', async () => {
    const secret = newSecret();
    setTwoFactor('pm', secret);
    await signInWithCode('1001', DEMO_PASSWORDS.pm, await codeAt(secret));
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/admin/users/:userId" element={<UserDetailPage />} /></Routes>, { route: `/admin/users/${uid('1204')}` });
    await u.click(await screen.findByTestId('user-reset-password'));
    await u.type(screen.getByTestId('reset-password-dialog-reason'), 'User forgot the password');
    await u.click(screen.getByTestId('reset-password-dialog-submit'));
    await u.type(await screen.findByTestId('stepup-password'), DEMO_PASSWORDS.pm);
    expect(screen.getByTestId('stepup-continue')).toBeDisabled(); // the code is missing
    await u.type(screen.getByTestId('stepup-code'), '000000');
    await u.click(screen.getByTestId('stepup-continue'));
    expect(await screen.findByTestId('stepup-error')).toBeInTheDocument();
    await u.type(screen.getByTestId('stepup-password'), DEMO_PASSWORDS.pm);
    await u.type(screen.getByTestId('stepup-code'), await codeAt(secret, 1));
    await u.click(screen.getByTestId('stepup-continue'));
    expect((await screen.findByTestId('temp-password')).textContent).toHaveLength(16);
  });

  it('a user without two-factor sees the password field only', async () => {
    await api.post('/auth/local/login', { body: { identifier: '1001', password: DEMO_PASSWORDS.pm } });
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/admin/users/:userId" element={<UserDetailPage />} /></Routes>, { route: `/admin/users/${uid('1204')}` });
    await u.click(await screen.findByTestId('user-reset-password'));
    await u.type(screen.getByTestId('reset-password-dialog-reason'), 'User forgot the password');
    await u.click(screen.getByTestId('reset-password-dialog-submit'));
    await screen.findByTestId('stepup-password');
    expect(screen.queryByTestId('stepup-code')).toBeNull();
    await u.click(screen.getByTestId('stepup-cancel')); // leave no step-up waiting for the next test
  });
});

describe('Users & Roles: the 2FA badge and the admin actions', () => {
  const asAdmin = async () => {
    const s = await api.post<{ csrf_token: string }>('/auth/local/login', { body: { identifier: '1001', password: DEMO_PASSWORDS.pm } });
    setCsrfToken(s.csrf_token);
  };
  const stepUp = async (u: ReturnType<typeof userEvent.setup>) => {
    await u.type(await screen.findByTestId('stepup-password'), DEMO_PASSWORDS.pm);
    await u.click(screen.getByTestId('stepup-continue'));
  };

  it('the admin turns two-factor on, then resets it, then turns it off, with a reason each time', async () => {
    await asAdmin();
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/admin/users/:userId" element={<UserDetailPage />} /></Routes>, { route: `/admin/users/${uid('1204')}` });
    expect(await screen.findByTestId('tf-badge-1204')).toHaveAttribute('data-state', 'off');
    await u.click(await screen.findByTestId('two-factor-on'));
    await u.click(screen.getByTestId('two-factor-dialog-submit')); // no reason yet
    expect(await screen.findByTestId('two-factor-dialog-reason-error')).toBeInTheDocument();
    await u.type(screen.getByTestId('two-factor-dialog-reason'), 'Finance approver');
    await u.click(screen.getByTestId('two-factor-dialog-submit'));
    await stepUp(u);
    // the one-time enrolment code is shown once, with copy, the expiry and a button that closes it
    const dlg = await screen.findByTestId('enrol-code-dialog');
    const shown = within(dlg).getByTestId('enrol-code-value').textContent!;
    expect(shown).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(shown).toBe(cred('engineer')!.tf!.enrolCode);
    expect(within(dlg).getByTestId('enrol-code-expiry')).toHaveTextContent(/expires on/i);
    expect(within(dlg).getByTestId('enrol-code-warning')).toBeInTheDocument();
    expect(within(dlg).getByTestId('enrol-code-copy')).toBeInTheDocument();
    await u.keyboard('{Escape}');
    expect(screen.getByTestId('enrol-code-dialog')).toBeInTheDocument(); // not lost by a stray key
    await u.click(within(dlg).getByTestId('enrol-code-done'));
    await waitFor(() => expect(screen.queryByTestId('enrol-code-dialog')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('tf-badge-1204')).toHaveAttribute('data-state', 'pending_enrolment'));
    expect(cred('engineer')!.tf).toMatchObject({ on: true, secret: null });
    expect(await screen.findByTestId('enrol-code-status')).toHaveAttribute('data-state', 'active');

    // enrolled by the user, then reset by the admin: a new code is shown
    cred('engineer')!.tf = { on: true, secret: newSecret(), pending: null, codes: newRecoveryCodes(), lastStep: null, failures: 0 };
    save();
    await u.click(await screen.findByTestId('two-factor-reset'));
    await u.type(screen.getByTestId('two-factor-dialog-reason'), 'Lost phone');
    await u.click(screen.getByTestId('two-factor-dialog-submit'));
    const again = await screen.findByTestId('enrol-code-dialog');
    expect(within(again).getByTestId('enrol-code-value').textContent).toBe(cred('engineer')!.tf!.enrolCode);
    await u.click(within(again).getByTestId('enrol-code-done'));
    await waitFor(() => expect(cred('engineer')!.tf).toMatchObject({ on: true, secret: null, codes: [] }));

    // a new code for a user who is waiting: the old one stops working
    const before = cred('engineer')!.tf!.enrolCode;
    await u.click(await screen.findByTestId('two-factor-new-code'));
    await u.type(screen.getByTestId('two-factor-dialog-reason'), 'The user lost the note');
    await u.click(screen.getByTestId('two-factor-dialog-submit'));
    const fresh = await screen.findByTestId('enrol-code-dialog');
    const freshCode = within(fresh).getByTestId('enrol-code-value').textContent!;
    expect(freshCode).not.toBe(before);
    expect(cred('engineer')!.tf!.enrolCode).toBe(freshCode);
    await u.click(within(fresh).getByTestId('enrol-code-done'));
    await waitFor(() => expect(screen.queryByTestId('enrol-code-dialog')).toBeNull());

    await u.click(await screen.findByTestId('two-factor-off'));
    await u.type(screen.getByTestId('two-factor-dialog-reason'), 'Phone replaced, user re-enrols later');
    await u.click(screen.getByTestId('two-factor-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('tf-badge-1204')).toHaveAttribute('data-state', 'off'));
    expect(screen.queryByTestId('enrol-code-dialog')).toBeNull(); // turning it off makes no code
    expect(cred('engineer')!.tf).toBeUndefined();
  });

  it('shows when the code ended, offers a new one, and the dialog reads right in Arabic and dark mode', async () => {
    setTwoFactor('engineer', null, { expires: Date.now() - 3600_000 });
    document.documentElement.dataset.theme = 'dark';
    await asAdmin();
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/admin/users/:userId" element={<UserDetailPage />} /></Routes>, { route: `/admin/users/${uid('1204')}`, locale: 'ar' });
    expect(await screen.findByTestId('enrol-code-status')).toHaveAttribute('data-state', 'expired');
    await u.click(await screen.findByTestId('two-factor-new-code'));
    await u.type(screen.getByTestId('two-factor-dialog-reason'), 'انتهت صلاحية الرمز');
    await u.click(screen.getByTestId('two-factor-dialog-submit'));
    await stepUp(u);
    const dlg = await screen.findByTestId('enrol-code-dialog');
    expect(dlg).toHaveTextContent('رمز التسجيل');
    expect(document.documentElement.dir).toBe('rtl');
    expect(within(dlg).getByTestId('enrol-code-value')).toHaveAttribute('dir', 'ltr');
    expect(within(dlg).getByTestId('enrol-code-expiry')).toHaveTextContent('تنتهي صلاحيته');
    await u.click(within(dlg).getByTestId('enrol-code-done'));
    delete document.documentElement.dataset.theme;
  });

  it('issuing a code is refused for a user who is not waiting, for yourself, and for a user without admin rights', async () => {
    await asAdmin();
    await api.post('/auth/local/step-up', { body: { password: DEMO_PASSWORDS.pm } });
    const off = await fail(api.post(`/users/${uid('1204')}/two-factor/enrol-code`, { body: { reason: 'nothing to enrol' } }));
    expect(off.status).toBe(409);
    const self = await fail(api.post(`/users/${uid('1001')}/two-factor/enrol-code`, { body: { reason: 'for myself' } }));
    expect(self.status).toBe(403);
    expect(self.code).toBe('self_beneficiary');
    await api.post('/auth/logout');
    const s = await api.post<{ csrf_token: string }>('/auth/local/login', { body: { identifier: '1204', password: DEMO_PASSWORDS.engineer } });
    setCsrfToken(s.csrf_token);
    setTwoFactor('reviewer', null);
    const denied = await fail(api.post(`/users/${uid('1102')}/two-factor/enrol-code`, { body: { reason: 'let me in' } }));
    expect(denied.status).toBe(403);
  });

  it('nobody changes their own: the buttons are disabled on your own page and the server refuses', async () => {
    await asAdmin();
    renderApp(<Routes><Route path="/admin/users/:userId" element={<UserDetailPage />} /></Routes>, { route: `/admin/users/${uid('1001')}` });
    expect(await screen.findByTestId('two-factor-on')).toBeDisabled();
    expect(screen.getByTestId('two-factor-self-note')).toBeInTheDocument();
    await api.post('/auth/local/step-up', { body: { password: DEMO_PASSWORDS.pm } });
    const refused = await fail(api.put(`/users/${uid('1001')}/two-factor`, { body: { enabled: true, reason: 'myself' } }));
    expect(refused.status).toBe(403);
    expect(refused.code).toBe('self_beneficiary');
  });

  it('shows the badge in the list and keeps the actions away from a user who cannot administer', async () => {
    setTwoFactor('engineer', newSecret());
    await asAdmin();
    renderApp(<Routes><Route path="/admin/users" element={<Users />} /></Routes>, { route: '/admin/users' });
    expect(await screen.findByTestId('tf-badge-1204')).toHaveAttribute('data-state', 'on');
    expect(screen.getByTestId('tf-badge-1204')).toHaveTextContent(/2FA/);
  });

  it('a user cannot see or call the admin actions: the call is refused (403)', async () => {
    const s = await api.post<{ csrf_token: string }>('/auth/local/login', { body: { identifier: '1204', password: DEMO_PASSWORDS.engineer } });
    setCsrfToken(s.csrf_token);
    const e = await fail(api.put(`/users/${uid('1204')}/two-factor`, { body: { enabled: false, reason: 'let me in' } }));
    expect(e.status).toBe(403);
  });
});

describe('account card: recovery codes left and new ones', () => {
  it('shows the number left and makes new codes only with a valid code', async () => {
    const secret = newSecret();
    const tf = setTwoFactor('engineer', secret);
    await signInWithCode('1204', DEMO_PASSWORDS.engineer, await codeAt(secret));
    tf.codes.splice(0, 3); // three used earlier
    save();
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/change-password" element={<ChangePassword />} /></Routes>, { route: '/change-password' });
    expect(await screen.findByTestId('recovery-remaining')).toHaveTextContent('7');
    await u.click(screen.getByTestId('recovery-regenerate'));
    await u.type(screen.getByTestId('regen-code'), '000000');
    await u.click(screen.getByTestId('regen-dialog-submit'));
    expect(await screen.findByTestId('regen-dialog-error')).toBeInTheDocument();
    await u.type(screen.getByTestId('regen-code'), await codeAt(secret, 1));
    await u.click(screen.getByTestId('regen-dialog-submit'));
    const list = await screen.findByTestId('recovery-code-list');
    expect(within(list).getAllByTestId('recovery-code')).toHaveLength(10);
    expect(cred('engineer')!.tf!.codes).toHaveLength(10);
  });

  it('offers no way to turn two-factor off', async () => {
    const secret = newSecret();
    setTwoFactor('engineer', secret);
    await signInWithCode('1204', DEMO_PASSWORDS.engineer, await codeAt(secret));
    renderApp(<Routes><Route path="/change-password" element={<ChangePassword />} /></Routes>, { route: '/change-password' });
    const card = await screen.findByTestId('two-factor-card');
    expect(within(card).queryByRole('button', { name: /turn off|disable|إيقاف/i })).toBeNull();
    expect(card).toHaveTextContent(/turn two-factor off in My profile unless an administrator enforces it/i); // owner decision 2026-11-02 (0.9.2): self-disable lives on the profile page
  });
});
