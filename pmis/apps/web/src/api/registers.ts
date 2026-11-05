import { useEffect, useMemo, useRef } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, ApiError, downloadFile } from './client';
import type { ImportBatch, Job, ImportBatchResult, ImportDecisionRequest, ImportRow, Page, RegisterDefinition, RegisterRecord, RegisterRecordInput, RegisterRecordPatch, RegisterRecordState, RegisterRecordStep, Template, UploadedBatch, UserRef } from './types';

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
  // Q131: the record's document slots move with submit, approval and rejection
  void qc.invalidateQueries({ queryKey: ['record-slots', key] });
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

/** Contract 0.13.2 (Q267): a System Admin cancels an approved Quality snag record entered by mistake (reason and step-up; its QC snag is cancelled with it). */
export function useCancelSnagRecord() {
  const qc = useQueryClient();
  return useMutation<RegisterRecord, ApiError, { record: RegisterRecord; reason: string }>({
    mutationFn: ({ record, reason }) => api.post(`/registers/quality/records/${record.id}/cancel-snag`, { version: record.version, body: { reason } }),
    onSuccess: (r) => qc.setQueryData(['register-record', 'quality', r.id], r),
    onSettled: (_d, _e, v) => {
      settle(qc, 'quality', v.record.id);
      void qc.invalidateQueries({ queryKey: ['site-snags'] });   // the QC snag of the record is cancelled with it
    },
  });
}

/** `POST .../claim` and `.../release` (contract 0.4.5): one member of a group level takes the level, or gives it back. If-Match = record version. */
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
/** 0.12.2 (Q221): hand a permit draft to a qualified entry holder, or take over one held by somebody who lost the row. The server decides who and to whom. */
export function useRecordTransfer(key: string) {
  const qc = useQueryClient();
  return useMutation<RegisterRecord, ApiError, { record: RegisterRecord; note?: string }>({
    mutationFn: ({ record, note }) => api.post(`/registers/${key}/records/${record.id}/transfer`, { version: record.version, body: note ? { note } : {} }),
    onSuccess: (r) => qc.setQueryData(['register-record', key, r.id], r),
    onSettled: (_d, _e, v) => settle(qc, key, v.record.id),
  });
}
/** `GET .../history` (contract 0.4.5): the steps of this version, oldest first, auto-skips included. */
export const useRecordHistory = (key: string, id: string | null) =>
  useQuery({ queryKey: ['register-history', key, id], enabled: !!id, retry: false, queryFn: () => api.get<Page<RegisterRecordStep>>(`/registers/${key}/records/${id}/history`) });

/** `GET .../versions`: every version of the logical record, newest first. */
export const useRecordVersions = (key: string, id: string | null) =>
  useQuery({ queryKey: ['register-versions', key, id], enabled: !!id, queryFn: () => api.get<{ items: RegisterRecord[] }>(`/registers/${key}/records/${id}/versions`).then((r) => r.items) });

/** `POST .../versions`: a new version (state `entry`) of an approved record; the approved one stays in force until the new one is approved. */
export function useNewVersion(key: string) {
  const qc = useQueryClient();
  return useMutation<RegisterRecord, ApiError, RegisterRecord>({
    mutationFn: (record) => api.post(`/registers/${key}/records/${record.id}/versions`, { version: record.version }),
    onSettled: (_d, _e, v) => { settle(qc, key, v.id); void qc.invalidateQueries({ queryKey: ['register-versions', key] }); },
  });
}

// ---- template entry (contract 0.7.0: /templates, /import-batches)
export const useTemplates = () => useQuery({ queryKey: ['templates'], staleTime: 60_000, queryFn: () => api.get<{ items: Template[] }>('/templates').then((r) => r.items) });

export type TemplateDownload = { prefill?: boolean; taskId?: string; siteIds?: string[]; regionId?: string };
/** `GET /templates/{id}/download`: a blank copy, or a pre-filled one (the records in force inside the caller's regions). Returns the file name. */
export const downloadTemplate = (templateId: string, o: TemplateDownload = {}): Promise<string> =>
  downloadFile(`/templates/${templateId}/download`, {
    ...(o.prefill ? { prefill: 'true' } : {}), ...(o.taskId ? { task_id: o.taskId } : {}), ...(o.siteIds?.length ? { site_ids: o.siteIds.join(',') } : {}), ...(o.regionId ? { region_id: o.regionId } : {}),
  });

/** How often the batch page polls (ms). A test may lower them. */
export const BATCH_POLL = { parsing: 2000, job: 1500, pending: 4000, processing: 3000 };
/** Rows are waiting for L2 (or for a predecessor): the page keeps the batch fresh so the bar moves as L2 decides. */
const SENT_STATUSES = ['in_approval', 'partially_approved', 'in_review'];
export const batchPending = (b: Pick<ImportBatch, 'status' | 'counts'> | undefined): boolean =>
  !!b && (b.status === 'parsing' || b.status === 'processing' || (SENT_STATUSES.includes(b.status) && (b.counts.pending ?? 0) > 0));

/**
 * The batch of an upload; its status follows the rows and the records they created. It polls while it is parsing, while a big batch is processed in the
 * background (0.14.4, `processing`) and while rows wait for L2, and stops when nothing is pending. While it is processing the rows are refreshed too, so
 * the table follows the chunks; when the processing ends the rows and the lists are refreshed once more.
 */
