import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import { server } from '@/mocks/server';
import { applyTheme } from '@/i18n';
import { siteIdOf, siteMeta } from '@/mocks/sites';
import { renderApp, signIn } from '@/test/utils';
import { Site } from './Site';
import { Warehouse } from './Warehouse';

/** Work package P7 (contract 0.12.1, migration 0053): quarantine (Q105), the Doc No. lock (Q106), code source and need status (Q107), and D6 (both values). */
const Routed = () => (
  <Routes>
    <Route path="/warehouse" element={<Warehouse />} />
    <Route path="/sites/:siteId" element={<Site />} />
  </Routes>
);
const COMBOS = [['en', 'light'], ['en', 'dark'], ['ar', 'light'], ['ar', 'dark']] as const;
const show = (route: string, locale: 'en' | 'ar' = 'en', theme: 'light' | 'dark' = 'light') => { applyTheme(theme); return renderApp(<Routed />, { route, locale }); };

describe('P7 in the Warehouse screen', () => {
  it.each(COMBOS)('shows the TE dispatch date beside the need status in %s, %s theme', async (locale, theme) => {
    await signIn('pm');
    show('/warehouse', locale, theme);
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('wh-tab-dispatch'));
    const c0 = siteMeta(0).code, c1 = siteMeta(1).code, c2 = siteMeta(2).code;
    expect(await screen.findByTestId(`wh-dispatch-status-${c0}`)).toHaveTextContent(locale === 'ar' ? 'مكتمل' : 'Complete');
    expect(screen.getByTestId(`wh-dispatch-date-${c0}`)).toHaveTextContent('2026-10-18');
    expect(screen.getByTestId(`wh-dispatch-status-${c1}`)).toHaveTextContent(locale === 'ar' ? 'ناقص' : 'Short');
    expect(screen.getByTestId(`wh-dispatch-date-${c1}`)).toHaveTextContent('—');
    // the date is kept even when GSDN Workspace status is not complete (D6: two separate values)
    expect(screen.getByTestId(`wh-dispatch-status-${c2}`)).toHaveTextContent(locale === 'ar' ? 'بانتظار الضبط' : 'Pending configuration');
    expect(screen.getByTestId(`wh-dispatch-date-${c2}`)).toHaveTextContent('2026-10-18');
    expect(within(screen.getByTestId(`wh-dispatch-${c0}`)).getByRole('link')).toHaveAttribute('href', `/sites/${siteIdOf(0)}?tab=warehouse`);
    expect(document.documentElement.dir).toBe(locale === 'ar' ? 'rtl' : 'ltr');
  });

  it('filters the dispatch list by need status', async () => {
    await signIn('pm');
    show('/warehouse');
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('wh-tab-dispatch'));
    await screen.findByTestId(`wh-dispatch-${siteMeta(0).code}`);
    await u.selectOptions(screen.getByTestId('wh-dispatch-filter'), 'short');
    await waitFor(() => expect(screen.queryByTestId(`wh-dispatch-${siteMeta(0).code}`)).not.toBeInTheDocument());
    expect(screen.getByTestId(`wh-dispatch-${siteMeta(1).code}`)).toBeInTheDocument();
  });

  it('shows the quarantine column of the stock (Q105)', async () => {
    await signIn('pm');
    show('/warehouse', 'ar', 'dark');
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('wh-tab-stock'));
    expect(await screen.findByTestId('wh-stock-ANT-900-quarantine')).toHaveTextContent(/2|٢/);
    expect(screen.getByText('الحجر')).toBeInTheDocument();
  });

  it('marks provisional codes and pending needs, and lists the missing configuration (Q107)', async () => {
    await signIn('pm');
    show('/warehouse');
    expect(await screen.findByTestId('wh-provisional-CBL-FEED')).toHaveTextContent('Internal provisional code');
    expect(screen.queryByTestId('wh-provisional-ANT-900')).not.toBeInTheDocument();
    expect(screen.getByTestId('wh-need-pending-ANT-900')).toHaveTextContent('1 need pending configuration');
    expect(screen.queryByTestId('wh-need-pending-RRU-3')).not.toBeInTheDocument();
    const u = userEvent.setup();
    await u.click(screen.getByTestId('wh-tab-gaps'));
    expect(within(await screen.findByTestId('wh-gaps-pending')).getByText(/ANT-900 · Cambium Sector/)).toBeInTheDocument();
    expect(within(screen.getByTestId('wh-gaps-codes')).getByText(/CBL-FEED/)).toBeInTheDocument();
    expect(await within(screen.getByTestId('wh-gaps-vendor')).findAllByText('Not set')).toHaveLength(7);
  });

  it('lets the admin set the WL vendor of a region from the gaps tab, with a reason (D58)', async () => {
    await signIn('pm');
    show('/warehouse');
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('wh-tab-gaps'));
    await u.click(await screen.findByTestId('wh-vendor-edit-7'));
    await u.selectOptions(screen.getByTestId('wh-vendor-select'), 'Intracom');
    await u.click(screen.getByTestId('wh-vendor-panel-submit'));
    expect(await screen.findByTestId('wh-vendor-panel-reason-error')).toBeInTheDocument();
    await u.type(screen.getByTestId('wh-vendor-panel-reason'), 'owner confirmed');
    await u.click(screen.getByTestId('wh-vendor-panel-submit'));
    expect(await within(await screen.findByTestId('wh-vendor-row-7')).findByText('Intracom')).toBeInTheDocument();
    expect(screen.queryByTestId('wh-vendor-panel')).not.toBeInTheDocument();
  });

  it('lets the admin confirm a need quantity in the item dialog; the request carries the rule status', async () => {
    await signIn('pm');
    show('/warehouse');
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('wh-edit-ANT-900'));
    expect(screen.getByTestId('wh-f-rule-status-0')).toHaveValue('pending_configuration');
    await u.clear(screen.getByTestId('wh-f-rule-qty-0'));
    await u.type(screen.getByTestId('wh-f-rule-qty-0'), '3');
    await u.selectOptions(screen.getByTestId('wh-f-rule-status-0'), 'confirmed');
    await u.type(screen.getByTestId('wh-dialog-reason'), 'owner gave it');
    await u.click(screen.getByTestId('wh-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('wh-dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByTestId('wh-need-pending-ANT-900')).not.toBeInTheDocument());
  }, 15_000);

  it('edits a pending document in place through the register record; a posted one shows its lock and the reversal rule', async () => {
    await signIn('pm');
    let patched: unknown = null;
    server.use(
      http.get(`${API_BASE}/registers/warehouse/records/:id`, ({ params }) => HttpResponse.json({ id: params.id, register_key: 'warehouse', state: 'entry', version: 3, data: { doc_no: 'DN-2026-0101', doc_date: '2026-10-20' } })),
      http.patch(`${API_BASE}/registers/warehouse/records/:id`, async ({ request, params }) => { patched = { ifMatch: request.headers.get('if-match'), body: await request.json() }; return HttpResponse.json({ id: params.id, register_key: 'warehouse', state: 'entry', version: 4, data: {} }); }),
    );
    show('/warehouse');
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('wh-tab-movements'));
    expect(await screen.findByTestId('wh-mv-lock-DN-2026-0099')).toHaveTextContent(/reversal/i);
    expect(screen.queryByTestId('wh-mv-edit-open-DN-2026-0099')).not.toBeInTheDocument();
    await u.click(await screen.findByTestId('wh-mv-edit-open-DN-2026-0101'));
    const panel = await screen.findByTestId('wh-mv-edit');
    expect(panel.closest('[role=rowgroup]')).not.toBeNull();   // in the table, not a modal
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('wh-mv-edit-reason')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('wh-mv-edit-submit')).toBeDisabled());
    await u.type(screen.getByTestId('wh-mv-edit-remark'), 'checked at the gate');
    await waitFor(() => expect(screen.getByTestId('wh-mv-edit-submit')).toBeEnabled());
    await u.click(screen.getByTestId('wh-mv-edit-submit'));
    await waitFor(() => expect(screen.queryByTestId('wh-mv-edit')).not.toBeInTheDocument());
    expect(patched).toMatchObject({ body: { data: { remark: 'checked at the gate' } } });
  });

  it('reverses a posted delivery note with a counterpart return note through POST /warehouse/movements', async () => {
    await signIn('pm');
    let posted: { body: { record_type: string; reason: string; lines: unknown[] } } | null = null;
    const l = { item_id: '11111111-1111-4111-8111-111111111111', item_code: 'ANT-900', qty: 4 };
    const dn = { id: 'c1', doc_no: 'DN-2026-0500', record_type: 'te_dn', kind: 'issue', status: 'posted', site_id: '22222222-2222-4222-8222-222222222222', site_code: 'TRP-001', register_record_id: 'e1', lines: [l], version: 1, doc_no_locked: true, reserved: false, created_at: '2026-10-20T08:00:00Z' };
    server.use(
      http.get(`${API_BASE}/warehouse/movements`, () => HttpResponse.json({ items: [dn], next_cursor: null })),
      http.post(`${API_BASE}/warehouse/movements`, async ({ request }) => { posted = { body: (await request.json()) as never }; return HttpResponse.json({ ...dn, id: 'c2', doc_no: 'RN-2026-0501', record_type: 'te_rn', status: 'pending' }); }),
    );
    show('/warehouse');
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('wh-tab-movements'));
    await u.click(await screen.findByTestId('wh-mv-reverse-open-DN-2026-0500'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('wh-mv-reverse-lines')).toHaveTextContent('ANT-900');
    await u.click(screen.getByTestId('wh-mv-reverse-submit'));
    expect(await screen.findByTestId('wh-mv-reverse-reason-error')).toBeInTheDocument();
    await u.type(screen.getByTestId('wh-mv-reverse-reason'), 'Wrong site');
    await u.click(screen.getByTestId('wh-mv-reverse-submit'));
    await waitFor(() => expect(screen.queryByTestId('wh-mv-reverse')).not.toBeInTheDocument());
    expect(posted).toMatchObject({ body: { record_type: 'te_rn', reason: 'Wrong site', lines: [{ qty: 4 }] } });
  });

  it('shows the lock of a posted Doc No. (Q106)', async () => {
    await signIn('pm');
    show('/warehouse');
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('wh-tab-movements'));
    expect(await screen.findByTestId('wh-mv-locked-DN-2026-0099')).toBeInTheDocument();
    expect(screen.queryByTestId('wh-mv-locked-DN-2026-0101')).not.toBeInTheDocument();
  });
});

