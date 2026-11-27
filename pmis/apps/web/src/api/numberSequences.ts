import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { NumberSequence } from './types';

/** Settings > Documents > Numbering (Q106): the numbering sequences of the warehouse documents and forms. Edit only; a new sequence is made by the system. */
export const useNumberSequences = () =>
  useQuery({ queryKey: ['number-sequences'], queryFn: () => api.get<{ items: NumberSequence[] }>('/number-sequences').then((r) => r.items) });

export type SequencePatch = { pattern?: string; reset?: 'never' | 'yearly'; next_value?: number; region_code?: string | null; is_active?: boolean };
export function useSaveNumberSequence() {
  const qc = useQueryClient();
  return useMutation<NumberSequence, ApiError, { key: string; version: number; patch: SequencePatch; reason: string }>({
    mutationFn: ({ key, version, patch, reason }) => api.patch<NumberSequence>(`/number-sequences/${encodeURIComponent(key)}`, { version, body: { ...patch, reason } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['number-sequences'] }); },
  });
}
