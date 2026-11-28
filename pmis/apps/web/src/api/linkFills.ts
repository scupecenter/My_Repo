import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from './client';

/** Contract 0.15.648 (migration 0772, automation item 9): the rules "the final approval of a record fills a field of the record it links to" (Settings > Registers). */
export type LinkFill = { register_key: string; link_field: string; target_field: string; source_field: string; sort_order: number; is_active: boolean };
export type LinkFillField = { code: string; label_en: string; label_ar?: string | null; field_type: string };
export type LinkFills = {
  rows: LinkFill[];
  links: { register_key: string; link_field: string; target_register: string; source_fields: LinkFillField[]; target_fields: LinkFillField[] }[];
  version: number; can_edit: boolean;
};
const K = ['link-fills'] as const;

export const useLinkFills = () => useQuery({ queryKey: K, queryFn: () => api.get<LinkFills>('/settings/link-fills') });
export const useSaveLinkFills = () => {
  const qc = useQueryClient();
  return useMutation<LinkFills, ApiError, { version: number; body: { reason: string; rows: Partial<LinkFill>[] } }>({
    mutationFn: ({ version, body }) => api.put('/settings/link-fills', { body, version }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: K }); },
  });
};
