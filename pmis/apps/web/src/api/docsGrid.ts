import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

/** The documents grid (contract 0.15.14, `/documents/grid`, migration 0097). Types follow the contract by hand: the grid's schemas are inline in the paths. */
export const GRID_STATUSES = ['missing', 'pending', 'approved', 'expired', 'rejected', 'not_required', 'generatable', 'blocked', 'not_applicable'] as const;
export type GridStatus = (typeof GRID_STATUSES)[number];
export interface GridColumn { doc_code: string; name_en: string; name_ar: string | null; kind: string; generated: boolean; group_key: string; group_label: string }
export interface GridCell { status: GridStatus; reason: string | null; slots: number; files: number }
export interface GridRow { site_id: string; site_code: string; site_name: string | null; region_id: number; download_allowed: boolean; cells: Record<string, GridCell> }
export interface GridFilters { site_code?: string; region_id?: number[]; stage_code?: string; doc_code?: string[]; status?: GridStatus; uploaded_from?: string; uploaded_to?: string }
export interface GridPage { columns: GridColumn[]; rows: GridRow[]; page: { limit: number; next_cursor: string | null } }

const clean = (f: GridFilters) => ({ ...f, site_code: f.site_code?.trim() ? f.site_code.trim() : undefined });

export function useDocsGrid(filters: GridFilters) {
  return useInfiniteQuery({
    queryKey: ['docs-grid', clean(filters)],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.get<GridPage>('/documents/grid', { query: { ...clean(filters), limit: 50, cursor: pageParam } }),
    getNextPageParam: (last) => last.page.next_cursor ?? undefined,
  });
}

export const useDocsGridView = () =>
  useQuery({ queryKey: ['docs-grid-view'], queryFn: () => api.get<{ columns: string[] }>('/documents/grid/view').then((r) => r.columns) });

export function useSaveDocsGridView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (columns: string[]) => api.put<void>('/documents/grid/view', { body: { columns } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['docs-grid-view'] }),
  });
}

export function useMarkNotRequired() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { site_id: string; doc_code: string; reason: string }) =>
      api.post<{ id: string; slots_changed: number }>(`/sites/${v.site_id}/document-overrides`, { body: { doc_code: v.doc_code, reason: v.reason } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['docs-grid'] }),
  });
}
