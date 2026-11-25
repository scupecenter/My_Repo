import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './Settings';

/**
 * Settings > Workflow > Columns (W3; before: the SiteMaster tab). Contract 0.15.21, F15: every Master column with its Site Master menus, changed in one
 * dialog with a reason (`PATCH /site-master/columns/{ord}/sections`, the same right as before: site_master_col_can_admin on the server).
 */
function Probe() {
  const l = useLocation();
  return <div data-testid="probe">{l.pathname}</div>;
}
const screenAt = (route = '/admin/settings/workflow/columns', locale: 'en' | 'ar' = 'en') =>
  renderApp(<><Probe /><Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes></>, { route, locale });

describe('Settings > Workflow > Columns (Site Master columns)', () => {
  it('lists the Master columns with their menus; the status columns cannot be changed', async () => {
    await signIn('pm');
    screenAt();
    expect(await screen.findByTestId('siteMasterCols-row-AG')).toBeInTheDocument();
    expect(screen.getByTestId('siteMasterCols-row-B')).toBeInTheDocument();   // a site field: not reachable from a task form of the Studio
    expect(screen.getByTestId('siteMasterCols-fixed-FX')).toBeInTheDocument();
    expect(screen.queryByTestId('siteMasterCols-edit-FX')).toBeNull();
    expect(screen.getByTestId('settings-section-workflow-columns')).toHaveClass('btn-accent');
    expect(screen.getByTestId('settings-section-workflow-columns')).toHaveTextContent('Columns');
    expect(screen.getByTestId('site-master-columns')).toHaveTextContent('Site Master columns');
    expect(screen.getByTestId('site-master-columns')).not.toHaveTextContent(/SiteMaster|SITE 360|Site 360/);
    expect(screen.getByTestId('siteMasterCols-studio-link')).toHaveAttribute('href', '/admin/settings/workflow/editor');
  });

  it('opens the menu dialog of a column with its current menus ticked', async () => {
    await signIn('pm');
    screenAt();
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('siteMasterCols-edit-AG'));
    await waitFor(() => expect(screen.getByTestId('siteMasterCols-menu-cw')).toBeChecked());
    expect(screen.getByTestId('siteMasterCols-menu-te')).not.toBeChecked();
  });

  it('saves the new menus with the reason through the same API', async () => {
    const sent: unknown[] = [];
    server.use(http.patch(`${API_BASE}/site-master/columns/:ord/sections`, async ({ params, request }) => {
      sent.push({ ord: Number(params.ord), ...(await request.json() as object) });
      return HttpResponse.json({ ord: Number(params.ord), sections: ['cw', 'te'] });
    }));
    await signIn('pm');
    screenAt();
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('siteMasterCols-edit-AG'));
    await u.click(await screen.findByTestId('siteMasterCols-menu-te'));
    await u.type(screen.getByTestId('siteMasterCols-dialog-reason'), 'The TE team reads it too');
    await u.click(screen.getByTestId('siteMasterCols-dialog-submit'));
    await waitFor(() => expect(sent).toEqual([{ ord: 33, sections: ['cw', 'te'], reason: 'The TE team reads it too' }]));
    await waitFor(() => expect(screen.queryByTestId('siteMasterCols-dialog')).toBeNull());
  });

  it.each(['/admin/settings/site360', '/admin/settings/site360-columns'])('the old link %s opens Workflow > Columns', async (old) => {
    await signIn('pm');
    screenAt(old);
    expect(await screen.findByTestId('site-master-columns')).toBeInTheDocument();
    expect(screen.getByTestId('probe')).toHaveTextContent('/admin/settings/workflow/columns');
  });

  it('is in Arabic, with the Arabic name of the Site Master', async () => {
    await signIn('pm');
    screenAt('/admin/settings/workflow/columns', 'ar');
    expect(await screen.findByTestId('siteMasterCols-row-AG')).toBeInTheDocument();
    expect(screen.getByTestId('site-master-columns')).toHaveTextContent('أعمدة ماستر المواقع');
    expect(screen.getByTestId('settings-section-workflow-columns')).toHaveTextContent('الأعمدة');
  });
});
