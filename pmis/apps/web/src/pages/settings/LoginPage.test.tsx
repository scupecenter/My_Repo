import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, API_BASE } from '@/api/client';
import type { LoginPage } from '@/api/types';
import { loginPage } from '@/mocks/db';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './Settings';

/** Settings > Screens > Login page (owner request 2026-11-26, migration 0185, contract 0.15.97). */

const page = () => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/screens/login' });

describe('Settings > Screens > Login page', () => {
  it('lists Login page under the Screens tab', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/screens' });
    await screen.findByTestId('settings-tab-screens');
    expect(screen.getByTestId('settings-section-screens-login')).toBeInTheDocument();
  });

  it('saves the announcement, the default language, the animation and a support link with a reason and a step-up (audited)', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    const u = userEvent.setup();
    page();
    await screen.findByTestId('page-login-settings');
    expect(screen.getByTestId('lp-version')).toHaveTextContent('0.15.97');
    await u.type(screen.getByTestId('lp-ann-en'), 'Maintenance on Sunday.');
    await u.click(screen.getByTestId('lp-kind-maintenance'));
    await u.click(screen.getByTestId('lp-locale-ar'));
    await u.click(screen.getByTestId('lp-animation'));
    await u.click(screen.getByTestId('lp-link-add'));
    await u.type(screen.getByTestId('lp-link-0-en'), 'IT support');
    await u.type(screen.getByTestId('lp-link-0-url'), 'mailto:it@example.test');
    await u.click(screen.getByTestId('lp-save'));
    expect(await screen.findByTestId('lp-dialog')).toBeInTheDocument();
    await u.type(screen.getByTestId('lp-dialog-reason'), 'Owner request 2026-11-26');
    await u.click(screen.getByTestId('lp-dialog-submit'));
    await waitFor(async () => expect((await api.get<LoginPage>('/settings/login-page')).version).toBe(2));
    const s = await api.get<LoginPage>('/settings/login-page');
    expect(s).toMatchObject({
      announcement_en: 'Maintenance on Sunday.', announcement_kind: 'maintenance', animation: false, default_locale: 'ar',
      support_links: [{ label_en: 'IT support', label_ar: '', url: 'mailto:it@example.test' }], updated_by: { employee_id: '1001' },
    });
    expect(loginPage().updated_by?.employee_id).toBe('1001');
  });

  it('cannot save a link without a URL, and the server answers 422 politely when the body is wrong', async () => {
    await signIn('pm');
    page();
    await screen.findByTestId('page-login-settings');
    const u = userEvent.setup();
    await u.click(screen.getByTestId('lp-link-add'));
    await u.type(screen.getByTestId('lp-link-0-en'), 'IT support');
    expect(screen.getByTestId('lp-save')).toBeDisabled(); // the URL is still missing
    await u.type(screen.getByTestId('lp-link-0-url'), 'not-a-link');
    expect(screen.getByTestId('lp-save')).toBeDisabled();
    await u.clear(screen.getByTestId('lp-link-0-url'));
    await u.type(screen.getByTestId('lp-link-0-url'), 'https://help.example.test/');
    expect(screen.getByTestId('lp-save')).toBeEnabled();
  });

  it('shows the dialog error and keeps the values when the save fails', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    const u = userEvent.setup();
    page();
    await screen.findByTestId('page-login-settings');
    await u.type(screen.getByTestId('lp-ann-en'), 'x');
    server.use(http.put(`${API_BASE}/settings/login-page`, () => HttpResponse.json({ type: 'x', title: 'Conflict', status: 409, code: 'invalid_transition' }, { status: 409 })));
    await u.click(screen.getByTestId('lp-save'));
    await u.type(await screen.findByTestId('lp-dialog-reason'), 'Owner request 2026-11-26');
    await u.click(screen.getByTestId('lp-dialog-submit'));
    expect(await screen.findByTestId('lp-dialog-error')).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('lp-ann-en')).toHaveValue('x');
  });

  it('is read-only for a user who may not change it, and the API refuses the change', async () => {
    await signIn('engineer');
    page();
    expect(await screen.findByTestId('lp-readonly')).toBeInTheDocument();
    expect(screen.getByTestId('lp-ann-en')).toBeDisabled();
    expect(screen.queryByTestId('lp-save')).toBeNull();
  });

  it('says the server could not be reached when the read fails, with a retry', async () => {
    await signIn('pm');
    server.use(http.get(`${API_BASE}/settings/login-page`, () => HttpResponse.json({ type: 'x', title: 'x', status: 500 }, { status: 500 })));
    page();
    expect(await screen.findByTestId('loginpage-loading-error')).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('loginpage-loading-error-retry')).toBeInTheDocument();
  });
});
