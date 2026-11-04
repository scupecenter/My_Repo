import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { applyTheme } from '@/i18n';
import { renderApp, signIn } from '@/test/utils';
import { Warehouse } from './Warehouse';

/** Follow-up B (contract 0.13.1, migration 0067), Q270: three movements take quarantined stock out again, each a document with a reason that L2 approves. */
const Routed = () => (
  <Routes>
    <Route path="/warehouse" element={<Warehouse />} />
  </Routes>
);
const COMBOS = [['en', 'light'], ['ar', 'dark']] as const;
const show = (locale: 'en' | 'ar' = 'en', theme: 'light' | 'dark' = 'light') => { applyTheme(theme); return renderApp(<Routed />, { route: '/warehouse', locale }); };
const openStock = async (u: ReturnType<typeof userEvent.setup>) => { await u.click(await screen.findByTestId('wh-tab-stock')); await screen.findByTestId('wh-stock-ANT-900'); };

describe('Q270: quarantine exit controls in the stock list', () => {
  it.each(COMBOS)('offers the exit only for stock that is in quarantine and free, and shows the three movements in %s, %s theme', async (locale, theme) => {
    await signIn('pm');
    show(locale, theme);
    const u = userEvent.setup();
    await openStock(u);
    expect(screen.getByTestId('wh-qx-open-ANT-900')).toBeInTheDocument();
    expect(screen.queryByTestId('wh-qx-open-CBL-FEED')).not.toBeInTheDocument();      // nothing in quarantine
    await u.click(screen.getByTestId('wh-qx-open-ANT-900'));
    const dlg = await screen.findByTestId('wh-qx');
    expect(within(dlg).getByTestId('wh-qx-free')).toHaveTextContent(locale === 'ar' ? /٢|2/ : '2');
    const kinds = within(dlg).getAllByRole('option').map((o) => o.getAttribute('value'));
    expect(kinds).toEqual(['repaired', 'written_off', 'returned_to_supplier']);
    expect(within(dlg).getByRole('option', { name: locale === 'ar' ? /أُعيد إلى المورّد/ : /Returned to supplier/ })).toBeInTheDocument();
    expect(document.documentElement.dir).toBe(locale === 'ar' ? 'rtl' : 'ltr');
  });

  it('creates the document with a reason: the quantity is held as pending and the movement shows in the list', async () => {
    await signIn('pm');
    show();
    const u = userEvent.setup();
    await openStock(u);
    await u.click(screen.getByTestId('wh-qx-open-ANT-900'));
    await u.selectOptions(screen.getByTestId('wh-qx-kind'), 'written_off');
    await u.clear(screen.getByTestId('wh-qx-qty'));
    await u.type(screen.getByTestId('wh-qx-qty'), '2');
    await u.type(screen.getByTestId('wh-qx-reason'), 'Beyond repair');
    await u.click(screen.getByTestId('wh-qx-submit'));
    await waitFor(() => expect(screen.queryByTestId('wh-qx')).not.toBeInTheDocument());
    expect(await screen.findByTestId('wh-stock-ANT-900-qx-pending')).toHaveTextContent('2 held by pending exits');
    expect(screen.queryByTestId('wh-qx-open-ANT-900')).not.toBeInTheDocument();       // nothing left to take out
    await u.click(screen.getByTestId('wh-tab-movements'));
    const chip = await screen.findByTestId(/^wh-mv-exit-ADJ-WH-/);
    expect(chip).toHaveTextContent('Written off');
  });

  it('keeps the submit closed until the reason is given and the quantity fits what is in quarantine', async () => {
    await signIn('pm');
    show();
    const u = userEvent.setup();
    await openStock(u);
    await u.click(screen.getByTestId('wh-qx-open-ANT-900'));
    await u.clear(screen.getByTestId('wh-qx-qty'));
    await u.type(screen.getByTestId('wh-qx-qty'), '3');
    expect(screen.getByTestId('wh-qx-submit')).toBeDisabled();                         // more than the 2 in quarantine
    await u.clear(screen.getByTestId('wh-qx-qty'));
    await u.type(screen.getByTestId('wh-qx-qty'), '1');
    expect(screen.getByTestId('wh-qx-submit')).toBeEnabled();
    await u.click(screen.getByTestId('wh-qx-submit'));                                 // no reason yet
    expect(await screen.findByTestId('wh-qx-reason-error')).toBeInTheDocument();
    expect(screen.getByTestId('wh-qx')).toBeInTheDocument();
  });

  it('a person without the create right does not see the control', async () => {
    await signIn('reviewer');
    show();
    const u = userEvent.setup();
    await openStock(u);
    expect(screen.queryByTestId('wh-qx-open-ANT-900')).not.toBeInTheDocument();
  });
});
