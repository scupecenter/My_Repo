import { describe, expect, it } from 'vitest';
import type { M, P } from '../wf/model';
import { buildTree, editedCodes, letterOf, nextColumnLetter, pendingChanges, type Struct } from './studioModel';

const m = (code: string, name: string): M => ({ code, name_en: name });
const p = (task_code: string, stage_code: string, n: number, name_en: string, predecessors: string[] = []): P => ({ task_code, stage_code, sort_order: n, name_en, predecessors, is_active: true });
const base = (): Struct => ({
  milestones: [m('MS1', 'Release'), m('MS2', 'Design')],
  gates: [{ code: 'G1', name_en: 'Gate one', from_milestone: 'MS1', to_milestone: 'MS2' }],
  placements: [p('A1', 'MS1', 1, 'Survey'), p('A2', 'MS1', 2, 'Report', ['A1']), p('B1', 'MS2', 1, 'Plan')],
});

describe('studioModel', () => {
  it('calls a rename Light and an added task Structural, and marks the codes that carry the amber dot', () => {
    const d = base();
    d.placements = d.placements.map((x) => (x.task_code === 'A1' ? { ...x, name_en: 'Survey v2' } : x)).concat(p('A3', 'MS1', 3, 'New', ['A2']));
    const c = pendingChanges(base(), d);
    expect(c.find((x) => x.id === 't_renamed:A1')?.kind).toBe('light');
    expect(c.find((x) => x.id === 't_added:A3')?.kind).toBe('structural');
    expect([...editedCodes(c)].sort()).toEqual(['A1', 'A3']);
  });

  it('reports an SLA change as Light, per task, from the two lists of rules', () => {
    const rule = (min: number, max: number) => ({ task_code: 'A1', counts_in_weight: false, weight_value: 0, weight_group: null, sla: { id: 'r', min_working_days: min, max_working_days: max, start_event: 'PRED', unit: 'working' as const, calendar_code: 'default', warning_pct: null, breach_owner_role: null, escalation_role: null, pause_on_client_wait: false } });
    const c = pendingChanges(base(), base(), [rule(1, 3)], [rule(2, 5)]);
    expect(c).toMatchObject([{ key: 'sla_changed', kind: 'light', code: 'A1', detail: '1/3 → 2/5' }]);
  });

  it('builds the tree: collapsed by default, a hit on a task opens its milestone, a hit on a milestone shows all its tasks', () => {
    const s = base();
    expect(buildTree(s, '', new Set()).map((r) => [r.m.code, r.open, r.tasks.length, r.gate?.code])).toEqual([['MS1', false, 2, 'G1'], ['MS2', false, 1, undefined]]);
    const hit = buildTree(s, 'plan', new Set());
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatchObject({ open: true, gate: undefined });
    expect(buildTree(s, 'release', new Set())[0]!.tasks).toHaveLength(2);
  });
});

describe('Site Master column letters', () => {
  it('numbers the Master like the sheet: 187 is GE, so the first added column is GF', () => {
    expect([1, 26, 27, 52, 53, 187, 188, 189, 702, 703].map(letterOf)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA', 'GE', 'GF', 'GG', 'ZZ', 'AAA']);
  });
  it('previews the next letter after the 187 and after the columns already added (a deleted one leaves its position)', () => {
    expect(nextColumnLetter([{ ord: 5 }, { ord: 187 }])).toBe('GF');
    expect(nextColumnLetter([{ ord: 187 }, { ord: 188 }, { ord: 190 }])).toBe('GI');
  });
});
