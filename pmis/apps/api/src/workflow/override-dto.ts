import type { TaskViewService, UserRefDto } from './task-view.service';

export interface OverrideJson {
  id: string; entity: 'site' | 'task'; task_id: string | null; site_id: string; kind: string; reason: string; before: Record<string, unknown>; after: Record<string, unknown>;
  acted_by_id: string; created_at: string; reverted_at: string | null; reverted_by_id: string | null; revert_reason: string | null; revertible: boolean;
}

export interface OverrideDto {
  id: string;
  entity: 'site' | 'task';
  task_id: string | null;
  site_id: string;
  kind: string;
  reason: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  acted_by?: UserRefDto;
  created_at: string;
  reverted_at: string | null;
  reverted_by?: UserRefDto;
  revert_reason: string | null;
  revertible: boolean;
}

/** Adds the people the database answered by id (the database returns ids; names come from the same lookup the task views use). */
export async function overrideDtos(view: TaskViewService, rows: OverrideJson[]): Promise<OverrideDto[]> {
  const refs = await view.userRefs([...new Set(rows.flatMap((r) => [r.acted_by_id, r.reverted_by_id]).filter((x): x is string => !!x))]);
  return rows.map((r) => ({
    id: r.id, entity: r.entity, task_id: r.task_id, site_id: r.site_id, kind: r.kind, reason: r.reason, before: r.before, after: r.after,
    ...(refs.get(r.acted_by_id) ? { acted_by: refs.get(r.acted_by_id) } : {}), created_at: r.created_at, reverted_at: r.reverted_at,
    ...(r.reverted_by_id && refs.get(r.reverted_by_id) ? { reverted_by: refs.get(r.reverted_by_id) } : {}), revert_reason: r.revert_reason, revertible: r.revertible,
  }));
}
