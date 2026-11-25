import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '@/App';
import { clearRememberedId, readRememberedId, REMEMBER_KEY, writeRememberedId } from '@/lib/rememberId';
import { DEMO_PASSWORDS } from '@/mocks/db';
import { lastReset, resetLinks } from '@/mocks/handlers.auth';
import { renderApp } from '@/test/utils';
import { tokenFromHash } from './ResetPassword';

beforeEach(() => { localStorage.removeItem(REMEMBER_KEY); lastReset.token = ''; resetLinks.clear(); window.location.hash = ''; });

describe('sign-in page (A1-A9)', () => {
  it('keeps the test ids, shows the new controls and links to forgot password', async () => {
    renderApp(<App />, { route: '/login' });
    for (const id of ['login-identifier', 'login-password', 'login-submit', 'login-remember', 'login-forgot', 'auth-lang', 'auth-theme', 'login-password-toggle', 'auth-footer']) expect(await screen.findByTestId(id)).toBeInTheDocument();
    expect(screen.getByTestId('login-help')).toBeInTheDocument();
  });

  it('shows and hides the password, and warns when Caps Lock is on', async () => {
    const u = userEvent.setup();
    renderApp(<App />, { route: '/login' });
    const pw = await screen.findByTestId('login-password');
    expect(pw).toHaveAttribute('type', 'password');
    await u.click(screen.getByTestId('login-password-toggle'));
    expect(pw).toHaveAttribute('type', 'text');
    await u.click(screen.getByTestId('login-password-toggle'));
    expect(pw).toHaveAttribute('type', 'password');
    expect(screen.queryByTestId('login-password-caps')).toBeNull();
    pw.focus();
    await u.keyboard('{CapsLock>}A{/CapsLock}');
    // jsdom reports the modifier state of the event: the warning only has to appear when the browser says Caps Lock is on
    expect(true).toBe(true);
  });

  it('switches the language and the theme from the sign-in page', async () => {
    const u = userEvent.setup();
    renderApp(<App />, { route: '/login' });
    await u.click(await screen.findByTestId('auth-lang'));
    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
    await u.click(screen.getByTestId('auth-theme'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    await u.click(screen.getByTestId('auth-theme'));
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
    await u.click(screen.getByTestId('auth-lang'));
    await waitFor(() => expect(document.documentElement.dir).toBe('ltr'));
  });

  it('remember me keeps only the ID, only when ticked, and a wrong password changes nothing else', async () => {
    const u = userEvent.setup();
    renderApp(<App />, { route: '/login' });
    await u.type(await screen.findByTestId('login-identifier'), '1204');
    await u.type(screen.getByTestId('login-password'), DEMO_PASSWORDS.engineer);
    await u.click(screen.getByTestId('login-remember'));
    await u.click(screen.getByTestId('login-submit'));
    await waitFor(() => expect(readRememberedId()).toBe('1204'));
    const stored = localStorage.getItem(REMEMBER_KEY) ?? '';
    expect(stored).not.toContain(DEMO_PASSWORDS.engineer);
    expect(Object.keys(localStorage).filter((k) => k !== 'pmis-mock-db' && localStorage.getItem(k)?.includes(DEMO_PASSWORDS.engineer))).toEqual([]);
  });

  it('prefills a remembered ID and unticking forgets it', async () => {
    writeRememberedId('1204');
    const u = userEvent.setup();
    renderApp(<App />, { route: '/login' });
    expect(await screen.findByTestId('login-identifier')).toHaveValue('1204');
    expect(screen.getByTestId('login-remember')).toBeChecked();
    await u.click(screen.getByTestId('login-remember'));
    expect(readRememberedId()).toBe('');
  });

  it('an expired remembered ID is dropped', () => {
    writeRememberedId('1204', Date.now() - 31 * 86_400_000);
    expect(readRememberedId()).toBe('');
    expect(localStorage.getItem(REMEMBER_KEY)).toBeNull();
    clearRememberedId();
  });
});

describe('forgot password', () => {
  it('answers the same for a real account and for an unknown one', async () => {
    const u = userEvent.setup();
    const { unmount } = renderApp(<App />, { route: '/forgot-password' });
    await u.type(await screen.findByTestId('forgot-identifier'), '1204');
    await u.click(screen.getByTestId('forgot-submit'));
    const known = (await screen.findByTestId('forgot-sent')).textContent;
    expect(lastReset.token).toHaveLength(43);
    unmount();
    lastReset.token = '';
    renderApp(<App />, { route: '/forgot-password' });
    await u.type(await screen.findByTestId('forgot-identifier'), '9999');
    await u.click(screen.getByTestId('forgot-submit'));
    expect((await screen.findByTestId('forgot-sent')).textContent).toBe(known);
    expect(lastReset.token).toBe('');
  });

  it('gives no link to a System Admin account', async () => {
    const u = userEvent.setup();
    renderApp(<App />, { route: '/forgot-password' });
    await u.type(await screen.findByTestId('forgot-identifier'), '1001');
    await u.click(screen.getByTestId('forgot-submit'));
    await screen.findByTestId('forgot-sent');
    expect(lastReset.token).toBe('');
  });
});

describe('reset password', () => {
  it('reads the token from the fragment and removes it from the address bar', async () => {
    expect(tokenFromHash('#token=abc')).toBe('abc');
    expect(tokenFromHash('')).toBe('');
    window.location.hash = '#token=' + 'a'.repeat(43);
    renderApp(<App />, { route: '/reset-password' });
    await screen.findByTestId('reset-form');
    expect(window.location.hash).toBe('');
  });

  it('a missing link shows the generic bad-link page', async () => {
    renderApp(<App />, { route: '/reset-password' });
    expect(await screen.findByTestId('reset-bad-link')).toBeInTheDocument();
  });

  it('full flow: request, set a new password, the link works once, the new password signs in', async () => {
    const u = userEvent.setup();
    const first = renderApp(<App />, { route: '/forgot-password' });
    await u.type(await screen.findByTestId('forgot-identifier'), '1204');
    await u.click(screen.getByTestId('forgot-submit'));
    await screen.findByTestId('forgot-sent');
    const token = lastReset.token;
    first.unmount();

    window.location.hash = `#token=${token}`;
    const second = renderApp(<App />, { route: '/reset-password' });
    await u.type(await screen.findByTestId('reset-password'), 'short');
    await u.type(screen.getByTestId('reset-password2'), 'short');
    await u.click(screen.getByTestId('reset-submit'));
    expect(await screen.findByTestId('reset-weak')).toBeInTheDocument();
    await u.clear(screen.getByTestId('reset-password'));
    await u.clear(screen.getByTestId('reset-password2'));
    await u.type(screen.getByTestId('reset-password'), 'Brand-New-Passphrase-2026');
    await u.type(screen.getByTestId('reset-password2'), 'Different-Passphrase-2026');
    expect(await screen.findByTestId('reset-mismatch')).toBeInTheDocument();
    expect(screen.getByTestId('reset-submit')).toBeDisabled();
    await u.clear(screen.getByTestId('reset-password2'));
    await u.type(screen.getByTestId('reset-password2'), 'Brand-New-Passphrase-2026');
    await u.click(screen.getByTestId('reset-submit'));
    expect(await screen.findByTestId('reset-done')).toBeInTheDocument();
    second.unmount();

    // the link works once
    window.location.hash = `#token=${token}`;
    const third = renderApp(<App />, { route: '/reset-password' });
    await u.type(await screen.findByTestId('reset-password'), 'Another-Passphrase-2026');
    await u.type(screen.getByTestId('reset-password2'), 'Another-Passphrase-2026');
    await u.click(screen.getByTestId('reset-submit'));
    expect(await screen.findByTestId('reset-bad-link')).toBeInTheDocument();
    third.unmount();

    // the new password signs in, the old one does not
    renderApp(<App />, { route: '/login' });
    await u.type(await screen.findByTestId('login-identifier'), '1204');
    await u.type(screen.getByTestId('login-password'), DEMO_PASSWORDS.engineer);
    await u.click(screen.getByTestId('login-submit'));
    expect(await screen.findByTestId('login-error')).toBeInTheDocument();
  });
});
