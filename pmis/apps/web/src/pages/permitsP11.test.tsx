import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, API_BASE } from '@/api/client';
import i18n from '@/i18n';
import type { Matrix, PermitEntryType, RegisterDefinition, RegisterRecord } from '@/api/types';
import { forEntry, isHidden, validateRecord } from '@/lib/registerForms';
import { REGISTER_DEFS } from '@/mocks/registersData';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { MatrixPage } from './Matrix';
import { RegisterPage } from './Register';

/**
 * Migration 0054 / contract 0.12.2 (work package P11): permits per stream (Q220, D220b), the permit types the caller may enter (Q222), the transfer of a
 * draft whose holder lost the row (Q221), and the "previous path before conversion" label of the old review acts (Q216).
 */
const Routed = () => <Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes>;
const permits = (): RegisterDefinition => REGISTER_DEFS.find((d) => d.register_key === 'permits_hse')!;
const CW_ONLY: PermitEntryType[] = [
  { code: 'Access - CW', stream: 'CW', choose_stream: false, streams: ['CW'] },
  { code: 'Access - Dismantle', stream: null, choose_stream: true, streams: ['CW'] },
  { code: 'Access - QC / Maintenance', stream: null, choose_stream: true, streams: ['CW'] },
];
const optionValues = (testid: string) => within(screen.getByTestId(testid)).getAllByRole('option').map((o) => (o as HTMLOptionElement).value).filter(Boolean);

describe('the permit form follows the catalogue (Q222, D220b)', () => {
  it('offers only the permit types the caller may enter, and the stream only for a purpose-based type, limited to the caller\'s streams', () => {
    const def = { ...permits(), entry_permit_types: CW_ONLY };
    const f = forEntry(def, { permit_type: 'Access - Dismantle' });
    expect(f.fields.find((x) => x.code === 'permit_type')!.options!.map((o) => o.value)).toEqual(['Access - CW', 'Access - Dismantle', 'Access - QC / Maintenance']);
    const stream = f.fields.find((x) => x.code === 'permit_stream')!;
    expect(stream.required).toBe(true);
    expect(stream.options!.map((o) => o.value)).toEqual(['CW']);
    expect(isHidden('permits_hse', 'permit_stream', { permit_type: 'Access - Dismantle' }, def)).toBe(false);
    expect(isHidden('permits_hse', 'permit_stream', { permit_type: 'Access - CW' }, def)).toBe(true);
    // a stream is required before submit for a purpose-based type, never for a fixed one
    expect(validateRecord(f, { permit_type: 'Access - Dismantle', status: 'Applied' }, 'site', '2026-11-04').permit_stream).toBeTruthy();
    expect(validateRecord(f, { permit_type: 'Access - Dismantle', status: 'Applied', permit_stream: 'CW' }, 'site', '2026-11-04').permit_stream).toBeUndefined();
    expect(validateRecord(forEntry(def, { permit_type: 'Access - CW' }), { permit_type: 'Access - CW', status: 'Applied' }, 'site', '2026-11-04').permit_stream).toBeUndefined();
    // the type of an existing draft stays listed, so the form can show it
    expect(forEntry(def, { permit_type: 'Access - TE' }).fields.find((x) => x.code === 'permit_type')!.options!.map((o) => o.value)).toContain('Access - TE');
  });

  it('shows the stream choice in the form when a purpose-based type is chosen, in English and Arabic, and the server refuses a missing stream', async () => {
    await signIn('pm');
    server.use(http.get(`${API_BASE}/registers`, () => HttpResponse.json({ items: [{ ...permits(), entry_permit_types: CW_ONLY, record_count: 0 }] })));
    renderApp(<Routed />, { route: '/registers/permits_hse' });
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('register-new'));
    await screen.findByTestId('reg-field-permit_type');
    expect(optionValues('reg-field-permit_type')).toEqual(['Access - CW', 'Access - Dismantle', 'Access - QC / Maintenance']);
    expect(screen.queryByTestId('reg-field-permit_stream')).not.toBeInTheDocument();
    await u.selectOptions(screen.getByTestId('reg-field-permit_type'), 'Access - Dismantle');
    expect(await screen.findByTestId('reg-field-permit_stream')).toBeInTheDocument();
    expect(optionValues('reg-field-permit_stream')).toEqual(['CW']);
    expect(screen.getByText('Civil Works (CW)')).toBeInTheDocument();
    await i18n.changeLanguage('ar');
    try {
      expect(await screen.findByText('الأعمال المدنية (CW)')).toBeInTheDocument();
      expect(screen.getAllByText(/المسار \(حسب الغرض\)/).length).toBeGreaterThan(0);
    } finally {
      await i18n.changeLanguage('en');
    }
    const refused = await api.post('/registers/permits_hse/records', { body: { site_id: (await api.get<{ items: { id: string }[] }>('/sites', { query: { limit: 1 } })).items[0]!.id, data: { permit_type: 'PTW - Dismantle', status: 'Applied' } } }).catch((e: unknown) => e) as { status: number; problem: { errors: { path: string; code: string }[] } };
    expect(refused.status).toBe(422);
    expect(refused.problem.errors[0]).toMatchObject({ path: '/data/permit_stream', code: 'stream_required' });
  });
});

