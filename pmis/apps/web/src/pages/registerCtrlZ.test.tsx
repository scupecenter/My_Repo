import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { RegisterPage } from './Register';

const Routed = () => <Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes>;

describe('Ctrl+Z undoes the last register edit (same 8-second undo as the toast)', () => {
  it('puts the old value back outside text fields, and leaves a text field to itself', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/registers/procurement?view=grid' });
    const grid = await screen.findByTestId('register-grid');
    const row = await waitFor(() => {
      const r = grid.querySelector('tr[data-state="entry"]');
      if (!r) throw new Error('no editable row');
      return r as HTMLElement;
    });
    const col = () => row.querySelector('td[data-col="f:po_wo_no"]') as HTMLElement;
    const old = col().textContent;
    const u = userEvent.setup();
    await u.click(col());
    const input = within(await screen.findByTestId('grid-edit-po_wo_no')).getByRole('textbox');
    await u.clear(input);
    await u.type(input, 'WO-CTRLZ-1{Enter}');
    await waitFor(() => expect(col()).toHaveTextContent('WO-CTRLZ-1'));
    // inside a text field Ctrl+Z is the field's own: the undo does not run
    await u.click(col());
    const again = within(await screen.findByTestId('grid-edit-po_wo_no')).getByRole('textbox');
    again.focus();
    await u.keyboard('{Control>}z{/Control}');
    await u.keyboard('{Escape}');
    await waitFor(() => expect(col()).toHaveTextContent('WO-CTRLZ-1'));
    // outside text fields it runs the undo once
    (document.activeElement as HTMLElement | null)?.blur();
    await u.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(col().textContent).toBe(old));
    expect(await screen.findByText('Change undone.', { exact: false })).toBeInTheDocument();
  }, 20_000);
});
