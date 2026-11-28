import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { MappingRedirect, SettingsAlias } from '@/App';
import { PeopleAdminLayout } from '@/components/PeopleAdmin';
import { renderApp, signIn } from '@/test/utils';
import { SecurityAlerts } from '../logs/SecurityAlerts';
import { SettingsRoutes } from './Settings';

/** One home for settings: the Access tab lists the People screens, the alert settings live in Settings, and the pages that used to hold them carry a gear. */
const app = (route: string) => renderApp(
  <Routes>
    <Route path="/admin/settings/*" element={<SettingsRoutes />} />
    <Route path="/settings/*" element={<SettingsAlias />} />
    <Route path="/templates/mapping" element={<MappingRedirect />} />
    <Route path="/admin/logs/alerts" element={<SecurityAlerts />} />
    <Route element={<PeopleAdminLayout />}><Route path="/admin/users" element={<p>users</p>} /><Route path="/admin/matrix" element={<p>matrix</p>} /></Route>
  </Routes>, { route });

describe('Settings hub', () => {
  it('Access lists the People screens with a link to each', async () => {
    await signIn('pm');
    app('/settings/access');
    expect(await screen.findByTestId('settings-access')).toBeInTheDocument();
    for (const k of ['users', 'assignments', 'roles', 'profiles', 'groups', 'delegation', 'matrix']) expect(screen.getByTestId(`settings-access-${k}`)).toBeInTheDocument();
  });

  it('the alert settings are a Settings section, and the Security Alerts log page has a gear to it instead', async () => {
    await signIn('pm');
    app('/admin/settings/security/alerts');
    expect(await screen.findByTestId('rules-networks')).toBeInTheDocument();
  });

  it('the Security Alerts log page keeps the list and has no settings panel', async () => {
    await signIn('pm');
    app('/admin/logs/alerts');
    expect(await screen.findByTestId('page-security-alerts')).toBeInTheDocument();
    expect(screen.queryByTestId('rules-networks')).toBeNull();
    expect(await screen.findByTestId('screen-settings-link')).toHaveAttribute('href', '/admin/settings/security/alerts');
  });

  it('the Users page has a gear to the Limits section', async () => {
    await signIn('pm');
    app('/admin/users');
    expect(await screen.findByTestId('screen-settings-link')).toHaveAttribute('href', '/admin/settings/security/limits');
  });

  it('keeps template mapping open for the templates right: a user with Templates but no Settings entry still reaches Settings > Data > Mapping, from the old address and the Templates link', async () => {
    await signIn('reviewer');
    const me = await (await import('@/api/client')).api.get<{ effective: { nav: string[] } }>('/me');
    expect(me.effective.nav).toContain('templates');
    expect(me.effective.nav).not.toContain('admin.settings');
    app('/templates/mapping');
    expect(await screen.findByTestId('tmap-fields')).toBeInTheDocument();
    expect(screen.queryByTestId('tmap-add')).toBeNull(); // read only: the server decides who edits
  });
});
