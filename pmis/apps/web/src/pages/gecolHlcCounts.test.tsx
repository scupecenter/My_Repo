import { screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import ar from '@/i18n/ar.json';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './settings/Settings';

/** Contract 0.15.84: Settings > Data > GECOL / HLC counts, read only. */
const page = (opts: { locale?: 'en' | 'ar' } = {}) =>
  renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/data/counts', ...opts });

describe('Settings, GECOL / HLC counts', () => {
  it('shows the counts of the GECOL, HLC and Procurement records and has no button that changes data', async () => {
    await signIn('pm');
    page();
    expect(await screen.findByTestId('page-gecol-hlc-counts')).toBeInTheDocument();
    expect(await screen.findByTestId('settings-section-data-counts')).toHaveTextContent('GECOL / HLC counts');
    expect(await screen.findByTestId('ghc-gecol-total')).toHaveTextContent('5');
    expect(screen.getByTestId('ghc-gecol-pr')).toHaveTextContent('3');
    expect(screen.getByTestId('ghc-hlc-linked')).toHaveTextContent('2');
    expect(screen.getByTestId('ghc-hlc-notlinked')).toHaveTextContent('2');
    expect(screen.getByTestId('ghc-sites-gecol')).toHaveTextContent('5');
    expect(within(screen.getByTestId('ghc-procurement')).getByText('HLC')).toBeInTheDocument();
    expect(within(screen.getByTestId('page-gecol-hlc-counts')).queryAllByRole('button')).toHaveLength(0);
  });

  it('is in Arabic too', async () => {
    await signIn('pm');
    page({ locale: 'ar' });
    expect(await screen.findByTestId('ghc-gecol-total')).toBeInTheDocument();
    expect(await screen.findByTestId('settings-section-data-counts')).toHaveTextContent(ar.settings.section_data_counts);
  });
});
