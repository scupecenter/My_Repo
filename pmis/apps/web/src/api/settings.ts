import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, ApiError, downloadFile } from './client';
import type {
  ActiveSession, ActOnBehalfRequest, Calendar, DeletedUser, DlpSettings, DlpVersion, DlpVersionInput, Holiday, HolidayChangeResult, HolidayInput, HolidayPatch, HolidaySummary, IdleTaskAlertSetting, Job, LogIntegrity, LogRetention, LogRetentionInput,
  NotificationPolicy, NotificationPolicyInput, NotificationTypeDef, Page, ReassignmentAlert, SecurityLogEntry, SessionRevokeResult, SlaRule, StaffVisibility, StructuralFreeze, TransitionResultT, User, UserDetail, WeekendDaysResult, WeightSet,
} from './types';

const refresh = (qc: QueryClient, ...ks: string[]) => ks.forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));
type Snap = { rollback: () => void };

// ---------------------------------------------------------------- calendar
export const useHolidays = (year: number | null) =>
  useQuery({ queryKey: ['holidays', year], queryFn: () => api.get<{ items: Holiday[]; summary: HolidaySummary }>('/settings/holidays', { query: { year } }) });
export const useCalendar = () => useQuery({ queryKey: ['calendars'], queryFn: () => api.get<{ items: Calendar[] }>('/settings/calendars').then((r) => r.items[0]) });

