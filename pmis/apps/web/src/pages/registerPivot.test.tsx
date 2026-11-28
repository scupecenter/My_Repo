import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { layoutsOf, pivotAxes, pivotDrillTree } from '@/components/RegisterViews';
import type { RegisterDefinition } from '@/api/types';
import { renderApp, signIn } from '@/test/utils';
import { RegisterPage } from './Register';

/** Pivot table of a register: two fields, a count or a sum, a cell lists its rows. Synthetic mock data only. */
const Where = () => { const l = useLocation(); return <output data-testid="where">{l.search}</output>; };
const App = () => <><Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes><Where /></>;
const where = () => screen.getByTestId('where').textContent ?? '';
const T = 20_000;

describe('register pivot table', () => {
  it('is a layout of every register and offers the state, the region and the list fields as axes', () => {
    const def = { site_scoped: true, fields: [{ code: 'scope', type: 'list' }, { code: 'qty', type: 'number' }, { code: 'note', type: 'text' }] } as unknown as RegisterDefinition;
    expect(layoutsOf(def)).toContain('pivot');
    expect(pivotAxes(def)).toEqual(['state', 'region', 'scope']);
    expect(pivotAxes({ ...def, site_scoped: false } as RegisterDefinition)).toEqual(['state', 'scope']);
  });

  it('a clicked cell becomes conditions of the filter tree, keeping other conditions on other fields', () => {
    const t = pivotDrillTree([{ field: 'state', value: 'entry' }, { field: 'f:scope', value: 'a' }], { op: 'and', items: [{ field: 'f:scope', operator: 'is', value: 'b' }, { field: 'region_id', operator: 'is', value: 1 }] });
    expect(t.items).toEqual([{ field: 'region_id', operator: 'is', value: 1 }, { field: 'state', operator: 'is', value: 'entry' }, { field: 'f:scope', operator: 'is', value: 'a' }]);
    expect(pivotDrillTree([{ field: 'state', value: 'entry' }], { op: 'or', items: [{ field: 'region_id', operator: 'is', value: 1 }] }).items).toHaveLength(1);
  });

  it('Procurement: Pivot in the Layout panel, rows and columns chosen there and kept in the URL, a cell lists its rows', async () => {
    const u = userEvent.setup();
    await signIn('pm');
    renderApp(<App />, { route: '/registers/procurement' });
    await screen.findByTestId('register-list-card');
    await u.click(screen.getByTestId('register-view'));
    await u.click(await screen.findByTestId('register-layout-pivot'));
    expect(where()).toContain('layout=pivot');
    const table = await screen.findByTestId('register-pivot');
    expect(Number(table.getAttribute('data-total'))).toBeGreaterThan(0);
    expect(screen.getByTestId('register-pivot-grand')).toBeInTheDocument();
    await u.click(screen.getByTestId('register-view'));
    await u.selectOptions(await screen.findByTestId('register-pivot-cols'), 'none');
    expect(where()).toContain('pvc=none');
    expect(screen.queryAllByTestId(/register-pivot-coltotal-/)).toHaveLength(0);
    await u.selectOptions(screen.getByTestId('register-pivot-cols'), 'scope');
    expect(where()).toContain('pvc=scope');
    const cell = (await screen.findAllByTestId(/^register-pivot-cell-/)).find((c) => c.tagName === 'BUTTON' && !(c as HTMLButtonElement).disabled);
    expect(cell).toBeTruthy();
    await u.keyboard('{Escape}');
    await u.click(cell!);
    expect(where()).toContain('adv=');
    expect(where()).not.toContain('layout=pivot');
    await screen.findByTestId('register-list-card');
  }, T);
});
