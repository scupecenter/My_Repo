// The self-service "My profile" page (contract 0.9.2, 0.12.6): details, email and phone change requests, password, two-factor on/off.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, setCsrfToken } from './client';
import type { components } from './schema';
import type { Session, TwoFactorEnrolment, UserDetail } from './types';

type S = components['schemas'];
export type MyProfile = S['MyProfile'];
export type MyProfilePatch = S['MyProfilePatch'];
export type MyTwoFactor = S['MyTwoFactor'];
export type EmailChangeRequest = S['EmailChangeRequest'];
export type EmailChangeRequestAdmin = S['EmailChangeRequestAdmin'];
export type EmailChangeStatus = S['EmailChangeStatus'];
export type PhoneChangeRequest = S['PhoneChangeRequest'];
export type PhoneChangeRequestAdmin = S['PhoneChangeRequestAdmin'];

const PROFILE = ['my-profile'] as const;

export const useMyProfile = () => useQuery({ queryKey: PROFILE, queryFn: () => api.get<MyProfile>('/me/profile') });

/** Refreshes everything that shows the user's own data (the top bar name, the session, the profile). */
function useRefreshSelf() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: PROFILE });
    void qc.invalidateQueries({ queryKey: ['me'] });
    void qc.invalidateQueries({ queryKey: ['session'] });
  };
}

export function useUpdateMyProfile() {
  const qc = useQueryClient();
  const refresh = useRefreshSelf();
  return useMutation<MyProfile, ApiError, { version: number; patch: MyProfilePatch }>({
    mutationFn: ({ version, patch }) => api.patch<MyProfile>('/me/profile', { body: patch, version }),
    onSuccess: (p) => { qc.setQueryData(PROFILE, p); refresh(); },
  });
}

export function useChangeMyPassword() {
  const qc = useQueryClient();
  return useMutation<Session, ApiError, { current_password: string; new_password: string }>({
    mutationFn: (body) => api.post<Session>('/me/password', { body }),
    onSuccess: (s) => { if (s.csrf_token) setCsrfToken(s.csrf_token); qc.setQueryData(['session'], s); },
  });
}

export function useRequestEmailChange() {
  const refresh = useRefreshSelf();
  return useMutation<EmailChangeRequest, ApiError, { new_email: string; password: string }>({
    mutationFn: (body) => api.post<EmailChangeRequest>('/me/email-change', { body }),
    onSuccess: refresh,
  });
}

export function useCancelEmailChange() {
  const refresh = useRefreshSelf();
  return useMutation<void, ApiError, void>({ mutationFn: () => api.del<void>('/me/email-change'), onSuccess: refresh });
}

/** 0.12.6 (Q158): the code mailed to the new address, and a new code. */
export function useVerifyEmailChange() {
  const refresh = useRefreshSelf();
  return useMutation<EmailChangeRequest, ApiError, { code: string }>({
    mutationFn: (body) => api.post<EmailChangeRequest>('/me/email-change/verify', { body }),
    onSuccess: refresh,
  });
}

export function useResendEmailCode() {
  const refresh = useRefreshSelf();
  return useMutation<EmailChangeRequest, ApiError, void>({ mutationFn: () => api.post<EmailChangeRequest>('/me/email-change/resend'), onSuccess: refresh });
}

/** 0.12.6 (D156): the phone is a sign-in identifier; a change is a request an admin approves. `new_phone` null removes it. */
export function useRequestPhoneChange() {
  const refresh = useRefreshSelf();
  return useMutation<PhoneChangeRequest, ApiError, { new_phone: string | null; password: string }>({
    mutationFn: (body) => api.post<PhoneChangeRequest>('/me/phone-change', { body }),
    onSuccess: refresh,
  });
}

export function useCancelPhoneChange() {
  const refresh = useRefreshSelf();
  return useMutation<void, ApiError, void>({ mutationFn: () => api.del<void>('/me/phone-change'), onSuccess: refresh });
}

/** The secret is shown once: it must not stay in the mutation cache (`gcTime: 0`). The step-up is asked by the client handler. */
export const useSelfEnrolStart = () => useMutation<TwoFactorEnrolment, ApiError, void>({ gcTime: 0, mutationFn: () => api.post<TwoFactorEnrolment>('/me/two-factor/enrol/start') });

export function useSelfEnrolConfirm() {
  const refresh = useRefreshSelf();
  return useMutation<{ recovery_codes: string[]; two_factor: MyTwoFactor; other_sessions_ended: number }, ApiError, { code: string }>({
    gcTime: 0,
    mutationFn: (body) => api.post('/me/two-factor/enrol/confirm', { body }),
    onSuccess: refresh,
  });
}

export function useSelfDisableTwoFactor() {
  const refresh = useRefreshSelf();
  return useMutation<MyTwoFactor, ApiError, { password: string; code?: string; recovery_code?: string }>({
    mutationFn: (body) => api.post<MyTwoFactor>('/me/two-factor/disable', { body }),
    onSuccess: refresh,
  });
}

// ------------------------------------------------------------------ admin side
export const useEmailChangeRequests = (enabled: boolean, status: EmailChangeStatus | 'all' = 'pending') =>
  useQuery({ queryKey: ['email-change-requests', status], enabled, retry: false, queryFn: () => api.get<{ items: EmailChangeRequestAdmin[] }>('/email-change-requests', { query: { status } }) });

export function useDecideEmailChange() {
  const qc = useQueryClient();
  return useMutation<EmailChangeRequestAdmin, ApiError, { id: string; decision: 'approve' | 'reject'; reason: string; identity_check?: string }>({
    mutationFn: ({ id, ...body }) => api.post<EmailChangeRequestAdmin>(`/email-change-requests/${id}/decide`, { body }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['email-change-requests'] }); void qc.invalidateQueries({ queryKey: ['users'] }); },
  });
}

export const usePhoneChangeRequests = (enabled: boolean, status: EmailChangeStatus | 'all' = 'pending') =>
  useQuery({ queryKey: ['phone-change-requests', status], enabled, retry: false, queryFn: () => api.get<{ items: PhoneChangeRequestAdmin[] }>('/phone-change-requests', { query: { status } }) });

export function useDecidePhoneChange() {
  const qc = useQueryClient();
  return useMutation<PhoneChangeRequestAdmin, ApiError, { id: string; decision: 'approve' | 'reject'; reason: string }>({
    mutationFn: ({ id, ...body }) => api.post<PhoneChangeRequestAdmin>(`/phone-change-requests/${id}/decide`, { body }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['phone-change-requests'] }); void qc.invalidateQueries({ queryKey: ['users'] }); },
  });
}

export function useSetTwoFactorEnforced(userId: string) {
  const qc = useQueryClient();
  return useMutation<{ two_factor: string; enforced: boolean }, ApiError, { enforced: boolean; reason: string }>({
    mutationFn: (body) => api.put(`/users/${userId}/two-factor/enforced`, { body }),
    onSuccess: (r) => {
      qc.setQueryData<UserDetail>(['user', userId], (u) => (u ? { ...u, two_factor_enforced: r.enforced } : u));
      void qc.invalidateQueries({ queryKey: ['user', userId] });
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
}
