import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { ImportBatch, ImportDecisionRequest, ImportRow, Page, RegisterDefinition, RegisterRecord, RegisterRecordInput, RegisterRecordPatch, RegisterRecordState, Template, UserRef, WorkflowStep } from './types';

export type RecordFilters = { q: string; region_id: string; state: string; record_type: string; site_id?: string };
export type RecordOp = 'submit' | 'review' | 'approve' | 'reject' | 'void';

/** `GET /registers`: the catalogue with the fields the caller may see (the form is built from it, never hard-coded). */
export const useRegisterDefs = () =>
  useQuery({ queryKey: ['register-defs'], staleTime: 300_000, queryFn: () => api.get<{ items: RegisterDefinition[] }>('/registers').then((r) => r.items) });

export const useRegisterRecords = (key: string, f: RecordFilters) =>
  useInfiniteQuery({
    queryKey: ['register-records', key, f], initialPageParam: '' as string, placeholderData: keepPreviousData,
    queryFn: ({ pageParam }) => api.get<Page<RegisterRecord>>(`/registers/${key}/records`, { query: { ...f, limit: 100, cursor: pageParam } }),
    getNextPageParam: (last) => last.page.next_cursor ?? undefined,
  });

export const useRegisterRecord = (key: string, id: string | null) =>
  useQuery({ queryKey: ['register-record', key, id], enabled: !!id, queryFn: () => api.get<RegisterRecord>(`/registers/${key}/records/${id}`) });

type ListSnap = [readonly unknown[], { pages: Page<RegisterRecord>[]; pageParams: unknown[] } | undefined][];
function patchLists(qc: QueryClient, key: string, fn: (items: RegisterRecord[]) => RegisterRecord[]) {
  const snaps = qc.getQueriesData<{ pages: Page<RegisterRecord>[]; pageParams: unknown[] }>({ queryKey: ['register-records', key] }) as ListSnap;
  for (const [k, d] of snaps) if (d) qc.setQueryData(k, { ...d, pages: d.pages.map((p) => ({ ...p, items: fn(p.items) })) });
  return () => snaps.forEach(([k, d]) => qc.setQueryData(k, d));
}
const settle = (qc: QueryClient, key: string, id?: string) => {
  void qc.invalidateQueries({ queryKey: ['register-records', key] });
  if (id) void qc.invalidateQueries({ queryKey: ['register-record', key, id] });
  void qc.invalidateQueries({ queryKey: ['register-defs'] });
};

/** Create (state `entry`): the new row shows in the list at once and is removed again if the server refuses. */
export function useCreateRecord(key: string) {
  const qc = useQueryClient();
  return useMutation<RegisterRecord, ApiError, RegisterRecordInput & { site_code?: string; region_id?: number }, { rollback: () => void }>({
    mutationFn: ({ site_code: _s, region_id: _r, ...body }) => { void [_s, _r]; return api.post(`/registers/${key}/records`, { body }); },
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['register-records', key] });
      const tmp = { id: `tmp-${Date.now()}`, register_key: key, state: 'entry', data: v.data, version: 0, site_id: v.site_id ?? null, site_code: v.site_code ?? null, region_id: v.region_id ?? null, record_type: v.record_type ?? null, allowed_actions: [] } as unknown as RegisterRecord;
      return { rollback: patchLists(qc, key, (items) => [tmp, ...items]) };
    },
    onError: (_e, _v, ctx) => ctx?.rollback(),
    onSettled: () => settle(qc, key),
  });
}

export function useUpdateRecord(key: string) {
  const qc = useQueryClient();
  return useMutation<RegisterRecord, ApiError, { record: RegisterRecord; patch: RegisterRecordPatch }, { rollback: () => void; before?: RegisterRecord }>({
    mutationFn: ({ record, patch }) => api.patch(`/registers/${key}/records/${record.id}`, { version: record.version, body: patch }),
    onMutate: async ({ record, patch }) => {
      await qc.cancelQueries({ queryKey: ['register-record', key, record.id] });
      const before = qc.getQueryData<RegisterRecord>(['register-record', key, record.id]);
      const next = { ...record, data: { ...record.data, ...(patch.data ?? {}) } };
      qc.setQueryData(['register-record', key, record.id], next);
      return { before, rollback: patchLists(qc, key, (items) => items.map((x) => (x.id === record.id ? next : x))) };
    },
    onSuccess: (r) => qc.setQueryData(['register-record', key, r.id], r),
    onError: (_e, v, ctx) => { ctx?.rollback(); qc.setQueryData(['register-record', key, v.record.id], ctx?.before); },
    onSettled: (_d, _e, v) => settle(qc, key, v.record.id),
  });
}

/** The state the record is expected to reach, so the chip and buttons change before the server answers. */
function expected(r: RegisterRecord, op: RecordOp): RegisterRecordState {
  const L = r.levels_required ?? 3;
  if (op === 'void') return 'voided';
  if (op === 'submit') return L <= 1 ? 'approved' : 'in_review';
  if (op === 'review') return L <= 2 ? 'approved' : 'in_approval';
  if (op === 'approve') return 'approved';
  return r.state === 'in_approval' ? 'in_review' : 'entry';
}

