import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, ApiError } from '@/api/client';
import type { TeamScopeMatch } from '@/api/types';
import { validateScopeMatch } from '@/mocks/handlers.settings';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './settings/Settings';

/** Settings, team / scope match of Procurement (contract 0.9.1, Q97, migration 0043). */
const settings = (opts = {}) => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/team-scope', ...opts });
const errCode = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => `${e.status}:${e.code}`);
const cell = (scope: string, spec: string) => screen.getByTestId(`tsm-cell-${scope}-${spec}`) as HTMLInputElement;

describe('team / scope match (Q97)', () => {
  it('shows the seed as a grid of checkboxes: CW scopes need CW, TE Installation needs TE, TE Dismantle takes both, HLC is exempt', async () => {
    await signIn('pm');
    settings();
    expect(await screen.findByTestId('tsm-grid')).toBeInTheDocument();
    expect(screen.getByTestId('settings-tab-team-scope')).toHaveTextContent('Team / scope match');
    expect(cell('CW', 'CW').checked).toBe(true);
    expect(cell('CW', 'TE').checked).toBe(false);
    expect(cell('TE Installation', 'TE').checked).toBe(true);
    expect(cell('TE Installation', 'CW').checked).toBe(false);
    expect(cell('TE Dismantle', 'CW').checked && cell('TE Dismantle', 'TE').checked).toBe(true);
    expect(cell('STA', 'CW').checked || cell('STA', 'TE').checked).toBe(false);
    expect((screen.getByTestId('tsm-exempt-HLC') as HTMLInputElement).checked).toBe(true);
    expect(cell('HLC', 'CW')).toBeDisabled();
    expect(screen.getByTestId('tsm-save')).toBeDisabled();       // nothing changed yet
  });

  it('saves a ticked cell and a new specialization with a reason; the version goes up', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    settings();
    await screen.findByTestId('tsm-grid');
    await u.click(cell('STA', 'CW'));
    await u.type(screen.getByTestId('tsm-new-spec'), 'Civil');
    await u.click(screen.getByTestId('tsm-add-spec'));
    await u.click(cell('CW', 'Civil'));
    expect(screen.getByTestId('tsm-version')).toHaveTextContent('Unsaved changes');
    await u.click(screen.getByTestId('tsm-save'));
    await u.type(await screen.findByTestId('tsm-dialog-reason'), 'STA providers are CW contractors');
    await u.click(screen.getByTestId('tsm-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('tsm-version')).toHaveTextContent('Version 2'));
    const saved = await api.get<TeamScopeMatch>('/settings/team-scope-match');
    expect(saved.specializations).toEqual(['CW', 'TE', 'Civil']);
    expect(saved.scopes.find((s) => s.scope === 'STA')!.allowed).toEqual(['CW']);
    expect(saved.scopes.find((s) => s.scope === 'CW')!.allowed).toEqual(['CW', 'Civil']);
  });

  it('is in Arabic when the locale is Arabic', async () => {
    await signIn('pm');
    settings({ locale: 'ar' });
    expect(await screen.findByText('مطابقة الفريق والنطاق (المشتريات)')).toBeInTheDocument();
    expect(screen.getByTestId('tsm-save')).toHaveTextContent('حفظ الجدول');
    expect(cell('CW', 'CW')).toHaveAttribute('aria-label', 'فرق CW يمكنها تنفيذ أوامر CW');
  });

  it('mock contract: reason, If-Match, unknown specialization and the admin right', async () => {
    await signIn('pm');
    const cur = await api.get<TeamScopeMatch>('/settings/team-scope-match');
    const body = { specializations: cur.specializations, scopes: cur.scopes };
    expect(await errCode(api.put('/settings/team-scope-match', { version: cur.version, body }))).toBe('422:validation_failed');                  // no reason
    expect(await errCode(api.put('/settings/team-scope-match', { version: cur.version + 5, body: { ...body, reason: 'stale' } }))).toBe('412:precondition_failed');
    expect(await errCode(api.put('/settings/team-scope-match', { version: cur.version, body: { specializations: ['CW'], scopes: [{ scope: 'CW', exempt: false, allowed: ['TE'] }], reason: 'bad' } }))).toBe('422:validation_failed');
    expect(validateScopeMatch({ specializations: ['CW', 'cw'], scopes: [{ scope: 'CW', exempt: false, allowed: [] }, { scope: 'CW', exempt: false, allowed: ['XX'] }], colour: 1 }).map((e) => `${e.path}:${e.code}`))
      .toEqual(['/colour:unknown_key', '/specializations/1:duplicate', '/scopes/1/scope:duplicate', '/scopes/1/allowed/0:unknown_specialization']);
    await signIn('engineer');
    expect(await errCode(api.put('/settings/team-scope-match', { version: cur.version, body: { ...body, reason: 'not an admin' } }))).toBe('403:action_forbidden');
  });
});
