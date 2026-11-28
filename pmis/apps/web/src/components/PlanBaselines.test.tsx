import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/i18n';
import { PlanBaselines } from './PlanBaselines';

const create = vi.fn();
const hide = vi.fn();
let list: unknown;
let report: unknown;
vi.mock('@/api/sites', () => ({ useRegions: () => ({ data: [{ id: 1, name_en: 'West', name_ar: null }] }) }));
vi.mock('@/api/x', () => ({
  usePlanFreezes: () => ({ isLoading: false, isError: false, data: list, refetch: vi.fn() }),
  usePlanFreezeReport: (id: string) => ({ isLoading: false, isError: false, data: id ? report : undefined, refetch: vi.fn() }),
  useCreatePlanFreeze: () => ({ mutate: create, isPending: false, isError: false, error: null }),
  useHidePlanFreeze: () => ({ mutate: hide, isPending: false, isError: false, error: null }),
}));

const rep = {
  freeze: { id: 'f1', label: 'Baseline 1', frozen_at: '2026-11-01T00:00:00Z' }, as_of: '2026-11-28',
  totals: { rows: 4, done: 3, done_late: 1, open_overdue: 1, avg_days: 2.5 },
  stages: [{ code: 'MS1', name_en: 'Acquired', rows: 2, done: 2, done_late: 1, open_overdue: 0, avg_days: -1.5, worst_days: 5 }],
  regions: [{ region_id: 1, rows: 4, done: 3, done_late: 1, open_overdue: 1, avg_days: 2.5 }],
  worst: [{ site_id: 's1', site_code: 'TRP-1', region_id: 1, code: 'MS1', base: '2026-10-01', actual: null, days: 58, open: true }],
};

describe('PlanBaselines (0.15.480)', () => {
  beforeEach(() => { create.mockReset(); hide.mockReset(); });
  it('a System Admin freezes with a name; the report shows stages, regions and the worst rows', () => {
    list = { items: [{ id: 'f1', label: 'Baseline 1', note: null, site_count: 2, row_count: 4, frozen_at: '2026-11-01T00:00:00Z' }], can_freeze: true };
    report = rep;
    render(<PlanBaselines region="" />);
    expect(screen.getByTestId('planfreeze-stage-MS1').textContent).toContain('Acquired');
    expect(screen.getByTestId('planfreeze-stage-MS1').textContent).toContain('-1.5');
    expect(screen.getByTestId('planfreeze-regions').textContent).toContain('West');
    expect(screen.getByTestId('planfreeze-worst').textContent).toContain('TRP-1');
    expect((screen.getByTestId('planfreeze-create') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('planfreeze-label'), { target: { value: ' Q1 plan ' } });
    fireEvent.click(screen.getByTestId('planfreeze-create'));
    expect(create.mock.calls[0]?.[0]).toEqual({ label: 'Q1 plan' });
    fireEvent.click(screen.getByTestId('planfreeze-hide'));
    expect(hide.mock.calls[0]?.[0]).toBe('f1');
  });
  it('a reader sees the report but no freeze or hide controls', () => {
    list = { items: [{ id: 'f1', label: 'Baseline 1', note: null, site_count: 2, row_count: 4, frozen_at: '2026-11-01T00:00:00Z' }], can_freeze: false };
    report = rep;
    render(<PlanBaselines region="" />);
    expect(screen.getByTestId('planfreeze-report')).toBeTruthy();
    expect(screen.queryByTestId('planfreeze-create')).toBeNull();
    expect(screen.queryByTestId('planfreeze-hide')).toBeNull();
  });
  it('says so when nothing is frozen', () => {
    list = { items: [], can_freeze: false };
    render(<PlanBaselines region="" />);
    expect(screen.getByTestId('state-empty')).toBeTruthy();
    expect(screen.queryByTestId('planfreeze-report')).toBeNull();
  });
});
