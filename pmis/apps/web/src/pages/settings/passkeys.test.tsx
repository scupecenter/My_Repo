import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { api, setCsrfToken } from '@/api/client';
import { cred, db, DEMO_PASSWORDS, save } from '@/mocks/db';
import { passkeyState } from '@/mocks/passkeys';
import { newRecoveryCodes, newSecret } from '@/mocks/totp';
import { renderApp, signIn } from '@/test/utils';
import { uid } from '@/mocks/ids';
import { Profile } from '../Profile';
import { UserDetailPage } from '../UserDetail';
import { SettingsRoutes } from './Settings';

/** Passkeys (migration 0294, contract 0.15.194): off by default, an alternative to the code at the second step, never forced. The browser prompt is stubbed. */
const page = () => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/security/passkeys' });
const submit = async (u: ReturnType<typeof userEvent.setup>, reason: string) => {
  await u.type(await screen.findByTestId('passkeys-dialog-reason'), reason);
  await u.click(screen.getByTestId('passkeys-dialog-submit'));
};
const twoFactorOn = (key: string) => {
  cred(key)!.tf = { on: true, secret: newSecret(), pending: null, codes: newRecoveryCodes(), lastStep: null, failures: 0, enrolCode: null, enrolExpires: null };
  save();
};
const buf = (n: number) => new Uint8Array(n).fill(7).buffer;
const fakeCredential = (id: string, kind: 'create' | 'get') => ({
  id, rawId: buf(8), type: 'public-key', authenticatorAttachment: null, getClientExtensionResults: () => ({}),
  response: kind === 'create'
    ? { clientDataJSON: buf(10), attestationObject: buf(12), getTransports: () => ['internal'] }
    : { clientDataJSON: buf(10), authenticatorData: buf(37), signature: buf(70), userHandle: null },
});
function stubBrowser(id = 'cred-1') {
  const create = vi.fn(async () => fakeCredential(id, 'create'));
  const get = vi.fn(async () => fakeCredential(id, 'get'));
  Object.defineProperty(navigator, 'credentials', { value: { create, get }, configurable: true });
  Object.defineProperty(window, 'PublicKeyCredential', { value: class {}, configurable: true });
  return { create, get };
}
beforeEach(() => { Object.assign(passkeyState, { enabled: false, ready: true, version: 1, updated_at: null, updated_by: null, items: {} }); });
afterEach(() => { Object.defineProperty(navigator, 'credentials', { value: undefined, configurable: true }); Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true }); });

describe('Settings, Passkeys', () => {
  it('is off by default; an admin turns it on and off again', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    page();
    expect(await screen.findByTestId('page-passkeys')).toBeInTheDocument();
    expect(screen.getByTestId('passkeys-enabled')).not.toBeChecked();
    expect(screen.getByTestId('passkeys-save')).toBeDisabled();
    await u.click(screen.getByTestId('passkeys-enabled'));
    await u.click(screen.getByTestId('passkeys-save'));
    await api.post('/__mock/step-up');
    await submit(u, 'Turn on passkeys');
    await waitFor(() => expect(screen.getByTestId('passkeys-updated')).toBeInTheDocument());
    expect(screen.getByTestId('passkeys-enabled')).toBeChecked();
    await u.click(screen.getByTestId('passkeys-enabled'));
    await u.click(screen.getByTestId('passkeys-save'));
    await submit(u, 'Back to normal');
    await waitFor(() => expect(screen.getByTestId('passkeys-enabled')).not.toBeChecked());
  });

  it('cannot be turned on while the workspace address is not set, and says why', async () => {
    passkeyState.ready = false;
    await signIn('pm');
    page();
    expect(await screen.findByTestId('passkeys-not-ready')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByTestId('passkeys-enabled'));
    expect(screen.getByTestId('passkeys-save')).toBeDisabled();
  });

  it('shows a short notice, not the data, to someone who is not a System Admin', async () => {
    await signIn('engineer');
    page();
    expect(await screen.findByTestId('passkeys-readonly')).toBeInTheDocument();
  });
});

