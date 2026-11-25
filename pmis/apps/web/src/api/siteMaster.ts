import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { components } from '@/api/schema';

/** Site Master menus and the Master columns of each (contract 0.15.21, F15). */
export type SiteMasterSections = components['schemas']['SiteMasterSections'];
export type SiteMasterMenuItem = components['schemas']['SiteMasterMenuItem'];
export type SiteMasterMenu = components['schemas']['SiteMasterMenu'];
export type SiteMasterBand = components['schemas']['SiteMasterBand'];
export type SiteMasterRows = components['schemas']['SiteMasterRows'];

/** Filters, sort and paging of the grid rows (contract 0.15.21, `GET /site-master/{menu}/rows`). Multi values are comma-separated. */
export interface SiteMasterRowsQuery {
  /** W8 item 5 (0.15.64): the search box: one token = contains on code and name; a pasted list = exact Site ID or Site Owner ID */
  q?: string;
  site_code?: string;
  /** 0.15.31 (F3): the AND/OR filter tree as JSON, compiled by the server */
  filter?: string;
  region_id?: string;
  scenario?: string;
  /** the stored overall status (comma-separated); the API and the contract name it `status` (audit A finding 11: `overall_status` was ignored) */
  status?: string;
  /** 0.15.50: the filters of the Site Master list, with the same meaning as in GET /sites (stage, mine/late, workflow locks, data gaps) */
  stage_code?: string;
  bucket?: string;
  workflow_locks?: string;
  data_gaps?: string;
  /** the other filters the rows endpoint already takes (comma-separated) */
  sub_region?: string;
  phase?: string;
  batch?: string;
  delivery_model?: string;
  contractor?: string;
  milestone?: string;
  sort?: string;
  dir?: 'asc' | 'desc';
  offset?: number;
  limit?: number;
}

/** The eight Site Master menus in menu order: Master first, then the sections. */
export const SITE_MASTER_MENU_KEYS: SiteMasterMenu[] = ['master', 'design_acq', 'sow', 'cw', 'te', 'hoto', 'dismantle', 'om'];

export const useSiteMasterSections = () =>
  useQuery({ queryKey: ['site-master-sections'], queryFn: () => api.get<SiteMasterSections>('/site-master/sections') });

/** One page of a menu's rows with the Master values of its columns; the values are read from the set-based view, one query per page. */
export const useSiteMasterRows = (menu: string | undefined, query: SiteMasterRowsQuery) =>
  useQuery({
    queryKey: ['site-master-rows', menu, query],
    enabled: !!menu,
    queryFn: () => api.get<SiteMasterRows>(`/site-master/${menu}/rows`, { query: { ...query } }),
  });

/** The source of one Master cell (contract 0.15.35): kind, origin and the ids to open the source record. */
export type SiteMasterCellSource = components['schemas']['SiteMasterCellSource'];
export type SiteMasterSiteSources = components['schemas']['SiteMasterSiteSources'];
export type SiteMasterSourceKind = components['schemas']['SiteMasterSourceKind'];

/** Every Master cell of one site with its value and source (`GET /site-master/sites/{site_id}/sources`); asked per site when a cell is opened, cached. */
export const useSiteMasterSiteSources = (siteId: string | null | undefined, menu?: string) =>
  useQuery({
    queryKey: ['site-master-sources', siteId, menu ?? 'master'],
    enabled: !!siteId,
    staleTime: 30_000,
    queryFn: () => api.get<SiteMasterSiteSources>(`/site-master/sites/${siteId}/sources`, { query: menu ? { menu } : {} }),
  });

/** The app route that opens the source record of a cell, or null when there is none to open (a formula over many rows, a hidden value, not tracked). */
export function siteMasterSourceHref(siteId: string, c: SiteMasterCellSource): string | null {
  if (c.hidden) return null;
  if (c.record_id && c.register_key) return `/registers/${c.register_key}?record=${c.record_id}`;
  if (c.task_id) return `/sites/${siteId}?task=${c.task_id}&row=${c.task_id}`;
  if (c.fed_by) return `/registers/${c.fed_by.register_key}?record=${c.fed_by.record_id}`;
  if (c.kind === 'site' || c.kind === 'custom_field') return `/sites/${siteId}`;
  return null;
}

/** The Site Master menus a Master column may be in (the status columns are in every menu and cannot change). */
export const SITE_MASTER_MOVABLE_MENUS = ['design_acq', 'sow', 'cw', 'te', 'hoto', 'dismantle', 'om'] as const;

/** Replaces the menus of one Master column (`PATCH /site-master/columns/{ord}/sections`): System Admin, a reason, step-up. */
export const useSetSiteMasterColumnSections = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { ord: number; sections: string[]; reason: string }) =>
      api.patch<unknown>(`/site-master/columns/${v.ord}/sections`, { body: { sections: v.sections, reason: v.reason } }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['site-master-sections'] });
      void qc.invalidateQueries({ queryKey: ['site-master-rows'] });
    },
  });
};

/** The rows of a menu, page after page (200 at a time, the API maximum): each page is one query on the set-based view. */
export const useSiteMasterRowsPaged = (menu: string | undefined, query: Omit<SiteMasterRowsQuery, 'offset'>) => {
  const limit = 200;
  return useInfiniteQuery({
    queryKey: ['site-master-rows-paged', menu, query],
    enabled: !!menu,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.get<SiteMasterRows>(`/site-master/${menu}/rows`, { query: { ...query, offset: pageParam, limit } }),
    getNextPageParam: (last) => (last.offset + last.limit < last.filtered ? last.offset + last.limit : undefined),
  });
};

/** One cell edit: the task, its version (If-Match), the field (a date key or a key of the task values) and the new value (an empty text or null clears it). */
export interface SiteMasterCellSave { task_id: string; version: number; field?: 'planned_date' | 'actual_date' | 'actual_start'; values?: string; value: string | number | boolean | null }

/** The one save path of a cell, `PATCH /tasks/{task_id}` with If-Match: used by the single inline edit and, once per site, by the bulk edit (0.15.50). */
export const saveSiteMasterCell = (v: SiteMasterCellSave) => {
  const body = v.field
    ? { [v.field]: v.value === '' || v.value === null ? null : v.value }
    : { values: { [v.values ?? '']: v.value === '' || v.value === null ? null : v.value } };
  return api.patch<unknown>(`/tasks/${v.task_id}`, { body, version: v.version });
};

/** Saves an inline edit of a task-backed cell through the task entry (`PATCH /tasks/{task_id}`, If-Match the task version): the L1 rules, gates and audit of the task screen apply. */
export const useSaveSiteMasterCell = (menu: string | undefined, query: Omit<SiteMasterRowsQuery, 'offset'>) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: saveSiteMasterCell,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['site-master-rows-paged', menu, query] });
      void qc.invalidateQueries({ queryKey: ['site-master-rows', menu] });
    },
  });
};

/** After a bulk edit: the rows of the menu are read again once (not once per saved cell), so the affected rows show their new values and versions. */
export const useRefreshSiteMasterRows = (menu: string | undefined) => {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: ['site-master-rows-paged', menu] }),
    qc.invalidateQueries({ queryKey: ['site-master-rows', menu] }),
  ]);
};
