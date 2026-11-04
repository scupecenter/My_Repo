import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, ApiError } from '@/api/client';
import type { GecolOrderWarnings, HlcLegacyMigration } from '@/api/p4c';
import type { RegisterDefinition, RegisterRecord } from '@/api/types';
import { isHidden, sectionsFor, validateRecord, visibleData } from '@/lib/registerForms';
import { recId, REGISTER_DEFS } from '@/mocks/registersData';
import { siteIdOf } from '@/mocks/sites';
import { db, save } from '@/mocks/db';
import { renderApp, signIn } from '@/test/utils';
import { RegisterPage } from './Register';
import { SettingsRoutes } from './settings/Settings';

/**
 * Work package P4c (contract 0.12.11, migration 0063): Q150 the HLC purchase requests of an HLC record, Q148 the emergency exception, Q114 the Dismantle
 * contractor from the Procurement order, Q139 the legacy HLC requests into Procurement drafts, Q151 the GECOL order warnings (off by default).
 */
const Routed = () => <Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes>;
const at = (key: string, q = '') => ({ route: `/registers/${key}${q}` });
const def = (key: string): RegisterDefinition => REGISTER_DEFS.find((d) => d.register_key === key)!;
const errCode = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => `${e.status}:${e.code}`);

describe('form rules of 0063', () => {
  it('shows the order of an outsourced Dismantle part and the team of an in-house one, and the reason of an HLC exception only with the exception', () => {
    expect(isHidden('dismantle', 'procurement_order_id', {})).toBe(true);
    expect(isHidden('dismantle', 'procurement_order_id', { execution_mode: 'Outsourced' })).toBe(false);
    expect(isHidden('dismantle', 'internal_team', { execution_mode: 'Outsourced' })).toBe(true);
    expect(isHidden('dismantle', 'internal_team', { execution_mode: 'In-House' })).toBe(false);
    expect(sectionsFor(def('dismantle'), { execution_mode: 'In-House' }).find((s) => s.id === 'execution')!.fields.map((f) => f.code)).toEqual(['execution_mode', 'internal_team']);
    // switching the mode drops the field of the other mode from what is sent
    expect(visibleData(def('dismantle'), { rfd_date: '2026-02-01', execution_mode: 'In-House', procurement_order_id: 'x', internal_team: 'Crew 2' })).toEqual({ rfd_date: '2026-02-01', execution_mode: 'In-House', internal_team: 'Crew 2' });
    expect(isHidden('hlc', 'pr_exception_reason', {})).toBe(true);
    expect(isHidden('hlc', 'pr_exception_reason', { pr_exception: true })).toBe(false);
    expect(validateRecord(def('hlc'), { pr_exception: true }, 'site', '2026-11-04').pr_exception_reason?.code).toBe('required');
    expect(validateRecord(def('hlc'), { pr_exception: true, pr_exception_reason: 'Storm' }, 'site', '2026-11-04')).toEqual({});
  });
});

describe('Q150: the HLC purchase requests of an HLC record', () => {
  it('shows the one approved request as complete', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('hlc', `?record=${recId(7)}`));
    const box = await screen.findByTestId('reg-hlc-prs', {}, { timeout: 15000 });
    expect(within(box).getByTestId('reg-hlc-prs-status')).toHaveAttribute('data-complete', 'true');
    expect(within(box).getByTestId('reg-hlc-prs-status')).toHaveTextContent('2026-09-14');
    expect(within(box).getByTestId('reg-hlc-prs-mode')).toHaveTextContent(/every submitted HLC request/);
    expect(within(box).queryByTestId('reg-hlc-prs-picker')).not.toBeInTheDocument();   // in review: nothing to name
  });

  it('lets the L1 name the requests a record covers when the site has several', async () => {
    await signIn('pm');
    const site_id = siteIdOf(6);
    const pr = async (no: string, extra: Record<string, unknown> = {}) => {
      const r = await api.post<RegisterRecord>('/registers/procurement/records', { body: { site_id, data: { scope: 'HLC', delivery: 'Outsourced', pr_no: no, pr_date: '2026-10-01', order_status: 'Open', ...extra } } });
      return api.post<RegisterRecord>(`/registers/procurement/records/${r.id}/submit`, { version: r.version, body: {} });
    };
    const a = await pr('HPR-T-1', { hlc_approval_date: '2026-10-05' });
    await pr('HPR-T-2');
    const rec = await api.post<RegisterRecord>('/registers/hlc/records', { body: { site_id, data: { fiber_status: 'Exchange' } } });
    expect(rec.purchase_requests).toMatchObject({ linked_explicitly: false, required: 2 });
    expect(rec.warnings!.map((w) => w.code)).toContain('hlc_prs_not_linked');
    renderApp(<Routed />, at('hlc', `?record=${rec.id}`));
    const u = userEvent.setup();
    const pick = await screen.findByTestId(`reg-hlc-prs-pick-${a.entity_id}`, {}, { timeout: 15000 });
    expect(screen.getByTestId('reg-hlc-prs-save')).toBeDisabled();
    await u.click(pick);
    await u.click(screen.getByTestId('reg-hlc-prs-save'));
    await waitFor(() => expect(screen.getByTestId('reg-hlc-prs-mode')).toHaveTextContent(/named below/));
    const saved = await api.get<RegisterRecord>(`/registers/hlc/records/${rec.id}`);
    expect(saved.purchase_requests).toMatchObject({ linked_explicitly: true, required: 1 });
    expect(saved.warnings!.map((w) => w.code)).not.toContain('hlc_prs_not_linked');
    // a CW order of the site is not an HLC request
    const cw = await api.post<RegisterRecord>('/registers/procurement/records', { body: { site_id, data: { scope: 'CW', delivery: 'Outsourced', pr_no: 'PR-T', pr_date: '2026-10-01', order_status: 'Open' } } });
    expect(await errCode(api.put(`/registers/hlc/records/${rec.id}/purchase-requests`, { version: saved.version, body: { procurement_entity_ids: [cw.entity_id] } }))).toBe('422:validation_failed');
  });

  it('offers the emergency exception on the HLC form, with its reason once ticked', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('hlc'));
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('register-new'));
    expect(await screen.findByTestId('reg-field-pr_exception')).toBeInTheDocument();
    expect(screen.queryByTestId('reg-field-pr_exception_reason')).not.toBeInTheDocument();
  });
});

