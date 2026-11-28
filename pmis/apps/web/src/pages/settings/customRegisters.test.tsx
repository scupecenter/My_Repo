import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetCustomRegisters, setCustomRegisterColumns } from '@/mocks/handlers.customRegisters';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './Settings';

/** Settings, Custom registers (migration 0531, contract 0.15.533): create, see the key, enable only with a required column, rename, hide and show; the limit row shows. */
const page = () => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/registers/custom' });

describe('Settings, Custom registers', () => {
  beforeEach(() => resetCustomRegisters());

  it('creates a register from its name, enables it once it has a required column, renames, hides and shows it', async () => {
    await signIn('pm');
    setCustomRegisterColumns('custom_ready_one', 3, 1);
    const u = userEvent.setup();
    page();
    expect(await screen.findByTestId('custreg-empty')).toBeInTheDocument();
    await u.click(screen.getByTestId('custreg-new'));
    await u.type(await screen.findByTestId('custreg-name-en'), 'Tower Audit');
    await u.type(screen.getByTestId('custreg-name-ar'), 'تدقيق الأبراج');
    await u.type(screen.getByTestId('custreg-dialog-create-reason'), 'New audit register');
    await u.click(screen.getByTestId('custreg-dialog-create-submit'));
    const row = await screen.findByTestId('custreg-row-custom_tower_audit');
    expect(row).toHaveTextContent('custom_tower_audit');
    expect(screen.getByTestId('custreg-status-custom_tower_audit')).toHaveTextContent('Not enabled yet');
    expect(screen.getByTestId('custreg-enable-custom_tower_audit')).toBeDisabled();
    expect(screen.getByTestId('custreg-limit')).toHaveTextContent('1 of 20');
    await u.click(screen.getByTestId('custreg-new'));
    await u.type(await screen.findByTestId('custreg-name-en'), 'Ready One');
    await u.type(screen.getByTestId('custreg-dialog-create-reason'), 'Second register');
    await u.click(screen.getByTestId('custreg-dialog-create-submit'));
    await u.click(await screen.findByTestId('custreg-enable-custom_ready_one'));
    await u.type(await screen.findByTestId('custreg-dialog-enable-reason'), 'Ready');
    await u.click(screen.getByTestId('custreg-dialog-enable-submit'));
    await waitFor(() => expect(screen.getAllByTestId('custreg-status-custom_ready_one').some((e) => /Enabled/.test(e.textContent ?? ''))).toBe(true));
    await u.click(screen.getByTestId('custreg-hide-custom_ready_one'));
    await u.type(await screen.findByTestId('custreg-dialog-hide-reason'), 'Not used now');
    await u.click(screen.getByTestId('custreg-dialog-hide-submit'));
    await waitFor(() => expect(screen.getAllByTestId('custreg-status-custom_ready_one').some((e) => /Hidden/.test(e.textContent ?? ''))).toBe(true));
  });

  it('shows the limit row with the other operational limits', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/security/limits' });
    expect(await screen.findByTestId('oplimits-registers_custom_max')).toHaveValue('20');
  });
});
