import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from './client';

export interface MyPush { enabled: boolean; public_key: string | null; count: number; this_browser: boolean }
export interface PushAdminStatus { enabled: boolean; subscriptions: number; users: number; last_pushed_at: string | null }

/** 0.15.156: Web Push of the signed-in person's own browsers. Off until the server has its VAPID keys. */
export const useMyPush = (endpoint: string | null) => useQuery({
  queryKey: ['myPush', endpoint],
  queryFn: () => api.get<MyPush>('/me/push', { query: { endpoint: endpoint ?? undefined } }),
});
export const useAdminWebPush = () => useQuery({ queryKey: ['adminWebPush'], queryFn: () => api.get<PushAdminStatus>('/admin/web-push') });

export const usePushSubscribe = () => {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, { endpoint: string; keys: { p256dh: string; auth: string }; user_agent?: string }>({
    mutationFn: (body) => api.post('/me/push/subscribe', { body }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['myPush'] }); },
  });
};
export const usePushUnsubscribe = () => {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, { endpoint: string }>({
    mutationFn: (body) => api.post('/me/push/unsubscribe', { body }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['myPush'] }); },
  });
};

/** The base64url public key as the bytes the browser wants. */
export function keyBytes(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
export const pushSupported = (): boolean => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window;
