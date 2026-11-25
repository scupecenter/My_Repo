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
    expect(SETTINGS_TABS.map((t) => t.key)).toEqual(['calendar', 'workflow', 'sla', 'weights', 'registers', 'ddl', 'documents', 'data', 'alerts', 'security', 'dashboard', 'display', 'identity', 'my-work']); // 0148 (W8): Display; 0149 (W7): Settings > My Work > Daily Plan
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
    ['documents', '/admin/settings/documents/types'],
    ['documents/library', '/admin/settings/documents/types'],
    ['calendar', '/admin/settings/calendar'],
    ['site360', '/admin/settings/workflow/columns'],
    ['site-master-columns', '/admin/settings/workflow/columns'],
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

  it('W3: no SiteMaster tab; the old SiteMaster routes open Workflow > Columns', async () => {
    at('/admin/settings/site-master-columns');
    expect(await screen.findByTestId('site-master-columns')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-tab-site360')).toBeNull();
    expect(screen.getByTestId('settings-tab-workflow')).toHaveClass('btn-accent');
    expect(screen.getByTestId('settings-section-workflow-columns')).toHaveClass('btn-accent');
    expect(screen.getByTestId('page-settings')).not.toHaveTextContent(/Site360|SITE 360|Site 360/);
  });

  it('the Workflow tab still opens the editor first', async () => {
    at('/admin/settings/workflow');
    await waitFor(() => expect(probe()).toBe('/admin/settings/workflow/editor'));
  });

  it('hides the mail kinds section from a user who is not a System Admin, and keeps the Documents tab', async () => {
    await signIn('engineer');
    at('/admin/settings/documents/library');
    expect(await screen.findByTestId('settings-section-documents-types')).toBeInTheDocument();
    expect(screen.getByTestId('settings-section-documents-forms')).toBeInTheDocument();
    expect(screen.getByTestId('settings-section-documents-archive')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('settings-section-documents-mail')).toBeNull());
    expect(screen.getByTestId('settings-tab-documents')).toBeInTheDocument();
  });
});
