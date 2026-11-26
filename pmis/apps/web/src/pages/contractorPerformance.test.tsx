import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { ContractorsReports } from './ContractorsReports';
import { SettingsRoutes } from './settings/Settings';

/** Contract 0.15.88: the contractor performance view (read only) and its thresholds in Settings. */
describe('Contractor performance', () => {
  it('shows each contractor with its measures, computed and read only', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/reports/contractors" element={<ContractorsReports />} /></Routes>, { route: '/reports/contractors' });
    expect(await screen.findByTestId('cr-performance')).toBeInTheDocument();
    expect(await screen.findByTestId('perf-Delta Build')).toHaveTextContent('42');
    expect(screen.getByTestId('perf-level-Delta Build')).toHaveAttribute('data-level', 'red');
    expect(screen.getByTestId('perf-level-Omega Works')).toHaveAttribute('data-level', 'ok');
    expect(screen.getByTestId('cr-performance').querySelectorAll('button, input')).toHaveLength(0);
  });

  it('an admin changes the thresholds with a reason', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/registers/contractors' });
    const amber = await screen.findByTestId('cperf-snag_overdue_pct-amber');
    expect(amber).toHaveValue(10);
    expect(screen.getByTestId('cperf-save')).toBeDisabled();
    fireEvent.change(amber, { target: { value: '15' } });
    fireEvent.click(screen.getByTestId('cperf-save'));
    expect(await screen.findByTestId('cperf-dialog')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('cperf-dialog')).toBeInTheDocument());
  });

  it('refuses a red below the amber before saving', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/registers/contractors' });
    const red = await screen.findByTestId('cperf-quality_fail_pct-red');
    fireEvent.change(red, { target: { value: '5' } });
    expect(screen.getByTestId('cperf-save')).toBeDisabled();
  });
});
