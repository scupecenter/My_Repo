import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, setCsrfToken } from './client';
import type { LocalUserCreate, LocalUserCreated, Session, UserDetail } from './types';

/** Store a fresh session from a login or password call so the router reacts at once. */
function useAdoptSession() {
  const qc = useQueryClient();
  return (s: Session) => {
    if (s.csrf_token) setCsrfToken(s.csrf_token);
    qc.setQueryData(['session'], s);
    void qc.invalidateQueries({ queryKey: ['me'] });
  };
}

export function useLocalLogin() {
  const adopt = useAdoptSession();
  return useMutation<Session, ApiError, { identifier: string; password: string }>({
    mutationFn: (body) => api.post<Session>('/auth/local/login', { body }),
    onSuccess: adopt,
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

/** Step-up for a local session; resolves when the password was right. */
export const localStepUp = (password: string) => api.post<Session>('/auth/local/step-up', { body: { password } });

/** Field messages from a 422/409 `errors[]`: path `/email` becomes `email`. */
export function fieldErrors(e: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!(e instanceof ApiError)) return out;
  for (const x of e.problem.errors ?? []) (out[x.path.replace(/^\//, '')] ??= []).push(x.code);
  return out;
}
