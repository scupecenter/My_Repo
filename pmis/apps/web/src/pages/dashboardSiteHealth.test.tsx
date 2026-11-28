import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { Dashboard } from './Dashboard';
import { weightsInvalid } from './settings/SiteHealthWeights';
import { SettingsRoutes } from './settings/Settings';

vi.mock('@/components/EChart', () => ({ EChart: ({ label, testid }: { label: string; testid?: string }) => <div role="img" aria-label={label} data-testid={testid} /> }));

describe('Dashboard: site health card (0.15.591)', () => {
  it('lists the sites worst first with colour counts, filters by colour and shows the factors of a site', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/dashboard" element={<Dashboard />} /></Routes>, { route: '/dashboard' });
    const card = await screen.findByTestId('dash-site-health', {}, { timeout: 8000 });
    expect(card).toHaveTextContent('Site health');
    expect(await screen.findByTestId('dash-site-health-row-0')).toHaveTextContent('TRP-014');
    expect(screen.getByTestId('dash-site-health-row-0').querySelector('[data-band="red"]')).not.toBeNull();
    expect(screen.getByTestId('dash-site-health-count-green')).toHaveTextContent('2');
    expect(screen.getByTestId('dash-site-health-unscored')).toHaveTextContent('1 not scored');
    await u.click(screen.getByTestId('dash-site-health-count-amber'));
    await waitFor(() => expect(screen.getByTestId('dash-site-health-total')).toHaveTextContent('Showing 1 of 1'));
    await u.click(screen.getByTestId('dash-site-health-count-amber'));
    await u.click(await screen.findByTestId('dash-site-health-row-1'));
    expect(await screen.findByTestId('dash-site-health-detail')).toHaveTextContent('BNG-007');
    expect(screen.getByTestId('dash-site-health-factor-tasks')).toHaveTextContent('weight 40');
  }, 30_000);
});

describe('Settings > Dashboard: site health weights (0.15.591)', () => {
  it('the rule: whole numbers 0 to 100 and one above 0', () => {
    expect(weightsInvalid({ tasks: 40, docs: 20, snags: 25, delay: 15 })).toBe(false);
    expect(weightsInvalid({ tasks: 0, docs: 0, snags: 0, delay: 0 })).toBe(true);
    expect(weightsInvalid({ tasks: 101, docs: 0, snags: 0, delay: 0 })).toBe(true);
    expect(weightsInvalid({ tasks: 1.5, docs: 0, snags: 0, delay: 0 })).toBe(true);
    expect(weightsInvalid({ tasks: NaN, docs: 0, snags: 0, delay: 0 })).toBe(true);
  });

  it('saves new weights with a reason and moves the version', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/dashboard' });
    const tasks = await screen.findByTestId('site-health-weights-tasks');
    expect(tasks).toHaveValue(40);
    expect(screen.getByTestId('site-health-weights-save')).toBeDisabled();
    await u.clear(tasks);
    await u.type(tasks, '50');
    await u.click(screen.getByTestId('site-health-weights-save'));
    await u.type(await screen.findByTestId('site-health-weights-dialog-reason'), 'Owner weighs tasks higher');
    await u.click(screen.getByTestId('site-health-weights-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('site-health-weights-version')).toHaveTextContent('1'));
  }, 30_000);
});
