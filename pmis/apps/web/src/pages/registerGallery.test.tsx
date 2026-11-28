import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { recId } from '@/mocks/registersData';
import { renderApp, signIn } from '@/test/utils';
import { RegisterPage } from './Register';

// ECharts draws in the browser; here the chart is a placeholder with its text alternative.
vi.mock('@/components/EChart', () => ({ EChart: ({ label, testid }: { label: string; testid?: string }) => <div role="img" aria-label={label} data-testid={testid} /> }));

/**
 * V9 of plan 2026-11-27-layout-panel: the Gallery, a card grid on every register, on the Procurement register (records with a site) and on
 * Meetings (global rows). Synthetic data of the mocks only.
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

describe('V9 register Gallery', () => {
  it('the View menu offers Gallery after Board; the grid shows one card per record with a title, chips and up to 3 fields', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<App />, { route: '/registers/procurement' });
    await screen.findByTestId('register-list-card');
    await pickView(u, 'register', 'gallery');
    const grid = await screen.findByTestId('register-gallery-grid');
    expect(where()).toContain('layout=gallery');
    const cards = within(grid).getAllByRole('button');
    expect(cards.length).toBeGreaterThan(1);
    const card = within(grid).getByTestId(`register-gallery-card-${ENTRY}`);
    expect(within(card).getByTestId(`register-gallery-title-${ENTRY}`).textContent).toBeTruthy();
    expect(within(card).getAllByTestId(new RegExp(`^register-gallery-field-${ENTRY}-`)).length).toBeLessThanOrEqual(3);
    expect(within(card).getByTestId(`register-gallery-value-${ENTRY}-state`)).toBeTruthy();
    expect(within(card).getByTestId(`register-gallery-value-${ENTRY}-site`)).toBeTruthy();
  }, T);

  it('a card opens its record in the drawer; the choice survives a reload of the URL', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<App />, { route: '/registers/procurement?layout=gallery' });
    const grid = await screen.findByTestId('register-gallery-grid');
    await u.click(within(grid).getByTestId(`register-gallery-card-${ENTRY}`));
    expect(await screen.findByTestId('register-drawer')).toBeInTheDocument();
    expect(where()).toContain(`record=${ENTRY}`);
  }, T);

  it('Meetings (global rows): Gallery too, without a site chip (Arabic)', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<App />, { route: '/registers/meetings', locale: 'ar' });
    await screen.findByTestId('register-list-card');
    await pickView(u, 'register', 'gallery');
    const grid = await screen.findByTestId('register-gallery-grid');
    expect(within(grid).queryByTestId(/-site$/)).toBeNull();
  }, T);
});
