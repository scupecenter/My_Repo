import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, downloadFile, fetchText } from './client';
import type { components } from './schema';
import type { Job } from './types';
import { trackRealJob } from '@/lib/hybrid';

/**
 * W5 of plan 2026-11-23-next-ui-cleanup (contract 0.15.70): the Library menu. Forms lists the approved forms; a user with the right previews,
 * generates, downloads or prints a filled document of a site (it enters the Archive as "generated"). Archive shows one card per document type
 * and a list of every document of that type with its lifecycle. Settings > Documents holds the form templates and the Archive settings.
 */
type S = components['schemas'];
export type LibraryForm = S['LibraryForm'];
export type LibraryFormTemplate = S['LibraryFormTemplate'];
export type LibraryGeneratedDocument = S['LibraryGeneratedDocument'];
export type LibraryArchive = S['LibraryArchive'];
export type LibraryArchiveCard = S['LibraryArchiveCard'];
export type LibraryArchiveRow = S['LibraryArchiveRow'];
export type LibraryDocStatus = S['LibraryDocStatus'];
export type LibraryArchiveSetting = S['LibraryArchiveSetting'];
export type LibraryArchiveConfig = S['LibraryArchiveConfig'];
export type ArchiveRowsPage = { items: LibraryArchiveRow[]; page: { limit: number; next_cursor: string | null }; counts: { total: number; filtered: number }; search?: { pasted: number; found: number; not_found: string[] } };

export const DOC_STATUSES: readonly LibraryDocStatus[] = ['due', 'generated', 'signed_uploaded', 'in_review', 'approved', 'rejected', 'superseded'];
export const ARCHIVE_COLUMNS = ['site', 'site_name', 'region', 'cluster', 'doc_type', 'doc_number', 'version', 'status', 'task', 'uploaded_by', 'uploaded_at', 'approved_by', 'approved_at', 'signed', 'stamped'] as const;

export const useLibraryForms = () => useQuery({ queryKey: ['library-forms'], queryFn: () => api.get<{ items: LibraryForm[]; can_configure: boolean }>('/library/forms') });

export const usePreviewForm = () =>
  useMutation<{ html: string; task_id: string | null; warnings: string[] }, ApiError, { templateId: string; siteId: string }>({
    mutationFn: ({ templateId, siteId }) => api.post(`/library/forms/${templateId}/preview`, { body: { site_id: siteId } }),
  });

export function useGenerateDocument() {
  const qc = useQueryClient();
  return useMutation<LibraryGeneratedDocument, ApiError, { templateId: string; siteId: string; remarks?: string }>({
    mutationFn: ({ templateId, siteId, remarks }) => api.post(`/library/forms/${templateId}/generate`, { body: { site_id: siteId, ...(remarks ? { remarks } : {}) }, idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['library-archive'] }); void qc.invalidateQueries({ queryKey: ['library-rows'] }); },
  });
}

export function useVoidDocument() {
  const qc = useQueryClient();
  return useMutation<LibraryGeneratedDocument, ApiError, { id: string; reason: string }>({
    mutationFn: ({ id, reason }) => api.post(`/library/generated/${id}/void`, { body: { reason } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['library-archive'] }); void qc.invalidateQueries({ queryKey: ['library-rows'] }); },
  });
}

/** The stored copy of a generated document, as text (the server audits every read with its purpose). */
export const generatedHtml = (id: string, purpose: 'view' | 'print') => fetchText(`/library/generated/${id}/download`, { purpose });
export const downloadGenerated = (id: string) => downloadFile(`/library/generated/${id}/download`, { purpose: 'download' });

/**
 * Prints a form from a frame that runs no script (sandbox without allow-scripts; the parent calls print on it, which a same-origin sandbox allows).
 * The served file also carries a CSP without scripts or network.
 */
export function printHtml(html: string) {
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-same-origin allow-modals');
  f.setAttribute('aria-hidden', 'true');
  f.style.position = 'fixed';
  f.style.width = '0';
  f.style.height = '0';
  f.style.border = '0';
  f.srcdoc = html;
  f.onload = () => {
    try { f.contentWindow?.focus(); f.contentWindow?.print(); } finally { setTimeout(() => f.remove(), 60_000); }
  };
  document.body.append(f);
}

export const useArchive = () => useQuery({ queryKey: ['library-archive'], queryFn: () => api.get<LibraryArchive>('/library/archive') });

