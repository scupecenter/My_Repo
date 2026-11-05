import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { components } from './schema';

type S = components['schemas'];
export type HistoricalWaiver = S['HistoricalWaiver'];
export type HistoricalWaiverInput = S['HistoricalWaiverInput'];
export type HistoricalLoadMark = S['HistoricalLoadMark'];
export type TaskHistoricalLoad = S['TaskHistoricalLoad'];

/** Q462 (contract 0.14.3): the one-time historical-load document waiver. Any signed-in user may read it; only a System Admin opens or closes it. */
export const useHistoricalWaiver = (enabled = true) =>
  useQuery({ queryKey: ['historical-waiver'], enabled, retry: false, staleTime: 30_000, queryFn: () => api.get<HistoricalWaiver>('/settings/historical-waiver') });

/** Open or close the waiver (a reason; the step-up dialog opens when the server asks). */
export function useSetHistoricalWaiver() {
  const qc = useQueryClient();
  return useMutation<HistoricalWaiver, ApiError, HistoricalWaiverInput>({
    mutationFn: (body) => api.put('/settings/historical-waiver', { body }),
    onSuccess: (w) => { qc.setQueryData(['historical-waiver'], w); },
  });
}

/**
 * The "historical load: accept without documents" option of the batch screens: the waiver while it is open and the caller may use it (a System Admin), else null.
 * `enabled` false (a register template, a draft) asks nothing.
 */
export function useHistoricalOffer(enabled = true): HistoricalWaiver | null {
  const q = useHistoricalWaiver(enabled);
  return enabled && q.data?.open && q.data.can_manage ? q.data : null;
}
