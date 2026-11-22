import { describe, expect, it } from 'vitest';
import type { SlaWeightItem } from '@/api/workflowEditor';
import type { G, M, P } from './settings/wf/model';
import { impactCounts, pendingChanges, undoPlan, type Struct } from './settings/studio/studioModel';

const m = (code: string, name: string, extra: Partial<M> = {}): M => ({ code, name_en: name, ...extra });
const p = (task_code: string, stage_code: string, n: number, name_en: string, predecessors: string[] = [], extra: Partial<P> = {}): P => ({ task_code, stage_code, sort_order: n, name_en, predecessors, is_active: true, ...extra });
const g = (extra: Partial<G> = {}): G => ({ code: 'G1', name_en: 'Gate', from_milestone: 'MS1', to_milestone: 'MS2', sla_min_wd: 1, sla_max_wd: 3, conditions: [], ...extra });
const base = (): Struct => ({ milestones: [m('MS1', 'Release'), m('MS2', 'Design')], gates: [g()], placements: [p('A1', 'MS1', 1, 'Survey'), p('A2', 'MS1', 2, 'Report', ['A1']), p('B1', 'MS2', 1, 'Plan')] });
const sw = (code: string, min: number, max: number, w = 0): SlaWeightItem => ({ task_code: code, counts_in_weight: w > 0, weight_value: w, weight_group: w > 0 ? 'CW' : null,
  sla: { id: `r-${min}`, min_working_days: min, max_working_days: max, start_event: 'PRED', unit: 'working', calendar_code: 'default', warning_pct: null, breach_owner_role: null, escalation_role: null, pause_on_client_wait: false } });

/** The plan of the undo of the one change that `edit` makes to the base version. */
function plan(edit: (d: Struct) => void, id: string, parentSw: SlaWeightItem[] = [], draftSw: SlaWeightItem[] = []) {
  const d = base(); edit(d);
  const ch = pendingChanges(base(), d, parentSw, draftSw).find((x) => x.id === id);
  if (!ch) throw new Error(`no change ${id}`);
  return undoPlan(ch, base(), d, parentSw, draftSw);
}