/** Submit, review, approve, reject (note) and void (reason): optimistic, If-Match = record version, rolled back on failure. */
export function useRecordOp(key: string) {
  const qc = useQueryClient();
  return useMutation<RegisterRecord, ApiError, { record: RegisterRecord; op: RecordOp; note?: string }, { rollback: () => void; before?: RegisterRecord }>({
    mutationFn: ({ record, op, note }) =>
      api.post(`/registers/${key}/records/${record.id}/${op}`, { version: record.version, ...(op === 'reject' ? { body: { note } } : op === 'void' ? { body: { reason: note } } : {}) }),
    onMutate: async ({ record, op }) => {
      await qc.cancelQueries({ queryKey: ['register-record', key, record.id] });
      const before = qc.getQueryData<RegisterRecord>(['register-record', key, record.id]);
      const next = { ...record, state: expected(record, op), allowed_actions: [] };
      qc.setQueryData(['register-record', key, record.id], next);
      return { before, rollback: patchLists(qc, key, (items) => items.map((x) => (x.id === record.id ? next : x))) };
    },
    onSuccess: (r) => qc.setQueryData(['register-record', key, r.id], r),
    onError: (_e, v, ctx) => { ctx?.rollback(); qc.setQueryData(['register-record', key, v.record.id], ctx?.before); },
    onSettled: (_d, _e, v) => settle(qc, key, v.record.id),
  });
}

// TODO(contract): claim, release and history of a register record are not in openapi.yaml yet (tasks have them). The shapes below copy
// /tasks/{id}/claim, /release and /history; the mock serves them, the real API does not until tech-lead adds them.
export function useRecordClaim(key: string) {
  const qc = useQueryClient();
  return useMutation<RegisterRecord, ApiError, { record: RegisterRecord; op: 'claim' | 'release' }, { before?: RegisterRecord }>({
    mutationFn: ({ record, op }) => api.post(`/registers/${key}/records/${record.id}/${op}`, { version: record.version }),
    onMutate: async ({ record, op }) => {
      await qc.cancelQueries({ queryKey: ['register-record', key, record.id] });
      const before = qc.getQueryData<RegisterRecord>(['register-record', key, record.id]);
      const me = qc.getQueryData<{ user?: UserRef }>(['session'])?.user;
      if (before?.ball_in_court) qc.setQueryData(['register-record', key, record.id], { ...before, ball_in_court: { ...before.ball_in_court, claimed_by: op === 'claim' ? me : undefined } });
      return { before };
    },
    onSuccess: (r) => qc.setQueryData(['register-record', key, r.id], r),
    onError: (_e, v, ctx) => qc.setQueryData(['register-record', key, v.record.id], ctx?.before),
    onSettled: (_d, _e, v) => settle(qc, key, v.record.id),
  });
}
export const useRecordHistory = (key: string, id: string | null) =>
  useQuery({ queryKey: ['register-history', key, id], enabled: !!id, retry: false, queryFn: () => api.get<Page<WorkflowStep>>(`/registers/${key}/records/${id}/history`) });

// ---- template entry (contract: /templates, /import-batches)
export const useTemplates = () => useQuery({ queryKey: ['templates'], staleTime: 300_000, queryFn: () => api.get<{ items: Template[] }>('/templates').then((r) => r.items) });

/** The batch polls while it parses. */
export const useBatch = (id: string) =>
  useQuery({ queryKey: ['import-batch', id], refetchInterval: (q) => (q.state.data?.status === 'parsing' ? 600 : false), queryFn: () => api.get<ImportBatch>(`/import-batches/${id}`) });
export const useBatchRows = (id: string, enabled: boolean) =>
  useQuery({ queryKey: ['import-batch-rows', id], enabled, queryFn: () => api.get<Page<ImportRow>>(`/import-batches/${id}/rows`, { query: { limit: 200 } }) });

export function useUploadBatch() {
  return useMutation<ImportBatch, ApiError, { file: File; template_id: string }>({
    mutationFn: ({ file, template_id }) => { const fd = new FormData(); fd.append('file', file); fd.append('template_id', template_id); return api.post('/import-batches', { body: fd, idempotencyKey: crypto.randomUUID() }); },
  });
}
export function useSubmitBatch() {
  const qc = useQueryClient();
  return useMutation<ImportBatch, ApiError, ImportBatch>({
    mutationFn: (b) => api.post(`/import-batches/${b.id}/submit`, { version: b.version }),
    onSuccess: (b) => qc.setQueryData(['import-batch', b.id], b),
    onSettled: (_d, _e, b) => { void qc.invalidateQueries({ queryKey: ['import-batch-rows', b.id] }); },
  });
}
/** Row-by-row or all-at-once decision; the rows in the cache change at once and come back if the server refuses. */
export function useDecideBatch() {
  const qc = useQueryClient();
  return useMutation<ImportBatch, ApiError, { batch: ImportBatch; req: ImportDecisionRequest }, { before?: Page<ImportRow> }>({
    mutationFn: ({ batch, req }) => api.post(`/import-batches/${batch.id}/decisions`, { version: batch.version, idempotencyKey: crypto.randomUUID(), body: req }),
    onMutate: async ({ batch, req }) => {
      await qc.cancelQueries({ queryKey: ['import-batch-rows', batch.id] });
      const before = qc.getQueryData<Page<ImportRow>>(['import-batch-rows', batch.id]);
      if (before && req.action !== 'reject') {
        const rows = new Map((req.rows ?? []).map((r) => [r.row_id, r.decision]));
        qc.setQueryData(['import-batch-rows', batch.id], { ...before, items: before.items.map((x) => (x.action === 'error' ? x : req.scope === 'all' && x.decision === 'pending' ? { ...x, decision: 'approved' as const } : rows.has(x.id) ? { ...x, decision: rows.get(x.id)! } : x)) });
      }
      return { before };
    },
    onSuccess: (b) => qc.setQueryData(['import-batch', b.id], b),
    onError: (_e, v, ctx) => qc.setQueryData(['import-batch-rows', v.batch.id], ctx?.before),
    onSettled: (_d, _e, v) => { void qc.invalidateQueries({ queryKey: ['import-batch-rows', v.batch.id] }); void qc.invalidateQueries({ queryKey: ['register-records'] }); },
  });
}
