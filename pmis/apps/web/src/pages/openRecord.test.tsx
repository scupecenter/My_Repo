import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { recId } from '@/mocks/registersData';
import { SETTINGS_TABS } from './settings/Settings';
import { OpenRecordSettings } from './settings/OpenRecordSettings';
import { RegisterPage, RegisterRecordPage } from './Register';

/**
 * Decision V5: where a register record opens. The side drawer stays the default; a person who chose the full page (Settings >
 * Screens > Records, stored per user on the server) lands on /registers/:key/records/:id, which draws the same body. The stored
 * choice is mocked here (the server round-trip is the drafts store's own, covered by its tests).
 */
const h = vi.hoisted(() => ({ mode: 'drawer' as 'drawer' | 'page' }));
vi.mock('@/lib/openRecordPref', async () => {
  const { useState } = await import('react');
  return { useOpenRecordMode: () => useState(h.mode) };
});

const Where = () => { const l = useLocation(); return <output data-testid="where">{l.pathname}{l.search}</output>; };
const App = () => (
  <>
    <Routes>
      <Route path="/registers/:key" element={<RegisterPage />} />
      <Route path="/registers/:key/records/:id" element={<RegisterRecordPage />} />
      <Route path="/admin/settings/screens/records" element={<OpenRecordSettings />} />
    </Routes>
    <Where />
  </>
);
const where = () => screen.getByTestId('where').textContent ?? '';
const T = 20_000;

describe('V5 open-record option', () => {
  it('the section is listed in Settings > Screens', () => {
    const screens = SETTINGS_TABS.find((x) => x.key === 'screens');
    expect(screens?.sections.map((s) => s.key)).toContain('records');
  });

  it('the setting: the drawer is the default and the choice flips at once', async () => {
    h.mode = 'drawer';
    const u = userEvent.setup();
    await signIn('pm');
    renderApp(<App />, { route: '/admin/settings/screens/records' });
    const page = await screen.findByTestId('page-openrecord-settings');
    expect(within(page).getByTestId('open-record-mode-drawer')).toHaveAttribute('aria-checked', 'true');
    expect(within(page).getByTestId('open-record-mode-page')).toHaveAttribute('aria-checked', 'false');
    await u.click(within(page).getByTestId('open-record-mode-page'));
    expect(within(page).getByTestId('open-record-mode-page')).toHaveAttribute('aria-checked', 'true');
    expect(within(page).getByTestId('open-record-mode-drawer')).toHaveAttribute('aria-checked', 'false');
  }, T);

  it('a row click opens the drawer while the choice is the drawer (today)', async () => {
    h.mode = 'drawer';
    const u = userEvent.setup();
    await signIn('pm');
    renderApp(<App />, { route: '/registers/procurement' });
    await screen.findByTestId('register-list-card');
    await u.click(await screen.findByTestId(`reg-row-${recId(1)}`));
    expect(where()).toBe(`/registers/procurement?record=${recId(1)}`);
    expect(await screen.findByTestId('register-drawer-body')).toBeInTheDocument();
  }, T);

  it('a row click lands on the full page when the person chose it, and the page draws the same body', async () => {
    h.mode = 'page';
    const u = userEvent.setup();
    await signIn('pm');
    renderApp(<App />, { route: '/registers/procurement' });
    await screen.findByTestId('register-list-card');
    await u.click(await screen.findByTestId(`reg-row-${recId(1)}`));
    expect(where()).toBe(`/registers/procurement/records/${recId(1)}`);
    // the same body as the drawer, with its back link to the register
    const page = await screen.findByTestId('register-record-page');
    expect(await within(page).findByTestId('register-drawer-body')).toBeInTheDocument();
    expect(screen.queryByTestId('register-drawer')).toBeNull();
    await u.click(within(page).getByTestId('register-record-back'));
    expect(where()).toBe('/registers/procurement');
  }, T);

  it('an explicit ?record= address still opens the drawer even when the choice is the page (a shared link keeps its meaning)', async () => {
    h.mode = 'page';
    await signIn('pm');
    renderApp(<App />, { route: `/registers/procurement?record=${recId(1)}` });
    expect(await screen.findByTestId('register-drawer-body')).toBeInTheDocument();
    expect(screen.queryByTestId('register-record-page')).toBeNull();
  }, T);

  it('a missing record says so instead of hanging', async () => {
    h.mode = 'page';
    await signIn('pm');
    renderApp(<App />, { route: `/registers/procurement/records/${recId(9999)}` });
    expect(await screen.findByTestId('register-record-missing')).toBeInTheDocument();
  }, T);
});
