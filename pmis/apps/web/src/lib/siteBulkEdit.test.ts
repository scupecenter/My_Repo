import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import type { Site360CellTarget } from '@/components/Site360Grid';
import { anyMissingParent, columnKind, columnOptions, editableOrds, optionsOf, planBulk, runBulk, toValue, type BulkRow } from './siteBulkEdit';

const city: Site360CellTarget = {
  task_id: 't', version: 1, editable: true, values: 'city', input_type: 'list', parent_ord: 40,
  options: [{ value: 'TIP', label_en: 'Tripoli', label_ar: null, parent: 'WEST' }, { value: 'MSR', label_en: 'Misrata', label_ar: null, parent: 'WEST' }, { value: 'BNG', label_en: 'Benghazi', label_ar: null, parent: 'EAST' }],
};
const row = (code: string, values: Record<string, string | null>, cells: Record<string, Site360CellTarget>): BulkRow => ({ site_id: `id-${code}`, site_code: code, values, cells });

describe('dependent lists: the options follow the parent value of the same row', () => {
  it('offers only the children of the parent value, none without a parent value, all without a parent column', () => {
    expect(optionsOf(city, { '40': 'WEST' }).map((o) => o.value)).toEqual(['TIP', 'MSR']);
    expect(optionsOf(city, { '40': 'EAST' }).map((o) => o.value)).toEqual(['BNG']);
    expect(optionsOf(city, { '40': null })).toEqual([]);
    expect(optionsOf({ ...city, parent_ord: undefined }, {}).map((o) => o.value)).toEqual(['TIP', 'MSR', 'BNG']);
  });
  it('a column offers the union of the options, and says when a parent value is missing', () => {
    const rows = [row('A', { '40': 'WEST' }, { '41': city }), row('B', { '40': null }, { '41': city })];
    expect(columnOptions(rows, 41)).toHaveLength(3);
    expect(anyMissingParent(rows, 41)).toBe(true);
    expect(anyMissingParent([rows[0]!], 41)).toBe(false);
  });
});

describe('planBulk', () => {
  const date = (editable: boolean, v = 1): Site360CellTarget => ({ task_id: `t${v}`, version: v, editable, field: 'actual_date', input_type: 'date' });
  const rows = [
    row('S1', { '78': '2026-03-10' }, { '78': date(true, 1) }),
    row('S2', { '78': '2026-04-01' }, { '78': date(true, 2) }),
    row('S3', { '78': '2026-03-10' }, { '78': date(false, 3) }),
    row('S4', { '78': null }, {}),
  ];
  it('splits the rows into the cells to save and the skipped ones with the reason', () => {
    const p = planBulk(rows, 78, 'date', '2026-04-01');
    expect(p.change.map((c) => c.row.site_code)).toEqual(['S1']);
    expect(p.skipped.map((s) => [s.row.site_code, s.reason])).toEqual([['S2', 'unchanged'], ['S3', 'locked'], ['S4', 'not_editable']]);
  });
  it('a list value must be offered for the parent value of the row', () => {
    const rs = [row('A', { '40': 'WEST', '41': null }, { '41': city }), row('B', { '40': 'EAST', '41': null }, { '41': city }), row('C', { '40': null, '41': null }, { '41': city })];
    const p = planBulk(rs, 41, 'list', 'TIP');
    expect(p.change.map((c) => c.row.site_code)).toEqual(['A']);
    expect(p.skipped.map((s) => s.reason)).toEqual(['not_allowed', 'not_allowed']);
  });
  it('compares a number and a yes or no with the stored text', () => {
    const num = (v: string) => row('N', { '9': v }, { '9': { task_id: 't', version: 1, editable: true, values: 'h', input_type: 'number' } });
    expect(planBulk([num('12')], 9, 'number', 12).skipped[0]?.reason).toBe('unchanged');
    expect(planBulk([num('12')], 9, 'number', 13).change).toHaveLength(1);
    const yn = row('Y', { '8': 'true' }, { '8': { task_id: 't', version: 1, editable: true, values: 'f', input_type: 'boolean' } });
    expect(planBulk([yn], 8, 'boolean', true).skipped[0]?.reason).toBe('unchanged');
    expect(planBulk([yn], 8, 'boolean', false).change).toHaveLength(1);
  });
  it('the columns offered are the ones some row backs with a task cell, with the kind of the first cell', () => {
    expect(editableOrds(rows, [4, 78, 90])).toEqual([78]);
    expect(columnKind(rows, 78)).toBe('date');
    expect(columnKind(rows, 4)).toBeNull();
  });
  it('toValue types the draft', () => {
    expect(toValue('number', '15.5')).toBe(15.5);
    expect(toValue('number', 'x')).toBeNull();
    expect(toValue('boolean', 'false')).toBe(false);
    expect(toValue('date', '')).toBeNull();
  });
});

