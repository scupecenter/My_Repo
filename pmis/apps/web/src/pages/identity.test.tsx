import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '@/App';
import { api, ApiError } from '@/api/client';
import type { Me, UiIdentity } from '@/api/types';
import { applyBrand, savedBrand } from '@/lib/brands';
import { renderApp, signIn } from '@/test/utils';
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
