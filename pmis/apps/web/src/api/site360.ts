import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { components } from '@/api/schema';

/** SITE 360 menus and the Master columns of each (contract 0.15.21, F15). */
export type Site360Sections = components['schemas']['Site360Sections'];
export type Site360MenuItem = components['schemas']['Site360MenuItem'];
export type Site360Menu = components['schemas']['Site360Menu'];
export type Site360Band = components['schemas']['Site360Band'];
export type Site360Rows = components['schemas']['Site360Rows'];

/** Filters, sort and paging of the grid rows (contract 0.15.21, `GET /site360/{menu}/rows`). Multi values are comma-separated. */
export interface Site360RowsQuery {
  site_code?: string;
  /** 0.15.31 (F3): the AND/OR filter tree as JSON, compiled by the server */
  filter?: string;
  region_id?: string;
  scenario?: string;
  overall_status?: string;
  sort?: string;
  dir?: 'asc' | 'desc';
  offset?: number;
  limit?: number;
}

/** The eight SITE 360 menus in menu order: Master first, then the sections. */
export const SITE360_MENU_KEYS: Site360Menu[] = ['master', 'design_acq', 'sow', 'cw', 'te', 'hoto', 'dismantle', 'om'];

export const useSite360Sections = () =>
  useQuery({ queryKey: ['site360-sections'], queryFn: () => api.get<Site360Sections>('/site360/sections') });

/** One page of a menu's rows with the Master values of its columns; the values are read from the set-based view, one query per page. */
export const useSite360Rows = (menu: string | undefined, query: Site360RowsQuery) =>
  useQuery({
    queryKey: ['site360-rows', menu, query],
    enabled: !!menu,
    queryFn: () => api.get<Site360Rows>(`/site360/${menu}/rows`, { query: { ...query } }),
  });

/** The SITE 360 menus a Master column may be in (the status columns are in every menu and cannot change). */
export const SITE360_MOVABLE_MENUS = ['design_acq', 'sow', 'cw', 'te', 'hoto', 'dismantle', 'om'] as const;

/** Replaces the menus of one Master column (`PATCH /site360/columns/{ord}/sections`): System Admin, a reason, step-up. */
export const useSetSite360ColumnSections = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { ord: number; sections: string[]; reason: string }) =>
      api.patch<unknown>(`/site360/columns/${v.ord}/sections`, { body: { sections: v.sections, reason: v.reason } }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['site360-sections'] });
      void qc.invalidateQueries({ queryKey: ['site360-rows'] });
    },
  });
};

/** The rows of a menu, page after page (200 at a time, the API maximum): each page is one query on the set-based view. */
export const useSite360RowsPaged = (menu: string | undefined, query: Omit<Site360RowsQuery, 'offset'>) => {
  const limit = 200;
  return useInfiniteQuery({
    queryKey: ['site360-rows-paged', menu, query],
    enabled: !!menu,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.get<Site360Rows>(`/site360/${menu}/rows`, { query: { ...query, offset: pageParam, limit } }),
    getNextPageParam: (last) => (last.offset + last.limit < last.filtered ? last.offset + last.limit : undefined),
  });
};

/** Saves an inline edit of a task-backed cell through the task entry (`PATCH /tasks/{task_id}`, If-Match the task version): the L1 rules, gates and audit of the task screen apply. */
export const useSaveSite360Cell = (menu: string | undefined, query: Omit<Site360RowsQuery, 'offset'>) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { task_id: string; version: number; field?: 'planned_date' | 'actual_date' | 'actual_start'; values?: string; value: string }) => {
      const body = v.field
        ? { [v.field]: v.value === '' ? null : v.value }
        : { values: { [v.values ?? '']: v.value === '' ? null : v.value } };
      return api.patch<unknown>(`/tasks/${v.task_id}`, { body, version: v.version });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['site360-rows-paged', menu, query] });
      void qc.invalidateQueries({ queryKey: ['site360-rows', menu] });
    },
  });
};
