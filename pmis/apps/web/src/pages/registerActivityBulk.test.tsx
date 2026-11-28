import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { recId } from '@/mocks/registersData';
import { renderApp, signIn } from '@/test/utils';
import { RegisterPage } from './Register';

const Routed = () => (
  <Routes>
    <Route path="/registers/:key" element={<RegisterPage />} />
  </Routes>
);

describe('Register Activity tab and bulk actions', () => {
  it('the drawer has one Activity list with filters', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/registers/procurement' });
    const u = userEvent.setup();
    await u.click(await screen.findByTestId(`reg-select-${recId(1)}`));
    await u.click(await screen.findByTestId('register-bulk-open'));
    await u.click(await screen.findByRole('tab', { name: 'Activity' }));
    expect(await screen.findByTestId('reg-activity')).toBeInTheDocument();
    await u.click(screen.getByTestId('activity-filter-comment'));
    expect(screen.getByTestId('activity-filter-comment')).toHaveAttribute('aria-pressed', 'true');
  });

  it('bulk set a field reports what was done', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/registers/procurement' });
    const u = userEvent.setup();
    await screen.findByTestId(`reg-row-${recId(1)}`);
    await u.click(screen.getByTestId('register-select-all'));
    await u.click(screen.getByTestId('register-bulk-set'));
    const dlg = await screen.findByTestId('bulk-set-dialog');
    expect(screen.getByTestId('bulk-set-apply')).toBeDisabled();
    const sel = within(dlg).getByTestId('bulk-set-field');
    const opt = within(sel).getAllByRole('option').find((o) => (o as HTMLOptionElement).value !== '') as HTMLOptionElement;
    await u.selectOptions(sel, opt.value);
    expect(screen.getByTestId('bulk-set-value')).toBeInTheDocument();
    await u.click(screen.getByTestId('bulk-set-apply'));
    expect(await screen.findByText(/Done:/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('bulk-set-dialog')).toBeNull());
  });

  it('export selected makes a CSV of the picked rows', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/registers/procurement' });
    const u = userEvent.setup();
    await screen.findByTestId(`reg-row-${recId(1)}`);
    await u.click(screen.getByTestId('register-select-all'));
    await u.click(screen.getByTestId('register-bulk-export'));
    expect(await screen.findByText(/Exported \d+ rows/)).toBeInTheDocument();
  });
});
