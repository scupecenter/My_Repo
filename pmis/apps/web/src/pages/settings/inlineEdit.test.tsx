import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './Settings';

/** Settings, edit in place: a holiday row cell saves with the reason typed above the table, and asks for the reason first. */
describe('Settings inline edit, calendar', () => {
  it('asks for the reason, then saves a changed holiday name in the row', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/calendar' });
    const cell = await screen.findByTestId('holiday-cell-name-2026-11-03');
    await u.click(cell);
    await u.clear(screen.getByTestId('holiday-cell-name-2026-11-03-input'));
    await u.type(screen.getByTestId('holiday-cell-name-2026-11-03-input'), 'Renamed day{Enter}');
    expect(await screen.findByTestId('holiday-cell-name-2026-11-03-err')).toBeInTheDocument();
    await u.type(screen.getByTestId('cal-inline-reason'), 'Owner asked');
    await u.click(screen.getByTestId('holiday-cell-name-2026-11-03-input'));
    await u.keyboard('{Enter}');
    expect(await screen.findByText('Renamed day')).toBeInTheDocument();
    expect(screen.getByTestId('toast')).toHaveTextContent('audited');
  });
});
