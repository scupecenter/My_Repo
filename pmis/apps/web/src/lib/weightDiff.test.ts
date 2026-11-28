import { describe, expect, it } from 'vitest';
import type { WeightSet } from '@/api/types';
import { diffWeightSets } from './weightDiff';

type Act = WeightSet['activities'][number];
const item = (code: string, weight: number, extra: object = {}) => ({ code, name_en: `Item ${code}`, weight, unit: null, measure_rule: null, ...extra }) as Act['items'][number];
const act = (code: string, weight: number, items: Act['items'], name = `Act ${code}`): Act => ({ code, name_en: name, weight, items }) as Act;

describe('diffWeightSets (settings review gap 7)', () => {
  const active = [act('A', 60, [item('A1', 50), item('A2', 50)]), act('B', 40, [item('B1', 100)])];
  it('is empty when the draft equals the set in force', () => {
    expect(diffWeightSets(active, JSON.parse(JSON.stringify(active)))).toEqual([]);
  });
  it('reports changed, added and removed items and activities with the fields', () => {
    const draft = [act('A', 70, [item('A1', 40, { unit: 'm', measure_rule: '{"method":"none"}' }), item('A3', 60)], 'Act A2')];
    const d = diffWeightSets(active, draft);
    const k = (kind: string, code: string) => d.find((r) => r.kind === kind && r.code === code);
    expect(k('changed', 'A')!.fields.map((f) => f.field)).toEqual(['name', 'weight']);
    expect(k('changed', 'A1')!.fields.map((f) => f.field)).toEqual(['weight', 'unit', 'measure_rule']);
    expect(k('added', 'A3')).toBeTruthy();
    expect(k('removed', 'A2')).toBeTruthy();
    expect(k('removed', 'B')).toBeTruthy();
    expect(k('removed', 'B1')).toBeTruthy();
  });
});
