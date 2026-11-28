import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, ApiError } from '@/api/client';
import type { RegisterOrderWarnings } from '@/api/p4c';
import ar from '@/i18n/ar.json';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './settings/Settings';

/** Contract 0.15.464 (M1): order warnings of every register and the Register counts, in Settings > Registers. */
const page = (section: string, opts: { locale?: 'en' | 'ar' } = {}) =>
  renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: `/admin/settings/registers/${section}`, ...opts });
const errCode = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => `${e.status}:${e.code}`);

describe('Settings > Registers > Order warnings', () => {
  it('serves any register: off by default, validates, saves with a reason and a version', async () => {
    await signIn('pm');
    page('order');
    const u = userEvent.setup();
    expect(await screen.findByTestId('page-register-order')).toBeInTheDocument();
    expect(screen.getByTestId('settings-section-registers-order')).toHaveTextContent('Order warnings');
    await u.selectOptions(await screen.findByTestId('rgo-register'), 'permits_hse');
    const on = await screen.findByTestId('gow-enabled') as HTMLInputElement;
    expect(on.checked).toBe(false);
    const cur = await api.get<RegisterOrderWarnings>('/settings/registers/permits_hse/order-warnings');
    expect(cur.version).toBe(0);
    expect(cur.fields.map((f) => f.code)).toContain('valid_from');
    expect(await errCode(api.put('/settings/registers/permits_hse/order-warnings', { version: 0, body: { reason: 'bad', enabled: true, chains: [['applied_date', 'meter_no']], billing_after: null, billing_field: null } }))).toBe('422:validation_failed');
    expect(await errCode(api.put('/settings/registers/permits_hse/order-warnings', { version: 0, body: { reason: 'half', enabled: true, chains: [], billing_after: 'valid_from', billing_field: null } }))).toBe('422:validation_failed');
    expect(await errCode(api.get('/settings/registers/no_such_register/order-warnings'))).toBe('404:not_found');
    await u.click(on);
    await u.selectOptions(screen.getByTestId('gow-billing'), 'valid_from');
    await u.selectOptions(screen.getByTestId('rgo-billing-field'), 'applied_date');
    await u.click(screen.getByTestId('gow-save'));
    await u.type(await screen.findByTestId('gow-dialog-reason'), 'Warn on the permit dates');
    await u.click(screen.getByTestId('gow-dialog-submit'));
    await waitFor(async () => expect((await api.get<RegisterOrderWarnings>('/settings/registers/permits_hse/order-warnings')).enabled).toBe(true));
    const saved = await api.get<RegisterOrderWarnings>('/settings/registers/permits_hse/order-warnings');
    expect(saved).toMatchObject({ version: 1, billing_after: 'valid_from', billing_field: 'applied_date' });
    expect(await errCode(api.put('/settings/registers/permits_hse/order-warnings', { version: 0, body: { reason: 'stale', enabled: false, chains: [], billing_after: null, billing_field: null } }))).toBe('412:precondition_failed');
  });

  it('is in Arabic, and the old GECOL tab is hidden but its route and endpoint stay', async () => {
    await signIn('pm');
    page('order', { locale: 'ar' });
    expect(await screen.findByTestId('settings-section-registers-order')).toHaveTextContent(ar.settings.section_registers_order);
    expect(await screen.findByText(ar.regOrder.title, { selector: 'h2' })).toBeInTheDocument();
    expect(screen.queryByTestId('settings-section-registers-gecol')).toBeNull();
    expect((await api.get<RegisterOrderWarnings>('/settings/gecol-order-warnings')).version).toBeGreaterThanOrEqual(0);
    expect((await api.get<RegisterOrderWarnings>('/settings/registers/gecol/order-warnings')).billing_field).toBe('billing_conversion_date');
  });
});

describe('Settings > Registers > Register counts', () => {
  it('lists every register read only, in English and Arabic', async () => {
    await signIn('pm');
    page('counts');
    expect(await screen.findByTestId('page-register-counts')).toBeInTheDocument();
    expect(await screen.findByTestId('rc-row-gecol')).toBeInTheDocument();
    expect(screen.getByTestId('rc-row-procurement')).toBeInTheDocument();
    expect(screen.getByTestId('page-register-counts').querySelectorAll('button')).toHaveLength(0);
  });
  it('is in Arabic', async () => {
    await signIn('pm');
    page('counts', { locale: 'ar' });
    expect(await screen.findByText(ar.regCounts.title, { selector: 'h2' })).toBeInTheDocument();
  });
});
