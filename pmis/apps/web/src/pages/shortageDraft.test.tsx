import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { RegisterPage } from './Register';

/** A10: the Procurement form opened from a shortage line has the site, the request type and the remark filled; it is a new record, so nothing exists until it is submitted. */
describe('Procurement form from a shortage line', () => {
  it('opens a new record with the site, type PR and the remark filled', async () => {
    await signIn('pm');
    const q = new URLSearchParams({ record: 'new', from: 'shortage', site: 's-1', site_code: 'TR101', remark: 'Shortage of PWR-001 Rectifier: missing 4' });
    renderApp(<Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes>, { route: `/registers/procurement?${q.toString()}` });
    expect(await screen.findByTestId('reg-field-remark')).toHaveValue('Shortage of PWR-001 Rectifier: missing 4');
    expect(screen.getByTestId('register-drawer')).toHaveTextContent('TR101');
  }, 30_000);
});
