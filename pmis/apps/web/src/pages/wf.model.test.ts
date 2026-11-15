import { describe, expect, it } from 'vitest';
import { bracketRole, findCycle, parallelGroups, resolveDrop, type P } from './settings/wf/model';

const p = (task_code: string, stage_code: string, predecessors: string[] = []): P => ({ task_code, stage_code, predecessors });
const all = [p('A1', 'MS1'), p('A2', 'MS1', ['A1']), p('A3', 'MS1', ['A1']), p('A4', 'MS1', ['A2', 'A3']), p('B1', 'MS2', ['A4'])];

describe('workflow editor model', () => {
  it('groups tasks with the same predecessors as parallel and brackets them', () => {
    const { index, groups } = parallelGroups(all.filter((x) => x.stage_code === 'MS1'));
    expect(groups).toEqual([['A2', 'A3']]);
    expect(index).toEqual([-1, 0, 0, -1]);
    expect(bracketRole(index, 1)).toBe('start');
    expect(bracketRole(index, 2)).toBe('end');
    expect(bracketRole(index, 0)).toBe('none');
  });
  it('finds a loop through other milestones', () => {
    expect(findCycle(all)).toBeNull();
    expect(findCycle(all.map((x) => (x.task_code === 'A1' ? { ...x, predecessors: ['B1'] } : x)))).not.toBeNull();
  });
  it('turns a drop into reorder, move or nothing', () => {
    const ms = ['MS1', 'MS2'];
    expect(resolveDrop('ms:MS1', 'ms:MS2', ms, all)).toEqual({ kind: 'reorder_milestones', codes: ['MS2', 'MS1'] });
    expect(resolveDrop('task:A1', 'task:A3', ms, all)).toEqual({ kind: 'reorder_tasks', stage: 'MS1', codes: ['A2', 'A3', 'A1', 'A4'] });
    expect(resolveDrop('task:A1', 'ms:MS2', ms, all)).toEqual({ kind: 'move_task', task: 'A1', stage: 'MS2' });
    expect(resolveDrop('task:A1', 'task:B1', ms, all)).toEqual({ kind: 'move_task', task: 'A1', stage: 'MS2' });
    expect(resolveDrop('task:A1', 'ms:MS1', ms, all)).toBeNull();
    expect(resolveDrop('task:A1', 'task:A1', ms, all)).toBeNull();
    expect(resolveDrop('task:A1', null, ms, all)).toBeNull();
  });
});
