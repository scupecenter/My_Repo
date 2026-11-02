import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import type { Problem } from '@/api/types';
import { Shell } from '@/components/Shell';
import { applyTheme } from '@/i18n';
import { registerErrorMessage } from '@/lib/registerErrors';
import { renderApp, signIn } from '@/test/utils';
import { AsBuiltItems } from './AsBuiltItems';
import { RegisterPage } from './Register';
import { Warehouse } from './Warehouse';
import i18n from '@/i18n';

const Routed = () => (
  <Routes>
    <Route path="/warehouse" element={<Warehouse />} />
    <Route path="/as-built/items" element={<AsBuiltItems />} />
    <Route path="/registers/:key" element={<RegisterPage />} />
  </Routes>
);
const COMBOS = [['en', 'light'], ['en', 'dark'], ['ar', 'light'], ['ar', 'dark']] as const;
const show = (route: string, locale: 'en' | 'ar' = 'en', theme: 'light' | 'dark' = 'light') => { applyTheme(theme); return renderApp(<Routed />, { route, locale }); };
const problem = (status: number, code: string) => new ApiError(status, { type: 'x', title: 'x', status, code } as Problem);

describe('Warehouse item master', () => {
  it.each(COMBOS)('lists the items in %s, %s theme', async (locale, theme) => {
    await signIn('pm');
    show('/warehouse', locale, theme);
    const row = await screen.findByTestId('wh-item-ANT-900');
    expect(within(row).getByText(locale === 'ar' ? 'هوائي لوحي 900 ميغاهرتز' : 'Panel antenna 900 MHz')).toBeInTheDocument();
    expect(document.documentElement.getAttribute('data-theme') === 'dark').toBe(theme === 'dark');
    expect(document.documentElement.dir).toBe(locale === 'ar' ? 'rtl' : 'ltr');
  });

  it('lets an admin add an item, and refuses a duplicate code on the code field', async () => {
    await signIn('pm');
    show('/warehouse');
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('wh-new'));
    await u.type(screen.getByTestId('wh-f-code'), 'ANT-900');
    await u.type(screen.getByTestId('wh-f-name_en'), 'Another');
    await u.type(screen.getByTestId('wh-f-uom'), 'pcs');
    await u.type(screen.getByTestId('wh-dialog-reason'), 'new item');
    await u.click(screen.getByTestId('wh-dialog-submit'));
    expect(await screen.findByTestId('wh-error-code')).toHaveTextContent('already used');
    await u.clear(screen.getByTestId('wh-f-code'));
    await u.type(screen.getByTestId('wh-f-code'), 'SPL-1');
    await u.click(screen.getByTestId('wh-dialog-submit'));
    expect(await screen.findByTestId('wh-item-SPL-1')).toBeInTheDocument();
    expect(screen.queryByTestId('wh-dialog')).not.toBeInTheDocument();
  }, 15_000);

  it('shows item_in_use under the unit field and puts the list back', async () => {
    await signIn('pm');
    show('/warehouse', 'ar', 'dark');
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('wh-edit-ANT-900'));
    await u.clear(screen.getByTestId('wh-f-uom'));
    await u.type(screen.getByTestId('wh-f-uom'), 'set');
    await u.type(screen.getByTestId('wh-dialog-reason'), 'unit fix');
    await u.click(screen.getByTestId('wh-dialog-submit'));
    expect(await screen.findByTestId('wh-error-uom')).toHaveTextContent('قيد الاستخدام');
    await waitFor(() => expect(within(screen.getByTestId('wh-item-ANT-900')).getByText('pcs')).toBeInTheDocument());
  }, 15_000);

  it('toasts item_in_use when deactivating an item with a pending movement, and deactivates a free one', async () => {
    await signIn('pm');
    show('/warehouse');
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('wh-off-ANT-900'));
    await u.type(screen.getByTestId('wh-dialog-reason'), 'retire it');
    await u.click(screen.getByTestId('wh-dialog-submit'));
    expect(await screen.findByTestId('toast')).toHaveTextContent('in use');
    expect(screen.getByTestId('wh-item-ANT-900')).toBeInTheDocument();
    await u.click(screen.getByTestId('wh-off-CBL-FEED'));
    await u.type(screen.getByTestId('wh-dialog-reason'), 'retire it');
    await u.click(screen.getByTestId('wh-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('wh-item-CBL-FEED')).not.toBeInTheDocument());
  }, 15_000);

  it('gives a non-admin the list without the edit buttons', async () => {
    await signIn('reviewer');
    show('/warehouse');
    await screen.findByTestId('wh-item-ANT-900');
    expect(screen.queryByTestId('wh-new')).not.toBeInTheDocument();
    expect(screen.queryByTestId('wh-edit-ANT-900')).not.toBeInTheDocument();
  });
});

