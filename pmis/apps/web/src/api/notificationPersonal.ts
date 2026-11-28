import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from './client';

/** Contract 0.15.531: personal notification settings. Own row only; the database re-checks everything. */
export interface NotificationTypePref { code: string; label_en: string; label_ar: string; kind: string; category: string; mandatory: boolean; in_app: boolean; email: boolean }
export interface NotificationDnd { enabled: boolean; start: number; end: number; days: number[]; timezone: string | null; effective_timezone: string }
export interface NotificationPrefs {
  version: number; types: NotificationTypePref[]; dnd: NotificationDnd; snooze_until: string | null; quiet_now: boolean;
  org: { allow_personal: boolean; allow_dnd: boolean; dedupe_minutes: number };
}
export interface NotificationDecision { id: number; kind: string; channel: string; reason: 'type_off' | 'duplicate' | 'quiet_mail'; title: string | null; link: string | null; created_at: string }
export interface NotificationPersonalSettings { allow_personal: boolean; allow_dnd: boolean; dedupe_minutes: number; decision_retention_days: number; version: number }
export interface NotificationPrefsInput {
  types?: Record<string, { in_app?: boolean; email?: boolean }>;
  dnd?: { enabled?: boolean; start?: number; end?: number; days?: number[]; timezone?: string | null };
}

const KEY = ['notificationPrefs'];
export const useMyNotificationPrefs = () => useQuery({ queryKey: KEY, queryFn: () => api.get<NotificationPrefs>('/me/notification-prefs') });
export const useMyNotificationDecisions = () => useQuery({ queryKey: ['notificationDecisions'], queryFn: () => api.get<{ items: NotificationDecision[] }>('/me/notification-prefs/decisions').then((r) => r.items) });

export const useSaveNotificationPrefs = () => {
  const qc = useQueryClient();
  return useMutation<NotificationPrefs, ApiError, { version: number; body: NotificationPrefsInput }>({
    mutationFn: ({ version, body }) => api.put('/me/notification-prefs', { version, body }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: KEY }); },
  });
};
export const useSnoozeNotifications = () => {
  const qc = useQueryClient();
  return useMutation<NotificationPrefs, ApiError, { until: string | null }>({
    mutationFn: (body) => api.post('/me/notification-prefs/snooze', { body }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: KEY }); },
  });
};
export const useTestNotification = () => {
  const qc = useQueryClient();
  return useMutation<{ notification_id: string; quiet_now: boolean }, ApiError, void>({
    mutationFn: () => api.post('/me/notification-prefs/test'),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['notifications'] }); void qc.invalidateQueries({ queryKey: ['notificationDecisions'] }); },
  });
};

export const useNotificationPersonalSettings = () => useQuery({ queryKey: ['notificationPersonalSettings'], queryFn: () => api.get<NotificationPersonalSettings>('/admin/notification-personal') });
export const useSetNotificationPersonalSettings = () => {
  const qc = useQueryClient();
  return useMutation<NotificationPersonalSettings, ApiError, { version: number; body: Partial<Omit<NotificationPersonalSettings, 'version'>> & { reason: string } }>({
    mutationFn: ({ version, body }) => api.put('/admin/notification-personal', { version, body }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['notificationPersonalSettings'] }); void qc.invalidateQueries({ queryKey: KEY }); },
  });
};