describe('Profile, own passkeys', () => {
  async function localSignIn() {
    const s = await api.post<{ csrf_token: string }>('/auth/local/login', { body: { identifier: '1204', password: DEMO_PASSWORDS.engineer } });
    setCsrfToken(s.csrf_token);
  }
  it('shows nothing while the setting is off', async () => {
    twoFactorOn('engineer');
    await signIn('engineer');
    renderApp(<Profile />);
    await screen.findByTestId('pf-tf-state');
    expect(screen.queryByTestId('pf-passkeys')).toBeNull();
  });

  it('adds a passkey (step-up, browser prompt) and removes it again', async () => {
    const { create } = stubBrowser();
    passkeyState.enabled = true;
    await localSignIn();
    twoFactorOn('engineer');
    db().session!.stepupAt = Date.now(); save();
    const u = userEvent.setup();
    renderApp(<Profile />);
    expect(await screen.findByTestId('pf-passkeys-none')).toBeInTheDocument();
    expect(screen.getByTestId('pf-passkey-add')).toBeDisabled();
    await u.type(screen.getByTestId('pf-passkey-label'), 'Work laptop');
    await u.click(screen.getByTestId('pf-passkey-add'));
    expect(await screen.findByText('Work laptop')).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);
    const id = passkeyState.items.engineer![0]!.id;
    await u.click(screen.getByTestId(`pf-passkey-remove-${id}`));
    await u.click(await screen.findByTestId('pf-passkey-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('pf-passkeys-none')).toBeInTheDocument());
  });

  it('does not offer a passkey to an account without two-step verification', async () => {
    stubBrowser();
    passkeyState.enabled = true;
    await localSignIn();
    renderApp(<Profile />);
    await screen.findByTestId('pf-tf-state');
    expect(screen.queryByTestId('pf-passkeys')).toBeNull();
  });

  it('a cancelled browser prompt leaves everything as it was, without an error', async () => {
    const { create } = stubBrowser();
    create.mockRejectedValueOnce(new DOMException('cancelled', 'NotAllowedError'));
    passkeyState.enabled = true;
    await localSignIn();
    twoFactorOn('engineer');
    db().session!.stepupAt = Date.now(); save();
    const u = userEvent.setup();
    renderApp(<Profile />);
    await u.type(await screen.findByTestId('pf-passkey-label'), 'Phone');
    await u.click(screen.getByTestId('pf-passkey-add'));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(screen.queryByTestId('pf-passkeys-error')).toBeNull();
    expect(passkeyState.items.engineer ?? []).toHaveLength(0);
  });
});

describe('Sign-in with a passkey at the second step', () => {
  const login = async (u: ReturnType<typeof userEvent.setup>) => {
    await u.type(await screen.findByTestId('login-identifier'), '1204');
    await u.type(screen.getByTestId('login-password'), DEMO_PASSWORDS.engineer!);
    await u.click(screen.getByTestId('login-submit'));
    await screen.findByTestId('two-factor-form');
  };
  const withPasskey = () => { passkeyState.enabled = true; passkeyState.items.engineer = [{ id: 'pk-1', credential_id: 'cred-1', label: 'Laptop', created_at: new Date().toISOString(), last_used_at: null, device_type: 'multiDevice', backed_up: true }]; };

  it('offers the button only when a passkey is registered and the setting is on; the code box stays', async () => {
    stubBrowser();
    twoFactorOn('engineer');
    renderApp(<App />, { route: '/login' });
    const u = userEvent.setup();
    await login(u);
    expect(screen.getByTestId('two-factor-code')).toBeInTheDocument();
    expect(screen.queryByTestId('two-factor-passkey')).toBeNull();
  });

  it('signs in with the passkey instead of the code', async () => {
    const { get } = stubBrowser();
    withPasskey();
    twoFactorOn('engineer');
    renderApp(<App />, { route: '/login' });
    const u = userEvent.setup();
    await login(u);
    expect(screen.getByTestId('two-factor-code')).toBeInTheDocument();
    await u.click(await screen.findByTestId('two-factor-passkey'));
    expect(await screen.findByTestId('page-my-work')).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('a passkey the server does not know is refused with a plain message and the code still works', async () => {
    stubBrowser('someone-else');
    withPasskey();
    twoFactorOn('engineer');
    renderApp(<App />, { route: '/login' });
    const u = userEvent.setup();
    await login(u);
    await u.click(await screen.findByTestId('two-factor-passkey'));
    expect(await screen.findByTestId('two-factor-passkey-error')).toBeInTheDocument();
    expect(screen.getByTestId('two-factor-code')).toBeInTheDocument();
  });

  it('hides the button when the browser has no passkey support', async () => {
    withPasskey();
    twoFactorOn('engineer');
    renderApp(<App />, { route: '/login' });
    const u = userEvent.setup();
    await login(u);
    expect(screen.queryByTestId('two-factor-passkey')).toBeNull();
  });
});

describe('Admin recovery', () => {
  it('removes every passkey of one person with a reason; the code and recovery codes stay', async () => {
    passkeyState.enabled = true;
    passkeyState.items.engineer = [{ id: 'pk-1', credential_id: 'c1', label: 'Laptop', created_at: new Date().toISOString(), last_used_at: null, device_type: 'multiDevice', backed_up: true }];
    twoFactorOn('engineer');
    const s = await api.post<{ csrf_token: string }>('/auth/local/login', { body: { identifier: '1001', password: DEMO_PASSWORDS.pm } });
    setCsrfToken(s.csrf_token);
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/admin/users/:userId" element={<UserDetailPage />} /></Routes>, { route: `/admin/users/${uid('1204')}` });
    await u.click(await screen.findByTestId('two-factor-passkeys-revoke'));
    await u.type(screen.getByTestId('passkeys-revoke-dialog-reason'), 'Lost laptop');
    await u.click(screen.getByTestId('passkeys-revoke-dialog-submit'));
    await u.type(await screen.findByTestId('stepup-password'), DEMO_PASSWORDS.pm!);
    await u.click(screen.getByTestId('stepup-continue'));
    await waitFor(() => expect(passkeyState.items.engineer).toBeUndefined());
    expect(cred('engineer')!.tf!.on).toBe(true);
    expect(cred('engineer')!.tf!.codes.length).toBeGreaterThan(0);
  });
});