describe('Q114: the Dismantle contractor comes from the Procurement order', () => {
  it('lists the active orders of the part and shows the contractor of the one chosen', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('dismantle', `?record=${recId(13)}`));
    const u = userEvent.setup();
    await u.selectOptions(await screen.findByTestId('reg-field-execution_mode', {}, { timeout: 15000 }), 'Outsourced');
    const sel = await screen.findByTestId('reg-field-procurement_order_id');
    await waitFor(() => expect(within(sel).getByText(/WO-2026-061 · Desert Lift Services/)).toBeInTheDocument());
    await u.selectOptions(sel, recId(16));
    expect(screen.getByTestId('reg-dismantle-contractor')).toHaveTextContent('Desert Lift Services');
    await u.click(screen.getByTestId('reg-save'));
    await waitFor(async () => {
      const r = await api.get<RegisterRecord>(`/registers/dismantle/records/${recId(13)}`);
      expect(r.data).toMatchObject({ execution_mode: 'Outsourced', procurement_order_id: recId(16) });
      expect(r.external_party?.name).toBe('Desert Lift Services (synthetic)');
    });
    // the CW part of the site has no CW Dismantle order
    const opts = await api.get<{ items: unknown[] }>('/registers/dismantle/order-options', { query: { site_id: (await api.get<RegisterRecord>(`/registers/dismantle/records/${recId(13)}`)).site_id!, record_type: 'cw' } });
    expect(opts.items).toEqual([]);
  });
});

describe('Q139: the legacy HLC requests into Procurement drafts', () => {
  it('previews, then creates the draft once with a reason', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('hlc'));
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('more-menu'));
    await u.click(await screen.findByTestId('register-hlc-legacy'));
    expect(await screen.findByTestId('hlc-legacy-submit')).toBeDisabled();       // preview first
    await u.click(screen.getByTestId('hlc-legacy-preview'));
    const item = await screen.findByTestId(`hlc-legacy-item-${recId(8)}`);
    expect(item).toHaveAttribute('data-outcome', 'create');
    expect(item).toHaveTextContent('HLC-2026-031');
    await u.type(screen.getByTestId('hlc-legacy-reason'), 'Q139 one-time move');
    db().session!.stepupAt = Date.now(); save();   // the run needs a recent step-up
    await u.click(screen.getByTestId('hlc-legacy-submit'));
    await waitFor(() => expect(screen.getByTestId('hlc-legacy-result')).toHaveAttribute('data-dry-run', 'false'));
    const list = await api.get<{ items: RegisterRecord[] }>('/registers/procurement/records', { query: { q: 'HLC-2026-031' } });
    expect(list.items[0]!).toMatchObject({ state: 'entry', data: { scope: 'HLC', pr_no: 'HLC-2026-031', pr_date: '2026-08-14' } });
    expect(list.items[0]!.data.hlc_approval_date).toBeUndefined();
    const again = await api.post<HlcLegacyMigration>('/registers/hlc/legacy-migration', { body: { dry_run: true } });
    expect(again.items.find((i) => i.hlc_record_id === recId(8))!.outcome).toBe('already_migrated');
  });
});

describe('Q151: the GECOL order warnings (Settings)', () => {
  it('is off by default, saves with a reason, and then warns the reviewer of an out-of-order GECOL record', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/gecol-order' });
    const u = userEvent.setup();
    const on = await screen.findByTestId('gow-enabled') as HTMLInputElement;
    expect(screen.getByTestId('settings-tab-gecol-order')).toHaveTextContent('GECOL order warnings');
    expect(on.checked).toBe(false);
    expect(screen.getByTestId('gow-step-0-1')).toHaveTextContent('Survey Date');
    const g = await api.post<RegisterRecord>('/registers/gecol/records', { body: { site_id: siteIdOf(3), data: { pr_no: 'GP-T', request_date: '2026-10-05', survey_date: '2026-10-01' } } });
    expect(g.warnings!.map((w) => w.code)).not.toContain('gecol_order');
    await u.click(on);
    await u.click(screen.getByTestId('gow-save'));
    await u.type(await screen.findByTestId('gow-dialog-reason'), 'GECOL team draft order');
    await u.click(screen.getByTestId('gow-dialog-submit'));
    await waitFor(async () => expect((await api.get<GecolOrderWarnings>('/settings/gecol-order-warnings')).enabled).toBe(true));
    expect((await api.get<RegisterRecord>(`/registers/gecol/records/${g.id}`)).warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'gecol_order', path: '/data/survey_date', related_path: '/data/request_date' })]));
    expect(await errCode(api.put('/settings/gecol-order-warnings', { version: 1, body: { reason: 'stale', enabled: false, chains: [], billing_after: null } }))).toBe('412:precondition_failed');
    expect(await errCode(api.put('/settings/gecol-order-warnings', { version: 2, body: { reason: 'bad', enabled: true, chains: [['request_date', 'meter_no']], billing_after: null } }))).toBe('422:validation_failed');
  });
});
