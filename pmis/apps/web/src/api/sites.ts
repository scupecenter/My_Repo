import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { Comment, DocumentFile, Group, Matrix, MatrixPatch, Page, Region, Role, SiteDetail, SiteListItem, SiteTasks, Stream, TaskDetail, TaskEntryPatch, TaskSummary, TransitionResult, UserPickerItem, WorkflowStep } from './types';

export type SiteFilters = { q: string; region_id: string; scenario: string; overall_status: string; stage_code: string; stream?: string };

export const useRegions = () => useQuery({ queryKey: ['regions'], staleTime: Infinity, queryFn: () => api.get<{ items: Region[] }>('/regions').then((r) => r.items) });

/** `stream` set = `GET /sites?stream=X` (each site's status in that stream only; sites where it does not apply are left out by the server). */
export const useSites = (f: SiteFilters, enabled = true) =>
  useInfiniteQuery({
    queryKey: ['sites', f], initialPageParam: '' as string, placeholderData: keepPreviousData, enabled,
    queryFn: ({ pageParam }) => api.get<Page<SiteListItem>>('/sites', { query: { ...f, limit: 100, cursor: pageParam } }),
    getNextPageParam: (last) => last.page.next_cursor ?? undefined,
  });

/** The streams of the workflow version, read from the first site (one tiny call); the tabs fall back to the seed list. */
export const useStreams = () =>
  useQuery({ queryKey: ['streams'], staleTime: 300_000, queryFn: () => api.get<Page<SiteListItem>>('/sites', { query: { limit: 1 } }).then((r) => r.items[0]?.streams as Stream[] | undefined) });

export const useSite = (id: string) => useQuery({ queryKey: ['site', id], queryFn: () => api.get<SiteDetail>(`/sites/${id}`) });
export const useSiteTasks = (id: string, stream?: string | null, enabled = true) =>
  useQuery({ queryKey: ['site-tasks', id, stream ?? ''], enabled, queryFn: () => api.get<SiteTasks>(`/sites/${id}/tasks`, { query: { stream } }) });
export const useHistory = (id: string) => useQuery({ queryKey: ['task-history', id], queryFn: () => api.get<Page<WorkflowStep>>(`/tasks/${id}/history`) });
export const useComments = (id: string) => useQuery({ queryKey: ['task-comments', id], queryFn: () => api.get<Page<Comment>>(`/tasks/${id}/comments`) });

const settleTask = (qc: QueryClient, siteId?: string) => {
  for (const k of ['site-tasks', 'site', 'task', 'task-history', 'task-comments', 'approvals', 'my-work', 'sites']) void qc.invalidateQueries({ queryKey: siteId && k === 'site-tasks' ? [k, siteId] : [k] });
};

/** Replace one task inside every cached grid of the site (all streams); returns a rollback. */
function patchGrid(qc: QueryClient, siteId: string, id: string, fn: (t: TaskSummary) => TaskSummary) {
  const before = qc.getQueriesData<SiteTasks>({ queryKey: ['site-tasks', siteId] });
  for (const [key, data] of before) if (data) qc.setQueryData<SiteTasks>(key, { ...data, stages: data.stages.map((s) => ({ ...s, tasks: s.tasks.map((t) => (t.id === id ? fn(t) : t)) })) });
  return () => before.forEach(([key, data]) => qc.setQueryData(key, data));
}

/** Same for the task drawer's cache (`['task', id]`). */
function patchDetail(qc: QueryClient, id: string, fn: (t: TaskDetail) => TaskDetail) {
  const before = qc.getQueryData<TaskDetail>(['task', id]);
  if (before) qc.setQueryData<TaskDetail>(['task', id], fn(before));
  return () => qc.setQueryData(['task', id], before);
}

const both = (...r: Array<() => void>) => () => r.forEach((f) => f());

/** Inline date edit and drawer save: the screen shows the new values at once and rolls back when the server refuses. */
export function useDatePatch(siteId: string) {
  const qc = useQueryClient();
  return useMutation<TaskDetail, ApiError, { task: TaskSummary; patch: TaskEntryPatch }, { rollback: () => void }>({
    mutationFn: ({ task, patch }) => api.patch(`/tasks/${task.id}`, { version: task.version, body: patch }),
    onMutate: async ({ task, patch }) => {
      await qc.cancelQueries({ queryKey: ['site-tasks', siteId] });
      await qc.cancelQueries({ queryKey: ['task', task.id] });
      return { rollback: both(patchGrid(qc, siteId, task.id, (t) => ({ ...t, ...(patch as Partial<TaskSummary>) })), patchDetail(qc, task.id, (t) => ({ ...t, ...(patch as Partial<TaskDetail>) }))) };
    },
    onSuccess: (d) => qc.setQueryData(['task', d.id], d),
    onError: (_e, _v, ctx) => ctx?.rollback(),
    onSettled: () => settleTask(qc, siteId),
  });
}
export const useTaskSave = useDatePatch;

