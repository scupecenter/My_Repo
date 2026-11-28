import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { CompanyPage } from './CompanyPage';

const view = (route: string) => renderApp(<Routes><Route path="/companies/:id" element={<CompanyPage />} /></Routes>, { route });
const ID = '5b0c1d4e-0000-4000-8000-000000000001';

describe('Company page', () => {
  it('shows the company, its tabs, and the link to the register record', async () => {
    await signIn('pm');
    view(`/companies/${ID}`);
    expect(await screen.findByText('Al-Nahda Contracting')).toBeInTheDocument();
    expect(screen.getByTestId('company-tab-overview')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('company-scopes')).toHaveTextContent('Tower RT, Tower GF, Fiber');
    await userEvent.click(screen.getByTestId('company-tab-record'));
    expect(screen.getByTestId('company-open-record')).toHaveAttribute('href', `/registers/contractors/records/${ID}`);
  });
  it('opens a tab from the link', async () => {
    await signIn('pm');
    view(`/companies/${ID}?tab=performance`);
    expect(await screen.findByTestId('company-performance')).toBeInTheDocument();
  });
  it('says so when the company does not exist', async () => {
    await signIn('pm');
    view('/companies/5b0c1d4e-0000-4000-8000-0000000000ff');
    expect(await screen.findByTestId('page-company-missing')).toBeInTheDocument();
  });
});
