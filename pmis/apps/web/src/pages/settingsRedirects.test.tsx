import { screen, waitFor } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { LEGACY_SETTINGS_PATHS, SETTINGS_TABS, SettingsRoutes } from './settings/Settings';

/** F19: the 11 Settings tabs. An old tab route opens its new tab and section, and keeps the query string. */
function Probe() {
  const l = useLocation();
  return <div data-testid="probe">{`${l.pathname}${l.search}${l.hash}`}</div>;
}
const at = (route: string, opts = {}) => renderApp(<><Probe /><Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes></>, { route, ...opts });
const probe = () => screen.getByTestId('probe').textContent;

describe('F19: Settings tabs and old routes', () => {
  beforeEach(async () => { await signIn('pm'); });

  it('has the 11 one-word tabs of the plan plus the F20 dashboard tab', () => {
    expect(SETTINGS_TABS.map((t) => t.key)).toEqual(['calendar', 'workflow', 'sla', 'weights', 'registers', 'ddl', 'site360', 'documents', 'data', 'alerts', 'security', 'dashboard']);
  });

  it.each([
    ['freeze', '/admin/settings/workflow/freeze'],
    ['idle', '/admin/settings/workflow/idle'],
    ['dlp', '/admin/settings/sla/dlp'],
    ['notifications', '/admin/settings/alerts'],
    ['retention', '/admin/settings/security/retention'],
    ['staff-visibility', '/admin/settings/security/staff'],
    ['team-scope', '/admin/settings/registers/team-scope'],
    ['contractor-rules', '/admin/settings/registers/contractors'],
    ['gecol-order', '/admin/settings/registers/gecol'],
    ['register-columns', '/admin/settings/registers/columns'],
    ['lists', '/admin/settings/ddl'],
    ['mail-kinds', '/admin/settings/documents/mail'],
    ['imports', '/admin/settings/data/imports'],
    ['historical-waiver', '/admin/settings/data/historical'],
    ['sla', '/admin/settings/sla/rules'],
    ['workflow', '/admin/settings/workflow/editor'],
    ['documents', '/admin/settings/documents/library'],
    ['calendar', '/admin/settings/calendar'],
  ])('old /admin/settings/%s opens %s', async (old, target) => {
    at(`/admin/settings/${old}`);
    await waitFor(() => expect(probe()).toBe(target));
  });

  it('keeps the query string when an old URL redirects (Register > Manage columns link)', async () => {
    at('/admin/settings/register-columns?register=gecol');
    await waitFor(() => expect(probe()).toBe('/admin/settings/registers/columns?register=gecol'));
    expect(await screen.findByTestId('settings-section-registers-columns')).toHaveClass('btn-accent');
  });

  it('every legacy route has a target inside a tab that exists', () => {
    for (const to of Object.values(LEGACY_SETTINGS_PATHS)) {
      const [tab, section] = to.split('/');
      const def = SETTINGS_TABS.find((t) => t.key === tab);
      expect(def, to).toBeDefined();
      if (section) expect(def?.sections.some((s) => s.key === section), to).toBe(true);
      else expect(def?.sections, to).toHaveLength(0);
    }
  });

  it('a tab with sections opens its first section by default', async () => {
    at('/admin/settings/registers');
    await waitFor(() => expect(probe()).toBe('/admin/settings/registers/columns'));
    expect(screen.getByTestId('settings-tab-registers')).toHaveClass('btn-accent');
  });

  it('opens the SITE 360 columns screen in the Site360 tab', async () => {
    at('/admin/settings/site360');
    expect(await screen.findByTestId('site360-columns')).toBeInTheDocument();
    expect(screen.getByTestId('settings-tab-site360')).toHaveTextContent('Site360');
  });

  it('redirects the old SITE 360 columns route to the Site360 tab', async () => {
    at('/admin/settings/site360-columns');
    expect(await screen.findByTestId('site360-columns')).toBeInTheDocument();
    expect(screen.getByTestId('settings-tab-site360')).toHaveClass('btn-accent');
  });

  it('hides the mail kinds section from a user who is not a System Admin, and keeps the Documents tab', async () => {
    await signIn('engineer');
    at('/admin/settings/documents/library');
    expect(await screen.findByTestId('settings-section-documents-library')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('settings-section-documents-mail')).toBeNull());
    expect(screen.getByTestId('settings-tab-documents')).toBeInTheDocument();
  });
});
