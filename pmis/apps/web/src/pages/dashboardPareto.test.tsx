import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { Dashboard } from './Dashboard';
import { pareto, paretoOption, PARETO_MARKER, trendOption } from './dashboardPareto';

const built: Record<string, (p: never, rtl: boolean) => unknown> = {};
vi.mock('@/components/EChart', () => ({
  EChart: ({ label, testid, build }: { label: string; testid?: string; build: (p: never, rtl: boolean) => unknown }) => {
    if (testid) built[testid] = build;
    return <div role="img" aria-label={label} data-testid={testid} />;
  },
}));

const P = { ink: '#111', mute: '#777', line: '#ddd', card: '#fff', done: '#0a0', open: '#00f', wait: '#fa0', late: '#f00', lock: '#999', accent: '#0aa', pipe: '#eee' };
const row = (label: string, count: number, sites = 1) => ({ label_en: label, label_ar: null, count, sites });

describe('Pareto helper (0.15.592)', () => {
  it('sorts biggest first and accumulates over all rows, not only the shown ones', () => {
    const p = pareto([row('b', 3), row('a', 7), row('d', 1), row('c', 5), row('e', 4)], 3);
    expect(p.total).toBe(20);
    expect(p.rows.map((r) => r.row.label_en)).toEqual(['a', 'c', 'e']);
    expect(p.rows.map((r) => r.cum)).toEqual([35, 60, 80]);
    expect(p.vital).toBe(3); // 7+5+4 = 16 of 20 = 80 %, the marker is reached
  });
  it('handles an empty list and ties', () => {
    expect(pareto([])).toEqual({ rows: [], total: 0, vital: 0 });
    expect(pareto([row('x', 0)]).rows[0]!.cum).toBe(0);
    expect(pareto([row('x', 2), row('y', 2)]).rows.map((r) => r.row.label_en)).toEqual(['x', 'y']);
    expect(pareto([row('only', 5)]).vital).toBe(1);
  });
  it('builds a bar series, a cumulative line on a 0 to 100 axis and the 80 % marker', () => {
    const o = paretoOption(P, false, 'x', pareto([row('a', 8), row('b', 2)]), (r) => r.label_en ?? '', { cum: 'Cum', count: 'Issues', marker: '80%' }, false) as {
      xAxis: { max?: number }[]; series: { type: string; data: number[]; markLine?: { data: { xAxis: number }[] } }[];
    };
    expect(o.xAxis[1]!.max).toBe(100);
    expect(o.series[0]!.data).toEqual([8, 2]);
    expect(o.series[1]!.type).toBe('line');
    expect(o.series[1]!.data).toEqual([80, 100]);
    expect(o.series[1]!.markLine!.data[0]!.xAxis).toBe(PARETO_MARKER);
  });
  it('builds the weekly trend with opened, closed and open at week end', () => {
    const o = trendOption(P, false, 'x', [{ week_start: '2026-11-02', opened: 3, closed: 1, open_end: 9 }], { opened: 'O', closed: 'C', open: 'E' }) as { series: { name: string; data: number[] }[] };
    expect(o.series.map((s) => [s.name, s.data[0]])).toEqual([['O', 3], ['C', 1], ['E', 9]]);
  });
});

describe('Dashboard Issues card: Pareto and weekly trend (0.15.592)', () => {
  it('shows the vital few under the category bars and the weekly trend on its own tab', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/dashboard" element={<Dashboard />} /></Routes>, { route: '/dashboard' });
    await u.click(await screen.findByTestId('dash-issues-by-category', {}, { timeout: 8000 }));
    expect(await screen.findByTestId('dash-issues-pareto-category')).toHaveTextContent('The first 3 of 4 account for at least 80% of the open issues.');
    const opt = built['dash-issues-cat-chart']!(P as never, false) as { series: { type: string; data: number[] }[] };
    expect(opt.series[1]!.type).toBe('line');
    expect(opt.series[1]!.data.at(-1)).toBe(100);
    await u.click(screen.getByTestId('dash-issues-by-reason'));
    expect(screen.getByTestId('dash-issues-pareto-reason')).toHaveTextContent('The first 3 of 3');
    await u.click(screen.getByTestId('dash-issues-by-trend'));
    await waitFor(() => expect(screen.getByTestId('dash-issues-trend-chart')).toBeInTheDocument());
    const t = built['dash-issues-trend-chart']!(P as never, false) as { series: { data: number[] }[] };
    expect(t.series[0]!.data).toHaveLength(12);
  }, 30_000);
});
