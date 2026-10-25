import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, ApiError, setCsrfToken } from './client';
import type { ApprovalItem, BulkResult, Me, Notification, Page, Session, StaffCard, TaskDetail, TaskSummary, TransitionResult } from './types';

export const useSession = () =>
  useQuery({
    queryKey: ['session'],
    retry: false,
    staleTime: 60_000,
    queryFn: async (): Promise<Session> => {
      try {
        const s = await api.get<Session>('/auth/session');
        setCsrfToken(s.csrf_token);
        return s;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return { authenticated: false, csrf_token: '' };
        throw e;
      }
    },
  });

export const useMe = (enabled: boolean) => useQuery({ queryKey: ['me'], enabled, queryFn: () => api.get<Me>('/me') });

export const useMyTasks = (bucket: 'late' | 'do_now' | 'waiting') =>
  useQuery({ queryKey: ['my-work', bucket], queryFn: () => api.get<Page<TaskSummary>>('/me/tasks', { query: { bucket } }) });

export const useApprovals = (tab: string, q: string) =>
  useQuery({ queryKey: ['approvals', tab, q], queryFn: () => api.get<Page<ApprovalItem>>('/approvals', { query: { tab, q } }) });

export const useTask = (id: string | null) =>
  useQuery({ queryKey: ['task', id], enabled: !!id, queryFn: () => api.get<TaskDetail>(`/tasks/${id}`) });

export const useStaffCard = (employeeId: string, enabled: boolean) =>
  useQuery({ queryKey: ['staff', employeeId], enabled, staleTime: 300_000, queryFn: () => api.get<StaffCard>(`/staff-registry/${employeeId}`) });

export const useNotifications = (enabled: boolean) =>
  useQuery({ queryKey: ['notifications'], enabled, queryFn: () => api.get<Page<Notification> & { unread_count: number }>('/notifications') });

/** Optimistic helper: drop ids from every cached approvals/do_now list, return a rollback. */
export function optimisticRemove(qc: QueryClient, ids: string[]) {
  const drop = new Set(ids);
  const snaps = [
    ...qc.getQueriesData<Page<ApprovalItem>>({ queryKey: ['approvals'] }),
    ...qc.getQueriesData<Page<TaskSummary>>({ queryKey: ['my-work'] }),
  ];
  for (const [key, data] of snaps) {
    if (!data) continue;
    const items = (data.items as Array<ApprovalItem | TaskSummary>).filter((i) => !drop.has('task' in i ? i.task.id : i.id));
    qc.setQueryData(key, { ...data, items });
  }
  return () => snaps.forEach(([key, data]) => qc.setQueryData(key, data));
}

const settle = (qc: QueryClient) => {
  for (const k of ['approvals', 'my-work', 'task', 'notifications']) void qc.invalidateQueries({ queryKey: [k] });
};

export type DecideArgs = { item: ApprovalItem; op: 'review' | 'approve' | 'reject'; note?: string };

export function useDecide() {
  const qc = useQueryClient();
  return useMutation<TransitionResult, ApiError, DecideArgs, { rollback: () => void }>({
    mutationFn: ({ item, op, note }) => api.post(`/tasks/${item.task.id}/${op}`, { version: item.task.version, body: { note } }),
    onMutate: async ({ item }) => {
      await qc.cancelQueries({ queryKey: ['approvals'] });
      await qc.cancelQueries({ queryKey: ['my-work'] });
      return { rollback: optimisticRemove(qc, [item.task.id]) };
    },
    onError: (_e, _v, ctx) => ctx?.rollback(),
    onSettled: () => settle(qc),
  });
}

export function useBulk() {
  const qc = useQueryClient();
  return useMutation<BulkResult, ApiError, { action: 'pass' | 'approve'; items: ApprovalItem[] }, { rollback: () => void }>({
    mutationFn: ({ action, items }) =>
      api.post('/approvals/bulk', { idempotencyKey: crypto.randomUUID(), body: { action, items: items.map((i) => ({ id: i.task.id, version: i.task.version })) } }),
    onMutate: async ({ items }) => {
      await qc.cancelQueries({ queryKey: ['approvals'] });
      return { rollback: optimisticRemove(qc, items.map((i) => i.task.id)) };
    },
    onError: (_e, _v, ctx) => ctx?.rollback(),
    onSettled: () => settle(qc),
  });
}

export const useLogout = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => api.post<void>('/auth/logout'), onSuccess: () => { qc.clear(); } });
};
