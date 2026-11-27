import { beforeEach, describe, expect, it } from 'vitest';
import { PINNED_RECORDS_MAX, RECENT_RECORDS_MAX, clearRecentRecords, recordChanged, resetRecordMemory, siteSignature, togglePinRecord, visitRecord, type RecRef } from './recordMemory';

const rec = (n: number): RecRef => ({ kind: 'site', id: `id-${n}`, code: `TR${n}`, name: `Site ${n}`, path: `/sites/id-${n}` });
let latest: ReturnType<typeof snapshot>;
function snapshot() { return { pins: JSON.parse(localStorage.getItem('pmis.records.pins') ?? '[]') as RecRef[], recent: JSON.parse(localStorage.getItem('pmis.records.recent') ?? '[]') as RecRef[], seen: JSON.parse(localStorage.getItem('pmis.records.seen') ?? '{}') as Record<string, string> }; }

describe('pins, recents and the changed dot', () => {
  beforeEach(() => resetRecordMemory());

  it('keeps the newest first, no duplicates, and at most the limit', () => {
    for (let i = 1; i <= RECENT_RECORDS_MAX + 3; i++) visitRecord(rec(i), 's');
    visitRecord(rec(5), 's');
    latest = snapshot();
    expect(latest.recent).toHaveLength(RECENT_RECORDS_MAX);
    expect(latest.recent[0]!.id).toBe('id-5');
    expect(new Set(latest.recent.map((r) => r.id)).size).toBe(RECENT_RECORDS_MAX);
  });

  it('pins up to the limit and unpins', () => {
    for (let i = 1; i <= PINNED_RECORDS_MAX + 2; i++) togglePinRecord(rec(i), 's');
    expect(snapshot().pins).toHaveLength(PINNED_RECORDS_MAX);
    togglePinRecord(rec(1), 's');
    expect(snapshot().pins.some((p) => p.id === 'id-1')).toBe(false);
  });

  it('the signature changes when something the person would notice changes, and the visit refreshes it', () => {
    const a = siteSignature({ overall_status: 'in_progress', late_task_count: 0 });
    const b = siteSignature({ overall_status: 'in_progress', late_task_count: 2 });
    expect(a).not.toBe(b);
    visitRecord(rec(1), a);
    const m = snapshot();
    expect(recordChanged(m, 'id-1', a)).toBe(false);
    expect(recordChanged(m, 'id-1', b)).toBe(true);
    expect(recordChanged(m, 'never-opened', b)).toBe(false);
    visitRecord(rec(1), b);
    expect(recordChanged(snapshot(), 'id-1', b)).toBe(false);
  });

  it('clearing the recent list keeps the pins', () => {
    togglePinRecord(rec(1), 's');
    visitRecord(rec(2), 's');
    clearRecentRecords();
    expect(snapshot().recent).toHaveLength(0);
    expect(snapshot().pins).toHaveLength(1);
  });
});