describe('Warehouse movements and stock', () => {
  it.each(COMBOS)('shows DN / RN with pending and approved status in %s, %s theme', async (locale, theme) => {
    await signIn('pm');
    show('/warehouse', locale, theme);
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('wh-tab-movements'));
    expect(await screen.findByTestId('wh-mv-status-DN-2026-0101')).toHaveTextContent(locale === 'ar' ? 'قيد الانتظار' : 'Pending');
    expect(screen.getByTestId('wh-mv-status-DN-2026-0099')).toHaveTextContent(locale === 'ar' ? 'معتمد' : 'Approved');
    expect(screen.queryByTestId('wh-mv-PL-2026-0003')).not.toBeInTheDocument(); // not a DN or RN
  });

  it('filters by status and links a document to its register record', async () => {
    await signIn('pm');
    show('/warehouse');
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('wh-tab-movements'));
    await screen.findByTestId('wh-mv-DN-2026-0099');
    await u.selectOptions(screen.getByTestId('wh-filter-status'), 'posted');
    await waitFor(() => expect(screen.queryByTestId('wh-mv-DN-2026-0101')).not.toBeInTheDocument());
    expect(within(screen.getByTestId('wh-mv-DN-2026-0099')).getByRole('link')).toHaveAttribute('href', expect.stringContaining('/registers/warehouse?record='));
  });

  it('shows the stock balance', async () => {
    await signIn('pm');
    show('/warehouse', 'ar');
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('wh-tab-stock'));
    expect(await screen.findByTestId('wh-stock-ANT-900-on_hand')).toHaveTextContent(/40|٤٠/);
    expect(screen.getByTestId('wh-stock-ANT-900-available')).toHaveTextContent(/34|٣٤/);
    await u.type(screen.getByTestId('wh-stock-search'), 'RRU');
    await waitFor(() => expect(screen.queryByTestId('wh-stock-ANT-900')).not.toBeInTheDocument());
  });

  it('words insufficient_stock and item_in_use in plain text, in both languages', async () => {
    await i18n.changeLanguage('en');
    expect(registerErrorMessage(i18n.t, problem(422, 'insufficient_stock'))).toMatch(/Not enough stock/);
    expect(registerErrorMessage(i18n.t, problem(422, 'item_in_use'))).toMatch(/in use/);
    await i18n.changeLanguage('ar');
    expect(registerErrorMessage(i18n.t, problem(422, 'insufficient_stock'))).toMatch(/المخزون غير كافٍ/);
  });
});

