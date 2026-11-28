import { Archive, Download } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { downloadDocument, useDocuments, zipDownload, type DocFilters, type DocumentListItem } from '@/api/documents';
import type { PipelineNode } from '@/api/types';
import { DocumentsGrid } from './DocumentsGrid';
import { StandardTable, type StdCol } from './StandardTable';
import { useToast } from './Toast';
import { SiteLifecycle } from '@/pages/library/Archive';

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
  const [view, setView] = useState<'list' | 'grid'>('list');
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
  const cols: StdCol<DocumentListItem>[] = [
    { id: 'pick', label: t('docs.pick'), w: 44, pinned: true, action: true, text: () => '', cell: (r) => <input type="checkbox" aria-label={t('docs.pick_file', { name: r.file.original_name })} data-testid={`doc-pick-${r.file.id}`} checked={picked.has(r.file.id)} onChange={() => toggle(r.file.id)} /> },
    ...(f.all ? [{ id: 'site', label: t('docs.c_site'), w: 110, text: (r: DocumentListItem) => r.site_code ?? '', cell: (r: DocumentListItem) => <span className="mono">{r.site_code}</span> }] : []),
    { id: 'stage', label: t('docs.c_stage'), w: 90, text: (r) => r.stage_code ?? '', cell: (r) => r.stage_code ?? '' },
    { id: 'task', label: t('docs.c_task'), w: 90, text: (r) => r.task_code ?? '', cell: (r) => <span className="mono">{r.task_code ?? ''}</span> },
    { id: 'doc', label: t('docs.c_doc'), w: 240, text: (r) => `${name(r)}${r.candidate_label ? ` (${r.candidate_label})` : ''}`, cell: (r) => <>{name(r)}{r.candidate_label ? ` (${r.candidate_label})` : ''}</> },
    { id: 'file', label: t('docs.c_file'), w: 260, text: (r) => r.file.download_name ?? r.file.original_name, cell: (r) => <button type="button" className="mono text-link hover:underline" title={r.file.download_name} data-testid={`doc-dl-${r.file.id}`} onClick={() => void downloadDocument(r.file.id).catch(() => toast(t('errors.generic'), 'err'))}><Download size={12} className="me-1 inline" />{r.file.download_name}</button> },
    { id: 'version', label: t('docs.c_version'), w: 150, text: (r) => `v${r.file.version}`, cell: (r) => <><span className="chip bg-card2">v{r.file.version}</span>{!r.file.is_current && <span className="ms-1 text-xs text-mute" data-testid={`doc-superseded-${r.file.id}`}>{t('docs.superseded')}</span>}</> },
    { id: 'status', label: t('docs.c_status'), w: 140, text: (r) => t(`slotStatus.${r.slot_status}`), cell: (r) => <span className={`chip ${TONE[r.slot_status]}`}>{t(`slotStatus.${r.slot_status}`)}</span> },
    { id: 'uploaded', label: t('docs.c_uploaded'), w: 230, text: (r) => `${r.file.uploaded_by?.display_name ?? ''} ${r.file.uploaded_at.slice(0, 10)}`, cell: (r) => <>{r.file.uploaded_by?.display_name} · {r.file.uploaded_at.slice(0, 10)}</> },
    { id: 'approved', label: t('docs.c_approved'), w: 130, text: (r) => r.file.approved_date ?? '', cell: (r) => <span className="mono">{r.file.approved_date ?? ''}</span> },
  ];
  const viewToggle = (
    <div className="mb-2 flex gap-1" role="group" aria-label={t('docsGrid.title')}>
      <button type="button" className={`btn ${view === 'list' ? 'btn-accent' : ''}`} data-testid="docs-view-list" aria-pressed={view === 'list'} onClick={() => setView('list')}>{t('docsGrid.toggle_list')}</button>
      <button type="button" className={`btn ${view === 'grid' ? 'btn-accent' : ''}`} data-testid="docs-view-grid" aria-pressed={view === 'grid'} onClick={() => setView('grid')}>{t('docsGrid.toggle_grid')}</button>
    </div>
  );
  if (view === 'grid') return <>{viewToggle}<DocumentsGrid /></>;
  return (
    <section data-testid="site-documents" aria-label={t('docs.tab')}>
      {/* W5-5: the lifecycle of the site's documents (due, generated, signed and uploaded, in review, approved), the same rows as Library > Archive */}
      <SiteLifecycle siteId={siteId} />
      {viewToggle}
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
        <label className="flex items-center gap-1 text-sm"><input type="checkbox" data-testid="docs-filter-history" checked={f.history} onChange={(e) => set('history', e.target.checked)} />{t('docs.f_history')}</label>
        <label className="flex items-center gap-1 text-sm"><input type="checkbox" data-testid="docs-filter-all-sites" checked={f.all} onChange={(e) => set('all', e.target.checked)} />{t('docs.f_all_sites')}</label>
        <div className="ms-auto flex flex-wrap gap-2">
          <button className="btn" data-testid="docs-zip-picked" disabled={busy || picked.size === 0} onClick={() => zip({ file_ids: [...picked], include_superseded: true })}><Archive size={14} />{t('docs.zip_picked', { count: picked.size })}</button>
          {!f.all && <button className="btn" data-testid="docs-zip-acceptance" disabled={busy} title={t('docs.zip_acceptance_hint')} onClick={() => zip({ site_id: siteId, pack: 'acceptance', include_superseded: false })}><Archive size={14} />{t('docs.zip_acceptance')}</button>}
          <button className="btn btn-accent" data-testid="docs-zip-all" disabled={busy || !all} title={all ? undefined : t('docs.zip_scope_needed')} onClick={() => all && zip(all)}><Archive size={14} />{t('docs.zip_all')}</button>
        </div>
      </div>
      {busy && <p role="status" className="mb-2 text-sm text-mute" data-testid="docs-zip-busy">{t('docs.zip_running')}</p>}
      {q.isError && <p role="alert" className="text-lateInk" data-testid="docs-error">{q.error instanceof ApiError && q.error.status === 403 ? t('errors.forbidden') : t('errors.generic')}</p>}
      <StandardTable screen={f.all ? 'site-documents-all' : 'site-documents'} testid="docs-table" cols={cols} rows={rows} rowId={(r) => r.file.id} rowTestId={(r) => `doc-row-${r.file.id}`}
        rowAttrs={(r) => ({ 'data-current': String(r.file.is_current) })} loading={q.isLoading} query={f.q} onQuery={(v) => set('q', v)} searchTestId="docs-filter-q"
        empty={t('docs.empty')} exportName="site-documents" noun="documents" />
    </section>
  );
}
