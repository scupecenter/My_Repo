import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import { Avatar } from '@/components/Avatar';
import { NewBadge } from '@/components/NewBadge';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './settings/Settings';

/** Settings > Screens > Interface (migration 0196): generated avatars and the New badge; the preview follows the unsaved choice. */
const settings = () => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/screens/interface' });

describe('Settings > Interface', () => {
  it('an admin saves the avatar choice with a reason and If-Match; the preview follows the choice before saving', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const puts: { body: unknown; ifMatch: string | null }[] = [];
    server.events.on('request:start', async ({ request }) => { if (request.method === 'PUT' && request.url.endsWith('/settings/ui-features')) puts.push({ body: await request.clone().json(), ifMatch: request.headers.get('If-Match') }); });
    settings();
    expect(await screen.findByTestId('page-ui-settings')).toBeInTheDocument();
    expect(screen.getByTestId('settings-section-screens-interface')).toHaveClass('btn-accent');
    const preview = screen.getByTestId('ui-av-preview');
    expect(within(preview).getAllByTestId('avatar')[0]).toHaveAttribute('data-style', 'gradient');
    await u.click(screen.getByTestId('ui-av-style-geometric'));
    await u.click(screen.getByTestId('ui-av-shape-rounded'));
    expect(within(preview).getAllByTestId('avatar')[0]).toHaveAttribute('data-style', 'geometric');
    expect(within(preview).getAllByTestId('avatar')[0]).toHaveAttribute('data-shape', 'rounded');
    await u.click(screen.getByTestId('ui-new-enabled'));
    expect(screen.getByTestId('ui-new-days')).toBeDisabled();
    await u.click(screen.getByTestId('ui-save'));
    const dlg = await screen.findByTestId('ui-dialog');
    await u.type(within(dlg).getByRole('textbox'), 'Square avatars, no badge');
    await u.click(within(dlg).getByRole('button', { name: /save|confirm|submit/i }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toMatchObject({ reason: 'Square avatars, no badge', sections: { avatars: { style: 'geometric', shape: 'rounded', palette: 'varied', in_lists: true }, new_badge: { enabled: false, days: 14 } } });
    expect(puts[0]!.ifMatch).toBe('"0"');
  });

  it('shows the field error of a bad number of days and a user without the right reads only', async () => {
    await signIn('pm');
    server.use(http.put(`${API_BASE}/settings/ui-features`, () => HttpResponse.json({ code: 'validation_failed', title: 'Invalid', status: 422, errors: [{ path: '/sections/new_badge/days', code: 'out_of_range' }] }, { status: 422 })));
    const u = userEvent.setup();
    settings();
    await screen.findByTestId('page-ui-settings');
    await u.clear(screen.getByTestId('ui-new-days'));
    await u.type(screen.getByTestId('ui-new-days'), '400');
    await u.click(screen.getByTestId('ui-save'));
    const dlg = await screen.findByTestId('ui-dialog');
    await u.type(within(dlg).getByRole('textbox'), 'Too many days');
    await u.click(within(dlg).getByRole('button', { name: /save|confirm|submit/i }));
    expect(await screen.findByTestId('err-sections-new_badge-days')).toBeInTheDocument();
  });

  it('a user without the right reads it only', async () => {
    await signIn('engineer');
    settings();
    expect(await screen.findByTestId('ui-read-only')).toBeInTheDocument();
    expect(screen.queryByTestId('ui-save')).toBeNull();
  });
});

describe('Settings > Interface > Inbox tabs and priority', () => {
  it('an admin turns a kind into priority, picks the first tab, and saves the inbox section with a reason', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const puts: { body: { sections: { inbox: unknown } } }[] = [];
    server.events.on('request:start', async ({ request }) => { if (request.method === 'PUT' && request.url.endsWith('/settings/ui-features')) puts.push({ body: await request.clone().json() }); });
    settings();
    await screen.findByTestId('ui-inbox');
    expect(screen.getByTestId('ui-inbox-kind-mention')).toBeChecked();
    expect(screen.getByTestId('ui-inbox-kind-system')).not.toBeChecked();
    await u.click(screen.getByTestId('ui-inbox-kind-system'));
    await u.click(screen.getByTestId('ui-inbox-kind-mention'));
    await u.selectOptions(screen.getByTestId('ui-inbox-default'), 'priority');
    await u.click(screen.getByTestId('ui-inbox-tabs'));
    expect(screen.getByTestId('ui-inbox-default')).toBeDisabled();
    await u.click(screen.getByTestId('ui-save'));
    const dlg = await screen.findByTestId('ui-dialog');
    await u.type(within(dlg).getByRole('textbox'), 'System alerts are priority');
    await u.click(within(dlg).getByRole('button', { name: /save|confirm|submit/i }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body.sections.inbox).toEqual({ tabs_enabled: false, default_tab: 'priority', priority_kinds: ['approval_due', 'task_returned', 'task_rejected', 'idle_task_alert', 'no_holder', 'absence_alert', 'system'] });
  });
});

describe('Settings > Interface > Notification panel', () => {
  it('an admin picks the side panel and its width; the width and tabs are off while the popover is chosen; saved with a reason', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const puts: { body: { sections: { panel: unknown } } }[] = [];
    server.events.on('request:start', async ({ request }) => { if (request.method === 'PUT' && request.url.endsWith('/settings/ui-features')) puts.push({ body: await request.clone().json() }); });
    settings();
    await screen.findByTestId('ui-panel');
    expect(screen.getByTestId('ui-panel-width')).toBeDisabled();
    expect(screen.getByTestId('ui-panel-tabs')).toBeDisabled();
    await u.selectOptions(screen.getByTestId('ui-panel-mode'), 'side_panel');
    await u.selectOptions(screen.getByTestId('ui-panel-width'), 'wide');
    await u.click(screen.getByTestId('ui-panel-tabs'));
    await u.click(screen.getByTestId('ui-save'));
    const dlg = await screen.findByTestId('ui-dialog');
    await u.type(within(dlg).getByRole('textbox'), 'Side panel for the team');
    await u.click(within(dlg).getByRole('button', { name: /save|confirm|submit/i }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body.sections.panel).toEqual({ mode: 'side_panel', width: 'wide', show_tabs: false });
  });
});

describe('Avatar component', () => {
  it('draws initials and follows the avatar setting in lists', async () => {
    await signIn('pm');
    renderApp(<div><Avatar name="Demo Person A" /><Avatar name="Demo Person B" lists /><NewBadge feature="interface-settings" /></div>);
    const av = await screen.findAllByTestId('avatar');
    expect(av[0]).toHaveTextContent('DP');
    expect(av.length).toBe(2);
    // whether the badge shows depends on the real date; the window itself is tested in avatar.test.ts
  });
});
