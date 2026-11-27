import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { components } from './schema';

type S = components['schemas'];
export type DashboardShareLink = S['DashboardShareLink'];
export type DashboardShareResolve = S['DashboardShareResolve'];

export interface ShareCreateBody {
  label?: string;
  params: Record<string, string>;
  days?: number;
  reason: string;
}

/** Dashboard share links (0.15.501): durable, revocable envelopes for a read-only dashboard view. The opener signs in and sees their own data. */
export const useShareLinks = (enabled = true) =>
  useQuery({
    queryKey: ['dashboard-share-links'],
    enabled,
    retry: false,
    queryFn: () => api.get<{ items: DashboardShareLink[] }>('/dashboard/share-links').then((r) => r.items),
  });

export const useCreateShareLink = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ShareCreateBody) => api.post<DashboardShareLink & { token: string; path: string }>('/dashboard/share-links', { body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['dashboard-share-links'] }),
  });
};

export const useRevokeShareLink = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post(`/dashboard/share-links/${id}/revoke`, { body: { reason } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['dashboard-share-links'] }),
  });
};

/** The envelope of an opened link (label + dashboard query). 404 unknown, 410 expired or revoked. */
export const useResolveShareLink = (token: string) =>
  useQuery({
    queryKey: ['dashboard-shared', token],
    retry: false,
    staleTime: Infinity,
    queryFn: () => api.get<DashboardShareResolve>(`/dashboard/shared/${token}`),
  });
