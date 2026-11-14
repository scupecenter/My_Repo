import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { components } from './schema';

type S = components['schemas'];
export type WorkflowVersion = S['WorkflowVersion'];
export type WorkflowVersionSummary = S['WorkflowVersionSummary'];
export type TaskPlacement = S['TaskPlacement'];

/** Decision 4 of 2026-11-12 (migration 0090): the workflow editor. Reads are open to any signed-in user; writes need System Admin or a delegate (the server decides). */
export const useWorkflowVersions = () =>
  useQuery({ queryKey: ['wf-versions'], retry: false, queryFn: () => api.get<{ items: WorkflowVersionSummary[] }>('/workflow/versions') });

export const useWorkflowVersion = (version: number | null) =>
  useQuery({ queryKey: ['wf-version', version], enabled: version !== null, retry: false, queryFn: () => api.get<WorkflowVersion>(`/workflow/versions/${version}`) });

type Wrap<I> = { body: I };

/** One mutation factory: every write sends the version ETag in If-Match and refreshes the version and the list afterwards. */
function useWrite<I, O>(version: number, etag: number, run: (input: I, etag: number) => Promise<O>) {
  const qc = useQueryClient();
  return useMutation<O, ApiError, I>({
    mutationFn: (input) => run(input, etag),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['wf-version', version] }); void qc.invalidateQueries({ queryKey: ['wf-versions'] }); void qc.invalidateQueries({ queryKey: ['task-definitions'] }); },
  });
}

const base = (v: number) => `/workflow/versions/${v}`;

export type TaskCreateInput = { stage_code: string; code: string; name_en: string; name_ar?: string | null; counts_toward_milestone?: boolean; after_task_code?: string | null; predecessors?: string[]; reason: string; confirm_master_impact?: string };
export type TaskPatchInput = { name_en?: string; name_ar?: string | null; counts_toward_milestone?: boolean; is_active?: boolean; stage_code?: string; reason: string; confirm_master_impact?: string };
export type GateCondition = { type: string; ref?: string; accept_na?: boolean };
export type LightInput = { name_en?: string; name_ar?: string; reason: string; counts_in_project_status?: boolean; sla_min_wd?: number; sla_max_wd?: number; conditions?: GateCondition[]; confirm_master_impact?: string };

export const useCreateDraft = () => {
  const qc = useQueryClient();
  return useMutation<WorkflowVersion, ApiError, { parent_version: number; reason: string }>({
    mutationFn: (body) => api.post('/workflow/versions', { body }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['wf-versions'] }); },
  });
};
export const useCreateTask = (v: number, etag: number) => useWrite<TaskCreateInput, unknown>(v, etag, (body, e) => api.post(`${base(v)}/tasks`, { body, version: e }));
export const useUpdateTask = (v: number, etag: number) => useWrite<{ code: string } & TaskPatchInput, unknown>(v, etag, ({ code, ...body }, e) => api.patch(`${base(v)}/tasks/${code}`, { body, version: e }));
export const useSetPredecessors = (v: number, etag: number) => useWrite<{ code: string; predecessors: string[]; reason: string }, unknown>(v, etag, ({ code, ...body }, e) => api.put(`${base(v)}/tasks/${code}/predecessors`, { body, version: e }));
export const useReorderTasks = (v: number, etag: number) => useWrite<{ stage: string; task_codes: string[]; reason: string }, unknown>(v, etag, ({ stage, ...body }, e) => api.put(`${base(v)}/milestones/${stage}/task-order`, { body, version: e }));
export const useMilestoneLight = (v: number, etag: number) => useWrite<{ code: string } & LightInput, unknown>(v, etag, ({ code, ...body }, e) => api.patch(`${base(v)}/milestones/${code}`, { body, version: e }));
export const useGateLight = (v: number, etag: number) => useWrite<{ code: string } & LightInput, unknown>(v, etag, ({ code, ...body }, e) => api.patch(`${base(v)}/gates/${code}`, { body, version: e }));
export const usePublish = (v: number, etag: number) => useWrite<{ reason: string; confirm_text: string; confirm_master_impact?: string }, WorkflowVersion>(v, etag, (body, e) => api.post(`${base(v)}/publish`, { body, version: e }));
export type InsertInput = TaskCreateInput & { successors?: string[]; remove_direct_links?: boolean; add_to_open_sites?: boolean };
export type TaskInsertPreview = S['TaskInsertPreview'];
export type TaskInsertResult = S['TaskInsertResult'];
export const useInsertTask = (v: number, etag: number) => useWrite<InsertInput, TaskInsertResult>(v, etag, (body, e) => api.post(`${base(v)}/tasks/insert`, { body, version: e }));
export const useSetSuccessors = (v: number, etag: number) => useWrite<{ code: string; successors: string[]; reason: string }, unknown>(v, etag, ({ code, ...body }, e) => api.put(`${base(v)}/tasks/${code}/successors`, { body, version: e }));
/** The preview writes nothing: a mutation only because it is a POST with a body. */
export const usePreviewInsert = (v: number) =>
  useMutation<TaskInsertPreview, ApiError, { stage_code: string; predecessors: string[]; successors: string[]; remove_direct_links: boolean; counts_toward_milestone: boolean }>({
    mutationFn: (body) => api.post(`${base(v)}/tasks/insert-preview`, { body }),
  });
