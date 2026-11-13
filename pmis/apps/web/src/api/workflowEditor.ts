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
export type TaskPatchInput = { name_en?: string; name_ar?: string | null; counts_toward_milestone?: boolean; is_active?: boolean; reason: string; confirm_master_impact?: string };
export type LightInput = { name_en?: string; name_ar?: string; reason: string; counts_in_project_status?: boolean; sla_min_wd?: number; sla_max_wd?: number; confirm_master_impact?: string };

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
export type { Wrap };
