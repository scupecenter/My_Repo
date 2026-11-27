import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from './client';
import type { components } from './schema';

/**
 * Contract 0.15.332 (migration 0431): the one catalogue of the links between registers. The record form draws a picker for every enabled link field, the
 * Related-records panel lists the same links, and the database checks the same links on every write.
 */
export type RegisterLink = components['schemas']['RegisterLink'];
export type RegisterLinks = components['schemas']['RegisterLinks'];
export type LinkOption = { entity_id: string; record_id?: string; title?: string; state?: string; record_type?: string; site_id?: string | null; po_wo_no?: string; pr_no?: string; external_party?: { name?: string } };
const K = ['register-links'] as const;

export const useRegisterLinks = () => useQuery({ queryKey: K, staleTime: 300_000, queryFn: () => api.get<RegisterLinks>('/settings/register-links') });

export const useLinkOptions = (key: string, field: string, siteId: string | null | undefined, enabled: boolean) =>
  useQuery({
    queryKey: ['link-options', key, field, siteId ?? null], enabled,
    queryFn: () => api.get<{ items: LinkOption[] }>(`/registers/${key}/link-options`, { query: { field, ...(siteId ? { site_id: siteId } : {}) } }).then((r) => r.items),
  });

export function useSaveRegisterLinks() {
  const qc = useQueryClient();
  return useMutation<RegisterLinks, ApiError, { version?: number; links: RegisterLink[]; reason: string }>({
    mutationFn: ({ version, ...body }) => api.put('/settings/register-links', { version, body }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: K }); void qc.invalidateQueries({ queryKey: ['link-options'] }); },
  });
}
