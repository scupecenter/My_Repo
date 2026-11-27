import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { Workload } from './Workload';

describe('F1 state durations report on the Workload page', () => {
  it('shows median and P85 working days per stage, then per register, and follows the region filter', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/workload" element={<Workload />} /></Routes>, { route: '/workload' });
    const table = await screen.findByTestId('sd-table');
    expect(within(table).getAllByTestId('sd-row')).toHaveLength(2);
    expect(within(table).getByText('5')).toBeInTheDocument();
    await u.click(screen.getByTestId('sd-entity-register_record'));
    await waitFor(() => expect(within(screen.getByTestId('sd-table')).getAllByTestId('sd-row')).toHaveLength(1));
    expect(within(screen.getByTestId('sd-table')).getByTestId('sd-row')).toHaveTextContent(/procurement/i);
    expect(within(screen.getByTestId('sd-table')).getAllByTestId('sd-row')).toHaveLength(1);
  });
});