export const useCreateHoliday = () => {
  const qc = useQueryClient();
  return useMutation<HolidayChangeResult, ApiError, HolidayInput>({ mutationFn: (body) => api.post('/settings/holidays', { body }), onSettled: () => refresh(qc, 'holidays', 'calendars') });
};
/** Edit or confirm a holiday; the row changes in the list at once and goes back if the server refuses. */
export function useHolidayChange() {
  const qc = useQueryClient();
  return useMutation<HolidayChangeResult, ApiError, { h: Holiday; patch: HolidayPatch | { reason: string; date?: string; confirm: true } }, Snap>({
    mutationFn: ({ h, patch }) => ('confirm' in patch
      ? api.post(`/settings/holidays/${h.id}/confirm`, { version: h.version, body: { reason: patch.reason, ...(patch.date ? { date: patch.date } : {}) } })
      : api.patch(`/settings/holidays/${h.id}`, { version: h.version, body: patch })),
    onMutate: async ({ h, patch }) => {
      await qc.cancelQueries({ queryKey: ['holidays'] });
      const snaps = qc.getQueriesData<{ items: Holiday[] }>({ queryKey: ['holidays'] });
      const { reason: _r, confirm, ...rest } = patch as Record<string, unknown>; void _r;
      snaps.forEach(([k, d]) => d && qc.setQueryData(k, { ...d, items: d.items.map((x) => (x.id === h.id ? { ...x, ...rest, ...(confirm ? { tentative: false } : {}) } : x)) }));
      return { rollback: () => snaps.forEach(([k, d]) => qc.setQueryData(k, d)) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => refresh(qc, 'holidays', 'calendars'),
  });
}
export function useDeleteHoliday() {
  const qc = useQueryClient();
  return useMutation<HolidayChangeResult, ApiError, { h: Holiday; reason: string }, Snap>({
    mutationFn: ({ h, reason }) => api.del(`/settings/holidays/${h.id}`, { version: h.version, query: { reason } }),
    onMutate: async ({ h }) => {
      await qc.cancelQueries({ queryKey: ['holidays'] });
      const snaps = qc.getQueriesData<{ items: Holiday[] }>({ queryKey: ['holidays'] });
      snaps.forEach(([k, d]) => d && qc.setQueryData(k, { ...d, items: d.items.filter((x) => x.id !== h.id) }));
      return { rollback: () => snaps.forEach(([k, d]) => qc.setQueryData(k, d)) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => refresh(qc, 'holidays', 'calendars'),
  });
}
export const useImportHolidays = () => {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, File>({
    mutationFn: (file) => { const fd = new FormData(); fd.append('file', file); return api.post('/settings/holidays/import', { idempotencyKey: crypto.randomUUID(), body: fd }); },
    onSettled: () => refresh(qc, 'holidays', 'calendars'),
  });
};
export const useSetWeekend = () => {
  const qc = useQueryClient();
  return useMutation<WeekendDaysResult, ApiError, { weekend_days: number[]; reason: string }>({ mutationFn: (body) => api.put('/settings/weekend-days', { body }), onSettled: () => refresh(qc, 'calendars') });
};

// ---------------------------------------------------------------- rules
export const useSlaRules = () => useQuery({ queryKey: ['sla-rules'], queryFn: () => api.get<Page<SlaRule>>('/settings/sla-rules').then((r) => r.items) });
export const useWeightSets = () => useQuery({ queryKey: ['weight-sets'], queryFn: () => api.get<{ items: WeightSet[] }>('/settings/weight-sets').then((r) => r.items) });
export const useFreeze = () => useQuery({ queryKey: ['freeze'], queryFn: () => api.get<StructuralFreeze>('/settings/structural-freeze') });
export const useLiftFreeze = () => {
  const qc = useQueryClient();
  return useMutation<StructuralFreeze, ApiError, { version: number; reason: string; confirm_text: string }>({
    mutationFn: ({ version, ...body }) => api.post('/settings/structural-freeze/lift', { version, body }), onSettled: () => refresh(qc, 'freeze'),
  });
};
export const useDlp = () => useQuery({ queryKey: ['dlp'], queryFn: () => api.get<DlpSettings>('/settings/dlp') });
export const usePublishDlp = () => {
  const qc = useQueryClient();
  return useMutation<DlpVersion, ApiError, DlpVersionInput>({ mutationFn: (body) => api.post('/settings/dlp/versions', { body }), onSettled: () => refresh(qc, 'dlp') });
};
export const useIdle = () => useQuery({ queryKey: ['idle'], queryFn: () => api.get<IdleTaskAlertSetting>('/settings/idle-task-alert') });
export const useSetIdle = () => {
  const qc = useQueryClient();
  return useMutation<IdleTaskAlertSetting, ApiError, { version: number; enabled: boolean; working_days: number; reason: string }, Snap>({
    mutationFn: ({ version, ...body }) => api.put('/settings/idle-task-alert', { version, body }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['idle'] });
      const before = qc.getQueryData<IdleTaskAlertSetting>(['idle']);
      qc.setQueryData(['idle'], { ...before, enabled: v.enabled, working_days: v.working_days });
      return { rollback: () => qc.setQueryData(['idle'], before) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => refresh(qc, 'idle'),
  });
};

// ---------------------------------------------------------------- notification policy and retention
export const usePolicy = () => useQuery({ queryKey: ['policy'], queryFn: () => api.get<NotificationPolicy>('/settings/notification-policy') });
export const useCatalogue = () => useQuery({ queryKey: ['catalogue'], staleTime: Infinity, queryFn: () => api.get<{ items: NotificationTypeDef[] }>('/settings/notification-policy/catalogue').then((r) => r.items) });
export const useSetPolicy = () => {
  const qc = useQueryClient();
  return useMutation<NotificationPolicy, ApiError, { version: number; body: NotificationPolicyInput }>({
    mutationFn: ({ version, body }) => api.put('/settings/notification-policy', { version, body }), onSettled: () => refresh(qc, 'policy'),
  });
};
export const useRetention = () => useQuery({ queryKey: ['retention'], queryFn: () => api.get<LogRetention>('/settings/log-retention') });
export const useSetRetention = () => {
  const qc = useQueryClient();
  return useMutation<LogRetention, ApiError, { version: number; body: LogRetentionInput }>({
    mutationFn: ({ version, body }) => api.put('/settings/log-retention', { version, body }), onSettled: () => refresh(qc, 'retention', 'notifications'),
  });
};

// ---------------------------------------------------------------- staff visibility
export const useStaffVisibility = () => useQuery({ queryKey: ['staff-visibility'], queryFn: () => api.get<StaffVisibility>('/staff-registry/visibility') });
export const useSetStaffVisibility = () => {
  const qc = useQueryClient();
  return useMutation<StaffVisibility, ApiError, { version: number; fields: StaffVisibility['fields']; reason: string }>({
    mutationFn: ({ version, ...body }) => api.put('/staff-registry/visibility', { version, body }), onSettled: () => refresh(qc, 'staff-visibility', 'staff'),
  });
};
export const useHideStaffFields = () => {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, { employee_id: string; hidden_fields: string[]; reason: string }>({
    mutationFn: ({ employee_id, ...body }) => api.patch(`/staff-registry/${employee_id}`, { body }), onSettled: () => refresh(qc, 'staff'),
  });
};

// ---------------------------------------------------------------- security log, integrity, sessions
export type SecFilter = { from: string; to: string; event: string[]; outcome: string; q: string };
export const useSecurityLog = (f: SecFilter) =>
  useQuery({
    queryKey: ['security-log', f],
    queryFn: () => api.get<Page<SecurityLogEntry>>('/security-log', { query: { from: f.from ? `${f.from}T00:00:00Z` : '', to: f.to ? `${f.to}T23:59:59Z` : '', event: f.event.join(','), outcome: f.outcome, q: f.q } }).then((r) => r.items),
  });
export const verifyIntegrity = (log: 'audit' | 'security') => api.get<LogIntegrity>(`/${log}-log/integrity`);
export const useVerifyIntegrity = () => useMutation<LogIntegrity, ApiError, 'audit' | 'security'>({ mutationFn: verifyIntegrity });

/** Starts the CSV export and polls its job; resolves with the downloaded file name. */
export async function exportSecurityLog(f: SecFilter, onStart?: () => void) {
  const job = await api.post<Job>('/security-log/exports', {
    idempotencyKey: crypto.randomUUID(),
    body: { ...(f.from ? { from: `${f.from}T00:00:00Z` } : {}), ...(f.to ? { to: `${f.to}T23:59:59Z` } : {}), ...(f.event.length ? { event: f.event } : {}), ...(f.outcome ? { outcome: f.outcome } : {}), ...(f.q ? { q: f.q } : {}) },
  });
  onStart?.();
  for (let i = 0; i < 30; i++) {
    const j = await api.get<Job>(`/jobs/${job.id}`);
    if (j.status === 'failed') throw new ApiError(500, j.error ?? ({ type: 'about:blank', title: 'Export failed', status: 500, code: 'unknown' } as never));
    if (j.status === 'done' && j.result_file_id) return downloadFile(`/files/${j.result_file_id}/download`);
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('export timeout');
}

/** Polls every 15 s with X-PMIS-Live so the poll never counts as activity (cannot extend the session). */
export const LIVE_POLL_MS = 15_000;
export const useActiveSessions = (f: { q: string; status: string }) =>
  useQuery({
    queryKey: ['sessions', f], refetchInterval: LIVE_POLL_MS, refetchIntervalInBackground: false,
    queryFn: () => api.get<Page<ActiveSession>>('/sessions/active', { query: f, headers: { 'X-PMIS-Live': '1' } }).then((r) => r.items),
  });
export function useRevokeSessions() {
  const qc = useQueryClient();
  return useMutation<SessionRevokeResult, ApiError, { session?: ActiveSession; user?: { id: string }; reason: string }, Snap>({
    mutationFn: ({ session, user, reason }) => api.post(session ? `/sessions/${session.session_id}/revoke` : `/users/${user!.id}/sessions/revoke`, { body: { reason } }),
    onMutate: async ({ session, user }) => {
      await qc.cancelQueries({ queryKey: ['sessions'] });
      const snaps = qc.getQueriesData<ActiveSession[]>({ queryKey: ['sessions'] });
      snaps.forEach(([k, d]) => d && qc.setQueryData(k, d.filter((s) => (session ? s.session_id !== session.session_id : s.user.id !== user!.id || s.is_current))));
      return { rollback: () => snaps.forEach(([k, d]) => qc.setQueryData(k, d)) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => refresh(qc, 'sessions'),
  });
}

// ---------------------------------------------------------------- users: deactivate, delete, restore
export const useDeletedUsers = (enabled: boolean) => useQuery({ queryKey: ['users-deleted'], enabled, queryFn: () => api.get<Page<DeletedUser>>('/users/deleted').then((r) => r.items) });
export function useDeactivateUser() {
  const qc = useQueryClient();
  return useMutation<UserDetail, ApiError, { user: User; status: 'suspended' | 'disabled' | 'active'; reason: string }, Snap>({
    mutationFn: ({ user, status, reason }) => api.patch(`/users/${user.id}`, { version: user.version, body: { status, reason } }),
    onMutate: async ({ user, status }) => {
      await qc.cancelQueries({ queryKey: ['users'] });
      const snaps = qc.getQueriesData<Page<User>>({ queryKey: ['users'] });
      snaps.forEach(([k, d]) => d && qc.setQueryData(k, { ...d, items: d.items.map((x) => (x.id === user.id ? { ...x, status } : x)) }));
      return { rollback: () => snaps.forEach(([k, d]) => qc.setQueryData(k, d)) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => refresh(qc, 'users', 'user', 'sessions', 'alerts', 'site-tasks', 'approvals', 'matrix'),
  });
}
export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation<DeletedUser, ApiError, { user: User; reason: string }, Snap>({
    mutationFn: ({ user, reason }) => api.post(`/users/${user.id}/delete`, { version: user.version, body: { reason } }),
    onMutate: async ({ user }) => {
      await qc.cancelQueries({ queryKey: ['users'] });
      const snaps = qc.getQueriesData<Page<User>>({ queryKey: ['users'] });
      snaps.forEach(([k, d]) => d && qc.setQueryData(k, { ...d, items: d.items.filter((x) => x.id !== user.id) }));
      return { rollback: () => snaps.forEach(([k, d]) => qc.setQueryData(k, d)) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => refresh(qc, 'users', 'users-deleted', 'sessions', 'alerts', 'site-tasks', 'approvals', 'matrix'),
  });
}
export const useRestoreUser = () => {
  const qc = useQueryClient();
  return useMutation<UserDetail, ApiError, { user: DeletedUser; reason: string }>({
    mutationFn: ({ user, reason }) => api.post(`/users/${user.id}/restore`, { version: user.version, body: { reason } }),
    onSettled: () => refresh(qc, 'users', 'users-deleted', 'alerts', 'site-tasks', 'approvals', 'matrix'),
  });
};

// ---------------------------------------------------------------- act on behalf (B12b choice 3)
export function useActOnBehalf() {
  const qc = useQueryClient();
  return useMutation<TransitionResultT, ApiError, { taskId: string; version: number; body: ActOnBehalfRequest }, Snap>({
    mutationFn: ({ taskId, version, body }) => api.post(`/tasks/${taskId}/act-on-behalf`, { version, body }),
    onMutate: async ({ taskId }) => {
      await qc.cancelQueries({ queryKey: ['alerts'] });
      const snaps = qc.getQueriesData<ReassignmentAlert[]>({ queryKey: ['alerts'] });
      snaps.forEach(([k, d]) => d && qc.setQueryData(k, d.filter((a) => a.task.id !== taskId)));
      return { rollback: () => snaps.forEach(([k, d]) => qc.setQueryData(k, d)) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => refresh(qc, 'alerts', 'my-work', 'approvals', 'site-tasks', 'task'),
  });
}