describe('As-Built items', () => {
  it.each(COMBOS)('lists the items with the Warehouse link in %s, %s theme', async (locale, theme) => {
    await signIn('pm');
    show('/as-built/items', locale, theme);
    const row = await screen.findByTestId('asb-item-TE_ANT');
    expect(within(row).getByText('ANT-900')).toBeInTheDocument();
    expect(within(row).getByText(locale === 'ar' ? 'الهوائيات المركّبة' : 'Antennas installed')).toBeInTheDocument();
  });

  it('creates an item linked to a Warehouse code, then filters by section', async () => {
    await signIn('pm');
    show('/as-built/items');
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('asb-new'));
    await u.type(screen.getByTestId('asb-f-code'), 'TE_RRU');
    await u.selectOptions(screen.getByTestId('asb-f-section'), 'te');
    await u.type(screen.getByTestId('asb-f-name_en'), 'Radio units');
    await u.type(screen.getByTestId('asb-f-unit'), 'pcs');
    await u.type(screen.getByTestId('asb-f-warehouse_item_code'), 'RRU-3');
    await u.type(screen.getByTestId('asb-dialog-reason'), 'new item');
    await u.click(screen.getByTestId('asb-dialog-submit'));
    expect(within(await screen.findByTestId('asb-item-TE_RRU')).getByText('RRU-3')).toBeInTheDocument();
    await u.selectOptions(screen.getByTestId('asb-filter-section'), 'cw');
    await waitFor(() => expect(screen.queryByTestId('asb-item-TE_RRU')).not.toBeInTheDocument());
    expect(screen.getByTestId('asb-item-CW_FENCE')).toBeInTheDocument();
  }, 15_000);

  it('shows item_in_use under the unit, and deactivates an item', async () => {
    await signIn('pm');
    show('/as-built/items', 'ar', 'dark');
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('asb-edit-TE_ANT'));
    await u.clear(screen.getByTestId('asb-f-unit'));
    await u.type(screen.getByTestId('asb-f-unit'), 'set');
    await u.type(screen.getByTestId('asb-dialog-reason'), 'unit fix');
    await u.click(screen.getByTestId('asb-dialog-submit'));
    expect(await screen.findByTestId('asb-error-unit')).toHaveTextContent('قيد الاستخدام');
    await u.click(screen.getByText('إلغاء'));
    await u.click(screen.getByTestId('asb-off-CW_FENCE'));
    await u.type(screen.getByTestId('asb-dialog-reason'), 'retire it');
    await u.click(screen.getByTestId('asb-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('asb-item-CW_FENCE')).not.toBeInTheDocument());
  }, 15_000);
});

describe('Registers reachable from the navigation', () => {
  it('lists every enabled register in the sidebar, by the server nav, and nothing else', async () => {
    await signIn('pm');
    renderApp(<Routes><Route element={<Shell />}><Route path="*" element={<div />} /></Route></Routes>, { route: '/my-work' });
    const links: Record<string, string> = { contractors: 'contractors', warehouse: '/warehouse', quality: 'quality', issues: 'issues', risks: 'risks', change_control: 'change_control', readiness: 'readiness_handover', as_built: 'as_built', meetings: 'meetings', rf_design: 'rf_design', acquisition: 'acquisition' };
    for (const [k, to] of Object.entries(links)) expect((await screen.findByTestId(`nav-${k}`)).getAttribute('href')).toBe(to.startsWith('/') ? to : `/registers/${to}`);
    expect(screen.queryByTestId('registers-soon')).not.toBeInTheDocument();
  });

  it('hides the registers the account may not open', async () => {
    await signIn('engineer');
    renderApp(<Routes><Route element={<Shell />}><Route path="*" element={<div />} /></Route></Routes>, { route: '/my-work' });
    await screen.findByTestId('nav-my_work');
    expect(screen.queryByTestId('nav-warehouse')).not.toBeInTheDocument();
  });

  it.each(['contractors', 'warehouse', 'quality', 'issues', 'risks', 'change_control', 'readiness_handover', 'as_built', 'meetings', 'rf_design', 'acquisition'])('opens %s on the generic register page', async (key) => {
    await signIn('pm');
    show(`/registers/${key}`);
    expect(await screen.findByTestId(`page-register-${key}`)).toBeInTheDocument();
    if (key === 'as_built') { await userEvent.click(screen.getByTestId('more-menu')); expect(await screen.findByTestId('register-asbuilt-items')).toBeInTheDocument(); }
  });
});
