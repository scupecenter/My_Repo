import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@/i18n';
import { CompanyStatusWarning } from './CompanyStatusWarning';

let data: unknown = { status: 'Blacklisted', reason: 'Fake invoices', date: '2026-11-01', history: [] };
vi.mock('@/api/registers', () => ({ useCompanyStatus: () => ({ data }) }));

describe('company status warning (K2b)', () => {
  it('warns with the reason and date for a blacklisted company', () => {
    render(<CompanyStatusWarning partyId="p1" />);
    const w = screen.getByTestId('company-status-warning');
    expect(w).toHaveTextContent('blacklisted');
    expect(w).toHaveTextContent('Fake invoices');
    expect(w).toHaveTextContent('2026-11-01');
  });
  it('shows nothing for an active company', () => {
    data = { status: 'Active', reason: null, date: null, history: [] };
    render(<CompanyStatusWarning partyId="p1" />);
    expect(screen.queryByTestId('company-status-warning')).toBeNull();
  });
});