export type StructureInput = {
  milestones: { code: string; name_en?: string; name_ar?: string | null; is_active?: boolean; counts_in_project_status?: boolean }[];
  gates: { code: string; name_en?: string; name_ar?: string | null; from_milestone?: string; to_milestone?: string; is_active?: boolean; conditions?: GateCondition[]; sla_min_wd?: number; sla_max_wd?: number }[];
  task_moves?: { task_code: string; stage_code: string }[]; reason: string; confirm_master_impact?: string;
};
export const useReplaceStructure = (v: number, etag: number) => useWrite<StructureInput, unknown>(v, etag, (body, e) => api.put(`${base(v)}`, { body, version: e }));

export type MigrationPreview = S['MigrationPreview'];
export type SiteMigration = S['SiteMigration'];
type Selection = { site_ids?: string[]; filter?: { from_version?: number } };
export const usePreviewMigration = (v: number) => useMutation<MigrationPreview, ApiError, Selection>({ mutationFn: (body) => api.post(`${base(v)}/migration-preview`, { body }) });
export const useMigrateSites = (v: number) => {
  const qc = useQueryClient();
  return useMutation<{ sites_migrated: number; to_version: number }, ApiError, { preview_hash: string; selection: Selection; reason: string; confirm_master_impact?: string }>({
    mutationFn: (body) => api.post(`${base(v)}/migrations`, { body }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['wf-versions'] }); void qc.invalidateQueries({ queryKey: ['wf-migrations'] }); },
  });
};
export const useSiteMigrations = (enabled: boolean) =>
  useQuery({ queryKey: ['wf-migrations'], enabled, retry: false, queryFn: () => api.get<{ items: SiteMigration[] }>('/workflow/site-migrations', { query: { limit: 50 } }) });
export const useRevertMigration = () => {
  const qc = useQueryClient();
  return useMutation<{ reverted_to_version: number }, ApiError, { id: string; reason: string }>({
    mutationFn: ({ id, ...body }) => api.post(`/workflow/site-migrations/${id}/revert`, { body }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['wf-migrations'] }); void qc.invalidateQueries({ queryKey: ['wf-versions'] }); },
  });
};
export type { Wrap };

export type RemoveResult = { outcome: 'deleted' | 'deactivated'; why: string[] };
export const useRemoveItem = (v: number, etag: number) => useWrite<{ kind: 'task' | 'milestone' | 'gate'; code: string; reason: string }, RemoveResult>(v, etag, (body, e) => api.post(`${base(v)}/remove`, { body, version: e }));
export const useDiscardDraft = (v: number, etag: number) => useWrite<{ reason: string }, unknown>(v, etag, (body, e) => api.post(`${base(v)}/discard`, { body, version: e }));
