import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { components } from './schema';
import type { Page } from './types';

type S = components['schemas'];
export type UserInvitation = S['UserInvitation'];
export type UserInvitationCreate = S['UserInvitationCreate'];
export type UserInvitationAssignment = S['UserInvitationAssignment'];
export type InvitationPreview = S['InvitationPreview'];
export type InvitationAccepted = S['InvitationAccepted'];

/** Admin list (`GET /users/invitations`), newest first. */
export const useInvitations = (f: { q: string; status: string }, enabled = true) =>
  useQuery({
    queryKey: ['invitations', f], enabled,
    queryFn: () => api.get<Page<UserInvitation>>('/users/invitations', { query: { q: f.q || undefined, status: f.status || undefined, limit: 200 } }),
  });

export function useCreateInvitation() {
  const qc = useQueryClient();
  return useMutation<UserInvitation, ApiError, UserInvitationCreate>({
    mutationFn: (body) => api.post<UserInvitation>('/users/invitations', { body }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['invitations'] }); },
  });
}

export function useInvitationAction(kind: 'resend' | 'revoke') {
  const qc = useQueryClient();
  return useMutation<UserInvitation, ApiError, { id: string; reason: string }>({
    mutationFn: ({ id, reason }) => api.post<UserInvitation>(`/users/invitations/${id}/${kind}`, { body: { reason } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['invitations'] }); },
  });
}

/** Public: what the accept page shows. Any failure is the same 404, so there is no retry. */
export const useInvitationPreview = (token: string) =>
  useQuery({ queryKey: ['invitation-preview', token], retry: false, staleTime: Infinity, queryFn: () => api.get<InvitationPreview>(`/invitations/${encodeURIComponent(token)}`) });

export const useAcceptInvitation = (token: string) =>
  useMutation<InvitationAccepted, ApiError, { password: string }>({
    gcTime: 0,
    mutationFn: (body) => api.post<InvitationAccepted>(`/invitations/${encodeURIComponent(token)}/accept`, { body }),
  });
