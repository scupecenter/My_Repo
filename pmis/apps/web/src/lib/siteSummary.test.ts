import { describe, expect, it } from 'vitest';
import { summarizePipeline } from './siteSummary';

const n = (code: string, state: string, planned?: string) => ({ code, kind: 'milestone', name_en: code, state, planned_date: planned }) as never;

describe('summarizePipeline', () => {
  it('counts done, finds the current and late stages and the next planned date, skips n/a', () => {
    const s = summarizePipeline([n('A', 'done'), n('B', 'na'), n('C', 'late', '2026-12-01'), n('D', 'planned', '2026-11-30')]);
    expect(s.total).toBe(3);
    expect(s.done).toBe(1);
    expect(s.current?.code).toBe('C');
    expect(s.late.map((x) => x.code)).toEqual(['C']);
    expect(s.nextPlanned?.node.code).toBe('D');
  });
  it('is empty for no pipeline', () => {
    expect(summarizePipeline(undefined)).toMatchObject({ total: 0, current: null, nextPlanned: null });
  });
});
