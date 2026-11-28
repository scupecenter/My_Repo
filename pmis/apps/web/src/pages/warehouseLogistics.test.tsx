import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { Warehouse } from './Warehouse';

/** Contract 0.15.342 (migration 0413): reorder limits and supplier returns (RMA). */
const show = () => renderApp(<Routes><Route path="/warehouse" element={<Warehouse />} /></Routes>, { route: '/warehouse' });
const fill = async (u: ReturnType<typeof userEvent.setup>, dlg: HTMLElement, reason: string) => { await u.type(within(dlg).getByRole('textbox', { name: /reason|السبب/i }), reason); await u.click(within(dlg).getByRole('button', { name: /save|confirm|submit|حفظ|تأكيد/i })); };

describe('Warehouse logistics depth', () => {
  it('sets a reorder limit and flags the item when the available stock is at or under it', async () => {
    await signIn('pm');
    show();
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('wh-tab-reorder'));
    await screen.findByTestId('wh-rl-empty');
    const add = screen.getByTestId('wh-rl-add');
    await u.selectOptions(add, within(add).getByRole('option', { name: 'ANT-900' }));
    const dlg = await screen.findByTestId('wh-rl-dialog');
    await u.type(within(dlg).getByTestId('wh-rl-level'), '50');
    await fill(u, dlg, 'Keep a buffer');
    expect(await screen.findByTestId('wh-rl-flag-ANT-900')).toBeInTheDocument();
  });

  it('records a supplier return from quarantined stock and moves it to replaced, then closed', async () => {
    await signIn('pm');
    show();
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('wh-tab-rma'));
    await screen.findByTestId('wh-rma-empty');
    await u.click(screen.getByTestId('wh-rma-new'));
    const dlg = await screen.findByTestId('wh-rma-dialog');
    const sel = within(dlg).getByTestId('wh-rma-item');
    await waitFor(() => expect(within(sel).getByRole('option', { name: /ANT-900/ })).toBeInTheDocument());
    await u.selectOptions(sel, within(sel).getByRole('option', { name: /ANT-900/ }));
    await u.type(within(dlg).getByTestId('wh-rma-qty'), '1');
    await u.type(within(dlg).getByTestId('wh-rma-supplier'), 'Vendor A');
    await fill(u, dlg, 'Faulty on arrival');
    await screen.findByTestId('wh-rma-RMA-00001');
    await u.click(screen.getByTestId('wh-rma-RMA-00001-replaced'));
    await u.click(within(await screen.findByTestId('wh-rma-step')).getByRole('button', { name: /save|confirm|submit|ok|حفظ|تأكيد/i }));
    await waitFor(() => expect(screen.getByTestId('wh-rma-RMA-00001-closed')).toBeInTheDocument());
  });
});
