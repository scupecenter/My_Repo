import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/i18n';

const resolveMock = vi.fn();
const createMock = vi.fn();
vi.mock('@/api/dashboardShares', () => ({
  useCreateShareLink: () => ({ mutate: createMock, isPending: false }),
  useResolveShareLink: (token: string) => resolveMock(token),
  useRevokeShareLink: () => ({ mutate: vi.fn(), isPending: false }),
  useShareLinks: () => ({ data: [], isLoading: false }),
}));
vi.mock('@/components/Toast', () => ({ useToast: () => vi.fn() }));
vi.mock('@/pages/Dashboard', () => ({ Dashboard: () => <div data-testid="dashboard-stub" /> }));

import { shareParamsOf, ShareDashboardButton, SharedDashboard } from './DashboardShare';

describe('shareParamsOf', () => {
  it('keeps only the dashboard query parameters, skipping empties', () => {
    const sp = new URLSearchParams('view=pmo&ref_date=2026-11-27&foo=bar&stream=&exclude_overrides=true');
    expect(shareParamsOf(sp)).toEqual({ view: 'pmo', ref_date: '2026-11-27', exclude_overrides: 'true' });
  });
});

describe('ShareDashboardButton', () => {
  beforeEach(() => { createMock.mockReset(); });

  it('asks for a reason before creating, then shows the link', async () => {
    createMock.mockImplementation((_b: unknown, opts: { onSuccess: (r: { path: string }) => void }) => opts.onSuccess({ path: '/dashboard/shared/abc' }));
    render(<ShareDashboardButton sp={new URLSearchParams('view=pmo')} />);
    fireEvent.click(screen.getByTestId('dash-share-link'));
    const create = screen.getByTestId('dashshare-create');
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByTestId('dashshare-reason'), { target: { value: 'weekly report' } });
    expect(create).not.toBeDisabled();
    fireEvent.click(create);
    await waitFor(() => expect(screen.getByTestId('dashshare-url')).toHaveValue('http://localhost:3000/dashboard/shared/abc'));
    const body = createMock.mock.calls[0][0] as { params: Record<string, string>; reason: string };
    expect(body.params).toEqual({ view: 'pmo' });
    expect(body.reason).toBe('weekly report');
  });
});

describe('SharedDashboard', () => {
  const route = (token: string) => (
    <MemoryRouter initialEntries={[`/dashboard/shared/${token}`]}>
      <Routes><Route path="/dashboard/shared/:token" element={<SharedDashboard />} /></Routes>
    </MemoryRouter>
  );
  beforeEach(() => { resolveMock.mockReset(); });

  it('seeds the shared query and renders the dashboard with a banner', async () => {
    resolveMock.mockReturnValue({ isLoading: false, isError: false, data: { label: 'Weekly', created_by: 'Sara', params: { view: 'pmo', region_id: '3' } } });
    render(route('tok123'));
    expect(screen.getByTestId('shared-banner')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-stub')).toBeInTheDocument();
  });

  it('a revoked or expired link (410) shows the gone card', () => {
    resolveMock.mockReturnValue({ isLoading: false, isError: true, error: { status: 410 } });
    render(route('tok123'));
    expect(screen.getByTestId('shared-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-stub')).not.toBeInTheDocument();
  });

  it('an unknown token (404) shows the missing card', () => {
    resolveMock.mockReturnValue({ isLoading: false, isError: true, error: { status: 404 } });
    render(route('tok123'));
    expect(screen.getByTestId('shared-unavailable')).toBeInTheDocument();
  });
});