export type TaskOp = 'start' | 'submit' | 'review' | 'approve' | 'reject' | 'claim' | 'release';
const NEXT: Record<TaskOp, Partial<TaskSummary>> = { start: { state: 'entry' }, submit: { state: 'in_review' }, review: { state: 'in_approval' }, approve: { state: 'approved' }, reject: { state: 'entry' }, claim: {}, release: {} };

export function useTaskOp(siteId: string) {
  const qc = useQueryClient();
  return useMutation<TransitionResult, ApiError, { task: TaskSummary; op: TaskOp; note?: string }, { rollback: () => void }>({
    // claim and release take no body; the others send `{ note }` (start: `{}`); If-Match is the task version
    mutationFn: ({ task, op, note }) =>
      api.post(`/tasks/${task.id}/${op}`, { version: task.version, ...(op === 'claim' || op === 'release' ? {} : { body: op === 'start' ? {} : { note } }) }),
    onMutate: async ({ task, op }) => {
      await qc.cancelQueries({ queryKey: ['site-tasks', siteId] });
      await qc.cancelQueries({ queryKey: ['task', task.id] });
      const me = qc.getQueryData<{ user?: { id: string; display_name: string; employee_id?: string | null } }>(['session'])?.user;
      const ball = (t: TaskSummary): Partial<TaskSummary> =>
        op === 'claim' && me && t.ball_in_court ? { ball_in_court: { ...t.ball_in_court, claimed_by: me as never } } : op === 'release' && t.ball_in_court ? { ball_in_court: { ...t.ball_in_court, claimed_by: undefined } } : {};
      return {
        rollback: both(
          patchGrid(qc, siteId, task.id, (t) => ({ ...t, ...NEXT[op], ...ball(t) })),
          // the buttons go away at once, so a second click cannot send a stale version
          patchDetail(qc, task.id, (t) => ({ ...t, ...NEXT[op], ...ball(t), allowed_actions: t.allowed_actions.filter((a) => a.action === 'comment') })),
        ),
      };
    },
    onSuccess: (r) => qc.setQueryData(['task', r.task.id], r.task),
    onError: (_e, _v, ctx) => ctx?.rollback(),
    onSettled: () => settleTask(qc, siteId),
  });
}

export function useUpload(task: TaskDetail) {
  const qc = useQueryClient();
  return useMutation<DocumentFile, ApiError, { slotId: string; file: File }, { before?: TaskDetail }>({
    mutationFn: ({ slotId, file }) => { const f = new FormData(); f.append('file', file); return api.post(`/tasks/${task.id}/slots/${slotId}/files`, { body: f }); },
    onMutate: async ({ slotId, file }) => {
      await qc.cancelQueries({ queryKey: ['task', task.id] });
      const before = qc.getQueryData<TaskDetail>(['task', task.id]);
      if (before) qc.setQueryData<TaskDetail>(['task', task.id], { ...before, slots: before.slots.map((s) => (s.id === slotId ? { ...s, status: 'uploaded', files: [...s.files, { id: 'pending', file_group_id: 'pending', version: 1, is_current: true, original_name: file.name, download_name: file.name, size_bytes: file.size, uploaded_at: new Date().toISOString() }] } : s)) });
      return { before };
    },
    onError: (_e, _v, ctx) => qc.setQueryData(['task', task.id], ctx?.before),
    onSettled: () => settleTask(qc, task.site_id),
  });
}

export function useAddComment(taskId: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: string) => api.post<Comment>(`/tasks/${taskId}/comments`, { body: { body } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['task-comments', taskId] }) });
}

export const useMatrix = () => useQuery({ queryKey: ['matrix'], queryFn: async () => ({ ...(await api.get<Matrix>('/matrix')) }) });
export const useRoles = () => useQuery({ queryKey: ['roles'], staleTime: 300_000, queryFn: () => api.get<{ items: Role[] }>('/roles').then((r) => r.items) });
export const useGroups = () => useQuery({ queryKey: ['groups'], staleTime: 300_000, queryFn: () => api.get<Page<Group>>('/groups').then((r) => r.items) });
export const usePicker = (q: string) => useQuery({ queryKey: ['picker', q], enabled: q.trim().length >= 2, queryFn: () => api.get<Page<UserPickerItem>>('/users/picker', { query: { q: q.trim() } }).then((r) => r.items) });

/** Publish: the screen already shows the draft, so the cache switches at once and returns on failure (If-Match = matrix revision). */
export function usePublishMatrix() {
  const qc = useQueryClient();
  return useMutation<Matrix, ApiError, { matrix: Matrix; patch: MatrixPatch; draft: Matrix }, { before?: Matrix }>({
    mutationFn: ({ matrix, patch }) => api.patch('/matrix', { version: matrix.version, body: patch }),
    onMutate: ({ draft }) => { const before = qc.getQueryData<Matrix>(['matrix']); qc.setQueryData(['matrix'], draft); return { before }; },
    onError: (_e, _v, ctx) => qc.setQueryData(['matrix'], ctx?.before),
    onSuccess: (m) => qc.setQueryData(['matrix'], m),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['matrix'] }); void qc.invalidateQueries({ queryKey: ['site-tasks'] }); },
  });
}
