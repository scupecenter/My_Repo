import { Archive, Download } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { downloadDocument, useDocuments, zipDownload, type DocFilters, type DocumentListItem } from '@/api/documents';
import type { PipelineNode } from '@/api/types';
import { useToast } from './Toast';

const TONE: Record<string, string> = { approved: 'bg-doneBg text-doneInk', uploaded: 'bg-openBg text-openInk', in_review: 'bg-waitBg text-waitInk', rejected: 'bg-lateBg text-lateInk', missing: 'bg-lockBg text-lockInk', not_required: 'bg-lockBg text-lockInk' };
const KINDS = ['scanned_document', 'photo', 'email', 'report', 'excel_template', 'generated_form'] as const;
const STATUSES = ['uploaded', 'in_review', 'approved', 'rejected'] as const;

/**
 * The Documents tab of a site (CLAUDE.md "Documents and QC"): every file of the site's slots with filters and version history, single downloads,
 * and the bulk zip (the files you ticked, or everything the filters show). "All sites" lifts the site filter, for a document type or a stage across sites.
 */
export function SiteDocuments({ siteId, stages }: { siteId: string; stages: PipelineNode[] }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [f, setF] = useState({ stage_code: '', doc_code: '', kind: '', slot_status: '', q: '', history: false, all: false });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const filters: DocFilters = {
    ...(f.all ? {} : { site_id: siteId }), ...(f.stage_code ? { stage_code: f.stage_code } : {}), ...(f.doc_code ? { doc_code: f.doc_code.trim() } : {}),
    ...(f.kind ? { kind: f.kind } : {}), ...(f.slot_status ? { slot_status: f.slot_status } : {}), ...(f.q.trim() ? { q: f.q.trim() } : {}), include_superseded: f.history,
  };
  const q = useDocuments(filters);
  const rows = q.data ?? [];
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => { setF({ ...f, [k]: v }); setPicked(new Set()); };
  const fail = (e: unknown) => toast(e instanceof ApiError && e.status === 403 ? t('errors.forbidden') : e instanceof ApiError && e.code === 'validation_failed' ? t('docs.zip_empty') : t('docs.zip_failed'), 'err');
  const zip = (scope: Parameters<typeof zipDownload>[0]) => { setBusy(true); void zipDownload(scope).then((n) => toast(t('docs.zip_done', { name: n })), fail).finally(() => setBusy(false)); };
  const scopeAll = (): Parameters<typeof zipDownload>[0] | null => {
    const s = { ...(f.all ? {} : { site_id: siteId }), ...(f.stage_code ? { stage_code: f.stage_code } : {}), ...(f.doc_code.trim() ? { doc_code: f.doc_code.trim() } : {}), ...(f.slot_status && f.slot_status !== 'missing' ? { slot_status: f.slot_status as (typeof STATUSES)[number] } : {}), include_superseded: f.history };
    return s.site_id || s.stage_code || s.doc_code ? s : null;
  };
  const all = scopeAll();
  const name = (r: DocumentListItem) => (i18n.language === 'ar' && r.doc_name_ar) || r.doc_name_en;
  const stageOptions = stages.filter((n) => n.kind === 'milestone');
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <section data-testid="site-documents" aria-label={t('docs.tab')}>
      <div className="mb-3 flex flex-wrap items-end gap-2" data-testid="docs-filters">
        <label className="text-sm">{t('docs.f_stage')}
          <select className="input mt-1" data-testid="docs-filter-stage" value={f.stage_code} onChange={(e) => set('stage_code', e.target.value)}>
            <option value="">{t('common.all')}</option>
            {stageOptions.map((n) => <option key={n.code} value={n.code}>{(i18n.language === 'ar' && n.name_ar) || n.name_en}</option>)}
          </select></label>
        <label className="text-sm">{t('docs.f_doc')}<input className="input mt-1 w-32" data-testid="docs-filter-doc" value={f.doc_code} onChange={(e) => set('doc_code', e.target.value)} placeholder="A2" /></label>
        <label className="text-sm">{t('docs.f_kind')}
          <select className="input mt-1" data-testid="docs-filter-kind" value={f.kind} onChange={(e) => set('kind', e.target.value)}>
            <option value="">{t('common.all')}</option>{KINDS.map((k) => <option key={k} value={k}>{t(`docs.kind.${k}`)}</option>)}
          </select></label>
        <label className="text-sm">{t('docs.f_status')}
          <select className="input mt-1" data-testid="docs-filter-status" value={f.slot_status} onChange={(e) => set('slot_status', e.target.value)}>
            <option value="">{t('common.all')}</option>{STATUSES.map((k) => <option key={k} value={k}>{t(`slotStatus.${k}`)}</option>)}
          </select></label>
        <label className="text-sm">{t('docs.f_search')}<input className="input mt-1 w-44" data-testid="docs-filter-q" value={f.q} onChange={(e) => set('q', e.target.value)} /></label>
        <label className="flex items-center gap-1 text-sm"><input type="checkbox" data-testid="docs-filter-history" checked={f.history} onChange={(e) => set('history', e.target.checked)} />{t('docs.f_history')}</label>
        <label className="flex items-center gap-1 text-sm"><input type="checkbox" data-testid="docs-filter-all-sites" checked={f.all} onChange={(e) => set('all', e.target.checked)} />{t('docs.f_all_sites')}</label>
        <div className="ms-auto flex flex-wrap gap-2">
          <button className="btn" data-testid="docs-zip-picked" disabled={busy || picked.size === 0} onClick={() => zip({ file_ids: [...picked], include_superseded: true })}><Archive size={14} />{t('docs.zip_picked', { count: picked.size })}</button>
          <button className="btn btn-accent" data-testid="docs-zip-all" disabled={busy || !all} title={all ? undefined : t('docs.zip_scope_needed')} onClick={() => all && zip(all)}><Archive size={14} />{t('docs.zip_all')}</button>
        </div>
      </div>
      {busy && <p role="status" className="mb-2 text-sm text-mute" data-testid="docs-zip-busy">{t('docs.zip_running')}</p>}
      {q.isError && <p role="alert" className="text-lateInk" data-testid="docs-error">{q.error instanceof ApiError && q.error.status === 403 ? t('errors.forbidden') : t('errors.generic')}</p>}
      {q.isLoading ? <p className="text-mute">{t('common.loading')}</p> : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm" data-testid="docs-table">
            <thead><tr className="text-start text-mute">
              <th className="p-2" scope="col"><span className="sr-only">{t('docs.pick')}</span></th>
              {f.all && <th className="p-2 text-start" scope="col">{t('docs.c_site')}</th>}
              <th className="p-2 text-start" scope="col">{t('docs.c_stage')}</th><th className="p-2 text-start" scope="col">{t('docs.c_task')}</th><th className="p-2 text-start" scope="col">{t('docs.c_doc')}</th>
              <th className="p-2 text-start" scope="col">{t('docs.c_file')}</th><th className="p-2 text-start" scope="col">{t('docs.c_version')}</th><th className="p-2 text-start" scope="col">{t('docs.c_status')}</th>
              <th className="p-2 text-start" scope="col">{t('docs.c_uploaded')}</th><th className="p-2 text-start" scope="col">{t('docs.c_approved')}</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.file.id} className={`border-t border-line ${r.file.is_current ? '' : 'opacity-75'}`} data-testid={`doc-row-${r.file.id}`} data-current={r.file.is_current}>
                  <td className="p-2"><input type="checkbox" aria-label={t('docs.pick_file', { name: r.file.original_name })} data-testid={`doc-pick-${r.file.id}`} checked={picked.has(r.file.id)} onChange={() => toggle(r.file.id)} /></td>
                  {f.all && <td className="mono p-2">{r.site_code}</td>}
                  <td className="p-2">{r.stage_code ?? ''}</td><td className="mono p-2">{r.task_code ?? ''}</td>
                  <td className="p-2">{name(r)}{r.candidate_label ? ` (${r.candidate_label})` : ''}</td>
                  <td className="p-2"><button type="button" className="mono text-link hover:underline" title={r.file.download_name} data-testid={`doc-dl-${r.file.id}`} onClick={() => void downloadDocument(r.file.id).catch(() => toast(t('errors.generic'), 'err'))}><Download size={12} className="me-1 inline" />{r.file.download_name}</button></td>
                  <td className="p-2"><span className="chip bg-card2">v{r.file.version}</span>{!r.file.is_current && <span className="ms-1 text-xs text-mute" data-testid={`doc-superseded-${r.file.id}`}>{t('docs.superseded')}</span>}</td>
                  <td className="p-2"><span className={`chip ${TONE[r.slot_status]}`}>{t(`slotStatus.${r.slot_status}`)}</span></td>
                  <td className="p-2">{r.file.uploaded_by?.display_name} · {r.file.uploaded_at.slice(0, 10)}</td>
                  <td className="mono p-2">{r.file.approved_date ?? ''}</td>
                </tr>
              ))}
              {q.isSuccess && rows.length === 0 && <tr><td className="p-4 text-mute" colSpan={f.all ? 10 : 9} data-testid="docs-empty">{t('docs.empty')}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
