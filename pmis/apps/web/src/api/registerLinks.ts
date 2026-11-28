import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from './client';
import type { components } from './schema';

/**
 * Contract 0.15.586 (migration 0713): Settings > Register links. The catalogue is the D60 table `register_links`: every declared link, switched-off ones included.
 * (The links of one register for the record form come from `useRegisterLinks` in p4c.ts; this is the settings view.)
 */
export type RegisterLinkEntry = components['schemas']['RegisterLinkEntry'];
export type RegisterLinkCatalogue = components['schemas']['RegisterLinkCatalogue'];
const K = ['register-link-catalogue'] as const;

export const useRegisterLinkCatalogue = () => useQuery({ queryKey: K, staleTime: 60_000, queryFn: () => api.get<RegisterLinkCatalogue>('/settings/register-links') });

export function useSaveRegisterLinkCatalogue() {
  const qc = useQueryClient();
  return useMutation<RegisterLinkCatalogue, ApiError, { version?: number; links: RegisterLinkEntry[]; reason: string }>({
    mutationFn: ({ version, ...body }) => api.put('/settings/register-links', { version, body }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: K });
      void qc.invalidateQueries({ queryKey: ['register-links'] });
      void qc.invalidateQueries({ queryKey: ['link-options'] });
    },
  });
}