describe('runBulk', () => {
  const changes = ['A', 'B', 'C', 'D', 'E'].map((c, i) => ({ row: row(c, {}, {}), target: { task_id: `t${i}`, version: i + 1, editable: true, field: 'actual_date' as const } }));
  it('saves every cell with its own version, a few at a time, and a failure does not stop the rest', async () => {
    let live = 0, peak = 0;
    const save = vi.fn(async (v: { task_id: string; version: number }) => {
      live += 1; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
      if (v.task_id === 't1') throw new ApiError(403, { type: 'about:blank', title: 'Forbidden', status: 403, code: 'forbidden' } as never);
      if (v.task_id === 't3') throw new Error('network');
    });
    const progress: number[] = [];
    const out = await runBulk(changes, '2026-05-01', save, { concurrency: 2, onProgress: (n) => progress.push(n) });
    expect(save).toHaveBeenCalledTimes(5);
    expect(save.mock.calls.map((c) => [c[0].task_id, c[0].version]).sort()).toEqual([['t0', 1], ['t1', 2], ['t2', 3], ['t3', 4], ['t4', 5]]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(out.map((o) => `${o.code}:${o.status}`)).toEqual(['A:saved', 'B:failed', 'C:saved', 'D:failed', 'E:saved']);
    expect(out[1]).toMatchObject({ http: 403 });
    expect(out[3]).toMatchObject({ http: null });
    expect(progress).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('clear a value (null)', () => {
  const dateCell = (editable: boolean, v: number): Site360CellTarget => ({ task_id: `t${v}`, version: v, editable, field: 'actual_date', input_type: 'date' });
  const rows = [
    row('S1', { '78': '2026-03-10' }, { '78': dateCell(true, 1) }),
    row('S2', { '78': null }, { '78': dateCell(true, 2) }),
    row('S3', { '78': '2026-03-10' }, { '78': dateCell(false, 3) }),
    row('S4', { '78': '2026-03-10' }, {}),
  ];
  it('saves the cells that hold a value and skips the empty, locked and not editable ones', () => {
    const p = planBulk(rows, 78, 'date', null);
    expect(p.change.map((c) => c.row.site_code)).toEqual(['S1']);
    expect(p.skipped.map((s) => [s.row.site_code, s.reason])).toEqual([['S2', 'already_empty'], ['S3', 'locked'], ['S4', 'not_editable']]);
  });
  it('does not check the options of a list when clearing', () => {
    const rs = [row('A', { '40': null, '41': 'TIP' }, { '41': city })];
    expect(planBulk(rs, 41, 'list', null).change).toHaveLength(1);
  });
  it('sends null for each cell and reports the message of a refusal as a failure', async () => {
    const plan = planBulk(rows, 78, 'date', null);
    const save = vi.fn(async (v: { value: unknown }) => { expect(v.value).toBeNull(); });
    const ok = await runBulk(plan.change, null, save);
    expect(ok.map((o) => o.status)).toEqual(['saved']);
    const err = new ApiError(422, { type: 'about:blank', title: 'Validation failed', status: 422, code: 'validation_failed', detail: 'A value is required.' } as never);
    const bad = await runBulk(plan.change, null, async () => { throw err; });
    expect(bad[0]).toMatchObject({ status: 'failed', http: 422, error: err });
  });
});
