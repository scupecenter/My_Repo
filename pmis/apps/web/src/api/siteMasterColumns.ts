import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { components } from './schema';

type S = components['schemas'];

/** Contract 0.15.43 (Workflow Studio S2): the Site Master columns as an admin manages them. */
export type ColumnAdmin = S['SiteMasterColumnAdmin'];
export type ColumnDetail = S['SiteMasterColumnDetail'];
export type ColumnList = S['SiteMasterColumnList'];
export type ColumnType = S['SiteMasterColumnType'];
export type ColumnCreate = S['SiteMasterColumnCreate'];
/** `confirm_unconvertible` has a default in the contract: optional here. */
export type ColumnUpdate = Omit<S['SiteMasterColumnUpdate'], 'confirm_unconvertible'> & { confirm_unconvertible?: boolean };
export type MenuKey = NonNullable<ColumnCreate['sections']>[number];
export type ColumnTypePreview = S['SiteMasterColumnTypePreview'];
export type ColumnDeleted = S['SiteMasterColumnDeleted'];
export type SiteCustomFieldDef = S['CustomFieldDefinition'];

export const COLUMN_TYPES: ColumnType[] = ['text', 'number', 'date', 'list', 'yes_no'];
/** The inputs of a task that a column can read (the contract's `field_key` pattern); any other input is `v:<key>`. */
export const TASK_INPUT_KEYS = ['planned_date', 'planned_start', 'actual_start', 'actual_date', 'submitted_date', 'approved_date', 'external_party'] as const;

/** Every column with its place, type, list, source, menus and protection. Only a System Admin (or a `fields` delegate) reads it: 403 otherwise. */
export const useColumnAdmin = () =>
  useQuery({ queryKey: ['site-master-columns'], retry: false, queryFn: () => api.get<ColumnList>('/site-master/columns') });

/** One column with its usage (`delete_mode` says whether DELETE is allowed). Asked only for the added columns. */
export const useColumnDetails = (ords: number[]) =>
  useQuery({
    queryKey: ['site-master-column-details', ords.join(',')],
    enabled: ords.length > 0,
    retry: false,
    queryFn: async () => {
      const rows = await Promise.all(ords.map((o) => api.get<ColumnDetail>(`/site-master/columns/${o}`)));
      return Object.fromEntries(rows.map((r) => [r.ord, r])) as Record<number, ColumnDetail>;
    },
  });

/** The site custom fields, to feed a column from one (the ones that carry no Master column yet are the choice). */
export const useSiteCustomFields = (enabled = true) =>
  useQuery({ queryKey: ['custom-fields', 'site'], enabled, retry: false, queryFn: () => api.get<{ items: SiteCustomFieldDef[] }>('/custom-fields', { query: { entity_type: 'site' } }).then((r) => r.items) });

/** The preview writes nothing: a mutation only because it is a POST with a body. */
export const usePreviewColumnType = () =>
  useMutation<ColumnTypePreview, ApiError, { ord: number; value_type: ColumnType; list_catalogue?: string | null }>({
    mutationFn: ({ ord, ...body }) => api.post(`/site-master/columns/${ord}/type-preview`, { body }),
  });

/**
 * After any write (or a refused one: 409, 412) the columns are read again, so the next attempt carries the current version. `patch` is the optimistic change
 * of one column in the cached list: it shows at once and is put back when the write fails.
 */
function useColumnWrite<I extends { ord?: number }, O>(run: (input: I) => Promise<O>, patch?: (input: I) => Partial<ColumnAdmin>) {
  const qc = useQueryClient();
  return useMutation<O, ApiError, I, { prev?: ColumnList }>({
    mutationFn: run,
    onMutate: async (input) => {
      if (!patch || input.ord === undefined) return {};
      await qc.cancelQueries({ queryKey: ['site-master-columns'] });
      const prev = qc.getQueryData<ColumnList>(['site-master-columns']);
      if (prev) qc.setQueryData<ColumnList>(['site-master-columns'], { ...prev, items: prev.items.map((x) => (x.ord === input.ord ? { ...x, ...patch(input) } : x)) });
      return { prev };
    },
    onError: (_e, _i, ctx) => { if (ctx?.prev) qc.setQueryData(['site-master-columns'], ctx.prev); },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['site-master-columns'] });
      void qc.invalidateQueries({ queryKey: ['site-master-column-details'] });
      void qc.invalidateQueries({ queryKey: ['site-master-sections'] });
      void qc.invalidateQueries({ queryKey: ['site-master-rows'] });
      void qc.invalidateQueries({ queryKey: ['custom-fields'] });
      void qc.invalidateQueries({ queryKey: ['task-definitions'] });
    },
  });
}

export const useCreateColumn = () => useColumnWrite<ColumnCreate & { ord?: number }, ColumnDetail>((body) => api.post('/site-master/columns', { body }));
/** `version` is the column's version as read (sent as If-Match). */
export const useUpdateColumn = () =>
  useColumnWrite<{ ord: number; version: number; body: ColumnUpdate }, ColumnDetail>(({ ord, version, body }) => api.patch(`/site-master/columns/${ord}`, { version, body }),
    ({ body }) => ({ ...(body.name_en !== undefined ? { name_en: body.name_en } : {}), ...(body.name_ar !== undefined ? { name_ar: body.name_ar } : {}) }));
export const useDeactivateColumn = () => useColumnWrite<{ ord: number; version: number; reason: string }, ColumnDetail>(({ ord, version, reason }) => api.post(`/site-master/columns/${ord}/deactivate`, { version, body: { reason } }), () => ({ is_active: false }));
export const useReactivateColumn = () => useColumnWrite<{ ord: number; version: number; reason: string }, ColumnDetail>(({ ord, version, reason }) => api.post(`/site-master/columns/${ord}/reactivate`, { version, body: { reason } }), () => ({ is_active: true }));
export const useDeleteColumn = () => useColumnWrite<{ ord: number; version: number; reason: string }, ColumnDeleted>(({ ord, version, reason }) => api.del(`/site-master/columns/${ord}`, { version, query: { reason } }));
export const useColumnSections = () =>
  useColumnWrite<{ ord: number; sections: MenuKey[]; reason: string }, unknown>(({ ord, sections, reason }) => api.patch(`/site-master/columns/${ord}/sections`, { body: { sections, reason } }), ({ sections }) => ({ sections }));
