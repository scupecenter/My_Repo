import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { BlockedBy, Comment, Follow, Notification, Page, StatusHealth, StatusUpdate, StatusUpdateInput, TaskTimeInState, TimeInStateReport, Workload } from './types';

/** Hooks of the phase 4b features X1 to X7 (contract 0.4.10 and 0.7.1). The server decides what a caller may see; nothing here widens it. */

// ---------------------------------------------------------------------------------------------------------------- X1 inbox
export type InboxFilter = { unread: boolean; snoozed: 'hide' | 'only' | 'include'; kind: string };
export type InboxPage = Page<Notification> & { unread_count: number };

export const useInbox = (f: InboxFilter) =>
  useInfiniteQuery({
    queryKey: ['notifications', 'inbox', f], initialPageParam: '' as string,
    queryFn: ({ pageParam }) => api.get<InboxPage>('/notifications', { query: { unread_only: f.unread || undefined, snoozed: f.snoozed, kind: f.kind || undefined, limit: 30, cursor: pageParam } }),
    getNextPageParam: (last) => last.page.next_cursor ?? undefined,
  });

export function useNotificationOps() {
  const qc = useQueryClient();
  const settle = () => void qc.invalidateQueries({ queryKey: ['notifications'] });
  return {
    mark: useMutation<Notification, ApiError, { id: string; read: boolean }>({ mutationFn: ({ id, read }) => api.post(`/notifications/${id}/${read ? 'read' : 'unread'}`), onSuccess: settle }),
    snooze: useMutation<Notification, ApiError, { id: string; until: string | null }>({ mutationFn: ({ id, until }) => api.post(`/notifications/${id}/snooze`, { body: { until } }), onSuccess: settle }),
    readAll: useMutation<void, ApiError, void>({ mutationFn: () => api.post<void>('/notifications/read-all'), onSuccess: settle }),
  };
}

// ---------------------------------------------------------------------------------------------------------------- X2 follow
export const useFollows = () => useQuery({ queryKey: ['follows'], queryFn: () => api.get<{ items: Follow[] }>('/me/follows').then((r) => r.items) });

export type FollowTarget = { kind: 'site'; id: string } | { kind: 'record'; key: string; id: string };
const followPath = (t: FollowTarget) => (t.kind === 'site' ? `/sites/${t.id}/follow` : `/registers/${t.key}/records/${t.id}/follow`);
export function useFollowToggle() {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, { target: FollowTarget; follow: boolean }>({
    mutationFn: ({ target, follow }) => (follow ? api.put(followPath(target)) : api.del<void>(followPath(target))),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['follows'] }),
  });
}

// ---------------------------------------------------------------------------------------------------------------- X3 register comments
export const useRegisterComments = (key: string, id: string, enabled = true) =>
  useQuery({ queryKey: ['register-comments', key, id], enabled, queryFn: () => api.get<Page<Comment>>(`/registers/${key}/records/${id}/comments`) });
export function useAddRegisterComment(key: string, id: string) {
  const qc = useQueryClient();
  return useMutation<Comment, ApiError, { body: string; mention_user_ids?: string[] }>({
    mutationFn: (b) => api.post<Comment>(`/registers/${key}/records/${id}/comments`, { body: b }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['register-comments', key, id] }),
  });
}

// ---------------------------------------------------------------------------------------------------------------- X4 to X6 insights
export const useTimeInState = (taskId: string, enabled = true) => useQuery({ queryKey: ['time-in-state', taskId], enabled, queryFn: () => api.get<TaskTimeInState>(`/tasks/${taskId}/time-in-state`) });
export const useBlockedBy = (taskId: string, enabled = true) => useQuery({ queryKey: ['blocked-by', taskId], enabled, queryFn: () => api.get<BlockedBy>(`/tasks/${taskId}/blocked-by`) });
export type InsightFilter = { region_id: string; stage_code: string };
export const useWorkload = (f: InsightFilter) => useQuery({ queryKey: ['workload', f], queryFn: () => api.get<Workload>('/reports/workload', { query: { region_id: f.region_id || undefined, stage_code: f.stage_code || undefined } }) });
export const useTimeReport = (f: InsightFilter & { group_by: 'holder' | 'team'; from: string; to: string }) =>
  useQuery({ queryKey: ['time-report', f], queryFn: () => api.get<TimeInStateReport>('/reports/time-in-state', { query: { group_by: f.group_by, region_id: f.region_id || undefined, stage_code: f.stage_code || undefined, from: f.from || undefined, to: f.to || undefined } }) });

// ---------------------------------------------------------------------------------------------------------------- X7 status updates
export type StatusFilter = { scope: string; region_id: string; team: string };
export const useStatusUpdates = (f: StatusFilter) =>
  useInfiniteQuery({
    queryKey: ['status-updates', f], initialPageParam: '' as string,
    queryFn: ({ pageParam }) => api.get<Page<StatusUpdate>>('/status-updates', { query: { scope: f.scope || undefined, region_id: f.region_id || undefined, team: f.team || undefined, limit: 20, cursor: pageParam } }),
    getNextPageParam: (last) => last.page.next_cursor ?? undefined,
  });
export function useStatusOps() {
  const qc = useQueryClient();
  const settle = () => void qc.invalidateQueries({ queryKey: ['status-updates'] });
  return {
    post: useMutation<StatusUpdate, ApiError, StatusUpdateInput>({ mutationFn: (body) => api.post<StatusUpdate>('/status-updates', { body }), onSuccess: settle }),
    edit: useMutation<StatusUpdate, ApiError, { u: StatusUpdate; health?: StatusHealth; summary?: string }>({
      mutationFn: ({ u, health, summary }) => api.patch<StatusUpdate>(`/status-updates/${u.id}`, { version: u.version, body: { ...(health ? { health } : {}), ...(summary !== undefined ? { summary } : {}) } }), onSuccess: settle }),
  };
}
