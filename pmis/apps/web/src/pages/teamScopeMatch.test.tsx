import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, ApiError } from '@/api/client';
import type { ContractorRules, TeamScopeMatch } from '@/api/types';
import { resolveSpec, validateContractorRules, validateScopeMatch } from '@/mocks/handlers.settings';
import { SPEC_SEED } from '@/mocks/settingsData';
import { renderApp, signIn } from '@/test/utils';
import { ContractorsReports } from './ContractorsReports';
import { SettingsRoutes } from './settings/Settings';

/** Settings, team / scope match of Procurement (contract 0.9.1, Q97; 0.12.9, P4b: Q143, Q144, Q145, Q147, D145b). */
const settings = (route = '/admin/settings/team-scope', opts = {}) => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route, ...opts });
const reports = (opts = {}) => renderApp(<Routes><Route path="/reports/contractors" element={<ContractorsReports />} /></Routes>, { route: '/reports/contractors', ...opts });
const errCode = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => `${e.status}:${e.code}`);
const cell = (scope: string, spec: string) => screen.getByTestId(`tsm-cell-${scope}-${spec}`) as HTMLInputElement;
const group = (scope: string, g: string) => screen.getByTestId(`tsm-group-${scope}-${g}`) as HTMLInputElement;

describe('team / scope match (Q97, Q143, Q144)', () => {
  it('shows the catalogue codes as columns and the groups: CW scopes take the CW group, TE Installation TE, HLC (exempt) a Fiber team', async () => {
    await signIn('pm');
    settings();
    expect(await screen.findByTestId('tsm-grid')).toBeInTheDocument();
    expect(screen.getByTestId('settings-tab-team-scope')).toHaveTextContent('Team / scope match');
    expect(screen.getByTestId('tsm-col-TOWER_RT')).toHaveTextContent('Tower RT');
    expect(group('CW', 'CW').checked).toBe(true);
    expect(cell('CW', 'TOWER_RT')).toBeChecked();                 // through the group
    expect(cell('CW', 'TOWER_RT')).toBeDisabled();
    expect(cell('CW', 'TE').checked).toBe(false);
    expect(cell('TE Installation', 'TE').checked).toBe(true);
    expect(cell('TE Installation', 'ADAPTION').checked).toBe(false);
    expect((screen.getByTestId('tsm-exempt-HLC') as HTMLInputElement).checked).toBe(true);
    expect(cell('HLC', 'FIBER').checked).toBe(true);                // Q144: a named HLC team is a Fiber team
    expect(cell('STA', 'SURVEY').checked).toBe(false);
    expect(screen.queryByTestId('tsm-readonly')).toBeNull();
    expect(screen.getByTestId('tsm-save')).toBeDisabled();       // nothing changed yet
  });

  it('saves a ticked cell, a group and a new specialization with a reason; the change of eligibility asks for the step-up first', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    settings();
    await screen.findByTestId('tsm-grid');
    await u.click(cell('STA', 'SURVEY'));
    await u.click(group('ST', 'CW'));
    await u.type(screen.getByTestId('tsm-new-spec'), 'Civil');
    await u.click(screen.getByTestId('tsm-add-spec'));
    await u.click(cell('Tower Erection', 'Civil'));
    expect(screen.getByTestId('tsm-version')).toHaveTextContent('Unsaved changes');
    await u.click(screen.getByTestId('tsm-save'));
    await u.type(await screen.findByTestId('tsm-dialog-reason'), 'Survey providers do the structural analysis');
    await api.post('/__mock/step-up', {});   // the change of eligibility needs a fresh step-up (the 401 itself: see the mock contract test)
    await u.click(screen.getByTestId('tsm-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('tsm-version')).toHaveTextContent('Version 3'));
    const saved = await api.get<TeamScopeMatch>('/settings/team-scope-match');
    expect(saved.specializations).toEqual([...SPEC_SEED.map((s) => s.code), 'CIVIL']);
    expect(saved.scopes.find((s) => s.scope === 'STA')!.allowed).toEqual(['SURVEY']);
    expect(saved.scopes.find((s) => s.scope === 'ST')!.allowed_groups).toEqual(['CW']);
    expect(saved.scopes.find((s) => s.scope === 'Tower Erection')!.allowed).toEqual(['CIVIL']);
  });

  it('is in Arabic when the locale is Arabic, with the Arabic labels of the catalogue', async () => {
    await signIn('pm');
    settings('/admin/settings/team-scope', { locale: 'ar' });
    expect(await screen.findByText('مطابقة الفريق والنطاق (المشتريات)')).toBeInTheDocument();
    expect(screen.getByTestId('tsm-save')).toHaveTextContent('حفظ الجدول');
    expect(screen.getByTestId('tsm-col-TOWER_RT')).toHaveTextContent('برج سطح');
    expect(cell('TE Installation', 'TE')).toHaveAttribute('aria-label', 'فرق تركيب المعدات يمكنها تنفيذ أوامر TE Installation');
    expect(group('CW', 'CW')).toHaveAttribute('aria-label', 'كل تخصصات CW يمكنها تنفيذ أوامر CW');
  });

  it('mock contract: reason, If-Match, unknown specialization, a group as a column, a name clash and the admin right', async () => {
    await signIn('pm');
    const cur = await api.get<TeamScopeMatch>('/settings/team-scope-match');
    const body = { specializations: cur.specializations, scopes: cur.scopes };
    expect(await errCode(api.put('/settings/team-scope-match', { version: cur.version, body }))).toBe('422:validation_failed');                  // no reason
    expect(await errCode(api.put('/settings/team-scope-match', { version: cur.version + 5, body: { ...body, reason: 'stale' } }))).toBe('412:precondition_failed');
    expect(await errCode(api.put('/settings/team-scope-match', { version: cur.version, body: { specializations: ['TE'], scopes: [{ scope: 'CW', exempt: false, allowed: ['TOWER_RT'] }], reason: 'bad' } }))).toBe('422:validation_failed');
    const v = validateScopeMatch({ specializations: ['TE', 'te', 'CW'], scopes: [{ scope: 'CW', exempt: false, allowed: [] }, { scope: 'CW', exempt: false, allowed: ['XX'] }], colour: 1 }, cur.catalogue);
    expect(v.map((e) => `${e.path}:${e.code}`)).toEqual(['/colour:unknown_key', '/specializations/1:duplicate', '/specializations/2:is_a_group', '/scopes/1/scope:duplicate', '/scopes/1/allowed/0:unknown_specialization']);
    expect(validateScopeMatch({ ...body, catalogue: [{ code: 'TOWER_RT', label_en: 'Tower RT', aliases: ['Tower GF'] }] }, cur.catalogue).map((e) => e.code)).toContain('name_clash');
    expect(resolveSpec(cur.catalogue ?? [], ' tower-rt ')).toBe('TOWER_RT');   // names compare without case, spaces and punctuation
    // Q147: a change of eligibility without a fresh step-up is refused; a label alone is saved
    const narrower = { ...body, scopes: cur.scopes.map((s) => (s.scope === 'Tower Erection' ? { ...s, allowed: ['TOWER_RT', 'TOWER_GF'], allowed_groups: [] } : s)) };
    expect(await errCode(api.put('/settings/team-scope-match', { version: cur.version, body: { ...narrower, reason: 'towers only' } }))).toBe('401:step_up_required');
    expect(await errCode(api.put('/settings/team-scope-match', { version: cur.version, body: { ...body, catalogue: [{ code: 'SURVEY', label_en: 'Survey', label_ar: 'مسح الموقع' }], reason: 'label' } }))).toBeNull();
    await signIn('engineer');
    expect(await errCode(api.put('/settings/team-scope-match', { version: cur.version, body: { ...body, reason: 'not an admin' } }))).toBe('403:action_forbidden');
  });
});

describe('contractor reports and the read-only match table (Q145, Q142, Q147)', () => {
  it('lists the running orders that no longer match with what to do, marks the certificate as information only, and shows the table read-only', async () => {
    await signIn('engineer');
    reports();
    expect(await screen.findByTestId('cr-mismatch-TRP-0012')).toBeInTheDocument();
    expect(screen.getByTestId('cr-problem-TRP-0012-specialization_mismatch')).toHaveTextContent('Specialization does not match');
    expect(screen.getByTestId('cr-problem-TRP-0012-safety_cert_expired')).toHaveTextContent('information only');
    expect(screen.getByTestId('cr-mismatch-TRP-0031')).toHaveTextContent('Stop Work is lifted');
    expect(screen.getByTestId('cr-team-Old Civil Team')).toHaveTextContent('Specialization not in the catalogue');
    expect(screen.getByTestId('cr-party-Desert Works House')).toHaveTextContent('Company type to review');
    expect(await screen.findByTestId('tsm-readonly')).toBeInTheDocument();
    expect(screen.queryByTestId('tsm-save')).toBeNull();
    expect(cell('TE Installation', 'TE')).toBeDisabled();
  });

  it('is in Arabic', async () => {
    await signIn('engineer');
    reports({ locale: 'ar' });
    expect(await screen.findByText('أوامر جارية لم تعد مطابقة')).toBeInTheDocument();
    expect(await screen.findByTestId('cr-problem-TRP-0031-stop_work')).toHaveTextContent('إيقاف عمل على الموقع');
  });
});

describe('contractor rules (D145b, Q147)', () => {
  it('saves the certificate lead time with a reason and no step-up; changing the CW Delivery Model scopes asks for the step-up', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const view = settings('/admin/settings/contractor-rules');
    const lead = await screen.findByTestId('cr-lead');
    expect(lead).toHaveValue(30);
    expect(await screen.findByTestId('cr-scope-CW')).toBeChecked();
    await waitFor(() => expect(screen.getByTestId('cr-version')).toHaveTextContent('Version 1'));
    await u.clear(lead);
    await u.type(lead, '45');
    await u.click(screen.getByTestId('cr-save'));
    await u.type(await screen.findByTestId('cr-dialog-reason'), 'More notice for renewals');
    await u.click(screen.getByTestId('cr-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('cr-version')).toHaveTextContent('Version 2'));
    const cur = await api.get<ContractorRules>('/settings/contractor-rules');
    expect(cur.safety_cert_lead_days).toBe(45);
    const { version, updated_at: _a, updated_by: _b, ...rest } = cur;
    void _a; void _b;
    view.unmount();   // without the page, the 401 reaches the caller instead of the step-up dialog
    expect(await errCode(api.put('/settings/contractor-rules', { version, body: { ...rest, cw_delivery_scopes: ['CW'], reason: 'narrow' } }))).toBe('401:step_up_required');
    expect(validateContractorRules({ ...rest, safety_cert_lead_days: 400, cw_delivery_scopes: ['Painting'], colour: 1 }).map((e) => `${e.path}:${e.code}`))
      .toEqual(['/colour:unknown_key', '/safety_cert_lead_days:out_of_range', '/cw_delivery_scopes:unknown_scope']);
  });

  it('is in Arabic', async () => {
    await signIn('pm');
    settings('/admin/settings/contractor-rules', { locale: 'ar' });
    expect(await screen.findByText('قواعد المقاولين', { selector: 'h2' })).toBeInTheDocument();
    expect(screen.getByText('تنبيه شهادة السلامة (أيام قبل الانتهاء)', { exact: false })).toBeInTheDocument();
  });
});
