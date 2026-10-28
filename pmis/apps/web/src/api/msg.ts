// Messages, announcements, departments and the direct manager (contract 0.4.0, ADR 0013).
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, ApiError, downloadFile } from './client';
import type {
  AnnouncementDetail, AnnouncementInput, AnnouncementResponse, AnnouncementSummary, Department, DepartmentInput, MessageContacts, MessageItem, MessageThread, MessageThreadSummary,
  Page, PendingAnnouncement, UserDetail, UserRef,
} from './types';

const LIVE = { 'X-PMIS-Live': '1' };
/** Timer-driven polls (unread badge, announcement pop-up) run every minute and never count as user activity. */
export const POLL_MS = 60_000;
type Snap = { rollback: () => void };

// ------------------------------------------------------------------ messages
type ThreadList = Page<MessageThreadSummary> & { unread_total: number };

export const useMessageContacts = (enabled = true) => useQuery({ queryKey: ['message-contacts'], enabled, queryFn: () => api.get<MessageContacts>('/messages/contacts') });

export const useMessageThreads = (unread: boolean) =>
  useQuery({
    queryKey: ['threads', { unread }], refetchInterval: POLL_MS, refetchIntervalInBackground: false,
    queryFn: () => api.get<ThreadList>('/messages/threads', { query: { unread: unread || undefined, limit: 100 } }),
  });

/** Unread badge of the sidebar. A timer-driven call, so it sends X-PMIS-Live. */
export const useUnreadTotal = (enabled: boolean) =>
  useQuery({
    queryKey: ['messages-unread'], enabled, refetchInterval: POLL_MS, refetchIntervalInBackground: false,
    queryFn: () => api.get<ThreadList>('/messages/threads', { query: { limit: 1 }, headers: LIVE }).then((r) => r.unread_total),
  });

export const useThread = (id: string | undefined) => useQuery({ queryKey: ['thread', id], enabled: !!id, queryFn: () => api.get<MessageThread>(`/messages/threads/${id}`) });

const refreshLists = (qc: QueryClient) => { void qc.invalidateQueries({ queryKey: ['threads'] }); void qc.invalidateQueries({ queryKey: ['messages-unread'] }); };

export const useStartThread = () => {
  const qc = useQueryClient();
  return useMutation<MessageThread, ApiError, { to_user_id: string; subject: string; body: string }>({
    mutationFn: (body) => api.post('/messages/threads', { body }), onSettled: () => refreshLists(qc),
  });
};

/** The reply shows at once at the top of the replies; it is taken back when the server refuses. */
export function useReply(threadId: string) {
  const qc = useQueryClient();
  return useMutation<MessageThread, ApiError, { body: string; author: UserRef }, Snap>({
    mutationFn: ({ body }) => api.post(`/messages/threads/${threadId}/replies`, { body: { body } }),
    onMutate: async ({ body, author }) => {
      const k = ['thread', threadId];
      await qc.cancelQueries({ queryKey: k });
      const before = qc.getQueryData<MessageThread>(k);
      if (before) qc.setQueryData<MessageThread>(k, { ...before, replies: [{ id: `pending-${Date.now()}`, author, body, created_at: new Date().toISOString() }, ...before.replies] });
      return { rollback: () => qc.setQueryData(k, before) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSuccess: (t) => qc.setQueryData(['thread', threadId], t),
    onSettled: () => refreshLists(qc),
  });
}

/** Opening a thread marks it read: the dot and the badge drop at once. */
export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation<void, ApiError, string, Snap>({
    mutationFn: (id) => api.post<void>(`/messages/threads/${id}/read`),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['threads'] });
      const snaps = qc.getQueriesData<ThreadList>({ queryKey: ['threads'] });
      const wasUnread = snaps.some(([, d]) => d?.items.some((x) => x.id === id && x.unread));
      snaps.forEach(([k, d]) => d && qc.setQueryData<ThreadList>(k, { ...d, items: d.items.map((x) => (x.id === id ? { ...x, unread: false } : x)), unread_total: Math.max(0, d.unread_total - (d.items.some((x) => x.id === id && x.unread) ? 1 : 0)) }));
      const badge = qc.getQueryData<number>(['messages-unread']);
      if (wasUnread && badge !== undefined) qc.setQueryData(['messages-unread'], Math.max(0, badge - 1));
      return { rollback: () => { snaps.forEach(([k, d]) => qc.setQueryData(k, d)); qc.setQueryData(['messages-unread'], badge); } };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => refreshLists(qc),
  });
}

// ------------------------------------------------------------------ announcements
export const useAnnouncements = () => useQuery({ queryKey: ['announcements'], queryFn: () => api.get<Page<AnnouncementSummary>>('/announcements', { query: { limit: 200 } }).then((r) => r.items) });
export const useAnnouncement = (id: string) => useQuery({ queryKey: ['announcement', id], queryFn: () => api.get<AnnouncementDetail>(`/announcements/${id}`) });
export const useAnnouncementResponses = (id: string, decision: string) =>
  useInfiniteQuery({
    queryKey: ['announcement-responses', id, decision], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.get<Page<AnnouncementResponse>>(`/announcements/${id}/responses`, { query: { decision: decision || undefined, limit: 200, cursor: pageParam } }),
    getNextPageParam: (p) => p.page.next_cursor ?? undefined,
  });
