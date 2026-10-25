import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, ApiError, downloadFile } from './client';
import type {
  Absence, AbsenceInput, Assignment, AssignmentPatch, BulkAssignRequest, BulkResult, Delegation, DelegationInput, ExportPart, GroupDetail, Group, MasterExport, MasterExportRequest, MfaExemption,
  Page, PermissionProfile, ReassignRequest, ReassignmentAlert, Role, User, UserDetail, UserPickerItem,
} from './types';

const key = (k: string, ...r: unknown[]) => [k, ...r];
const refresh = (qc: QueryClient, ...ks: string[]) => ks.forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));

export const useUsers = (f: { q: string; status: string; role_id: string }) =>
  useQuery({ queryKey: key('users', f), queryFn: () => api.get<Page<User>>('/users', { query: { ...f, limit: 200 } }) });
export const useUser = (id: string) => useQuery({ queryKey: key('user', id), queryFn: () => api.get<UserDetail>(`/users/${id}`) });
export const useRoles = () => useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ items: Role[] }>('/roles', { query: { include_inactive: true } }).then((r) => r.items) });
export const useProfiles = () => useQuery({ queryKey: ['profiles'], staleTime: Infinity, queryFn: () => api.get<{ items: PermissionProfile[] }>('/permission-profiles').then((r) => r.items) });
export const useGroups = () => useQuery({ queryKey: ['groups'], queryFn: () => api.get<Page<Group>>('/groups').then((r) => r.items) });
export const useGroup = (id: string | null) => useQuery({ queryKey: key('group', id), enabled: !!id, queryFn: () => api.get<GroupDetail>(`/groups/${id}`) });
export const useMfa = (id: string) => useQuery({ queryKey: key('mfa', id), queryFn: () => api.get<MfaExemption>(`/users/${id}/mfa-exemption`) });
export const useDelegations = (state: string) => useQuery({ queryKey: key('delegations', state), queryFn: () => api.get<Page<Delegation>>('/delegations', { query: { state } }).then((r) => r.items) });
export const useAbsences = () => useQuery({ queryKey: ['absences'], queryFn: () => api.get<Page<Absence>>('/absences').then((r) => r.items) });
export const useAlerts = (cause: string) => useQuery({ queryKey: key('alerts', cause), queryFn: () => api.get<Page<ReassignmentAlert>>('/reassignments/alerts', { query: { cause } }).then((r) => r.items), retry: false });
export const useEligible = (from: string | undefined, q: string, enabled = true) =>
  useQuery({ queryKey: key('eligible', from, q), enabled, queryFn: () => api.get<Page<UserPickerItem>>('/reassignments/eligible-users', { query: { from_user_id: from, q } }).then((r) => r.items) });
export const usePicker = (q: string) =>
  useQuery({ queryKey: key('picker', q), enabled: q.trim().length >= 2, queryFn: () => api.get<Page<UserPickerItem>>('/users/picker', { query: { q: q.trim() } }).then((r) => r.items) });

export const bulkAssign = (body: BulkAssignRequest) => api.post<BulkResult>('/assignments/bulk-assign', { idempotencyKey: crypto.randomUUID(), body });
export const useBulkAssign = () => {
  const qc = useQueryClient();
  return useMutation<BulkResult, ApiError, BulkAssignRequest>({ mutationFn: bulkAssign, onSettled: () => refresh(qc, 'users', 'user', 'roles') });
};

type Snap = { rollback: () => void };
/** Optimistically patch assignment rows in the cached user detail; rolls back when the server refuses. */
function patchUser(qc: QueryClient, userId: string, fn: (a: Assignment) => Assignment | null) {
  const k = key('user', userId), before = qc.getQueryData<UserDetail>(k);
  if (before) qc.setQueryData<UserDetail>(k, { ...before, assignments: (before.assignments ?? []).flatMap((a) => fn(a) ?? []) });
  return () => qc.setQueryData(k, before);
}
const failed = (r: BulkResult) => { if (r.failed.length) throw new ApiError(409, { type: 'about:blank', title: 'Some rows failed', status: 409, code: r.failed[0].code }); return r; };

