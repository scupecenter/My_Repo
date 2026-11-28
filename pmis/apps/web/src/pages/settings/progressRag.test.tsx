import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, ApiError } from '@/api/client';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './Settings';

/** Settings review gap 5 (contract 0.15.432): colours of the SPI, the progress against plan and the weekly velocity. Nothing is on until saved. */
const open = () => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/dashboard' });
const errCode = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => `${e.status}:${e.code}`);

describe('progress figure colours', () => {
  it('starts with every figure off and the suggested numbers, then saves a row with a reason', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    open();
    expect(await screen.findByTestId('progress-rag-green-spi')).toHaveValue('0.95');
    expect(screen.getByTestId('progress-rag-amber-spi')).toHaveValue('0.85');
    for (const c of ['spi', 'progress_gap', 'velocity']) expect(screen.getByTestId(`progress-rag-on-${c}`)).not.toBeChecked();
    expect(screen.getByTestId('progress-rag-save')).toBeDisabled();
    await u.click(screen.getByTestId('progress-rag-on-spi'));
    await u.click(screen.getByTestId('progress-rag-save'));
    await u.type(await screen.findByTestId('progress-rag-dialog-reason'), 'Owner wants the SPI coloured');
    await u.click(screen.getByTestId('progress-rag-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('progress-rag-version')).toHaveTextContent('1'));
    expect(screen.getByTestId('progress-rag-on-spi')).toBeChecked();
    expect(screen.getByTestId('progress-rag-on-velocity')).not.toBeChecked();
  }, 30_000);

  it('refuses green below amber and numbers outside the range in the form, with no save', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    open();
    const g = await screen.findByTestId('progress-rag-green-velocity');
    await u.clear(g);
    await u.type(g, '0.5');
    expect(await screen.findByTestId('progress-rag-error-velocity')).toBeInTheDocument();
    expect(screen.getByTestId('progress-rag-save')).toBeDisabled();
    await u.clear(g);
    await u.type(g, '500');
    expect(screen.getByTestId('progress-rag-error-velocity')).toBeInTheDocument();
    await u.click(screen.getByTestId('progress-rag-suggest-velocity'));
    expect(screen.queryByTestId('progress-rag-error-velocity')).toBeNull();
  }, 30_000);

  it('the server refuses a missing figure, a wrong order, a range error and a stale version', async () => {
    await signIn('pm');
    const cur = await api.get<{ version: number }>('/settings/dashboard/progress-rag');
    const ok = { enabled: true, green: 1.5, amber: 0.75 };
    const all = { spi: { enabled: false, green: 0.95, amber: 0.85 }, progress_gap: { enabled: false, green: -2, amber: -5 }, velocity: ok };
    const put = (items: object, version = cur.version) => api.put('/settings/dashboard/progress-rag', { version, body: { items, reason: 'Server rules test' } });
    expect(await errCode(put({ spi: all.spi }))).toBe('422:validation_failed');
    expect(await errCode(put({ ...all, velocity: { enabled: true, green: 0.5, amber: 0.75 } }))).toBe('422:validation_failed');
    expect(await errCode(put({ ...all, spi: { enabled: true, green: 9, amber: 0.85 } }))).toBe('422:validation_failed');
    expect(await errCode(put(all, cur.version + 5))).toBe('412:precondition_failed');
  });
});
