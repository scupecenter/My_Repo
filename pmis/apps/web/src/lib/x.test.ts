import { describe, expect, it } from 'vitest';
import type { Me } from '@/api/types';
import { canReassign, fmtDuration, insertMention, mentionQuery, mentionTokens, notificationTarget, snoozeDate, splitMentions, weekStartOf } from './x';

const ID = '3f2a9c1e-5b7d-4e8a-9c1b-2d3e4f5a6b7c';
const U = { d: 'd', h: 'h', min: 'min', lt: '< 1 min' };

describe('notificationTarget (X1)', () => {
  it('opens a task in the inbox drawer and a register record in its list', () => {
    expect(notificationTarget({ link: `/tasks/${ID}` })).toBe(`/inbox?task=${ID}`);
    expect(notificationTarget({ link: `/registers/procurement/records/${ID}` })).toBe(`/registers/procurement?record=${ID}`);
    expect(notificationTarget({ link: null, entity_type: 'task', entity_id: ID })).toBe(`/inbox?task=${ID}`);
  });
  it('keeps plain app paths and refuses anything that leaves the app', () => {
    expect(notificationTarget({ link: '/approvals' })).toBe('/approvals');
    expect(notificationTarget({ link: '/admin/settings/retention' })).toBe('/admin/settings/retention');
    for (const link of ['https://evil.example/x', '//evil.example/x', 'javascript:alert(1)', '/a b', '/x"onmouseover=', '', null, undefined]) expect(notificationTarget({ link }), String(link)).toBeNull();
  });
});

describe('fmtDuration (X4)', () => {
  it('shows the two largest units, and a floor for nothing', () => {
    expect(fmtDuration(0, U)).toBe('< 1 min');
    expect(fmtDuration(59, U)).toBe('< 1 min');
    expect(fmtDuration(60, U)).toBe('1 min');
    expect(fmtDuration(3_600, U)).toBe('1 h');
    expect(fmtDuration(5 * 3_600 + 20 * 60, U)).toBe('5 h 20 min');
    expect(fmtDuration(86_400, U)).toBe('1 d');
    expect(fmtDuration(3 * 86_400 + 4 * 3_600 + 59, U)).toBe('3 d 4 h');
    expect(fmtDuration(-5, U)).toBe('< 1 min');
  });
});

describe('mentions (X3)', () => {
  it('finds the unfinished @query at the end of the box only', () => {
    expect(mentionQuery('hello @sa')).toBe('sa');
    expect(mentionQuery('@')).toBe('');
    expect(mentionQuery('(@12')).toBe('12');
    expect(mentionQuery('hello @sami more')).toBeNull();
    expect(mentionQuery('mail a@b')).toBeNull();
    expect(mentionQuery('no mention')).toBeNull();
  });
  it('writes the employee-ID token in place of the query', () => {
    expect(insertMention('hello @sa', '1204')).toBe('hello @1204 ');
    expect(insertMention('@sa', '1204')).toBe('@1204 ');
    expect(insertMention('(@sa', '1204')).toBe('(@1204 ');
    expect(insertMention('no query', '1204')).toBe('no query');
  });
  it('lists the 4-digit tokens the server also resolves, without repeats', () => {
    expect(mentionTokens('hi @1204 and @1001, @1204 again')).toEqual(['1204', '1001']);
    expect(mentionTokens('a@1204 @12345 @abc @123')).toEqual([]);
    expect(mentionTokens('(@1204)')).toEqual(['1204']);
  });
  it('splits a comment into text and token parts that join back to the text', () => {
    const parts = splitMentions('ask @1204 and (@1001) today');
    expect(parts.filter((p) => p.token).map((p) => p.text)).toEqual(['@1204', '@1001']);
    expect(parts.map((p) => p.text).join('')).toBe('ask @1204 and (@1001) today');
    expect(splitMentions('plain')).toEqual([{ text: 'plain', token: false }]);
    expect(splitMentions('')).toEqual([]);
  });
});

describe('weeks and snooze dates (X1, X7): the week runs Sunday to Saturday, the weekend is Friday and Saturday', () => {
  it('finds the Sunday that opens the week of any day', () => {
    expect(weekStartOf('2026-11-01')).toBe('2026-11-01'); // a Sunday
    expect(weekStartOf('2026-11-04')).toBe('2026-11-01'); // Wednesday
    expect(weekStartOf('2026-11-06')).toBe('2026-11-01'); // Friday (weekend)
    expect(weekStartOf('2026-11-07')).toBe('2026-11-01'); // Saturday (weekend)
    expect(weekStartOf('2026-11-08')).toBe('2026-11-08');
    expect(weekStartOf('2026-01-01')).toBe('2025-12-28'); // across a year end
    expect(new Date(`${weekStartOf('2026-02-28')}T00:00:00Z`).getUTCDay()).toBe(0);
  });
  it('gives snooze dates that are always in the future', () => {
    expect(snoozeDate('tomorrow', '2026-11-04')).toBe('2026-11-05');
    expect(snoozeDate('in_a_week', '2026-11-04')).toBe('2026-11-11');
    expect(snoozeDate('next_sunday', '2026-11-04')).toBe('2026-11-08'); // Wednesday: the coming Sunday
    expect(snoozeDate('next_sunday', '2026-11-01')).toBe('2026-11-08'); // on a Sunday: the next one, never today
    expect(snoozeDate('next_sunday', '2026-11-07')).toBe('2026-11-08'); // Saturday
    expect(snoozeDate('tomorrow', '2026-12-31')).toBe('2027-01-01');
    for (const day of ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07']) {
      for (const c of ['tomorrow', 'next_sunday', 'in_a_week'] as const) expect(snoozeDate(c, day) > day, `${c} from ${day}`).toBe(true);
    }
  });
});

describe('canReassign (X5, X7)', () => {
  const me = (admin: boolean, grants: { module_key: string; action: string }[]) => ({ is_system_admin: admin, effective: { grants } }) as unknown as Me;
  it('is a System Admin, or a holder of the reassign right', () => {
    expect(canReassign(me(true, []))).toBe(true);
    expect(canReassign(me(false, [{ module_key: 'overrides.reassign', action: 'administer' }]))).toBe(true);
    expect(canReassign(me(false, [{ module_key: 'sites', action: 'view' }, { module_key: 'overrides.unlock', action: 'administer' }]))).toBe(false);
    expect(canReassign(me(false, []))).toBe(false);
    expect(canReassign(undefined)).toBe(false);
    expect(canReassign(null)).toBe(false);
  });
});
