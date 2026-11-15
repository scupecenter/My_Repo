import type { GateCondition } from '@/api/workflowEditor';

/** The shapes the editor reads from a version (the contract types leave the names optional). */
export type P = { task_code: string; stage_code: string; sort_order?: number; name_en?: string; name_ar?: string | null; is_active?: boolean; is_milestone_task?: boolean; has_documents?: boolean; counts_toward_milestone?: boolean; predecessors?: string[] };
export type M = { code: string; name_en: string; name_ar?: string | null; is_active?: boolean; counts_in_project_status?: boolean };
export type G = { code: string; name_en: string; name_ar?: string | null; from_milestone: string; to_milestone: string; is_active?: boolean; sla_min_wd?: number | null; sla_max_wd?: number | null; conditions?: GateCondition[] };

export type Sel = { kind: 'task' | 'gate'; code: string } | null;

/** The tasks that wait for `code`. */
export const successorsOf = (all: P[], code: string): string[] => all.filter((x) => (x.predecessors ?? []).includes(code)).map((x) => x.task_code);

/** Tasks of one milestone that wait for exactly the same tasks run in parallel. A group has two members or more; every task has a group index (or -1). */
export function parallelGroups(rows: P[]): { index: number[]; groups: string[][] } {
  const key = (p: P) => [...(p.predecessors ?? [])].sort().join('|');
  const by = new Map<string, string[]>();
  for (const p of rows) {
    if (p.is_active === false) continue;
    by.set(key(p), [...(by.get(key(p)) ?? []), p.task_code]);
  }
  const groups = [...by.values()].filter((g) => g.length > 1);
  const index = rows.map((p) => groups.findIndex((g) => g.includes(p.task_code)));
  return { index, groups };
}

/** Whether a row opens, continues or ends a run of neighbours of the same parallel group (drawn as a side bracket). */
export function bracketRole(index: number[], i: number): 'none' | 'start' | 'mid' | 'end' | 'single' {
  const g = index[i]!;
  if (g < 0) return 'none';
  const prev = i > 0 && index[i - 1] === g;
  const next = i < index.length - 1 && index[i + 1] === g;
  return prev && next ? 'mid' : prev ? 'end' : next ? 'start' : 'single';
}