export const useSendAnnouncement = () => {
  const qc = useQueryClient();
  return useMutation<AnnouncementSummary, ApiError, AnnouncementInput>({
    mutationFn: (body) => api.post('/announcements', { body }), onSettled: () => { void qc.invalidateQueries({ queryKey: ['announcements'] }); void qc.invalidateQueries({ queryKey: ['announcement-pending'] }); },
  });
};
export const exportAnnouncement = (id: string) => downloadFile(`/announcements/${id}/responses/export`);

export const usePendingAnnouncements = (enabled: boolean) =>
  useQuery({
    queryKey: ['announcement-pending'], enabled, refetchInterval: POLL_MS, refetchIntervalInBackground: false,
    queryFn: () => api.get<{ items: PendingAnnouncement[] }>('/me/announcements/pending', { headers: LIVE }).then((r) => r.items),
  });

/** Answers one announcement. It leaves the pop-up queue at once; if the server refuses it comes back (a 409 means it was already answered elsewhere, so it stays gone). */
export function useRespond() {
  const qc = useQueryClient();
  return useMutation<void, ApiError, { id: string; decision: 'agree' | 'disagree'; note?: string }, Snap>({
    mutationFn: ({ id, decision, note }) => api.post<void>(`/announcements/${id}/respond`, { body: { decision, ...(decision === 'disagree' ? { note } : {}) } }),
    onMutate: async ({ id }) => {
      await qc.cancelQueries({ queryKey: ['announcement-pending'] });
      const before = qc.getQueryData<PendingAnnouncement[]>(['announcement-pending']);
      qc.setQueryData<PendingAnnouncement[]>(['announcement-pending'], before?.filter((x) => x.id !== id));
      return { rollback: () => qc.setQueryData(['announcement-pending'], before) };
    },
    onError: (e, _v, c) => { if (e.status !== 409) c?.rollback(); },
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['announcement-pending'] }); void qc.invalidateQueries({ queryKey: ['announcements'] }); },
  });
}

// ------------------------------------------------------------------ departments and manager
export const useDepartments = (includeInactive = false) =>
  useQuery({ queryKey: ['departments', { includeInactive }], queryFn: () => api.get<{ items: Department[] }>('/departments', { query: { include_inactive: includeInactive || undefined } }).then((r) => r.items) });

export const useCreateDepartment = () => {
  const qc = useQueryClient();
  return useMutation<Department, ApiError, DepartmentInput>({ mutationFn: (body) => api.post('/departments', { body }), onSettled: () => { void qc.invalidateQueries({ queryKey: ['departments'] }); } });
};
/** Edit or (de)activate: the row changes in the list at once and goes back if the server refuses. */
export function useUpdateDepartment() {
  const qc = useQueryClient();
  return useMutation<Department, ApiError, { dept: Department; patch: DepartmentInput }, Snap>({
    mutationFn: ({ dept, patch }) => api.patch(`/departments/${dept.id}`, { body: patch }),
    onMutate: async ({ dept, patch }) => {
      await qc.cancelQueries({ queryKey: ['departments'] });
      const snaps = qc.getQueriesData<Department[]>({ queryKey: ['departments'] });
      const { reason: _r, code, ...rest } = patch; void _r;
      snaps.forEach(([k, d]) => d && qc.setQueryData(k, d.map((x) => (x.id === dept.id ? { ...x, ...rest, code: code.toUpperCase() } : x))));
      return { rollback: () => snaps.forEach(([k, d]) => qc.setQueryData(k, d)) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['departments'] }); },
  });
}

/** Sets the direct manager and the department; the detail page shows them at once and takes them back on a refusal. */
export function useSetOrg(userId: string) {
  const qc = useQueryClient();
  return useMutation<UserDetail, ApiError, { manager: UserRef | null; department: Department | null; reason: string }, Snap>({
    mutationFn: ({ manager, department, reason }) => api.put(`/users/${userId}/org`, { body: { manager_id: manager?.id ?? null, department_id: department?.id ?? null, reason } }),
    onMutate: async ({ manager, department }) => {
      const k = ['user', userId];
      await qc.cancelQueries({ queryKey: k });
      const before = qc.getQueryData<UserDetail>(k);
      if (before) qc.setQueryData<UserDetail>(k, { ...before, manager, department: department ? { id: department.id, code: department.code, name_en: department.name_en, name_ar: department.name_ar } : null });
      return { rollback: () => qc.setQueryData(k, before) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['user', userId] }); void qc.invalidateQueries({ queryKey: ['users'] }); void qc.invalidateQueries({ queryKey: ['message-contacts'] }); void qc.invalidateQueries({ queryKey: ['departments'] }); },
  });
}

export type { MessageItem };
