import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '@/App';
import { api, ApiError } from '@/api/client';
import type { Me, UiIdentity } from '@/api/types';
import { applyBrand, savedBrand } from '@/lib/brands';
import { renderApp, signIn } from '@/test/utils';
import { AuthShell } from '@/components/AuthShell';
import { FaviconSync } from '@/components/PublicLogo';
import type { UiPublicIdentity } from '@/api/types';
import { Profile } from './Profile';
import { SettingsRoutes } from './settings/Settings';

/** Switchable UI designs (owner decision 2026-11-19, migration 0130, contract 0.15.41): Settings > Identity & themes, the Appearance control of My profile, data-brand. */
const settings = () => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/identity' });
const errCode = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => `${e.status}:${e.code}`);
const html = () => document.documentElement;
afterEach(() => applyBrand('current'));

describe('applyBrand', () => {
  it('sets data-brand on <html> for a design, removes it for current, and remembers it', () => {
    applyBrand('field');
    expect(html().getAttribute('data-brand')).toBe('field');
    expect(savedBrand()).toBe('field');
    applyBrand('current');
    expect(html().hasAttribute('data-brand')).toBe(false);
    applyBrand('bogus' as never);
    expect(html().hasAttribute('data-brand')).toBe(false);
    expect(savedBrand()).toBe('current');
  });
  it('is independent of the light/dark theme', () => {
    html().setAttribute('data-theme', 'dark');
    applyBrand('aljeel');
    expect(html().getAttribute('data-theme')).toBe('dark');
    expect(html().getAttribute('data-brand')).toBe('aljeel');
    html().removeAttribute('data-theme');
  });
});