/** The first cycle among the active tasks (a list of codes, the first repeated at the end), or null. */
export function findCycle(all: P[]): string[] | null {
  const preds = new Map(all.filter((p) => p.is_active !== false).map((p) => [p.task_code, p.predecessors ?? []]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (c: string): string[] | null => {
    if (state.get(c) === 2) return null;
    if (state.get(c) === 1) return [...stack.slice(stack.indexOf(c)), c];
    state.set(c, 1); stack.push(c);
    for (const p of preds.get(c) ?? []) if (preds.has(p)) { const r = visit(p); if (r) return r; }
    stack.pop(); state.set(c, 2);
    return null;
  };
  for (const c of preds.keys()) { const r = visit(c); if (r) return r; }
  return null;
}

export type DropAction =
  | { kind: 'reorder_milestones'; codes: string[] }
  | { kind: 'reorder_tasks'; stage: string; codes: string[] }
  | { kind: 'move_task'; task: string; stage: string };

const arrayMove = <T,>(a: T[], from: number, to: number): T[] => { const n = [...a]; const [x] = n.splice(from, 1); n.splice(to, 0, x!); return n; };

/** What a drop means: ids are `ms:<code>` and `task:<code>`. A task dropped on its own milestone, a milestone dropped on itself or anything else is nothing. */
export function resolveDrop(activeId: string, overId: string | null, milestones: string[], placements: P[]): DropAction | null {
  if (!overId || activeId === overId) return null;
  if (activeId.startsWith('ms:') && overId.startsWith('ms:')) {
    const a = milestones.indexOf(activeId.slice(3)), b = milestones.indexOf(overId.slice(3));
    return a < 0 || b < 0 ? null : { kind: 'reorder_milestones', codes: arrayMove(milestones, a, b) };
  }
  if (!activeId.startsWith('task:')) return null;
  const task = placements.find((p) => p.task_code === activeId.slice(5));
  if (!task) return null;
  if (overId.startsWith('ms:')) return overId.slice(3) === task.stage_code ? null : { kind: 'move_task', task: task.task_code, stage: overId.slice(3) };
  if (overId.startsWith('task:')) {
    const other = placements.find((p) => p.task_code === overId.slice(5));
    if (!other) return null;
    if (other.stage_code !== task.stage_code) return { kind: 'move_task', task: task.task_code, stage: other.stage_code };
    const codes = placements.filter((p) => p.stage_code === task.stage_code).map((p) => p.task_code);
    return { kind: 'reorder_tasks', stage: task.stage_code, codes: arrayMove(codes, codes.indexOf(task.task_code), codes.indexOf(other.task_code)) };
  }
  return null;
}

export type Diff = { milestones: { added: string[]; removed: string[]; renamed: string[]; reordered: boolean }; gates: { added: string[]; removed: string[]; changed: string[] };
  tasks: { added: string[]; deactivated: string[]; moved: string[]; renamed: string[]; relinked: string[]; closing: string[] } };

/** What a draft changes against its parent version (the preview of the impact before publishing). */
export function diffVersions(parent: { milestones: M[]; gates: G[]; placements: P[] }, draft: { milestones: M[]; gates: G[]; placements: P[] }): Diff {
  const pm = new Map(parent.milestones.map((m) => [m.code, m])), dm = new Map(draft.milestones.map((m) => [m.code, m]));
  const pg = new Map(parent.gates.map((g) => [g.code, g])), dg = new Map(draft.gates.map((g) => [g.code, g]));
  const pt = new Map(parent.placements.map((p) => [p.task_code, p])), dt = new Map(draft.placements.map((p) => [p.task_code, p]));
  const common = (a: Map<string, unknown>, b: Map<string, unknown>) => [...a.keys()].filter((k) => b.has(k));
  const orderOf = (l: M[], other: Map<string, unknown>) => l.map((m) => m.code).filter((c) => other.has(c)).join(',');
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return {
    milestones: {
      added: [...dm.keys()].filter((c) => !pm.has(c)), removed: [...pm.keys()].filter((c) => !dm.has(c)),
      renamed: common(pm, dm).filter((c) => pm.get(c)!.name_en !== dm.get(c)!.name_en || (pm.get(c)!.name_ar ?? null) !== (dm.get(c)!.name_ar ?? null) || (pm.get(c)!.is_active !== false) !== (dm.get(c)!.is_active !== false)),
      reordered: orderOf(parent.milestones, dm) !== orderOf(draft.milestones, pm),
    },
    gates: {
      added: [...dg.keys()].filter((c) => !pg.has(c)), removed: [...pg.keys()].filter((c) => !dg.has(c)),
      changed: common(pg, dg).filter((c) => { const a = pg.get(c)!, b = dg.get(c)!; return !same([a.name_en, a.name_ar, a.sla_min_wd, a.sla_max_wd, a.conditions, a.from_milestone, a.to_milestone, a.is_active !== false], [b.name_en, b.name_ar, b.sla_min_wd, b.sla_max_wd, b.conditions, b.from_milestone, b.to_milestone, b.is_active !== false]); }),
    },
    tasks: {
      added: [...dt.keys()].filter((c) => !pt.has(c)),
      deactivated: common(pt, dt).filter((c) => pt.get(c)!.is_active !== false && dt.get(c)!.is_active === false),
      moved: common(pt, dt).filter((c) => pt.get(c)!.stage_code !== dt.get(c)!.stage_code),
      renamed: common(pt, dt).filter((c) => pt.get(c)!.name_en !== dt.get(c)!.name_en || (pt.get(c)!.name_ar ?? null) !== (dt.get(c)!.name_ar ?? null)),
      relinked: common(pt, dt).filter((c) => !same([...(pt.get(c)!.predecessors ?? [])].sort(), [...(dt.get(c)!.predecessors ?? [])].sort())),
      closing: common(pt, dt).filter((c) => !!pt.get(c)!.is_milestone_task !== !!dt.get(c)!.is_milestone_task),
    },
  };
}
export const diffCount = (d: Diff): number => Object.values(d.milestones).reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : v ? 1 : 0), 0) + Object.values(d.gates).reduce((n, v) => n + v.length, 0) + Object.values(d.tasks).reduce((n, v) => n + v.length, 0);

/** A condition of type date_field is `ref` = a task date, a site date or a date custom field of the site. */
export const TASK_DATES = ['actual_start', 'actual_date', 'planned_date', 'baseline_date'] as const;
export const SITE_DATES = ['rf_survey_date', 'acquisition_date'] as const;
export type DateRef = { kind: 'task'; task: string; field: string } | { kind: 'site'; field: string } | { kind: 'custom'; code: string };
export function parseDateRef(ref: string | undefined): DateRef {
  const r = ref ?? '';
  if (r.startsWith('task:')) { const [task, field] = r.slice(5).split('.'); return { kind: 'task', task: task ?? '', field: field ?? 'actual_date' }; }
  if (r.startsWith('site.custom.')) return { kind: 'custom', code: r.slice(12) };
  if (r.startsWith('site.')) return { kind: 'site', field: r.slice(5) };
  return { kind: 'site', field: 'rf_survey_date' };
}
export const dateRefString = (d: DateRef): string => (d.kind === 'task' ? `task:${d.task}.${d.field}` : d.kind === 'site' ? `site.${d.field}` : `site.custom.${d.code}`);
