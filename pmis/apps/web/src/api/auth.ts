import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, setCsrfToken } from './client';
import type { LocalUserCreate, LocalUserCreated, PendingSignIn, RecoveryCodes, Session, TwoFactorEnrolled, TwoFactorEnrolment, TwoFactorState, UserDetail } from './types';

/** Store a fresh session from a login or password call so the router reacts at once. */
function useAdoptSession() {
  const qc = useQueryClient();
  return (s: Session) => {
    if (s.csrf_token) setCsrfToken(s.csrf_token);
    qc.setQueryData(['session'], s);
    void qc.invalidateQueries({ queryKey: ['me'] });
  };
}

export type LoginResult = Session | PendingSignIn;
/** The password was right but a code (or the enrolment) is still to do: no session yet (contract 0.5.0). */
export const isPending = (r: LoginResult): r is PendingSignIn => r.authenticated === false && 'next' in r;

export function useLocalLogin() {
  const adopt = useAdoptSession();
  return useMutation<LoginResult, ApiError, { identifier: string; password: string }>({
    mutationFn: (body) => api.post<LoginResult>('/auth/local/login', { body }),
    onSuccess: (r) => { if (!isPending(r)) adopt(r); },
  });
}

/** Second step of sign-in: a TOTP code or one recovery code. The pending-sign-in cookie travels by itself. */
export function useTwoFactorSignIn() {
  const adopt = useAdoptSession();
  return useMutation<Session, ApiError, { code: string } | { recovery_code: string }>({
    mutationFn: (body) => api.post<Session>('/auth/local/2fa', { body }),
    onSuccess: adopt,
  });
}

/** Secrets must not stay in the mutation cache (`gcTime: 0`). */
export function useEnrolStart() {
  // Contract 0.6.0: the one-time enrolment code is needed before the QR code is shown.
  return useMutation<TwoFactorEnrolment, ApiError, { enrol_code: string }>({ gcTime: 0, mutationFn: (body) => api.post<TwoFactorEnrolment>('/auth/local/2fa/enrol/start', { body }) });
}

/** Confirms the first code. The answer carries the session (adopted here) and the recovery codes (shown once by the caller). */
export function useEnrolConfirm() {
  const adopt = useAdoptSession();
  return useMutation<TwoFactorEnrolled, ApiError, { code: string; enrol_code: string }>({
    gcTime: 0,
    mutationFn: (body) => api.post<TwoFactorEnrolled>('/auth/local/2fa/enrol/confirm', { body }),
    onSuccess: (r) => adopt(r.session),
  });
}

export function useRegenerateRecoveryCodes() {
  const qc = useQueryClient();
  return useMutation<RecoveryCodes, ApiError, { code: string }>({
    gcTime: 0,
    mutationFn: (body) => api.post<RecoveryCodes>('/auth/local/2fa/recovery-codes', { body }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['session'] }); },
  });
}

/** Admin: turn two-factor on or off for a user. The server asks for the step-up (password and code) through the client handler.
 *  Turning it on returns the one-time enrolment code: shown once, so it must not stay in the mutation cache (`gcTime: 0`; the dialog calls `reset()`). */
export function useSetTwoFactor(userId: string) {
  const qc = useQueryClient();
  return useMutation<TwoFactorState, ApiError, { enabled: boolean; reason: string }>({
    gcTime: 0,
    mutationFn: (body) => api.put<TwoFactorState>(`/users/${userId}/two-factor`, { body }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['user', userId] }); void qc.invalidateQueries({ queryKey: ['users'] }); },
  });
}

export function useResetTwoFactor(userId: string) {
  const qc = useQueryClient();
  return useMutation<TwoFactorState, ApiError, { reason: string }>({
    gcTime: 0,
    mutationFn: (body) => api.post<TwoFactorState>(`/users/${userId}/two-factor/reset`, { body }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['user', userId] }); void qc.invalidateQueries({ queryKey: ['users'] }); },
  });
}

/** Admin: a new one-time enrolment code for a user who is waiting for enrolment (the old code stops working). Shown once. */
export function useIssueEnrolCode(userId: string) {
  const qc = useQueryClient();
  return useMutation<TwoFactorState, ApiError, { reason: string }>({
    gcTime: 0,
    mutationFn: (body) => api.post<TwoFactorState>(`/users/${userId}/two-factor/enrol-code`, { body }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['user', userId] }); void qc.invalidateQueries({ queryKey: ['users'] }); },
  });
}

export function useChangePassword() {
  const adopt = useAdoptSession();
  return useMutation<Session, ApiError, { current_password: string; new_password: string }>({
    mutationFn: (body) => api.post<Session>('/auth/local/password', { body }),
    onSuccess: adopt,
  });
}

/** Shown-once secrets must not stay in the mutation cache: `gcTime: 0`, and callers `reset()` when the dialog closes. */
export function useCreateLocalUser() {
  const qc = useQueryClient();
  return useMutation<LocalUserCreated, ApiError, LocalUserCreate>({
    gcTime: 0,
    mutationFn: (body) => api.post<LocalUserCreated>('/users', { body }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['users'] }); },
  });
}

export function useResetPassword(userId: string) {
  const qc = useQueryClient();
  return useMutation<{ temporary_password: string }, ApiError, { reason: string; temporary_password?: string }>({
    gcTime: 0,
    mutationFn: (body) => api.post(`/users/${userId}/password-reset`, { body }),
    // Optimistic: the badges flip at once; rolled back if the server refuses (for example a wrong step-up).
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ['user', userId] });
      const before = qc.getQueryData<UserDetail>(['user', userId]);
      if (before) qc.setQueryData<UserDetail>(['user', userId], { ...before, local_sign_in: true, must_change_password: true });
      return { before };
    },
    onError: (_e, _v, ctx) => { const c = ctx as { before?: UserDetail } | undefined; if (c?.before) qc.setQueryData(['user', userId], c.before); },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['user', userId] }); void qc.invalidateQueries({ queryKey: ['users'] }); },
  });
}

/** Step-up for a local session; resolves when the password (and, when two-factor is on, the code) was right. */
export const localStepUp = (password: string, extra: { code?: string; recovery_code?: string } = {}) => api.post<Session>('/auth/local/step-up', { body: { password, ...extra } });

/** Field messages from a 422/409 `errors[]`: path `/email` becomes `email`. */
export function fieldErrors(e: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!(e instanceof ApiError)) return out;
  for (const x of e.problem.errors ?? []) (out[x.path.replace(/^\//, '')] ??= []).push(x.code);
  return out;
}
