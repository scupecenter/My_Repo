import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from './client';

/** Global search (contract 0.15.19, plan F4). Read only; the server applies visibility per group. */
export type SearchType = 'sites' | 'registers' | 'documents' | 'meetings' | 'people' | 'contractors' | 'tasks' | 'warehouse_items';

export interface SearchHit {
  id: string;
  title: string;
  subtitle: string | null;
  region_id: number | null;
  href: string;
  /** [start, end) offsets into `title` (UTF-16 code units) to highlight. */
  match_ranges: [number, number][];
  /** Documents group: the text around the match inside the file contents; null when the file matched by name (contract 0.15.155). */
  snippet?: string | null;
}

export interface SearchGroup {
  type: SearchType;
  total: number;
  truncated: boolean;
  items: SearchHit[];
}

export interface SearchResponse {
  q: string;
  groups: SearchGroup[];
}

export interface SiteIdLookup {
  found: { id: string; site_code: string; name: string; region_id: number; href: string }[];
  not_found: string[];
}

export const SEARCH_GROUP_ORDER: SearchType[] = ['sites', 'registers', 'documents', 'meetings', 'people', 'contractors', 'tasks', 'warehouse_items'];

/** The global search for one text (2 to 100 characters). */
export const useGlobalSearch = (q: string) =>
  useQuery({
    queryKey: ['global-search', q],
    enabled: q.length >= 2,
    placeholderData: keepPreviousData,
    queryFn: () => api.get<SearchResponse>('/search', { query: { q, limit: 5 } }),
  });

/** Many Site IDs at once. The key is the joined list, so the same paste is answered from the cache. */
export const useSiteIdLookup = (ids: string[]) =>
  useQuery({
    queryKey: ['site-id-lookup', ids.join(',')],
    enabled: ids.length > 0,
    queryFn: () => api.post<SiteIdLookup>('/search/site-ids', { body: { ids } }),
  });
