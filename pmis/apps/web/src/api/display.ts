import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { components } from './schema';
import { DISPLAY_SEED, type Display } from '@/lib/tablePrefs';

/** W8 item 4 (contract 0.15.64, migration 0148): the defaults of the Display menu, a general setting (Administration > Settings > Display). */
export type TableDisplaySetting = components['schemas']['TableDisplaySetting'];

export const useTableDisplaySetting = (enabled = true) =>
  useQuery({ queryKey: ['table-display'], enabled, staleTime: 300_000, retry: false, queryFn: () => api.get<TableDisplaySetting>('/settings/table-display') });

/** The defaults every site-data table starts from; the seed look while the setting loads or when it cannot be read. */
export function useTableDisplayDefaults(): Display {
  const q = useTableDisplaySetting();
  return q.data?.defaults ? { ...DISPLAY_SEED, ...q.data.defaults } : DISPLAY_SEED;
}

/** PUT /settings/table-display: a System Admin or an all-regions delegate of admin.settings, a reason and If-Match. */
export function useSaveTableDisplay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { defaults: Display; reason: string; version: number }) =>
      api.put<TableDisplaySetting>('/settings/table-display', { version: v.version, body: { defaults: v.defaults, reason: v.reason } }),
    onSuccess: (r) => qc.setQueryData(['table-display'], r),
  });
}
