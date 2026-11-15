import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { RegisterPage } from './Register';

const Routed = () => (
  <Routes>
    <Route path="/registers/:key" element={<RegisterPage />} />
  </Routes>
);

describe('As-Built and Dismantle tabs (F16)', () => {
  it('As-Built opens on CW BOQ and switches to TE BOQ', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/registers/as_built' });
    const cw = await screen.findByTestId('register-tab-cw_part');
    expect(cw).toHaveAttribute('aria-pressed', 'true');
    const u = userEvent.setup();
    await u.click(screen.getByTestId('register-tab-te_part'));
    expect(screen.getByTestId('register-tab-te_part')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('register-tab-cw_part')).toHaveAttribute('aria-pressed', 'false');
  });

  it('Dismantle splits CW and TE by part', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/registers/dismantle' });
    expect(await screen.findByTestId('register-tab-cw')).toHaveAttribute('aria-pressed', 'true');
    const u = userEvent.setup();
    await u.click(screen.getByTestId('register-tab-te'));
    await waitFor(() => expect(screen.getByTestId('register-tab-te')).toHaveAttribute('aria-pressed', 'true'));
  });
});

describe('Inline cell edit in the grid (F16)', () => {
  it('edits an open text cell and saves it through the record update', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/registers/procurement?view=grid' });
    const grid = await screen.findByTestId('register-grid');
    const row = await waitFor(() => {
      const r = grid.querySelector('tr[data-state="entry"]');
      if (!r) throw new Error('no editable row');
      return r as HTMLElement;
    });
    const cell = row.querySelector('td[data-col="f:po_wo_no"]') as HTMLElement;
    expect(cell).toHaveAttribute('data-editable', 'true');
    const u = userEvent.setup();
    await u.click(cell);
    const editor = await screen.findByTestId('grid-edit-po_wo_no');
    const input = within(editor).getByRole('textbox');
    await u.clear(input);
    await u.type(input, 'WO-EDIT-9{Enter}');
    await waitFor(() => expect(row.querySelector('td[data-col="f:po_wo_no"]')).toHaveTextContent('WO-EDIT-9'));
    expect(screen.queryByTestId('grid-edit-po_wo_no')).toBeNull();
  });

  it('does not open the editor for a record that is not in entry (no edit action)', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/registers/procurement?view=grid' });
    const grid = await screen.findByTestId('register-grid');
    const row = await waitFor(() => {
      const r = grid.querySelector('tr[data-state="approved"]');
      if (!r) throw new Error('no approved row');
      return r as HTMLElement;
    });
    expect(row.querySelector('td[data-col="f:po_wo_no"]')).not.toHaveAttribute('data-editable');
  });
});
