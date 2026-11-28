import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { SettingsAlias } from '@/App';
import { renderApp, signIn } from '@/test/utils';
import { SETTINGS_TABS, SettingsRoutes } from './Settings';

/** Review item 11: the short address /settings opens Settings (not the placeholder), and Settings opens on an index of every tab and section. */
const app = (route: string) => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /><Route path="/settings/*" element={<SettingsAlias />} /></Routes>, { route });

describe('Settings index and the /settings address', () => {
  it('/settings opens the index with every tab and its sections', async () => {
    await signIn('pm');
    app('/settings');
    expect(await screen.findByTestId('settings-index')).toBeInTheDocument();
    for (const tab of SETTINGS_TABS) expect(screen.getByTestId(`settings-index-${tab.key}`)).toBeInTheDocument();
    expect(screen.getByTestId('settings-index-security-limits')).toHaveAttribute('href', '/admin/settings/security/limits');
    expect(screen.queryByTestId('page-soon')).toBeNull();
  });

  it('/settings/security/limits keeps its path and opens the Limits section', async () => {
    await signIn('pm');
    app('/settings/security/limits?x=1');
    expect(await screen.findByTestId('page-ops-limits')).toBeInTheDocument();
  });
});
