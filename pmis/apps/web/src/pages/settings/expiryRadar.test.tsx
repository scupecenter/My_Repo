import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { api } from '@/api/client';
import type { ExpiryRadarSetting } from '@/api/expiryRadar';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './Settings';

/** Settings, Alerts, Expiry radar (migration 0760, contract 0.15.640): the watched registers, the date field and the lead times; saved through the reason dialog. */
const open = () => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/alerts/expiry' });
afterEach(() => cleanup());

describe('expiry radar screen', () => {
  it('lists the seed registers with their lead times and a preview; icon buttons have hints', async () => {
    await signIn('pm');
    open();
    const row = await screen.findByTestId('radar-row-permits_hse');
    expect(within(row).getByTestId('radar-lead-permits_hse-30')).toHaveTextContent('30 days');
    expect(within(row).getByTestId('radar-preview-permits_hse')).toHaveTextContent('7, 14, 30');
    expect(within(row).getByTestId('radar-remove-permits_hse')).toHaveAttribute('aria-label');
    expect(screen.getByTestId('radar-save')).toBeDisabled();
  });

  it('adds a lead time and a register, then saves with a reason; the server keeps them sorted', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    open();
    await screen.findByTestId('radar-row-permits_hse');
    await u.type(screen.getByTestId('radar-lead-input-permits_hse'), '60');
    await u.click(screen.getByTestId('radar-lead-add-permits_hse'));
    expect(screen.getByTestId('radar-lead-permits_hse-60')).toBeInTheDocument();
    await u.selectOptions(screen.getByTestId('radar-add'), 'tools_equipment');
    expect(await screen.findByTestId('radar-row-tools_equipment')).toBeInTheDocument();
    await u.click(screen.getByTestId('radar-save'));
    await u.type(await screen.findByTestId('radar-dialog-reason'), 'Earlier warning for permits');
    await u.click(screen.getByTestId('radar-dialog-submit'));
    await screen.findByTestId('radar-row-tools_equipment');
    const saved = await api.get<ExpiryRadarSetting>('/settings/expiry-radar');
    expect(saved.registers.find((r) => r.register_key === 'permits_hse')?.lead_days).toEqual([7, 14, 30, 60]);
    expect(saved.registers.map((r) => r.register_key)).toContain('tools_equipment');
    expect(saved.version).toBe(2);
    expect(screen.getByTestId('radar-save')).toBeDisabled();
  });

  it('removes a register and a lead time; refuses a register with no lead time', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    open();
    await screen.findByTestId('radar-row-acquisition');
    await u.click(screen.getByTestId('radar-remove-acquisition'));
    expect(screen.queryByTestId('radar-row-acquisition')).toBeNull();
    for (const d of [7, 14, 30]) await u.click(within(screen.getByTestId(`radar-lead-permits_hse-${d}`)).getByRole('button'));
    expect(screen.getByTestId('radar-save')).toBeDisabled();
  });
});
