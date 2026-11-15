import { useQuery } from '@tanstack/react-query';
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
