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
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['wf-version', version] }); void qc.invalidateQueries({ queryKey: ['wf-versions'] }); void qc.invalidateQueries({ queryKey: ['wf-archive'] }); void qc.invalidateQueries({ queryKey: ['task-definitions'] }); void qc.invalidateQueries({ queryKey: ['wf-sla-weight'] }); void qc.invalidateQueries({ queryKey: ['wf-weight-totals'] }); },
  });
}

const base = (v: number) => `/workflow/versions/${v}`;

export type TaskCreateInput = { stage_code: string; code: string; name_en: string; name_ar?: string | null; counts_toward_milestone?: boolean; after_task_code?: string | null; predecessors?: string[]; reason: string; confirm_master_impact?: string };
export type TaskPatchInput = { name_en?: string; name_ar?: string | null; counts_toward_milestone?: boolean; is_active?: boolean; stage_code?: string; reason: string; confirm_master_impact?: string };
export type GateCondition = { type: string; ref?: string; accept_na?: boolean; offset_wd?: number };
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
/** 0.15.321 (migration 0491): the sequence lock mode of a draft version (strict or open); the per-site switch stays the override. */
export const useSetLockMode = (v: number, etag: number) => useWrite<{ lock_mode: 'strict' | 'open'; reason: string }, unknown>(v, etag, (body, e) => api.put(`${base(v)}/lock-mode`, { body, version: e }));
/** 0.15.16 (migration 0096): the task that closes its milestone, chosen in a draft. */
export const useSetClosing = (v: number, etag: number) => useWrite<{ code: string; closing: boolean; reason: string }, unknown>(v, etag, ({ code, ...body }, e) => api.put(`${base(v)}/tasks/${code}/closing`, { body, version: e }));
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
/** 0.15.436 (migration 0575): delete an old published version after the server archived a full snapshot of it. */
export const useDeleteVersion = (v: number, etag: number) => useWrite<{ reason: string; confirm_text: string }, { version: number; deleted: boolean; archive_id: string }>(v, etag, (body, e) => api.post(`${base(v)}/delete`, { body, version: e }));
export type ArchivedVersion = { id: string; version: number; archived_at: string; reason?: string; effective_from?: string | null; stages?: number; tasks?: number; restored_at?: string | null };
export const useVersionArchive = (enabled = true) => useQuery({ queryKey: ['wf-archive'], enabled, retry: false, queryFn: () => api.get<{ items: ArchivedVersion[] }>('/workflow/version-archive') });
export const useRestoreVersion = () => {
  const qc = useQueryClient();
  return useMutation<{ version: number; restored: boolean; archive_id: string }, ApiError, { id: string; reason: string }>({
    mutationFn: ({ id, ...body }) => api.post(`/workflow/version-archive/${id}/restore`, { body }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['wf-archive'] }); void qc.invalidateQueries({ queryKey: ['wf-versions'] }); void qc.invalidateQueries({ queryKey: ['wf-version'] }); },
  });
};
export const useDiscardDraft = (v: number, etag: number) => useWrite<{ reason: string }, unknown>(v, etag, (body, e) => api.post(`${base(v)}/discard`, { body, version: e }));

/** The SLA (target and limit in working days) of each task in force today, read-only here: the SLA rules are a versioned set with its own publishing (Settings, SLA). */
export type TaskSla = { min: number; max: number };
export const useTaskSla = () =>
  useQuery({
    queryKey: ['wf-task-sla'], retry: false, staleTime: 60_000,
    queryFn: () => api.get<{ items: { task_code: string; min_working_days: number; max_working_days: number; scenario?: string | null; region_id?: number | null }[] }>('/settings/sla-rules', { query: { limit: 200 } })
      .then((r) => { const m = new Map<string, TaskSla>(); for (const x of r.items) if (!x.scenario && !x.region_id && !m.has(x.task_code)) m.set(x.task_code, { min: x.min_working_days, max: x.max_working_days }); return m; }),
  });

