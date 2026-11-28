import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE, api, type ApiError } from './client';

export interface MyCalendarFeed { enabled: boolean; created_at?: string; rotated_at?: string | null; last_read_at?: string | null; read_count?: number }
export interface CalendarFeedLink { enabled: boolean; rotated: boolean; path: string }

/** 0.15.460 (D4): the signed-in person's own calendar feed. Off until turned on; the link is shown once. */
export const useMyCalendarFeed = () => useQuery({ queryKey: ['myCalendarFeed'], queryFn: () => api.get<MyCalendarFeed>('/me/calendar-feed') });
export const useSetCalendarFeed = () => {
  const qc = useQueryClient();
  return useMutation<CalendarFeedLink, ApiError, void>({
    mutationFn: () => api.post<CalendarFeedLink>('/me/calendar-feed', { body: {} }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['myCalendarFeed'] }); },
  });
};
export const useRevokeCalendarFeed = () => {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, void>({
    mutationFn: () => api.del('/me/calendar-feed'),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['myCalendarFeed'] }); },
  });
};
/** The absolute link a calendar app subscribes to. */
export const feedUrl = (path: string): string => `${API_BASE.startsWith('http') ? '' : window.location.origin}${API_BASE}${path}`;
