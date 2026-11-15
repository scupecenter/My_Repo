import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api } from '@/api/client';
import { recId } from '@/mocks/registersData';
import { renderApp, signIn } from '@/test/utils';
import { RegisterPage } from './Register';

const Routed = () => (
  <Routes>
    <Route path="/registers/:key" element={<RegisterPage />} />
  </Routes>
);

describe('Register locks (F16, contract 0.15.22)', () => {
  it('bulk lock asks for a reason and marks the picked rows locked', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    renderApp(<Routed />, { route: '/registers/procurement' });
    const row = await screen.findByTestId(`reg-row-${recId(1)}`);
    expect(row).not.toHaveAttribute('data-locked');
    const u = userEvent.setup();
    await u.click(screen.getByTestId('register-select-all'));
    await u.click(screen.getByTestId('register-bulk-lock'));
    await u.type(await screen.findByTestId('reject-note'), 'Agreed with the client');
    await u.click(screen.getByTestId('reject-submit'));
    await waitFor(() => expect(screen.getByTestId(`reg-row-${recId(1)}`)).toHaveAttribute('data-locked', 'true'));
    expect(await screen.findByText(/Done:/)).toBeInTheDocument();
  });

  it('a column lock needs a reason before it is sent', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    renderApp(<Routed />, { route: '/registers/procurement' });
    const sel = await screen.findByTestId('register-column-lock-select');
    const u = userEvent.setup();
    const choice = within(sel).getAllByRole('option').find((o) => (o as HTMLOptionElement).value !== '') as HTMLOptionElement;
    await u.selectOptions(sel, choice.value);
    await u.click(screen.getByTestId('register-column-lock'));
    await u.click(await screen.findByTestId('reject-submit'));
    expect(await screen.findByTestId('reject-error')).toBeInTheDocument();
    await u.type(screen.getByTestId('reject-note'), 'Frozen after approval');
    await u.click(screen.getByTestId('reject-submit'));
    expect(await screen.findByText('Column locked.')).toBeInTheDocument();
  });
});
