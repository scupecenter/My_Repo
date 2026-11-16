import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './Settings';

/** Settings, SITE 360 columns (contract 0.15.21, F15): the menus of a Master column are shown and changed in one dialog. */
const screenAt = () => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/site360-columns' });

describe('Settings: SITE 360 columns', () => {
  it('lists the Master columns with their menus; the status columns cannot be changed', async () => {
    await signIn('pm');
    screenAt();
    expect(await screen.findByTestId('site360cols-row-AG')).toBeInTheDocument();
    expect(screen.getByTestId('site360cols-fixed-FX')).toBeInTheDocument();
    expect(screen.queryByTestId('site360cols-edit-FX')).toBeNull();
  });

  it('opens the menu dialog of a column with its current menus ticked', async () => {
    await signIn('pm');
    screenAt();
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('site360cols-edit-AG'));
    await waitFor(() => expect(screen.getByTestId('site360cols-menu-cw')).toBeChecked());
    expect(screen.getByTestId('site360cols-menu-te')).not.toBeChecked();
  });
});
