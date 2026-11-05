import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api, ApiError, downloadFile } from './client';
import type { components } from './schema';

type S = components['schemas'];
export type MasterImportRun = S['MasterImportRun'];
export type MasterImportDiff = S['MasterImportDiff'];
export type MasterImportOutcome = S['MasterImportOutcome'];
export type TemplateMapping = S['TemplateMapping'];
export type TemplateTaskField = S['TemplateTaskField'];
export type TemplateMappingChange = S['TemplateMappingChange'];
export type TemplateMappingResult = S['TemplateMappingResult'];
export type ImportAlias = S['ImportAlias'];
export type ImportAliasInput = S['ImportAliasInput'];
type Page<T> = { items: T[]; page: { limit: number; next_cursor: string | null } };

export type DiffFilters = { kind: string; reason: string; resolution: string; site_code: string };

/** Q1 / Q211 (contract 0.12.8): the legacy Master import runs (System Admin or a delegate of templates administer). */
export const useMasterRuns = () => useQuery({ queryKey: ['master-runs'], retry: false, queryFn: () => api.get<Page<MasterImportRun>>('/master-import/runs', { query: { limit: 50 } }) });
export type MasterImportRunProgress = S['MasterImportRunProgress'];
/** 0.14.6: how often an applied run whose batches are sent in the background is read again. */
export const RUN_POLL = { ms: 3000 };
/** The run; while its batches are sent in the background (`progress.state` running) it is read again every 3 s, and the batch lists once more when it ends. */
export function useMasterRun(id: string | undefined) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['master-run', id], enabled: !!id, retry: false, queryFn: () => api.get<MasterImportRun>(`/master-import/runs/${id}`),
    refetchInterval: (x) => (x.state.data?.progress?.state === 'running' ? RUN_POLL.ms : false),
  });
  const was = useRef<string | undefined>(undefined);
  const st = q.data?.progress?.state;
  useEffect(() => {
    if (was.current === 'running' && st && st !== 'running') {
      void qc.invalidateQueries({ queryKey: ['import-batches'] });
      void qc.invalidateQueries({ queryKey: ['master-runs'] });
    }
    was.current = st;
  }, [st, qc]);
  return q;
}
export const useMasterDiffs = (id: string | undefined, f: DiffFilters) =>
  useQuery({
    queryKey: ['master-diffs', id, f], enabled: !!id, placeholderData: keepPreviousData,
    queryFn: () => api.get<Page<MasterImportDiff>>(`/master-import/runs/${id}/diffs`, { query: { ...f, limit: 200 } }),
  });

export function useUploadLegacyMaster() {
  const qc = useQueryClient();
  return useMutation<MasterImportRun, ApiError, File>({
    mutationFn: (file) => { const fd = new FormData(); fd.append('file', file); return api.post('/master-import/runs', { body: fd }); },
    onSuccess: (r) => { qc.setQueryData(['master-run', r.id], r); void qc.invalidateQueries({ queryKey: ['master-runs'] }); },
  });
}

/** Apply a previewed run (reason; the step-up dialog opens when the server asks). */
export function useApplyRun() {
  const qc = useQueryClient();
  return useMutation<MasterImportRun & { outcome?: MasterImportOutcome }, ApiError, { run: MasterImportRun; mode: 'submit' | 'draft'; reason: string; historical_load?: { reason: string } }>({
    mutationFn: ({ run, mode, reason, historical_load }) => api.post(`/master-import/runs/${run.id}/apply`, { version: run.version, body: { mode, reason, ...(historical_load ? { historical_load } : {}) } }),
    onSuccess: (r) => { qc.setQueryData(['master-run', r.id], r); void qc.invalidateQueries({ queryKey: ['master-runs'] }); void qc.invalidateQueries({ queryKey: ['import-batches'] }); },
  });
}

export function useResolveDiff() {
  const qc = useQueryClient();
  return useMutation<MasterImportDiff, ApiError, { id: string; resolution: string; note?: string }>({
    mutationFn: ({ id, resolution, note }) => api.patch(`/master-import/diffs/${id}`, { body: { resolution, ...(note ? { note } : {}) } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['master-diffs'] }),
  });
}

/** The comparison report as XLSX (same filters as the screen). */
export const exportDiffs = (id: string, f: Partial<DiffFilters>) => downloadFile(`/master-import/runs/${id}/export`, Object.fromEntries(Object.entries(f).filter(([, v]) => !!v)));
export const downloadOriginal = (id: string) => downloadFile(`/master-import/runs/${id}/file`);

/** Q207: the template mapping screen. */
export const useTemplateMapping = () => useQuery({ queryKey: ['template-mapping'], retry: false, queryFn: () => api.get<TemplateMapping>('/template-mapping') });
export function useSaveMapping() {
  const qc = useQueryClient();
  return useMutation<TemplateMappingResult, ApiError, { changes: TemplateMappingChange[]; reason: string; dry_run: boolean }>({
    mutationFn: (body) => api.post('/template-mapping', { body }),
    onSuccess: (r) => { if (!r.dry_run) { void qc.invalidateQueries({ queryKey: ['template-mapping'] }); void qc.invalidateQueries({ queryKey: ['templates'] }); } },
  });
}

/** Q8 / Q10: the role and region aliases of the import. */
export const useImportAliases = (kind: 'region' | 'role') =>
  useQuery({ queryKey: ['import-aliases', kind], queryFn: () => api.get<{ items: ImportAlias[]; can_edit: boolean }>('/import-aliases', { query: { kind } }) });
export function useSaveAlias() {
  const qc = useQueryClient();
  return useMutation<ImportAlias, ApiError, ImportAliasInput>({
    mutationFn: (body) => api.put('/import-aliases', { body }),
    onSuccess: (_r, v) => void qc.invalidateQueries({ queryKey: ['import-aliases', v.kind] }),
  });
}
