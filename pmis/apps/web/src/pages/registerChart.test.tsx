import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { RegisterDefinition } from '@/api/types';
import { layoutsOf } from '@/components/RegisterViews';
import { renderApp, signIn } from '@/test/utils';
import { RegisterPage } from './Register';

vi.mock('@/components/EChart', () => ({ EChart: ({ label, testid }: { label: string; testid?: string }) => <div role="img" aria-label={label} data-testid={testid} /> }));

/**
 * Decision V4: the register chart. The Procurement register draws its loaded rows by the approval state or any list or yes/no field, counted or
 * summed by a number field, as bars or a ring. The axis, the measure and the drawing are chosen in the Layout panel and kept in the URL and the
 * saved views. Synthetic mock data only.
 */
const Where = () => { const l = useLocation(); return <output data-testid="where">{l.search}</output>; };
const App = () => <><Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes><Where /></>;
const where = () => screen.getByTestId('where').textContent ?? '';
const T = 20_000;

describe('V4 register chart', () => {
  it('Procurement: Chart in the Layout panel, the axis, the measure and the drawing chosen in the panel and kept in the URL', async () => {
    const u = userEvent.setup();
    await signIn('pm');
    renderApp(<App />, { route: '/registers/procurement' });
    await screen.findByTestId('register-list-card');
    await u.click(screen.getByTestId('register-view'));
    await u.click(await screen.findByTestId('register-layout-chart'));
    expect(where()).toContain('layout=chart');
    await screen.findByTestId('register-chart-card');
    // the default axis is the approval state, the default measure a count, the default drawing bars
    expect((await screen.findAllByTestId(/register-chart-slice-/)).length).toBeGreaterThan(0);
    // the three selects live in the Layout panel options
    await u.click(screen.getByTestId('register-view'));
    const axis = await screen.findByTestId('register-chart-axis');
    expect(axis).toHaveValue('');
    await u.selectOptions(axis, 'scope');
    expect(where()).toContain('chx=scope');
    expect(where()).toContain('layout=chart');
    // Procurement has no plain number field (its Received is a percentage): the measure stays a count here
    const measure = await screen.findByTestId('register-chart-measure');
    expect(measure).toHaveValue('');
    expect(within(measure).getAllByRole('option')).toHaveLength(1);
    await u.selectOptions(await screen.findByTestId('register-chart-kind'), 'pie');
    expect(where()).toContain('chk=pie');
    // the slices follow the chosen axis (the Procurement scopes)
    expect((await screen.findAllByTestId(/register-chart-slice-/)).length).toBeGreaterThan(0);
  }, T);

  it('Financial Advances: the sum of a number field as the measure', async () => {
    const u = userEvent.setup();
    await signIn('pm');
    renderApp(<App />, { route: '/registers/financial_advances' });
    await screen.findByTestId('register-list-card');
    await u.click(screen.getByTestId('register-view'));
    await u.click(await screen.findByTestId('register-layout-chart'));
    expect(where()).toContain('layout=chart');
    await u.click(screen.getByTestId('register-view'));
    await u.selectOptions(await screen.findByTestId('register-chart-measure'), 'requested_amount');
    expect(where()).toContain('chm=requested_amount');
    expect(where()).toContain('layout=chart');
    // the chart card redraws on the new measure (empty or not, it never drops the rows silently)
    expect(await screen.findByTestId('register-chart-card')).toBeInTheDocument();
  }, T);

  it('layoutsOf: the chart on every register, the map still only where the records carry a site', () => {
    const base = { register_key: 'x', name_en: 'X', name_ar: 'X', module_key: 'x', site_scoped: false, fields: [] } as unknown as RegisterDefinition;
    expect(layoutsOf(base)).toEqual(['list', 'wide', 'board', 'gallery', 'feed', 'chart']);
    expect(layoutsOf({ ...base, site_scoped: true })).toEqual(['list', 'wide', 'board', 'gallery', 'feed', 'map', 'chart']);
  });
});
