import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { Route, Routes } from 'react-router-dom';
import { SettingsRoutes } from './settings/Settings';
import { Sites } from './Sites';

/** W8 item 4: the Display menu (text size, alignment, density, wrap, zebra), remembered per user and screen, kept in saved views, defaults in Settings > Display. */
const card = () => screen.getByTestId('sites-list-card');

describe('W8 Display menu', () => {
  it('applies text size, alignment, density, wrap and zebra to the table, remembers them per screen, and resets to the defaults', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Sites />, { route: '/sites?layout=list' });
    await screen.findByTestId('site-row-TR101');
    expect(card()).toHaveAttribute('data-tsize', 'md');
    expect(card()).toHaveAttribute('data-tzebra', '1');
    await u.click(screen.getByTestId('display-menu'));
    const panel = await screen.findByTestId('display-panel');
    await u.click(within(panel).getByTestId('display-size-lg'));
    await u.click(within(panel).getByTestId('display-align-center'));
    await u.click(within(panel).getByTestId('display-density-normal'));
    await u.click(within(panel).getByTestId('display-wrap'));
    await u.click(within(panel).getByTestId('display-zebra'));
    expect(card()).toHaveAttribute('data-tsize', 'lg');
    expect(card()).toHaveAttribute('data-talign', 'center');
    expect(card()).toHaveAttribute('data-density', 'normal');
    expect(card()).toHaveAttribute('data-twrap', '1');
    expect(card()).toHaveAttribute('data-tzebra', '0');
    // an admin sees the link to the defaults
    expect(within(panel).getByTestId('display-settings-link')).toHaveAttribute('href', '/admin/settings/display');
    // remembered: a new render of the same screen keeps them (the browser store is per user and per screen)
    const saved = Object.keys(localStorage).find((k) => k.startsWith('pmis.table.sites.'));
    expect(JSON.parse(localStorage.getItem(saved!)!)).toMatchObject({ density: 'normal', display: { size: 'lg', align: 'center', wrap: true, zebra: false } });
    cleanup();
    renderApp(<Sites />, { route: '/sites?layout=list' });
    await screen.findByTestId('site-row-TR101');
    expect(card()).toHaveAttribute('data-tsize', 'lg');
    // another screen keeps its own
    cleanup();
    renderApp(<Sites />, { route: '/sites?stream=CW' });
    await screen.findByTestId('site-row-TR101');
    expect(card()).toHaveAttribute('data-tsize', 'md');
    cleanup();
    renderApp(<Sites />, { route: '/sites?layout=list' });
    await screen.findByTestId('site-row-TR101');
    await u.click(screen.getByTestId('display-menu'));
    await u.click(await screen.findByTestId('display-reset'));
    expect(card()).toHaveAttribute('data-tsize', 'md');
    expect(card()).toHaveAttribute('data-density', 'comfortable');
  });

  it('starts from the defaults of Settings > Display', async () => {
    await signIn('engineer');
    server.use(http.get(`${API_BASE}/settings/table-display`, () => HttpResponse.json({ defaults: { size: 'sm', align: 'center', density: 'compact', wrap: false, zebra: false }, version: 3 })));
    const u = userEvent.setup();
    renderApp(<Sites />, { route: '/sites?layout=list' });
    await screen.findByTestId('site-row-TR101');
    await waitFor(() => expect(card()).toHaveAttribute('data-tsize', 'sm'));
    expect(card()).toHaveAttribute('data-density', 'compact');
    expect(card()).toHaveAttribute('data-tzebra', '0');
    await u.click(screen.getByTestId('display-menu'));
    // not an admin: no link to the defaults
    expect(within(await screen.findByTestId('display-panel')).queryByTestId('display-settings-link')).toBeNull();
  });

  it('a saved view keeps the Display options and applies them again', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Sites />, { route: '/sites?layout=list' });
    await screen.findByTestId('site-row-TR101');
    await u.click(screen.getByTestId('display-menu'));
    await u.click(await screen.findByTestId('display-size-sm'));
    await u.keyboard('{Escape}');
    await u.click(screen.getByTestId('views-save'));
    await u.type(screen.getByTestId('views-name'), 'Small text');
    await u.click(screen.getByTestId('views-name-ok'));
    await waitFor(() => expect(within(screen.getByTestId('views-select')).getAllByRole('option').map((o) => o.textContent)).toContain('Small text'));
    await u.click(screen.getByTestId('display-menu'));
    await u.click(await screen.findByTestId('display-reset'));
    await u.keyboard('{Escape}');
    expect(card()).toHaveAttribute('data-tsize', 'md');
    await u.selectOptions(screen.getByTestId('views-select'), screen.getByRole('option', { name: 'Small text' }));
    await waitFor(() => expect(card()).toHaveAttribute('data-tsize', 'sm'));
  });
});

describe('W8 Settings > Display', () => {
  it('an admin saves the defaults with a reason (If-Match); the tab sits in the general Settings', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const puts: { body: unknown; ifMatch: string | null }[] = [];
    server.events.on('request:start', async ({ request }) => { if (request.method === 'PUT' && request.url.endsWith('/settings/table-display')) puts.push({ body: await request.clone().json(), ifMatch: request.headers.get('If-Match') }); });
    renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/display' });
    expect(await screen.findByTestId('page-display-settings')).toBeInTheDocument();
    expect(screen.getByTestId('settings-tab-display')).toHaveClass('btn-accent');
    await u.click(screen.getByTestId('display-default-size-lg'));
    await u.click(screen.getByTestId('display-default-zebra'));
    expect(screen.getByTestId('display-preview')).toHaveAttribute('data-tsize', 'lg');
    await u.click(screen.getByTestId('display-save'));
    const dlg = await screen.findByTestId('display-dialog');
    await u.type(within(dlg).getByRole('textbox'), 'Larger text for the field teams');
    await u.click(within(dlg).getByRole('button', { name: /save|confirm|submit/i }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toMatchObject({ reason: 'Larger text for the field teams', defaults: { size: 'lg', zebra: false, align: 'start', density: 'comfortable', wrap: false } });
    expect(puts[0]!.ifMatch).toBe('"0"');
  });

  it('a user without the right reads it only', async () => {
    await signIn('engineer');
    renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/display' });
    expect(await screen.findByTestId('display-read-only')).toBeInTheDocument();
    expect(screen.queryByTestId('display-save')).toBeNull();
  });
});