export function useEditAssignments(userId: string) {
  const qc = useQueryClient();
  return useMutation<BulkResult, ApiError, { rows: Assignment[]; patch: AssignmentPatch; reason: string }, Snap>({
    mutationFn: ({ rows, patch, reason }) => api.post<BulkResult>('/assignments/bulk-update', { idempotencyKey: crypto.randomUUID(), body: { items: rows.map((r) => ({ id: r.id, version: r.version })), patch, reason } }).then(failed),
    onMutate: async ({ rows, patch }) => {
      await qc.cancelQueries({ queryKey: key('user', userId) });
      const ids = new Set(rows.map((r) => r.id));
      return { rollback: patchUser(qc, userId, (a) => (ids.has(a.id) ? ({ ...a, ...patch } as Assignment) : a)) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => refresh(qc, 'user', 'users'),
  });
}
export function useEndAssignments(userId: string) {
  const qc = useQueryClient();
  return useMutation<BulkResult, ApiError, { rows: Assignment[]; reason: string }, Snap>({
    mutationFn: ({ rows, reason }) => api.post<BulkResult>('/assignments/bulk-end', { idempotencyKey: crypto.randomUUID(), body: { items: rows.map((r) => ({ id: r.id, version: r.version })), reason } }).then(failed),
    onMutate: async ({ rows }) => {
      await qc.cancelQueries({ queryKey: key('user', userId) });
      const ids = new Set(rows.map((r) => r.id));
      return { rollback: patchUser(qc, userId, (a) => (ids.has(a.id) ? { ...a, is_active_now: false, valid_to: new Date().toISOString() } : a)) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => refresh(qc, 'user', 'users', 'roles'),
  });
}
export const useCopyAssignments = () => {
  const qc = useQueryClient();
  return useMutation<BulkResult, ApiError, { from_user_id: string; to_user_ids: string[]; mode: 'add' | 'replace'; reason: string; dry_run: boolean }>({
    mutationFn: (body) => api.post<BulkResult>('/assignments/copy', { idempotencyKey: crypto.randomUUID(), body }),
    onSettled: () => refresh(qc, 'users', 'user'),
  });
};
export const useSetMfa = (userId: string) => {
  const qc = useQueryClient();
  return useMutation<MfaExemption, ApiError, { reason: string; until?: string | null; revoke?: boolean }>({
    mutationFn: ({ revoke, ...b }) => (revoke ? api.post(`/users/${userId}/mfa-exemption/revoke`, { body: { reason: b.reason } }) : api.put(`/users/${userId}/mfa-exemption`, { body: b })),
    onSettled: () => refresh(qc, 'mfa', 'users', 'user'),
  });
};

export const useCreateRole = () => {
  const qc = useQueryClient();
  return useMutation<Role, ApiError, Record<string, unknown>>({ mutationFn: (body) => api.post('/roles', { body }), onSettled: () => refresh(qc, 'roles') });
};
export function useRolePatch() {
  const qc = useQueryClient();
  return useMutation<Role, ApiError, { role: Role; patch: Partial<Role>; reason: string }, Snap>({
    mutationFn: ({ role, patch, reason }) => api.patch(`/roles/${role.id}`, { version: role.version, body: { ...patch, reason } }),
    onMutate: async ({ role, patch }) => {
      await qc.cancelQueries({ queryKey: ['roles'] });
      const before = qc.getQueryData<Role[]>(['roles']);
      qc.setQueryData<Role[]>(['roles'], (b) => b?.map((r) => (r.id === role.id ? { ...r, ...patch } : r)));
      return { rollback: () => qc.setQueryData(['roles'], before) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => refresh(qc, 'roles'),
  });
}

export const useCreateGroup = () => {
  const qc = useQueryClient();
  return useMutation<GroupDetail, ApiError, { name: string; reason: string }>({ mutationFn: (body) => api.post('/groups', { body }), onSettled: () => refresh(qc, 'groups') });
};
export const useAddMembers = (groupId: string) => {
  const qc = useQueryClient();
  return useMutation<BulkResult, ApiError, { user_ids: string[]; reason: string }>({ mutationFn: (body) => api.post(`/groups/${groupId}/members`, { body }), onSettled: () => refresh(qc, 'group', 'groups') });
};
export function useRemoveMember(groupId: string) {
  const qc = useQueryClient();
  return useMutation<void, ApiError, { userId: string; reason: string }, Snap>({
    mutationFn: ({ userId, reason }) => api.del(`/groups/${groupId}/members/${userId}`, { query: { reason } }),
    onMutate: async ({ userId }) => {
      await qc.cancelQueries({ queryKey: key('group', groupId) });
      const k = key('group', groupId), before = qc.getQueryData<GroupDetail>(k);
      if (before) qc.setQueryData<GroupDetail>(k, { ...before, members: before.members?.filter((m) => m.user.id !== userId) });
      return { rollback: () => qc.setQueryData(k, before) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => refresh(qc, 'group', 'groups'),
  });
}

export const useCreateDelegation = () => {
  const qc = useQueryClient();
  return useMutation<Delegation, ApiError, DelegationInput>({ mutationFn: (body) => api.post('/delegations', { body }), onSettled: () => refresh(qc, 'delegations') });
};
export function useRevokeDelegation() {
  const qc = useQueryClient();
  return useMutation<Delegation, ApiError, { id: string; reason: string }, Snap>({
    mutationFn: ({ id, reason }) => api.post(`/delegations/${id}/revoke`, { body: { reason } }),
    onMutate: async ({ id }) => {
      await qc.cancelQueries({ queryKey: ['delegations'] });
      const snaps = qc.getQueriesData<Delegation[]>({ queryKey: ['delegations'] });
      snaps.forEach(([k, d]) => d && qc.setQueryData(k, d.map((x) => (x.id === id ? { ...x, state: 'revoked' as const } : x))));
      return { rollback: () => snaps.forEach(([k, d]) => qc.setQueryData(k, d)) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => refresh(qc, 'delegations'),
  });
}

export const useCreateAbsence = () => {
  const qc = useQueryClient();
  return useMutation<Absence, ApiError, AbsenceInput>({ mutationFn: (body) => api.post('/absences', { body }), onSettled: () => refresh(qc, 'absences', 'alerts') });
};
export function useDeleteAbsence() {
  const qc = useQueryClient();
  return useMutation<void, ApiError, Absence, Snap>({
    mutationFn: (a) => api.del(`/absences/${a.id}`, { version: a.version }),
    onMutate: async (a) => {
      await qc.cancelQueries({ queryKey: ['absences'] });
      const before = qc.getQueryData<Absence[]>(['absences']);
      qc.setQueryData<Absence[]>(['absences'], before?.filter((x) => x.id !== a.id));
      return { rollback: () => qc.setQueryData(['absences'], before) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => refresh(qc, 'absences', 'alerts'),
  });
}
/** Lead decision: the alerts that the call covers vanish at once; rolled back when it fails (for example not_eligible_holder). */
export function useReassign() {
  const qc = useQueryClient();
  return useMutation<BulkResult, ApiError, { req: ReassignRequest; hide: (a: ReassignmentAlert) => boolean }, Snap>({
    mutationFn: ({ req }) => api.post('/tasks/reassign', { idempotencyKey: crypto.randomUUID(), body: req }),
    onMutate: async ({ hide, req }) => {
      if (req.dry_run) return { rollback: () => {} };
      await qc.cancelQueries({ queryKey: ['alerts'] });
      const snaps = qc.getQueriesData<ReassignmentAlert[]>({ queryKey: ['alerts'] });
      snaps.forEach(([k, d]) => d && qc.setQueryData(k, d.filter((a) => !hide(a))));
      return { rollback: () => snaps.forEach(([k, d]) => qc.setQueryData(k, d)) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => refresh(qc, 'alerts', 'my-work', 'approvals', 'site-tasks', 'task'),
  });
}

export const useExportParts = (enabled: boolean) => useQuery({ queryKey: ['export-parts'], enabled, queryFn: () => api.get<{ items: ExportPart[] }>('/exports/parts').then((r) => r.items) });
export const useExports = (enabled: boolean) =>
  useQuery({
    queryKey: ['exports'], enabled, queryFn: () => api.get<Page<MasterExport>>('/exports/master').then((r) => r.items),
    refetchInterval: (q) => (q.state.data?.some((e) => e.status === 'queued' || e.status === 'running') ? 1000 : false),
  });
export const useStartExport = () => {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, MasterExportRequest>({ mutationFn: (body) => api.post('/exports/master', { idempotencyKey: crypto.randomUUID(), body }), onSettled: () => refresh(qc, 'exports') });
};
export const downloadExport = (id: string) => downloadFile(`/exports/master/${id}/download`);
