import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { ContractorsReports } from './ContractorsReports';
import { SettingsRoutes } from './settings/Settings';

/** Contract 0.15.591: the SLA penalty (days late x the daily rate, per contractor, never above the cap). The rates are set in Settings, the amounts show in the performance view. */
describe('SLA penalty calculator', () => {
  it('shows the days late first with no rate, then the amount after an admin sets a default rate, an override and a cap', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /><Route path="/reports/contractors" element={<ContractorsReports />} /></Routes>, { route: '/reports/contractors' });
    const delta = await screen.findByTestId('perf-penalty-Delta Build');
    expect(delta).toHaveAttribute('data-late-days', '54'); // 12 on snags + 42 on issues
    expect(screen.queryByTestId('perf-amount-Delta Build')).toBeNull();
    // the settings: a default rate of 10 USD a day, capped at 400, 5 a day for Omega Works
    renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/registers/contractors' });
    const rate = await screen.findByTestId('cperf-pen-rate');
    fireEvent.change(rate, { target: { value: '10' } });
    fireEvent.change(screen.getByTestId('cperf-pen-currency'), { target: { value: 'usd' } });
    fireEvent.change(screen.getByTestId('cperf-pen-cap'), { target: { value: '400' } });
    fireEvent.click(screen.getByTestId('cperf-save'));
    fireEvent.change(await screen.findByTestId('cperf-dialog-reason'), { target: { value: 'Contract schedule 4 rate' } });
    fireEvent.click(screen.getByTestId('cperf-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('cperf-dialog')).toBeNull());
    // the report: 54 days x 10 = 540, capped at 400
    renderApp(<Routes><Route path="/reports/contractors" element={<ContractorsReports />} /></Routes>, { route: '/reports/contractors' });
    const amount = await screen.findByTestId('perf-amount-Delta Build');
    expect(amount).toHaveTextContent('400.00 USD');
    expect(amount).toHaveTextContent(/capped/i);
  });

  it('refuses a rate with a bad currency before saving', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/registers/contractors' });
    fireEvent.change(await screen.findByTestId('cperf-pen-rate'), { target: { value: '10' } });
    fireEvent.change(screen.getByTestId('cperf-pen-currency'), { target: { value: 'US' } });
    expect(screen.getByTestId('cperf-save')).toBeDisabled();
  });
});
