import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, API_BASE } from '@/api/client';
import type { Matrix, RegisterDefinition, RegisterRecord } from '@/api/types';
import { defaultsFor, forEntry, isHidden, sectionsFor, validateRecord } from '@/lib/registerForms';
import { recId, REGISTER_DEFS } from '@/mocks/registersData';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { RegisterPage } from './Register';

/**
 * Migration 0042 / contract 0.9.0: the HLC purchase request is a Procurement record of scope HLC (entered by the HLC Fiber Team), the HLC register holds
 * the execution only and links its purchase request, and non-blocking ordering issues come as RegisterRecord.warnings (Q96).
 */
const Routed = () => <Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes>;
const at = (key: string, q = '') => ({ route: `/registers/${key}${q}` });
const def = (key: string): RegisterDefinition => REGISTER_DEFS.find((d) => d.register_key === key)!;
const scopeValues = () => within(screen.getByTestId('reg-field-scope')).getAllByRole('option').map((o) => (o as HTMLOptionElement).value).filter(Boolean);

describe('form rules of the HLC redesign', () => {
  it('shows the HLC approval date only on scope HLC, and hides the pointer of an HLC record (shown as a link)', () => {
    const p = def('procurement');
    expect(isHidden('procurement', 'hlc_approval_date', { scope: 'CW' })).toBe(true);
    expect(isHidden('procurement', 'hlc_approval_date', { scope: 'HLC' })).toBe(false);
    expect(sectionsFor(p, { scope: 'CW' }).flatMap((s) => s.fields.map((f) => f.code))).not.toContain('hlc_approval_date');
    expect(sectionsFor(p, { scope: 'HLC' }).flatMap((s) => s.fields.map((f) => f.code))).toContain('hlc_approval_date');
    const h = sectionsFor(def('hlc'), {});
    expect(h.map((s) => s.id)).toEqual(['purchase_request', 'fiber_status', 'install', 'in_service', 'remark']);
    expect(h.flatMap((s) => s.fields.map((f) => f.code))).not.toContain('procurement_record_id');
    expect(def('hlc').fields.filter((f) => f.read_only).map((f) => f.code)).toEqual(['pr_no', 'hlc_approval_date', 'procurement_record_id']);
    expect(def('hlc').fields.map((f) => f.code)).not.toContain('request_no');
  });

  it('offers only the scopes the caller may enter, and presets the only one', () => {
    const p = def('procurement');
    const hlcTeam = { ...p, entry_scopes: ['HLC'] };
    expect(forEntry(hlcTeam).fields.find((f) => f.code === 'scope')!.options!.map((o) => o.value)).toEqual(['HLC']);
    expect(defaultsFor('procurement', hlcTeam)).toEqual({ scope: 'HLC' });
    const procTeam = { ...p, entry_scopes: ['CW', 'Tower Erection'] };
    expect(forEntry(procTeam).fields.find((f) => f.code === 'scope')!.options!.map((o) => o.value)).toEqual(['CW', 'Tower Erection']);
    expect(defaultsFor('procurement', procTeam)).toEqual({});
    expect(forEntry(p)).toBe(p);                                                      // no list: the server decides
    const none = { ...p, entry_scopes: [] };
    expect(forEntry(none)).toBe(none);
  });

  it('needs the PR No. and PR date of an HLC request, and refuses a future HLC approval date', () => {
    const codes = (data: Record<string, unknown>) => validateRecord(def('procurement'), data, 'site', '2026-10-30');
    expect(Object.keys(codes({ scope: 'HLC', order_status: 'Open' })).sort()).toEqual(['pr_date', 'pr_no']);
    expect(codes({ scope: 'HLC', order_status: 'Open', pr_no: 'H', pr_date: '2026-10-01', hlc_approval_date: '2026-11-15' }).hlc_approval_date?.code).toBe('future_date');
    expect(codes({ scope: 'CW', order_status: 'Open' })).toEqual({});
  });
});