export interface ArchiveQuery { doc_code?: string; site_id?: string; q?: string; filter?: string; status?: string; include_superseded?: boolean }
const rowsQuery = (q: ArchiveQuery) => ({ doc_code: q.doc_code || undefined, site_id: q.site_id || undefined, q: q.q?.trim() || undefined, filter: q.filter || undefined,
  status: q.status || undefined, include_superseded: q.include_superseded ? 'true' : undefined });

export const useArchiveRows = (q: ArchiveQuery, enabled = true) =>
  useInfiniteQuery({
    queryKey: ['library-rows', rowsQuery(q)],
    enabled,
    initialPageParam: '' as string,
    queryFn: ({ pageParam }) => api.get<ArchiveRowsPage>('/library/archive/rows', { query: { ...rowsQuery(q), limit: 100, cursor: pageParam || undefined } }),
    getNextPageParam: (p) => p.page.next_cursor ?? undefined,
  });

/** Bulk zip of the filtered Archive list: the server picks the files (limit of Settings > Documents > Archive), the existing zip export builds it; poll, then download (audited). */
export async function archiveZip(q: ArchiveQuery, wait = 500): Promise<string> {
  const b = rowsQuery(q);
  const body = Object.fromEntries(Object.entries({ ...b, include_superseded: q.include_superseded || undefined }).filter(([, v]) => v !== undefined));
  const job = await api.post<Job>('/library/archive/zip', { body, idempotencyKey: crypto.randomUUID() });
  trackRealJob(job.id);
  for (let i = 0; i < 600; i++) {
    const j = await api.get<Job>(`/jobs/${job.id}`);
    if (j.status === 'failed') throw new ApiError(500, j.error ?? ({ type: 'about:blank', title: 'Export failed', status: 500, code: 'unknown' } as never));
    if (j.status === 'done') return downloadFile(`/exports/zip/${job.id}/download`);
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new Error('export timeout');
}

/** Every row of the current view (Export current view): the pages of the server's filtered set, up to 10000 rows. */
export async function allArchiveRows(q: ArchiveQuery): Promise<LibraryArchiveRow[]> {
  const out: LibraryArchiveRow[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const p = await api.get<ArchiveRowsPage>('/library/archive/rows', { query: { ...rowsQuery(q), limit: 200, cursor } });
    out.push(...p.items);
    if (!p.page.next_cursor) break;
    cursor = p.page.next_cursor;
  }
  return out;
}

export const useArchiveSetting = () => useQuery({ queryKey: ['library-archive-setting'], queryFn: () => api.get<LibraryArchiveSetting>('/settings/library-archive') });
export function useSaveArchiveSetting() {
  const qc = useQueryClient();
  return useMutation<LibraryArchiveSetting, ApiError, LibraryArchiveConfig & { reason: string; version: number }>({
    mutationFn: ({ version, ...body }) => api.put('/settings/library-archive', { version, body }),
    onSuccess: (r) => { qc.setQueryData(['library-archive-setting'], r); void qc.invalidateQueries({ queryKey: ['library-archive'] }); },
  });
}

export const useFormTemplates = (enabled = true) =>
  useQuery({ queryKey: ['library-form-templates'], enabled, retry: false, queryFn: () => api.get<{ items: LibraryFormTemplate[] }>('/library/form-templates').then((r) => r.items) });

export interface TemplateUpload { code: string; name_en: string; name_ar?: string; doc_code: string; trigger_task_code: string; numbering_pattern: string; numbering_reset: 'never' | 'yearly'; bindings: Record<string, string>; reason: string; file: File }
export function useTemplateOps() {
  const qc = useQueryClient();
  const done = () => { void qc.invalidateQueries({ queryKey: ['library-form-templates'] }); void qc.invalidateQueries({ queryKey: ['library-forms'] }); };
  return {
    upload: useMutation<LibraryFormTemplate, ApiError, TemplateUpload>({
      mutationFn: ({ file, bindings, ...rest }) => {
        const f = new FormData();
        for (const [k, v] of Object.entries(rest)) if (v !== undefined && v !== '') f.append(k, String(v));
        f.append('bindings', JSON.stringify(bindings));
        f.append('file', file);
        return api.post('/library/form-templates', { body: f });
      },
      onSuccess: done,
    }),
    approve: useMutation<LibraryFormTemplate, ApiError, { id: string; reason: string }>({ mutationFn: ({ id, reason }) => api.post(`/library/form-templates/${id}/approve`, { body: { reason } }), onSuccess: done }),
    retire: useMutation<LibraryFormTemplate, ApiError, { id: string; reason: string }>({ mutationFn: ({ id, reason }) => api.post(`/library/form-templates/${id}/retire`, { body: { reason } }), onSuccess: done }),
  };
}
