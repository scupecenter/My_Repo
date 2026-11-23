import { screen } from '@testing-library/react';
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

describe('Register views (F16, toggle removed 2026-11-22)', () => {
  it('shows the row list by default and renders no view toggle', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/registers/procurement' });
    expect(await screen.findByTestId(`reg-row-${recId(1)}`)).toBeInTheDocument();
    expect(screen.queryByTestId('register-view')).toBeNull();
    expect(screen.queryByTestId('register-view-vertical')).toBeNull();
    expect(screen.queryByTestId('register-view-grid')).toBeNull();
    expect(screen.queryByTestId('register-grid')).toBeNull();
  });

  it('opens the grid straight from the URL (view=grid) and keeps the filter count', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/registers/procurement?view=grid' });
    expect(await screen.findByTestId('register-grid')).toBeInTheDocument();
    expect(screen.getByTestId('register-count')).toBeInTheDocument();
    expect(screen.queryByTestId('register-view')).toBeNull();
    expect(screen.queryByTestId(`reg-row-${recId(1)}`)).toBeNull();
  });
});
