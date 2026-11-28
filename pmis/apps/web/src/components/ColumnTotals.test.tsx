import '@/i18n';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RegisterRecord } from '@/api/types';
import { computeTotal, fmtTotal } from '@/lib/columnTotals';
import { setExtra } from '@/lib/uiExtras';
import { RegisterGrid } from './RegisterGrid';

/** Item 1: a totals row at the foot of a register grid. */
const rec = (id: string, n: unknown) => ({ id, state: 'draft', data: { qty: n } }) as unknown as RegisterRecord;
const rows = [rec('a', 10), rec('b', 5), rec('c', null), rec('d', '2.5')];
const totals = { storeKey: 't', numeric: (c: string) => c === 'qty', value: (_c: string, r: RegisterRecord) => { const v = (r.data as { qty: unknown }).qty; return v === null ? null : Number(v); } };
const grid = <RegisterGrid columns={[{ id: 'name', label: 'Name' }, { id: 'qty', label: 'Qty' }]} rows={rows} cell={(c, r) => (c === 'qty' ? String((r.data as { qty: unknown }).qty) : r.id)} onOpen={() => undefined} totals={totals} />;
beforeEach(() => localStorage.clear());
afterEach(() => { act(() => setExtra('totals_row', true)); });

describe('computeTotal', () => {
  it('sum, average, count, min and max skip the empty cells', () => {
    const v = [10, 5, null, 2.5, undefined];
    expect(computeTotal(v, 'sum')).toBe(17.5);
    expect(computeTotal(v, 'avg')).toBeCloseTo(5.8333, 3);
    expect(computeTotal(v, 'count')).toBe(3);
    expect(computeTotal(v, 'min')).toBe(2.5);
    expect(computeTotal(v, 'max')).toBe(10);
  });
  it('has no figure when nothing is filled, except a sum of 0 and a count of 0', () => {
    expect(computeTotal([null], 'sum')).toBe(0);
    expect(computeTotal([null], 'count')).toBe(0);
    expect(computeTotal([null], 'avg')).toBeNull();
    expect(computeTotal([], 'max')).toBeNull();
    expect(fmtTotal(null, 'en')).toBe('–');
    expect(fmtTotal(1234.567, 'en')).toBe('1,234.57');
  });
});

describe('totals row in the grid', () => {
  it('shows the sum under the numeric column only, lets the person pick the function and remembers it', async () => {
    const u = userEvent.setup();
    const { unmount } = render(grid);
    expect(screen.getByTestId('totals-value-qty')).toHaveTextContent('17.5');
    expect(screen.queryByTestId('totals-cell-name')).toBeNull();
    await u.selectOptions(screen.getByTestId('totals-fn-qty'), 'max');
    expect(screen.getByTestId('totals-value-qty')).toHaveTextContent('10');
    unmount();
    render(grid);
    expect(screen.getByTestId('totals-fn-qty')).toHaveValue('max');
  });
  it('is absent without a numeric column, without the prop, and when switched off', () => {
    const { rerender } = render(<RegisterGrid columns={[{ id: 'name', label: 'Name' }]} rows={rows} cell={() => 'x'} onOpen={() => undefined} totals={totals} />);
    expect(screen.queryByTestId('register-grid-totals')).toBeNull();
    rerender(<RegisterGrid columns={[{ id: 'qty', label: 'Qty' }]} rows={rows} cell={() => 'x'} onOpen={() => undefined} />);
    expect(screen.queryByTestId('register-grid-totals')).toBeNull();
    rerender(grid);
    expect(screen.getByTestId('register-grid-totals')).toBeInTheDocument();
    act(() => setExtra('totals_row', false));
    expect(screen.queryByTestId('register-grid-totals')).toBeNull();
  });
});