describe('P7 on the site page', () => {
  it.each(COMBOS)('the Warehouse section shows the date and the need lines in %s, %s theme', async (locale, theme) => {
    await signIn('pm');
    show(`/sites/${siteIdOf(2)}?tab=warehouse`, locale, theme);
    expect(await screen.findByTestId('dispatch-date')).toHaveTextContent('2026-10-18');
    expect(screen.getByTestId('dispatch-need-status')).toHaveAttribute('data-status', 'pending_configuration');
    expect(screen.getByTestId('dispatch-line-ROUTER')).toHaveAttribute('data-status', 'complete');
    expect(screen.getByTestId('dispatch-missing-ANT-900')).toHaveTextContent(locale === 'ar' ? 'كمية الاحتياج غير معطاة' : 'Need quantity not given');
    expect(screen.getByTestId('site-section-warehouse')).toHaveTextContent(locale === 'ar' ? 'المخزن' : 'Warehouse');
  });

  it('a short site shows no date and a short line', async () => {
    await signIn('pm');
    show(`/sites/${siteIdOf(1)}?tab=warehouse`);
    expect(await screen.findByTestId('dispatch-date')).toHaveTextContent('—');
    expect(screen.getByTestId('dispatch-need-status')).toHaveTextContent('Short');
    expect(screen.getByTestId('dispatch-line-ROUTER')).toHaveAttribute('data-status', 'short');
  });
});
