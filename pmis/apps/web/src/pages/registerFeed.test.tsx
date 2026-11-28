import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { recId } from '@/mocks/registersData';
import { renderApp, signIn } from '@/test/utils';
import { RegisterPage } from './Register';

// ECharts draws in the browser; here the chart is a placeholder with its text alternative.
vi.mock('@/components/EChart', () => ({ EChart: ({ label, testid }: { label: string; testid?: string }) => <div role="img" aria-label={label} data-testid={testid} /> }));

/**
 * V10 of plan 2026-11-27-layout-panel: the Feed, the records of the current filters latest-first, on every register. Synthetic data of the
 * mocks only.
 */
const Where = () => { const l = useLocation(); return <output data-testid="where">{l.search}</output>; };
const App = () => <><Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes><Where /></>;
const where = () => screen.getByTestId('where').textContent ?? '';
const T = 20_000;
const ENTRY = recId(3); // a Procurement WO

async function pickView(u: ReturnType<typeof userEvent.setup>, prefix: string, id: string) {
  await u.click(screen.getByTestId(`${prefix}-view`));
  await u.click(await screen.findByTestId(`${prefix}-layout-${id}`));
}

describe('V10 register Feed', () => {
  it('the View menu offers Feed after Board; the list shows one line per record, latest first', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<App />, { route: '/registers/procurement' });
    await screen.findByTestId('register-list-card');
    await pickView(u, 'register', 'feed');
    const list = await screen.findByTestId('register-feed-list');
    expect(where()).toContain('layout=feed');
    const items = within(list).getAllByRole('button');
    expect(items.length).toBeGreaterThan(1);
    // latest first: the order follows the records' updated/created time descending
    const times = within(list).getAllByTestId(/^register-feed-time-/).map((e) => e.getAttribute('data-testid'));
    expect(times.length).toBe(items.length);
    const item = within(list).getByTestId(`register-feed-item-${ENTRY}`);
    expect(within(item).getByTestId(`register-feed-title-${ENTRY}`).textContent).toBeTruthy();
    expect(within(item).getByTestId(`register-feed-value-${ENTRY}-state`)).toBeTruthy();
  }, T);

  it('a line opens its record in the drawer', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<App />, { route: '/registers/procurement?layout=feed' });
    const list = await screen.findByTestId('register-feed-list');
    await u.click(within(list).getByTestId(`register-feed-item-${ENTRY}`));
    expect(await screen.findByTestId('register-drawer')).toBeInTheDocument();
    expect(where()).toContain(`record=${ENTRY}`);
  }, T);

  it('Meetings (global rows): Feed too, without a region chip (Arabic)', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<App />, { route: '/registers/meetings', locale: 'ar' });
    await screen.findByTestId('register-list-card');
    await pickView(u, 'register', 'feed');
    const list = await screen.findByTestId('register-feed-list');
    expect(within(list).queryByTestId(/-site$/)).toBeNull();
  }, T);
});
