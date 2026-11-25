import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { Warehouse } from '../Warehouse';
import { RegisterColumns } from './RegisterColumns';

/** P6: Settings > Columns > Warehouse items adds an extra column with a reason; the item form and table then carry it. */
describe('item master extra columns', () => {
  it('adds a column and shows its value on the item', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const { unmount } = renderApp(<Routes><Route path="/admin/settings/registers/columns" element={<RegisterColumns />} /></Routes>, { route: '/admin/settings/registers/columns?register=wh:items' });
    expect(await screen.findByTestId('item-columns')).toBeInTheDocument();
    await u.type(await screen.findByTestId('item-col-f-code'), 'colour_p6');
    await u.type(screen.getByTestId('item-col-f-en'), 'Colour');
    await u.click(screen.getByTestId('item-col-add-go'));
    await u.type(await screen.findByTestId('studio-reason-dialog-reason'), 'Need the colour');
    await u.click(within(screen.getByTestId('studio-reason-dialog')).getByRole('button', { name: /save|confirm|ok/i }));
    expect(await screen.findByTestId('item-col-colour_p6')).toBeInTheDocument();
    unmount();

    renderApp(<Routes><Route path="/warehouse" element={<Warehouse />} /></Routes>, { route: '/warehouse' });
    expect(await screen.findByTestId('wh-colh-colour_p6')).toHaveTextContent('Colour');
    await u.click(await screen.findByTestId('wh-edit-ANT-900'));
    await u.type(await screen.findByTestId('wh-f-cv-colour_p6'), 'Grey');
    await u.type(screen.getByTestId('wh-dialog-reason'), 'Colour');
    await u.click(within(screen.getByTestId('wh-dialog')).getByRole('button', { name: /save|confirm|ok/i }));
    await waitFor(() => expect(screen.getByTestId('wh-cv-ANT-900-colour_p6')).toHaveTextContent('Grey'));
  });
});
