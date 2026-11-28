import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { FinanceHubPage } from './FinanceHub';

const Routed = () => (<Routes><Route path="/finance-hub" element={<FinanceHubPage />} /></Routes>);
const full = {
  advances: { open_count: 3, overdue_count: 1, open_amount: 12500, currency: 'LYD' },
  invoices: { open_count: 4, by_state: { Received: 2, UnderReview: 1, Approved: 1, Disputed: 0 }, aging: { first: 2, second: 1, third: 1 }, overdue_count: 2 },
};
const useSummary = (body: object) => server.use(http.get(`${API_BASE}/finance-hub/summary`, () => HttpResponse.json(body)));

describe('Finance hub landing', () => {
  it('shows both cards, the links, the templates and the settings gear', async () => {
    await signIn('pm');
    useSummary(full);
    renderApp(<Routed />, { route: '/finance-hub' });
    expect(await screen.findByTestId('fh-card-advances')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('fh-adv-open')).toHaveTextContent('3'));
    expect(screen.getByTestId('fh-adv-amount')).toHaveTextContent('12,500');
    expect(screen.getByTestId('fh-inv-open')).toHaveTextContent('4');
    expect(screen.getByTestId('fh-inv-state-Received')).toHaveTextContent('2');
    expect(screen.getByTestId('fh-inv-age-second')).toHaveTextContent('1');
    expect(screen.getByTestId('fh-link-adv-open')).toHaveAttribute('href', '/registers/financial_advances?record_type=advance');
    expect(screen.getByTestId('fh-link-inv')).toHaveAttribute('href', '/registers/invoices');
    expect(screen.getByTestId('fh-tpl-adv')).toBeInTheDocument();
    expect(screen.getByTestId('fh-tpl-inv')).toBeInTheDocument();
    expect(screen.getByTestId('screen-settings-link')).toHaveAttribute('href', '/admin/settings/screens/finance-hub');
    expect(screen.getByTestId('screen-settings-link')).toHaveAttribute('aria-label');
  });

  it('hides the amount when the amounts rule shows the caller none, and keeps the counts', async () => {
    await signIn('pm');
    useSummary({ ...full, advances: { ...full.advances, open_amount: null } });
    renderApp(<Routed />, { route: '/finance-hub' });
    expect(await screen.findByTestId('fh-adv-amount-hidden')).toBeInTheDocument();
    expect(screen.queryByTestId('fh-adv-amount')).not.toBeInTheDocument();
    expect(screen.getByTestId('fh-adv-open')).toHaveTextContent('3');
  });

  it('advances-only caller: the invoices card and its links stay out', async () => {
    await signIn('pm');
    useSummary({ advances: full.advances, invoices: null });
    renderApp(<Routed />, { route: '/finance-hub' });
    expect(await screen.findByTestId('fh-card-advances')).toBeInTheDocument();
    expect(screen.queryByTestId('fh-card-invoices')).not.toBeInTheDocument();
    expect(screen.getByTestId('fh-link-adv')).toBeInTheDocument();
    expect(screen.queryByTestId('fh-link-inv')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fh-tpl-inv')).not.toBeInTheDocument();
  });

  it('invoices-only caller: the advances card stays out', async () => {
    await signIn('pm');
    useSummary({ advances: null, invoices: full.invoices });
    renderApp(<Routed />, { route: '/finance-hub' });
    expect(await screen.findByTestId('fh-card-invoices')).toBeInTheDocument();
    expect(screen.queryByTestId('fh-card-advances')).not.toBeInTheDocument();
    expect(screen.getByTestId('fh-link-inv')).toBeInTheDocument();
    expect(screen.queryByTestId('fh-link-adv')).not.toBeInTheDocument();
  });

  it('no finance register: the empty state says so', async () => {
    await signIn('pm');
    useSummary({ advances: null, invoices: null });
    renderApp(<Routed />, { route: '/finance-hub' });
    expect(await screen.findByTestId('page-finance-hub')).toBeInTheDocument();
    expect(screen.queryByTestId('fh-card-advances')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fh-card-links')).not.toBeInTheDocument();
  });
});
