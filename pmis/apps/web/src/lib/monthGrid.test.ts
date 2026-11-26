import { describe, expect, it } from 'vitest';
import { monthGrid } from './monthGrid';

describe('monthGrid', () => {
  it('builds whole weeks, places items on their date and counts undated ones', () => {
    // November 2026 starts on a Sunday; with a Sunday week start there is no lead and 30 days make 5 weeks
    const g = monthGrid(2026, 11, [{ id: 'a', label: 'A', date: '2026-11-26', late: false }, { id: 'b', label: 'B', date: '', late: true }], 0);
    expect(g.cells.length).toBe(35);
    expect(g.cells[0]?.date).toBe('2026-11-01');
    expect(g.cells.find((c) => c.date === '2026-11-26')?.items.map((x) => x.id)).toEqual(['a']);
    expect(g.undated).toBe(1);
  });
  it('a Saturday week start adds one lead day for a month starting on Sunday and marks other months', () => {
    const g = monthGrid(2026, 11, [], 6);
    expect(g.cells[0]?.date).toBe('2026-10-31');
    expect(g.cells[0]?.inMonth).toBe(false);
    expect(g.cells.length % 7).toBe(0);
  });
});
