import { describe, expect, it } from 'vitest';
import { BATCH_TTL_DAYS, countChanges, dropRecord, emptyBatch, isExpired, readBatch, setChange } from './batchDraft';

describe('batch draft', () => {
  it('keeps the first original value, drops an edit that puts it back, and counts only real changes', () => {
    let d = setChange(emptyBatch(), 'r1', 3, 'TRP-1', 'po', 'A', 'B');
    d = setChange(d, 'r1', 3, 'TRP-1', 'po', 'A', 'C');
    expect(d.changes.r1!.set.po).toEqual({ from: 'A', to: 'C' });
    expect(countChanges(d)).toBe(1);
    d = setChange(d, 'r1', 3, 'TRP-1', 'po', 'C', 'A');
    expect(countChanges(d)).toBe(0);
    expect(d.changes.r1).toBeUndefined();
    expect(countChanges(dropRecord(setChange(emptyBatch(), 'r2', 1, 'x', 'f', null, 'v'), 'r2'))).toBe(0);
  });
  it('treats null and undefined as the same empty value', () => {
    expect(countChanges(setChange(emptyBatch(), 'r', 1, 'x', 'f', undefined, null))).toBe(0);
  });
  it('expires after 7 days and refuses a foreign payload', () => {
    const d = setChange(emptyBatch(), 'r1', 1, 'x', 'f', 'a', 'b');
    const old = { ...d, saved_at: new Date(Date.now() - (BATCH_TTL_DAYS * 86_400_000 + 1000)).toISOString() };
    expect(isExpired(old)).toBe(true);
    expect(readBatch(old)).toBeNull();
    expect(readBatch(d)).toMatchObject({ v: 1 });
    expect(readBatch({ foo: 1 })).toBeNull();
    expect(readBatch(null)).toBeNull();
  });
});
