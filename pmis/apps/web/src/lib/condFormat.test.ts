import { describe, expect, it } from 'vitest';
import { cellRule, cleanRules, daysFromToday, rowRule, ruleMatches, type FormatRule } from './condFormat';

const NOW = new Date(2026, 10, 28, 12, 0, 0);
const rule = (o: Partial<FormatRule>): FormatRule => ({ id: 'r', col: 'f:due', op: 'gt', value: 7, tone: 'red', scope: 'cell', ...o });

describe('conditional formatting rules', () => {
  it('overdue by more than N days: past dates only, today and the future never match', () => {
    const r = rule({ op: 'days_past', value: 7 });
    expect(ruleMatches(r, '2026-11-20', NOW)).toBe(true);   // 8 days past
    expect(ruleMatches(r, '2026-11-21', NOW)).toBe(false);  // 7 days past, not more
    expect(ruleMatches(r, '2026-11-28', NOW)).toBe(false);
    expect(ruleMatches(r, '2026-12-30', NOW)).toBe(false);
    expect(ruleMatches(r, '', NOW)).toBe(false);
    expect(ruleMatches(r, 'not a date', NOW)).toBe(false);
    expect(daysFromToday('2026-11-30', NOW)).toBe(2);
  });
  it('due within N days', () => {
    const r = rule({ op: 'days_ahead', value: 3 });
    expect(ruleMatches(r, '2026-11-28', NOW)).toBe(true);
    expect(ruleMatches(r, '2026-12-01', NOW)).toBe(true);
    expect(ruleMatches(r, '2026-12-02', NOW)).toBe(false);
    expect(ruleMatches(r, '2026-11-27', NOW)).toBe(false);
  });
  it('numbers, text, lists and empty values', () => {
    expect(ruleMatches(rule({ op: 'gte', value: 10 }), 10, NOW)).toBe(true);
    expect(ruleMatches(rule({ op: 'lt', value: 10 }), '9.5', NOW)).toBe(true);
    expect(ruleMatches(rule({ op: 'gt', value: 10 }), 'abc', NOW)).toBe(false);
    expect(ruleMatches(rule({ op: 'contains', value: 'rush' }), 'RUSH order', NOW, 'RUSH order')).toBe(true);
    expect(ruleMatches(rule({ op: 'eq', value: 'open' }), 'open', NOW)).toBe(true);
    expect(ruleMatches(rule({ op: 'eq', value: 'Open' }), 'o', NOW, 'Open')).toBe(true);
    expect(ruleMatches(rule({ op: 'ne', value: 'open' }), 'closed', NOW)).toBe(true);
    expect(ruleMatches(rule({ op: 'eq', value: 'a' }), ['a', 'b'], NOW)).toBe(true);
    expect(ruleMatches(rule({ op: 'empty', value: undefined }), '', NOW)).toBe(true);
    expect(ruleMatches(rule({ op: 'empty', value: undefined }), [], NOW)).toBe(true);
    expect(ruleMatches(rule({ op: 'notempty', value: undefined }), 0, NOW)).toBe(true);
    expect(ruleMatches(rule({ op: 'lt', value: 5 }), null, NOW)).toBe(false);
  });
  it('the first matching rule of the column wins; a row rule needs scope row', () => {
    const rules = [rule({ id: 'a', op: 'days_past', value: 30, tone: 'red' }), rule({ id: 'b', op: 'days_past', value: 7, tone: 'amber' }), rule({ id: 'c', col: 'f:other', op: 'notempty', value: undefined, tone: 'blue', scope: 'row' })];
    expect(cellRule(rules, 'f:due', '2026-11-15', NOW)?.tone).toBe('amber');
    expect(cellRule(rules, 'f:due', '2026-10-01', NOW)?.tone).toBe('red');
    expect(cellRule(rules, 'f:due', '2026-11-27', NOW)).toBeUndefined();
    expect(cellRule(rules, 'f:nope', '2026-10-01', NOW)).toBeUndefined();
    expect(rowRule(rules, (c) => ({ v: c === 'f:other' ? 'x' : undefined }), NOW)?.id).toBe('c');
    expect(rowRule(rules, () => ({ v: undefined }), NOW)).toBeUndefined();
  });
  it('cleanRules drops malformed rules and caps the list', () => {
    expect(cleanRules('x')).toBeUndefined();
    expect(cleanRules([{ id: 'a', col: 'f:x', op: 'nope', tone: 'red' }, { id: 'b', col: 'f:x', op: 'gt', tone: 'red' }, { id: 'c', col: 'f:x', op: 'gt', value: 3, tone: 'pink' }])).toBeUndefined();
    expect(cleanRules([{ id: 'a', col: 'f:x', op: 'empty', value: 'ignored', tone: 'red', scope: 'row' }])).toEqual([{ id: 'a', col: 'f:x', op: 'empty', tone: 'red', scope: 'row' }]);
    expect(cleanRules(Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, col: 'f:x', op: 'gt', value: i, tone: 'red', scope: 'cell' })))).toHaveLength(20);
  });
});