describe('undoPlan', () => {
  it('puts the parent name back through the task door, and the parent predecessors through the predecessors door', () => {
    expect(plan((d) => { d.placements[0]!.name_en = 'New'; }, 't_renamed:A1')).toMatchObject({ ok: true, needsStruct: false, op: { door: 'updateTask', body: { code: 'A1', name_en: 'Survey', name_ar: null } } });
    expect(plan((d) => { d.placements[1]!.predecessors = []; }, 't_relinked:A2')).toMatchObject({ ok: true, op: { door: 'setPreds', body: { code: 'A2', predecessors: ['A1'] } } });
  });

  it('undoes a move to another milestone (structural) and a deactivation, and refuses a move back into a milestone that is off', () => {
    expect(plan((d) => { d.placements[0]!.stage_code = 'MS2'; }, 't_moved:A1')).toMatchObject({ ok: true, needsStruct: true, op: { door: 'updateTask', body: { code: 'A1', stage_code: 'MS1' } } });
    expect(plan((d) => { d.placements[2]!.is_active = false; }, 't_deactivated:B1')).toMatchObject({ ok: true, needsStruct: false, op: { door: 'updateTask', body: { code: 'B1', is_active: true } } });
    expect(plan((d) => { d.placements[0]!.stage_code = 'MS2'; d.milestones[0]!.is_active = false; }, 't_moved:A1')).toEqual({ ok: false, why: 'stage_gone' });
  });

  it('removes what the draft added with the remove door, for a task, a milestone and a gate', () => {
    expect(plan((d) => { d.placements.push(p('N1', 'MS1', 3, 'New')); }, 't_added:N1')).toMatchObject({ ok: true, needsStruct: true, hint: 'remove', op: { door: 'removeItem', body: { kind: 'task', code: 'N1' } } });
    expect(plan((d) => { d.milestones.push(m('MS3', 'Closure')); }, 'ms_added:MS3')).toMatchObject({ op: { door: 'removeItem', body: { kind: 'milestone', code: 'MS3' } } });
    expect(plan((d) => { d.gates.push(g({ code: 'G2' })); }, 'g_added:G2')).toMatchObject({ op: { door: 'removeItem', body: { kind: 'gate', code: 'G2' } } });
  });

  it('is off, with a reason, for what the API cannot bring back: a removed milestone or gate, a gate whose ends moved, a link to a task that is gone', () => {
    expect(plan((d) => { d.milestones.pop(); d.placements = d.placements.filter((x) => x.stage_code === 'MS1'); d.gates = []; }, 'ms_removed:MS2')).toEqual({ ok: false, why: 'removed' });
    expect(plan((d) => { d.gates = []; }, 'g_removed:G1')).toEqual({ ok: false, why: 'removed' });
    expect(plan((d) => { d.gates[0]!.to_milestone = 'MS1'; }, 'g_changed:G1')).toEqual({ ok: false, why: 'gate_ends' });
    const parent = base(); parent.gates = [g({ sla_min_wd: null, sla_max_wd: null })];
    const draft = base(); draft.gates = [g({ sla_min_wd: 2, sla_max_wd: 4 })];
    const ch = pendingChanges(parent, draft).find((x) => x.id === 'g_changed:G1')!;
    expect(undoPlan(ch, parent, draft)).toEqual({ ok: false, why: 'clear_sla' });
  });

  it('undoes a gate change with the gate door (names, SLA, conditions of the parent) and a deactivated milestone with the structure door', () => {
    expect(plan((d) => { d.gates[0]!.name_en = 'Other'; d.gates[0]!.sla_max_wd = 9; }, 'g_changed:G1')).toMatchObject({ ok: true, needsStruct: false, op: { door: 'gateLight', body: { code: 'G1', name_en: 'Gate', sla_min_wd: 1, sla_max_wd: 3, conditions: [] } } });
    const r = plan((d) => { d.milestones[1]!.is_active = false; d.placements = d.placements.map((x) => (x.stage_code === 'MS2' ? { ...x, is_active: false } : x)); }, 'ms_renamed:MS2');
    expect(r).toMatchObject({ ok: true, needsStruct: true, op: { door: 'replace' } });
    if (r.ok && r.op.door === 'replace') expect(r.op.body.milestones).toEqual([{ code: 'MS1', is_active: true }, { code: 'MS2', is_active: true, name_en: 'Design', name_ar: null }]);
  });

  it('puts the milestone order back, keeping new milestones after the parent ones', () => {
    const r = plan((d) => { d.milestones = [d.milestones[1]!, d.milestones[0]!, m('MS3', 'New')]; }, 'ms_reordered:*');
    expect(r).toMatchObject({ ok: true, needsStruct: true });
    if (r.ok && r.op.door === 'replace') expect(r.op.body.milestones.map((x) => x.code)).toEqual(['MS1', 'MS2', 'MS3']);
  });

  it('puts the closing flag, the SLA rule and the weight of the parent back; an SLA that the draft created is removed', () => {
    expect(plan((d) => { d.placements[0]!.is_milestone_task = true; }, 't_closing:A1')).toMatchObject({ op: { door: 'setClosing', body: { code: 'A1', closing: false } }, needsStruct: true });
    expect(plan(() => undefined, 'sla_changed:A1', [sw('A1', 1, 3)], [sw('A1', 2, 5)])).toMatchObject({ op: { door: 'saveSla', body: { code: 'A1', min_working_days: 1, max_working_days: 3 } } });
    expect(plan(() => undefined, 'sla_changed:A1', [{ ...sw('A1', 1, 3), sla: null }], [sw('A1', 2, 5)])).toMatchObject({ hint: 'remove', op: { door: 'removeSla', body: { code: 'A1', rule: 'r-2' } } });
    expect(plan(() => undefined, 'weight_changed:A1', [sw('A1', 1, 3, 40)], [sw('A1', 1, 3, 60)])).toMatchObject({ op: { door: 'setWeight', body: { code: 'A1', counts_in_weight: true, weight_value: 40, weight_group: 'CW' } } });
    expect(plan(() => undefined, 'weight_changed:A1', [sw('A1', 1, 3)], [sw('A1', 1, 3, 60)])).toMatchObject({ op: { door: 'setWeight', body: { code: 'A1', counts_in_weight: false } } });
  });
});

describe('impactCounts', () => {
  it('sums tasks added and moved and the dates that change over the sites, and counts the ones that cannot move', () => {
    const site = (over: object) => ({ site_id: 'x', site_code: 'S', from_version: 1, migratable: true, ...over });
    const c = impactCounts({ sites: [site({ tasks_added: ['N1', 'N2'], tasks_moved: ['A1'], date_changes: [{ code: 'A1', before: '2026-01-01', after: '2026-01-05' }] }), site({ migratable: false, tasks_added: ['N1'] }), site({})] });
    expect(c).toEqual({ sites: 3, movable: 2, blocked: 1, added: 3, moved: 1, retired: 0, dates: 1 });
    expect(impactCounts({ sites: [] })).toMatchObject({ sites: 0, added: 0, moved: 0, dates: 0 });
  });
});
