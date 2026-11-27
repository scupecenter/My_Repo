import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '@/App';
import { api } from '@/api/client';
import { DEMO_PASSWORDS } from '@/mocks/db';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './Settings';

/** Settings, Security, New-device code (migration 0292, contract 0.15.192): off by default; an admin turns it on and off. A new device then needs the emailed code. */
const page = () => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/security/newdevice' });
const submit = async (u: ReturnType<typeof userEvent.setup>, reason: string) => {
  await u.type(await screen.findByTestId('newdevice-dialog-reason'), reason);
  await u.click(screen.getByTestId('newdevice-dialog-submit'));
};

describe('Settings, New-device code', () => {
  it('is off by default; an admin turns it on', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    page();
    expect(await screen.findByTestId('page-new-device')).toBeInTheDocument();
    expect(screen.getByTestId('newdevice-enabled')).not.toBeChecked();
    expect(screen.getByTestId('newdevice-save')).toBeDisabled();
    await u.click(screen.getByTestId('newdevice-enabled'));
    await u.click(screen.getByTestId('newdevice-save'));
    await api.post('/__mock/step-up');
    await submit(u, 'Turn on the new-device code');
    await waitFor(() => expect(screen.getByTestId('newdevice-updated')).toBeInTheDocument());
    expect(screen.getByTestId('newdevice-enabled')).toBeChecked();
  });

  it('turning it off again is as easy as turning it on', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    page();
    expect(await screen.findByTestId('newdevice-enabled')).toBeChecked();
    await u.click(screen.getByTestId('newdevice-enabled'));
    await u.click(screen.getByTestId('newdevice-save'));
    await api.post('/__mock/step-up');
    await submit(u, 'Back to normal');
    await waitFor(() => expect(screen.getByTestId('newdevice-enabled')).not.toBeChecked());
  });
});

describe('Sign-in on a new device', () => {
  it('asks for the emailed code once the setting is on, and a wrong code is refused', async () => {
    const { newDeviceState } = await import('@/mocks/newDevice');
    Object.assign(newDeviceState, { enabled: true, include_admins: false });
    renderApp(<App />, { route: '/login' });
    const u = userEvent.setup();
    await u.type(await screen.findByTestId('login-identifier'), '1204');
    await u.type(screen.getByTestId('login-password'), DEMO_PASSWORDS.engineer!);
    await u.click(screen.getByTestId('login-submit'));
    await u.type(await screen.findByTestId('device-code'), '000000');
    await u.click(screen.getByTestId('device-code-submit'));
    expect(await screen.findByTestId('device-code-error')).toBeInTheDocument();
    await u.type(screen.getByTestId('device-code'), '123456');
    await u.click(screen.getByTestId('device-code-submit'));
    await waitFor(() => expect(screen.queryByTestId('device-code-form')).toBeNull());
    Object.assign(newDeviceState, { enabled: false });
  });
});