/** Bulk edit of tasks (the table view): one write after the other, each with the ETag the previous answer returned, one reason; stops at the first refusal. */
export function useBulkTaskPatch(version: number, etag: number) {
  const qc = useQueryClient();
  return useMutation<{ done: number }, ApiError, { codes: string[]; patch: Omit<TaskPatchInput, 'reason'>; reason: string }>({
    mutationFn: async ({ codes, patch, reason }) => {
      let tag = etag, done = 0;
      for (const code of codes) {
        const r = await api.patch<{ version_etag?: number }>(`${base(version)}/tasks/${code}`, { body: { ...patch, reason }, version: tag });
        if (typeof r.version_etag === 'number') tag = r.version_etag;
        done += 1;
      }
      return { done };
    },
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['wf-version', version] }); void qc.invalidateQueries({ queryKey: ['wf-versions'] }); void qc.invalidateQueries({ queryKey: ['task-definitions'] }); void qc.invalidateQueries({ queryKey: ['wf-sla-weight'] }); void qc.invalidateQueries({ queryKey: ['wf-weight-totals'] }); },
  });
}

/** F14 (migration 0109, contract 0.15.20): the base SLA rule of a task, saved as a new effective-dated version. */
export type SlaRuleInput = {
  min_working_days: number; max_working_days: number; start_event: string; unit: 'working' | 'calendar'; calendar_code: string;
  warning_pct?: number | null; breach_owner_role?: string | null; escalation_role?: string | null; pause_on_client_wait: boolean; reason: string;
};
export const useSaveSlaRule = (v: number, etag: number) =>
  useWrite<SlaRuleInput & { code: string }, unknown>(v, etag, ({ code, ...body }, e) => api.put(`${base(v)}/tasks/${code}/sla-rule`, { body, version: e }));
/** Deleted when no task uses the rule, deactivated (with the reason) when one does. */
export const useRemoveSlaRule = (v: number, etag: number) =>
  useWrite<{ code: string; rule: string; reason: string }, unknown>(v, etag, ({ code, rule, ...body }, e) => api.post(`${base(v)}/tasks/${code}/sla-rules/${rule}/remove`, { body, version: e }));
export type WeightInput = { counts_in_weight: boolean; weight_value?: number; weight_group?: string | null; reason: string };
export const useSetWeight = (v: number, etag: number) =>
  useWrite<WeightInput & { code: string }, unknown>(v, etag, ({ code, ...body }, e) => api.put(`${base(v)}/tasks/${code}/weight`, { body, version: e }));
/** Migration 0542: estimated man-days and an optional planned duration of a task (draft only); the suggested weight they imply is advice only. */
export type EstimateInput = { est_man_days?: number | null; planned_duration_days?: number | null; reason: string };
export const useSetEstimate = (v: number, etag: number) =>
  useWrite<EstimateInput & { code: string }, unknown>(v, etag, ({ code, ...body }, e) => api.put(`${base(v)}/tasks/${code}/estimate`, { body, version: e }));
export type WeightTotal = { group: string; total: number; tasks: number; ok: boolean };
/** Live totals of the weight groups of a version (warns in the draft; publishing is refused while a group is not 100). */
export const useWeightTotals = (v: number | null) =>
  useQuery({ queryKey: ['wf-weight-totals', v], enabled: v !== null, retry: false, queryFn: () => api.get<{ items: WeightTotal[] }>(`/workflow/versions/${v}/weight-totals`) });
/** Migration 0110: the SLA rule and the weight of every task of a version (drafts included). */
export type SlaWeightItem = { task_code: string; counts_in_weight: boolean; weight_value: number; weight_group: string | null;
  est_man_days?: number | null; planned_duration_days?: number | null; suggested_weight?: number | null;
  sla: { id: string; min_working_days: number; max_working_days: number; start_event: string; unit: 'working' | 'calendar'; calendar_code: string; warning_pct: number | null;
    breach_owner_role: string | null; escalation_role: string | null; pause_on_client_wait: boolean } | null };
export const useSlaWeight = (v: number | null) =>
  useQuery({ queryKey: ['wf-sla-weight', v], enabled: v !== null, retry: false, queryFn: () => api.get<{ items: SlaWeightItem[] }>(`/workflow/versions/${v}/sla-weight`) });