export function useBatch(id: string) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['import-batch', id], queryFn: () => api.get<ImportBatch>(`/import-batches/${id}`),
    refetchInterval: (x) => { const b = x.state.data; return !b || !batchPending(b) ? false : b.status === 'parsing' ? BATCH_POLL.parsing : b.status === 'processing' ? BATCH_POLL.processing : BATCH_POLL.pending; },
  });
  const status = q.data?.status, done = q.data?.progress?.rows_done;
  const was = useRef(status);
  useEffect(() => {
    if (status === 'processing' || was.current === 'processing') settleBatch(qc, id);
    was.current = status;
  }, [status, done, id, qc]);
  return q;
}

/** `GET /jobs/{id}` of the parse job while the batch is `parsing`; the batch is refreshed when the job ends. */
export function useParseJob(batch: ImportBatch | undefined) {
  const qc = useQueryClient();
  const jobId = batch?.status === 'parsing' ? batch.job_id : null;
  const q = useQuery({
    queryKey: ['job', jobId], enabled: !!jobId, queryFn: () => api.get<Job>(`/jobs/${jobId}`),
    refetchInterval: (x) => { const j = x.state.data; return j && (j.status === 'done' || j.status === 'failed') ? false : BATCH_POLL.job; },
  });
  const ended = q.data?.status === 'done' || q.data?.status === 'failed';
  useEffect(() => { if (ended && batch) void qc.invalidateQueries({ queryKey: ['import-batch', batch.id] }); }, [ended, batch?.id, qc]); // eslint-disable-line react-hooks/exhaustive-deps
  return q.data;
}

/** Every row of the batch: the pages (`next_cursor`) are followed until the last one. The server counts (`b.counts`) are the totals; `items.length` is only what has arrived. */
export function useBatchRows(id: string, enabled: boolean) {
  const q = useInfiniteQuery({
    queryKey: ['import-batch-rows', id], enabled, initialPageParam: '' as string,
    queryFn: ({ pageParam }) => api.get<Page<ImportRow>>(`/import-batches/${id}/rows`, { query: { limit: 200, ...(pageParam ? { cursor: pageParam } : {}) } }),
    getNextPageParam: (last) => last.page.next_cursor ?? undefined,
  });
  const { hasNextPage, isFetching, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = q;
  const pages = q.data?.pages.length ?? 0;
  useEffect(() => { if (hasNextPage && !isFetching && !isFetchNextPageError) void fetchNextPage(); }, [hasNextPage, isFetching, isFetchNextPageError, fetchNextPage, pages]);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  return { items, isSuccess: q.isSuccess, isError: q.isError, loadingMore: q.isSuccess && (hasNextPage || isFetchingNextPage) && !isFetchNextPageError, complete: q.isSuccess && !hasNextPage };
}

export type BatchFilters = { status: string; template_id: string; register_key: string; stream?: string; group_id?: string };
/** `GET /import-batches`: the batches the caller uploaded, or may see through the register's module. */
export const useBatches = (f: BatchFilters, enabled = true) =>
  useQuery({ queryKey: ['import-batches', f], enabled, queryFn: () => api.get<Page<ImportBatch>>('/import-batches', { query: { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), limit: 100 } }) });

const settleBatch = (qc: QueryClient, id: string) => {
  void qc.invalidateQueries({ queryKey: ['import-batch-rows', id] });
  void qc.invalidateQueries({ queryKey: ['import-batches'] });
  void qc.invalidateQueries({ queryKey: ['register-records'] });
};

export function useUploadBatch() {
  const qc = useQueryClient();
  return useMutation<UploadedBatch, ApiError, { file: File; template_id: string; task_id?: string; mode?: 'submit' | 'draft'; historical_load_reason?: string }>({
    mutationFn: ({ file, template_id, task_id, mode, historical_load_reason }) => {
      const fd = new FormData();
      fd.append('file', file); fd.append('template_id', template_id);
      if (task_id) fd.append('task_id', task_id);
      if (mode && mode !== 'submit') fd.append('mode', mode);
      if (historical_load_reason) fd.append('historical_load_reason', historical_load_reason);   // Q462 (0.14.3): a System Admin under the open waiver
      return api.post('/import-batches', { body: fd, idempotencyKey: crypto.randomUUID() });
    },
    onSuccess: (b) => { qc.setQueryData(['import-batch', b.id], b); void qc.invalidateQueries({ queryKey: ['import-batches'] }); },
  });
}
/** The uploader sends the checked batch into the normal flow: its valid rows become records waiting for L2 (a self-approval needs the step-up dialog). */
export function useSubmitBatch() {
  const qc = useQueryClient();
  return useMutation<ImportBatchResult, ApiError, ImportBatch>({
    mutationFn: (b) => api.post(`/import-batches/${b.id}/submit`, { version: b.version }),
    onSuccess: (b) => qc.setQueryData(['import-batch', b.id], b),
    onSettled: (_d, _e, b) => settleBatch(qc, b.id),
  });
}
/** Approve, return (with a note) or discard: row by row, or all at once. The server decides every row again; the answer lists held and failed rows. */
export function useDecideBatch() {
  const qc = useQueryClient();
  return useMutation<ImportBatchResult, ApiError, { batch: ImportBatch; req: ImportDecisionRequest }>({
    mutationFn: ({ batch, req }) => api.post(`/import-batches/${batch.id}/decisions`, { version: batch.version, idempotencyKey: crypto.randomUUID(), body: req }),
    onSuccess: (b) => qc.setQueryData(['import-batch', b.id], b),
    onSettled: (_d, _e, v) => settleBatch(qc, v.batch.id),
  });
}