describe('the Matrix rows of the permit streams (Q220)', () => {
  it('lists the Acquisition / RF & Design and the O&M rows after the TE row, in English and Arabic', async () => {
    await signIn('pm');
    const m = await api.get<Matrix>('/matrix');
    const codes = m.stages.map((r) => r.code);
    expect(codes.slice(codes.indexOf('permits_hse'), codes.indexOf('permits_hse') + 4)).toEqual(['permits_hse', 'permits_hse_te', 'permits_hse_acq', 'permits_hse_om']);
    const acq = m.stages.find((r) => r.code === 'permits_hse_acq')!;
    expect(acq.cells.find((c) => c.level === 1)!.assignees.map((a) => a.employee_id)).toEqual(['1103']);
    renderApp(<MatrixPage />, { route: '/admin/matrix' });
    expect(within(await screen.findByTestId('matrix-row-permits_hse_om')).getByText('Permits & HSE - O&M stream')).toBeInTheDocument();
    await i18n.changeLanguage('ar');
    try {
      expect(await within(await screen.findByTestId('matrix-row-permits_hse_acq')).findByText('التصاريح والسلامة - مسار الاستحواذ / التصميم')).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('a permit draft whose holder lost the row (Q221) and the old review acts (Q216)', () => {
  it('offers "Transfer the draft" with a note, transfers it, and labels the old review acts in the history', async () => {
    await signIn('pm');
    const sites = await api.get<{ items: { id: string }[] }>('/sites', { query: { limit: 1 } });
    const rec = await api.post<RegisterRecord>('/registers/permits_hse/records', { body: { site_id: sites.items[0]!.id, data: { permit_type: 'Access - CW', status: 'Applied' } } });
    const steps = [
      { id: 'a0000000-0000-4000-8000-000000000001', level: 2, action: 'review', created_at: '2026-10-01T08:00:00Z', previous_path: true, acted_by: { id: 'x', display_name: 'Mona Fathi' } },
      { id: 'a0000000-0000-4000-8000-000000000002', level: 1, action: 'transfer', created_at: '2026-11-04T08:00:00Z', previous_path: false, acted_by: { id: 'y', display_name: 'Ahmed Salem' } },
    ];
    let transferred = false;
    server.use(
      http.get(`${API_BASE}/registers/permits_hse/records/${rec.id}`, () => HttpResponse.json({ ...rec, allowed_actions: transferred ? [] : ['transfer'] }, { headers: { ETag: `"${rec.version}"` } })),
      http.get(`${API_BASE}/registers/permits_hse/records/${rec.id}/history`, () => HttpResponse.json({ items: steps, page: { limit: 50, next_cursor: null } })),
      http.post(`${API_BASE}/registers/permits_hse/records/${rec.id}/transfer`, () => { transferred = true; return HttpResponse.json({ ...rec, version: rec.version + 1, allowed_actions: [] }); }),
    );
    renderApp(<Routed />, { route: `/registers/permits_hse?record=${rec.id}` });
    const u = userEvent.setup();
    expect(await screen.findByTestId('reg-transfer-note')).toHaveTextContent(/no longer holds Data Entry \(L1\)/);
    await u.click(screen.getByTestId('reg-transfer'));
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveTextContent('The draft was moved to a qualified holder.'));
    expect(transferred).toBe(true);
    await u.click(screen.getByRole('tab', { name: 'History' }));
    const items = within(await screen.findByTestId('reg-history')).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Previous path before conversion');
    expect(items[1]).toHaveTextContent('Transferred');
    expect(items[1]).not.toHaveTextContent('Previous path before conversion');
    await i18n.changeLanguage('ar');
    try {
      expect(await screen.findByText('المسار السابق قبل التحويل')).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
