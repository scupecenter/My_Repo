import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import ar from '@/i18n/ar.json';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './settings/Settings';

/** Contract 0.15.98: Settings > Registers > Recycle bin. */
const page = (opts: { locale?: 'en' | 'ar' } = {}) =>
  renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/registers/recycle', ...opts });

describe('Settings, Recycle bin', () => {
  it('lists the voided records, filters, shows a blocked one without a button and restores one with a reason', async () => {
    await signIn('pm');
    page();
    expect(await screen.findByTestId('page-recycle-bin')).toBeInTheDocument();
    const a1 = '00000000-0000-4000-8000-0000000000a1', a2 = '00000000-0000-4000-8000-0000000000a2';
    expect(await screen.findByTestId(`rb-row-${a1}`)).toHaveTextContent('Entered on the wrong site');
    expect(screen.getByTestId(`rb-blocked-${a2}`)).toHaveTextContent('The site already has another record');
    expect(screen.queryByTestId(`rb-restore-${a2}`)).toBeNull();
    fireEvent.change(screen.getByTestId('rb-register'), { target: { value: 'gecol' } });
    expect(screen.queryByTestId(`rb-row-${a1}`)).toBeNull();
    fireEvent.change(screen.getByTestId('rb-register'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId(`rb-restore-${a1}`));
    expect(await screen.findByTestId('rb-restore-dialog')).toBeInTheDocument();
  });

  it('is in Arabic too', async () => {
    await signIn('pm');
    page({ locale: 'ar' });
    expect(await screen.findByTestId('page-recycle-bin')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('settings-section-registers-recycle')).toHaveTextContent(ar.settings.section_registers_recycle));
  });
});
