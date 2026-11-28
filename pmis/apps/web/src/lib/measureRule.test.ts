import { describe, expect, it } from 'vitest';
import { parseRule, ruleErrors, serializeRule } from './measureRule';

describe('measure rule (structured editor)', () => {
  it('round-trips the seeded rules', () => {
    const t = '{"method":"tasks","tasks":["A2"],"plan":"MS1"}';
    expect(serializeRule(parseRule(t).rule)).toBe(t);
    const n = '{"method":"none","central":true}';
    expect(serializeRule(parseRule(n).rule)).toBe(n);
  });
  it('empty means not counted automatically', () => {
    expect(parseRule('').rule).toBeNull();
    expect(serializeRule(null)).toBeNull();
    expect(ruleErrors(null)).toEqual([]);
  });
  it('flags broken JSON, free text and unknown methods as legacy', () => {
    expect(ruleErrors('{"method": ')).toEqual(['legacy']);
    expect(ruleErrors('count the towers')).toEqual(['legacy']);
    expect(ruleErrors('{"method":"magic"}')).toEqual(['legacy']);
  });
  it('checks tasks, plan, register and the known task codes', () => {
    expect(ruleErrors('{"method":"tasks","tasks":[]}')).toEqual(['no_tasks']);
    expect(ruleErrors('{"method":"tasks","tasks":["ZZ"],"plan":"MS11"}', new Set(['A2']))).toEqual(['unknown_task', 'bad_plan']);
    expect(ruleErrors('{"method":"tasks","tasks":["A2"],"plan":"MS10"}', new Set(['A2']))).toEqual([]);
    expect(ruleErrors('{"method":"register","register":" "}')).toEqual(['no_register']);
  });
});