describe('Settings > Identity & themes', () => {
  it('shows the six designs with previews, the current default, the choice toggle and the locked status colours', async () => {
    await signIn('pm');
    settings();
    for (const b of ['current', 'aljeel', 'executive', 'field', 'obsidian', 'sahara']) {
      expect(await screen.findByTestId(`identity-card-${b}`)).toBeInTheDocument();
      expect(screen.getByTestId(`identity-preview-${b}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('identity-default-current')).toBeChecked();
    expect(screen.getByTestId('identity-current-current')).toBeInTheDocument();
    expect(screen.getByTestId('identity-allow')).toBeChecked();
    expect(screen.getByTestId('identity-status-locked')).toHaveTextContent('Status colours are locked');
    expect(screen.getByTestId('identity-save')).toBeDisabled();
    expect(screen.getByTestId('settings-tab-identity')).toHaveTextContent('Identity & themes');
  });

  it('saves a new default with a reason; the user\'s design follows', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    const u = userEvent.setup();
    settings();
    await u.click(await screen.findByTestId('identity-default-aljeel'));
    await u.click(screen.getByTestId('identity-allow'));
    await u.click(screen.getByTestId('identity-save'));
    expect(await screen.findByTestId('identity-confirm')).toHaveTextContent('Default design: Aljeel. Everyone sees this design.');
    await u.type(screen.getByTestId('identity-dialog-reason'), 'Owner decision 2026-11-19');
    await u.click(screen.getByTestId('identity-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('identity-current-aljeel')).toBeInTheDocument());
    const s = await api.get<UiIdentity>('/settings/identity');
    expect(s).toMatchObject({ default_brand: 'aljeel', allow_user_choice: false, updated_by: { employee_id: '1001' } });
    expect((await api.get<Me>('/me')).user).toMatchObject({ ui_brand: null, brand: 'aljeel' });
  });

  it('is read-only for a user who may not change it, and the API refuses the change', async () => {
    await signIn('engineer');
    settings();
    expect(await screen.findByTestId('identity-readonly')).toBeInTheDocument();
    expect(screen.getByTestId('identity-default-field')).toBeDisabled();
    expect(screen.queryByTestId('identity-save')).toBeNull();
    const cur = await api.get<UiIdentity>('/settings/identity');
    expect(await errCode(api.put('/settings/identity', { version: cur.version, body: { default_brand: 'field', allow_user_choice: true, reason: 'Not mine' } }))).toBe('403:action_forbidden');
  });

  it('applies the effective design of the signed-in user on <html>', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    const cur = await api.get<UiIdentity>('/settings/identity');
    await api.put('/settings/identity', { version: cur.version, body: { default_brand: 'executive', allow_user_choice: true, reason: 'Try the light sidebar' } });
    renderApp(<App />, { route: '/my-work' });
    await waitFor(() => expect(html().getAttribute('data-brand')).toBe('executive'));
  });
});

describe('Settings > Identity > Workspace logo (0243)', () => {
  const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', { type: 'image/png' });
  const upload = async (u: ReturnType<typeof userEvent.setup>) => {
    await u.upload(screen.getByTestId('identity-logo-file'), png());
    expect(await screen.findByTestId('identity-logo-confirm-upload')).toBeInTheDocument();
    await u.type(screen.getByTestId('identity-logo-dialog-reason'), 'Owner approval 2026-11-27, item 5');
    await u.click(screen.getByTestId('identity-logo-dialog-submit'));
  };

  it('uploads the logo with a reason, shows it in the sidebar, hides and restores it (never deletes)', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    const u = userEvent.setup();
    settings();
    expect(await screen.findByTestId('identity-logo-badge')).toBeInTheDocument();
    expect(screen.getByTestId('identity-logo-state')).toHaveTextContent('No logo uploaded');
    await upload(u);
    await waitFor(() => expect(screen.getByTestId('identity-logo-preview')).toBeInTheDocument());
    expect(screen.getByTestId('identity-logo-state')).toHaveTextContent('Uploaded by');
    const s = await api.get<UiIdentity>('/settings/identity');
    expect(s.logo).toMatchObject({ key: 'logo', mime: 'image/png', enabled: true, version: 1 });
    // the sidebar shows it instead of the badge
    renderApp(<App />, { route: '/my-work' });
    expect((await screen.findAllByTestId('sidebar-logo')).length).toBeGreaterThan(0);
    // hide: the row stays, the bytes answer 404, the badge is back
    await u.click(screen.getByTestId('identity-logo-hide'));
    await u.type(await screen.findByTestId('identity-logo-dialog-reason'), 'Hide it for now');
    await u.click(screen.getByTestId('identity-logo-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('identity-logo-state')).toHaveTextContent('hidden'));
    expect((await api.get<UiIdentity>('/settings/identity')).logo).toMatchObject({ enabled: false, version: 2 });
    expect(await errCode(api.get('/ui/assets/logo'))).toBe('404:not_found');
    // show again
    await u.click(screen.getByTestId('identity-logo-show'));
    await u.type(await screen.findByTestId('identity-logo-dialog-reason'), 'Show it again');
    await u.click(screen.getByTestId('identity-logo-dialog-submit'));
    await waitFor(() => expect((screen.getByTestId('identity-logo-preview'))).toBeInTheDocument());
    expect((await api.get<UiIdentity>('/settings/identity')).logo).toMatchObject({ enabled: true, version: 3 });
  });

  it('is read-only for a non-admin; the API refuses the upload and the toggle', async () => {
    await signIn('engineer');
    settings();
    expect(await screen.findByTestId('identity-logo-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('identity-logo-choose')).toBeNull();
    const f = new FormData();
    f.append('file', png());
    f.append('reason', 'Not mine to change');
    expect(await errCode(api.put('/settings/identity/logo', { body: f }))).toBe('403:action_forbidden');
    expect(await errCode(api.patch('/settings/identity/logo', { version: 1, body: { enabled: false, reason: 'Not mine to change' } }))).toBe('403:action_forbidden');
  });

  it('validates the file, the reason and the version; a no-op toggle is a conflict', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    const bad = new FormData();
    bad.append('file', new File([new Uint8Array([1])], 'notes.txt', { type: 'text/plain' }));
    bad.append('reason', 'A wrong file type');
    expect(await errCode(api.put('/settings/identity/logo', { body: bad }))).toBe('422:validation_failed');
    const f = new FormData();
    f.append('file', png());
    f.append('reason', 'The first logo');
    const up = await api.put<{ version: number }>('/settings/identity/logo', { body: f });
    expect(up.version).toBe(1);
    expect(await errCode(api.patch('/settings/identity/logo', { version: 1, body: { enabled: true, reason: 'Already shown' } }))).toBe('409:invalid_transition');
    expect(await errCode(api.patch('/settings/identity/logo', { version: 9, body: { enabled: false, reason: 'A stale version' } }))).toBe('412:precondition_failed');
  });
});

describe('Settings > Identity > the logo outside the app (0243: sign-in pages and tab icon, OFF by default)', () => {
  const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', { type: 'image/png' });
  const uploadApi = async () => { const f = new FormData(); f.append('file', png()); f.append('reason', 'The first logo'); await api.put('/settings/identity/logo', { body: f }); };
  const display = (version: number, show_on_login: boolean, use_as_favicon: boolean) => api.patch<{ version: number }>('/settings/identity/logo/display', { version, body: { show_on_login, use_as_favicon, reason: 'Owner decision 2026-11-27, logo' } });
  const favicon = () => document.getElementById('pmis-logo-favicon') as HTMLLinkElement | null;

  it('is closed by default: an uploaded logo is not public until an admin switches a place on', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    await uploadApi();
    expect(await api.get<UiPublicIdentity>('/ui/public/identity')).toEqual({ login: null, favicon: null });
    expect(await errCode(api.get('/ui/public/logo/login'))).toBe('404:not_found');
    expect(await errCode(api.get('/ui/public/logo/favicon'))).toBe('404:not_found');
    expect(await errCode(api.get('/ui/public/logo/other'))).toBe('404:not_found');
    renderApp(<AuthShell><div /></AuthShell>);
    expect(await screen.findByTestId('auth-shell')).toBeInTheDocument();
    expect(screen.queryByTestId('auth-logo')).toBeNull();
  });

  it('the admin switches the sign-in pages and the tab icon on from Settings, each audited; hiding the logo closes both', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    const u = userEvent.setup();
    await uploadApi();
    settings();
    const login = await screen.findByTestId('identity-logo-login');
    expect(login).not.toBeChecked();
    expect(screen.getByTestId('identity-logo-favicon')).not.toBeChecked();
    await u.click(login);
    expect(await screen.findByTestId('identity-logo-confirm-display')).toHaveTextContent('anyone who opens');
    await u.type(screen.getByTestId('identity-logo-display-dialog-reason'), 'Owner decision 2026-11-27, logo');
    await u.click(screen.getByTestId('identity-logo-display-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('identity-logo-login')).toBeChecked());
    expect(await api.get<UiPublicIdentity>('/ui/public/identity')).toMatchObject({ login: { version: 2, mime: 'image/png' }, favicon: null });
    expect((await api.get<UiIdentity>('/settings/identity')).logo).toMatchObject({ show_on_login: true, use_as_favicon: false, version: 2 });
    // the sign-in layout shows the logo instead of the badge
    renderApp(<AuthShell><div /></AuthShell>);
    expect((await screen.findAllByTestId('auth-logo')).length).toBeGreaterThan(0);
    // the tab icon follows its own switch
    renderApp(<FaviconSync />);
    expect(favicon()).toBeNull();
    await display(2, true, true);
    renderApp(<FaviconSync />);
    await waitFor(() => expect(favicon()?.getAttribute('href')).toContain('/ui/public/logo/favicon?v=3'));
    // hiding the logo closes both public places (the switches are kept)
    await api.patch('/settings/identity/logo', { version: 3, body: { enabled: false, reason: 'Hide it for now' } });
    expect(await api.get<UiPublicIdentity>('/ui/public/identity')).toEqual({ login: null, favicon: null });
    expect(await errCode(api.get('/ui/public/logo/login'))).toBe('404:not_found');
  });

  it('is refused for a non-admin, with nothing to show, a missing reason, a stale version or no change', async () => {
    await signIn('engineer');
    expect(await errCode(api.patch('/settings/identity/logo/display', { version: 1, body: { show_on_login: true, use_as_favicon: false, reason: 'Not mine to change' } }))).toBe('403:action_forbidden');
    await signIn('pm');
    await api.post('/__mock/step-up');
    expect(await errCode(display(1, true, false))).toBe('422:validation_failed');
    await uploadApi();
    expect(await errCode(api.patch('/settings/identity/logo/display', { version: 1, body: { show_on_login: true, use_as_favicon: false } }))).toBe('422:validation_failed');
    expect(await errCode(display(9, true, false))).toBe('412:precondition_failed');
    expect(await errCode(display(1, false, false))).toBe('409:invalid_transition');
  });
});

describe('My profile > Appearance', () => {
  it('offers the organization default and the four designs, and saves a personal design', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Profile />);
    const sel = await screen.findByTestId('pf-brand');
    expect(sel).toBeEnabled();
    expect(sel).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Use organization default (Current (standard))' })).toBeInTheDocument();
    await u.selectOptions(sel, 'field');
    await u.click(screen.getByTestId('pf-save'));
    await waitFor(async () => expect((await api.get<Me>('/me')).user).toMatchObject({ ui_brand: 'field', brand: 'field' }));
  });

  it('is disabled with a note while the admin set one design for everyone; a personal design is refused', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    const cur = await api.get<UiIdentity>('/settings/identity');
    await api.put('/settings/identity', { version: cur.version, body: { default_brand: 'aljeel', allow_user_choice: false, reason: 'One design for everyone' } });
    renderApp(<Profile />);
    expect(await screen.findByTestId('pf-brand')).toBeDisabled();
    expect(screen.getByTestId('pf-brand-note')).toHaveTextContent('Your administrator set one design for everyone (Aljeel)');
    const p = await api.get<{ version: number }>('/me/profile');
    expect(await errCode(api.patch('/me/profile', { version: p.version, body: { ui_brand: 'field' } }))).toBe('403:field_read_only');
  });

  it('shows the Arabic labels', async () => {
    await signIn('pm');
    renderApp(<Profile />, { locale: 'ar' });
    expect(await screen.findByLabelText('التصميم')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'ميداني (تباين عالٍ)' })).toBeInTheDocument();
  });
});
