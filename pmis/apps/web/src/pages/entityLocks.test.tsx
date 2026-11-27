import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { Warehouse } from './Warehouse';

const show = () => renderApp(<Routes><Route path="/warehouse" element={<Warehouse />} /></Routes>, { route: '/warehouse' });

describe('Warehouse locks (0565)', () => {
  it('locks an item with a reason, shows the badge, and unlocks it again', async () => {
    await signIn('pm');
    show();
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('wh-lock-ANT-900'));
    await u.type(screen.getByTestId('wh-lock-ANT-900-dialog-reason'), 'Frozen for audit');
    await u.click(screen.getByTestId('wh-lock-ANT-900-dialog-submit'));
    expect(await screen.findByTestId('wh-lock-ANT-900-badge')).toBeInTheDocument();
    await u.click(screen.getByTestId('wh-lock-ANT-900'));
    await u.type(screen.getByTestId('wh-lock-ANT-900-dialog-reason'), 'Audit finished');
    await u.click(screen.getByTestId('wh-lock-ANT-900-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('wh-lock-ANT-900-badge')).not.toBeInTheDocument());
  }, 15_000);

  it('locks a column for every item and lists it', async () => {
    await signIn('pm');
    show();
    const u = userEvent.setup();
    await u.selectOptions(await screen.findByTestId('wh-column-locks-select'), 'uom');
    await u.click(screen.getByTestId('wh-column-locks-lock'));
    await u.type(screen.getByTestId('wh-column-locks-dialog-reason'), 'Units are fixed');
    await u.click(screen.getByTestId('wh-column-locks-dialog-submit'));
    expect(await screen.findByTestId('wh-column-locks-open-uom')).toBeInTheDocument();
  }, 15_000);

  it('gives a non-admin no lock controls', async () => {
    await signIn('reviewer');
    show();
    await screen.findByTestId('wh-item-ANT-900');
    expect(screen.queryByTestId('wh-lock-ANT-900')).not.toBeInTheDocument();
    expect(screen.queryByTestId('wh-column-locks')).not.toBeInTheDocument();
  });
});
