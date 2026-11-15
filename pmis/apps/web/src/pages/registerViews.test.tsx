import { screen, within } from '@testing-library/react';
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

describe('Register Vertical and Grid views (F16)', () => {
  it('switches between the row list and the grid over the same records', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/registers/procurement' });
    expect(await screen.findByTestId(`reg-row-${recId(1)}`)).toBeInTheDocument();
    expect(screen.getByTestId('register-view-vertical')).toHaveAttribute('aria-pressed', 'true');

    const u = userEvent.setup();
    await u.click(screen.getByTestId('register-view-grid'));
    const grid = await screen.findByTestId('register-grid');
    expect(screen.getByTestId('register-view-grid')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId(`reg-row-${recId(1)}`)).toBeNull();
    expect(within(grid).getByTestId(`reg-grid-row-${recId(1)}`)).toHaveTextContent('TR101');

    await u.click(screen.getByTestId('register-view-vertical'));
    expect(await screen.findByTestId(`reg-row-${recId(1)}`)).toBeInTheDocument();
    expect(screen.queryByTestId('register-grid')).toBeNull();
  });

  it('opens the grid straight from the URL (view=grid) and keeps the filter count', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/registers/procurement?view=grid' });
    expect(await screen.findByTestId('register-grid')).toBeInTheDocument();
    expect(screen.getByTestId('register-count')).toBeInTheDocument();
  });
});