describe('the Procurement screen for the HLC Fiber Team', () => {
  it('offers scope HLC only (preset), with the HLC approval date, and saves the request', async () => {
    await signIn('pm');
    // the catalogue as the API serves it to an HLC Fiber Team member (contract 0.9.0: entry_scopes)
    server.use(http.get(`${API_BASE}/registers`, () => HttpResponse.json({ items: [{ ...def('procurement'), entry_scopes: ['HLC'], record_count: 0 }] })));
    renderApp(<Routed />, at('procurement'));
    const u = userEvent.setup();
    expect(await screen.findByTestId('register-owner-note')).toHaveTextContent(/HLC Fiber Team enters the HLC purchase requests here/);
    await u.click(screen.getByTestId('register-new'));
    await u.type(await screen.findByTestId('reg-site-search'), 'WM103');
    await u.click(await screen.findByTestId('reg-site-opt-WM103'));
    expect(scopeValues()).toEqual(['HLC']);
    expect(screen.getByTestId('reg-field-scope')).toHaveValue('HLC');
    expect(screen.getByTestId('reg-field-hlc_approval_date')).toBeInTheDocument();
    await u.click(screen.getByTestId('reg-submit'));
    expect(await screen.findByTestId('reg-error-pr_no')).toBeInTheDocument();
    expect(screen.getByTestId('reg-error-pr_date')).toBeInTheDocument();
    await u.type(screen.getByTestId('reg-field-pr_no'), 'HPR-2026-090');
    await u.type(screen.getByTestId('reg-field-pr_date'), '2026-10-01');
    await u.type(screen.getByTestId('reg-field-hlc_approval_date'), '2026-10-08');
    await u.click(screen.getByTestId('reg-save'));
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveTextContent(/Saved/i));
    const list = await api.get<{ items: RegisterRecord[] }>('/registers/procurement/records', { query: { q: 'HPR-2026-090' } });
    expect(list.items[0]!.data).toMatchObject({ scope: 'HLC', pr_no: 'HPR-2026-090', hlc_approval_date: '2026-10-08' });
  });

  it('lists the HLC scope beside the others for someone who may enter every scope, and hides the HLC approval date until HLC is chosen', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('procurement'));
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('register-new'));
    await screen.findByTestId('reg-field-scope');
    expect(scopeValues()).toEqual(expect.arrayContaining(['CW', 'HLC']));
    expect(screen.queryByTestId('reg-field-hlc_approval_date')).not.toBeInTheDocument();
    await u.selectOptions(screen.getByTestId('reg-field-scope'), 'HLC');
    expect(screen.getByTestId('reg-field-hlc_approval_date')).toBeInTheDocument();
  });

  it('shows the Matrix row of the HLC scope (L1 HLC Fiber Team, L2 CW Team Lead) in the mock matrix', async () => {
    await signIn('pm');
    const m = await api.get<Matrix>('/matrix');
    const codes = m.stages.map((r) => r.code);
    expect(codes.indexOf('procurement_hlc')).toBe(codes.indexOf('procurement') + 1);
    const row = m.stages.find((r) => r.code === 'procurement_hlc')!;
    expect(row.cells.find((c) => c.level === 1)!.assignees.map((a) => a.employee_id)).toEqual(['1207']);
    expect(row.cells.find((c) => c.level === 3)!.assignees.map((a) => a.employee_id)).toEqual(['1203']);
  });
});

describe('the HLC register screen: execution only, with the link to the purchase request', () => {
  it('links the approved HLC purchase request in Procurement and shows its HLC approval', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('hlc', `?record=${recId(7)}`));
    const link = await screen.findByTestId('reg-hlc-pr-link');
    expect(link).toHaveTextContent('HPR-2026-044');
    expect(link.getAttribute('href')).toBe(`/registers/procurement?record=${recId(14)}`);
    expect(screen.getByTestId('reg-hlc-pr-approval')).toHaveTextContent('2026-09-14');
    expect(screen.queryByTestId('reg-hlc-legacy')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reg-warnings')).not.toBeInTheDocument();
    expect(screen.getByTestId('reg-section-install')).toHaveTextContent(/Link Received/);
    expect(screen.queryByText('HLC Request No.')).not.toBeInTheDocument();
  });

  it('keeps a request entered before the move readable, and warns the reviewer that Procurement has no HLC request yet', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('hlc', `?record=${recId(8)}`));
    expect(await screen.findByTestId('reg-hlc-legacy')).toHaveTextContent('HLC-2026-031');
    expect(screen.getByTestId('reg-hlc-pr-missing')).toBeInTheDocument();
    expect(screen.getByTestId('reg-warning-no_approved_hlc_pr')).toHaveTextContent(/no approved HLC purchase request/);
  });

  it('names the field of a warning the server sends, and shows the server sentence for an unknown code', async () => {
    await signIn('pm');
    const real = await api.get<RegisterRecord>(`/registers/hlc/records/${recId(7)}`);
    server.use(http.get(`${API_BASE}/registers/hlc/records/${recId(7)}`, () => HttpResponse.json({ ...real, warnings: [
      { path: '/data/installation_date', code: 'before_hlc_approval', message: 'x' },
      { path: '/data/remark', code: 'something_new', message: 'A sentence from the server.' },
    ] })));
    renderApp(<Routed />, at('hlc', `?record=${recId(7)}`));
    expect(await screen.findByTestId('reg-warning-before_hlc_approval')).toHaveTextContent('Installation Date is before the HLC approval date.');
    expect(screen.getByTestId('reg-warning-something_new')).toHaveTextContent('A sentence from the server.');
  });
});
