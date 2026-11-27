import * as Dialog from '@radix-ui/react-dialog';
import { useDownloadGate } from '@/lib/downloadGate';
import { ArrowLeft, Download, Eye, FileArchive, FilePlus2, FolderOpen, History, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { downloadFile, fetchBlob, type ApiError } from '@/api/client';
import { useDocuments } from '@/api/documents';
import { allArchiveRows, archiveZip, useArchive, useArchiveRows, useArchiveSetting, DOC_STATUSES, type ArchiveQuery, type LibraryArchiveRow, type LibraryDocStatus } from '@/api/library';
import { decodeFilter, encodeFilter, type FilterTree } from '@/api/views';
import { LibraryTabs } from './LibraryTabs';
import { PageHeader } from '@/components/PageHeader';
import { SavedViews } from '@/components/SavedViews';
import { EmptyState, QueryFallback } from '@/components/States';
import { ColumnMenu, DensityToggle, Empty, HeaderRow, pin, rowPad, totalWidth, tracks, Trunc, useTablePrefs, type TableApi } from '@/components/TableKit';
import { DisplayMenu, displayAttrs, PastedChip, ROWNO_COL, RowNo, SearchBox, ShownFooter, TableCount, TableToolbar, toCsv } from '@/components/TableStandard';
import { useToast } from '@/components/Toast';
import { Tip } from '@/components/Tip';
import { UnifiedFilter } from '@/components/UnifiedFilter';
import type { ColDef } from '@/lib/tablePrefs';

/** The colour of a lifecycle status (green is kept for "approved", the completed state). */
export const STATUS_TONE: Record<LibraryDocStatus, string> = {
  due: 'bg-waitBg text-waitInk', generated: 'bg-openBg text-openInk', signed_uploaded: 'bg-accentSoft text-accentText', in_review: 'bg-openBg text-openInk',
  approved: 'bg-doneBg text-doneInk', rejected: 'bg-lateBg text-lateInk', superseded: 'bg-lockBg text-lockInk',
};
export function StatusChip({ status }: { status: LibraryDocStatus }) {
  const { t } = useTranslation();
  return <span className={`chip ${STATUS_TONE[status]}`} data-testid="lib-status" data-status={status}>{t(`lib.status.${status}`)}</span>;
}

/** Library > Archive (W5): one card per document type with a file or a generated copy, grouped by stream, with the counts approved, waiting review, missing. */
export function LibraryArchive() {
  const { t, i18n } = useTranslation();
  const q = useArchive();
  const ar = i18n.language === 'ar';
  return (
    <div data-testid="page-library-archive">
      <PageHeader title={t('lib.archive_title')} subtitle={t('lib.archive_sub')} settings="library_archive" context={q.data?.can_configure ? (
        <span className="ms-auto"><Link className="btn px-2 py-1 text-xs" to="/admin/settings/documents/archive" data-testid="lib-archive-settings">{t('lib.link_archive')}</Link></span>) : undefined} />
      <LibraryTabs />
      {!q.data ? <QueryFallback queries={[q]} /> : !q.data.groups.length ? <EmptyState testid="lib-archive-empty" title={t('lib.no_cards')} /> : (
        <div className="space-y-5">
          {q.data.groups.map((g) => (
            <section key={g.key} aria-labelledby={`lib-group-${g.key}`} data-testid={`lib-group-${g.key}`}>
              <h2 id={`lib-group-${g.key}`} className="mb-2 text-lg font-bold">{(ar && g.name_ar) || g.name_en}</h2>
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {g.cards.map((c) => {
                  const name = (ar && c.name_ar) || c.name_en;
                  return (
                    <li key={c.doc_code} className={`card p-3 ${c.hidden ? 'opacity-60' : ''}`} data-testid={`lib-card-${c.doc_code}`} data-hidden={c.hidden ? '1' : '0'}>
                      <Link to={`/library/archive/${encodeURIComponent(c.doc_code)}`} className="block" aria-label={t('lib.open_list', { name })} data-testid={`lib-card-open-${c.doc_code}`}>
                        <div className="flex items-start gap-2"><FolderOpen size={18} className="mt-0.5 text-accentText" aria-hidden /><b className="flex-1">{name}</b><span className="mono text-xs text-mute">{c.doc_code}</span></div>
                        {c.hidden && <span className="chip mt-1 bg-lockBg text-lockInk">{t('lib.hidden')}</span>}
                        <dl className="mt-2 grid grid-cols-3 gap-1 text-center text-xs">
                          <div className="rounded bg-doneBg p-1 text-doneInk"><dt>{t('lib.cnt_approved')}</dt><dd className="text-base font-bold" data-testid={`lib-card-approved-${c.doc_code}`}>{c.counts.approved}</dd></div>
                          <div className="rounded bg-openBg p-1 text-openInk"><dt>{t('lib.cnt_waiting')}</dt><dd className="text-base font-bold" data-testid={`lib-card-waiting-${c.doc_code}`}>{c.counts.waiting_review}</dd></div>
                          <div className="rounded bg-waitBg p-1 text-waitInk"><dt>{t('lib.cnt_missing')}</dt><dd className="text-base font-bold" data-testid={`lib-card-missing-${c.doc_code}`}>{c.counts.missing}</dd></div>
                        </dl>
                        <p className="mt-1 text-xs text-mute">{t('lib.cnt_files', { count: c.counts.files })}</p>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

const COLS: ColDef[] = [ROWNO_COL, { id: 'site', w: 120, min: 90, pinned: true }, { id: 'site_name', w: 200, min: 120 }, { id: 'region', w: 110, min: 80 }, { id: 'cluster', w: 110, min: 80 },
  { id: 'doc_type', w: 220, min: 120 }, { id: 'doc_number', w: 170, min: 110 }, { id: 'version', w: 80, min: 60 }, { id: 'status', w: 160, min: 110 }, { id: 'task', w: 200, min: 120 },
  { id: 'uploaded_by', w: 170, min: 110 }, { id: 'uploaded_at', w: 120, min: 100 }, { id: 'approved_by', w: 170, min: 110 }, { id: 'approved_at', w: 120, min: 100 }, { id: 'actions', w: 150, min: 120 }];
const EMPTY = { q: '', superseded: '' };

/** The preview of an uploaded file (from the existing audited download): images and PDFs in a sandboxed frame, nothing else. */
function FilePreview({ row, onClose }: { row: LibraryArchiveRow; onClose: () => void }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ok = !!row.mime_type && /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(row.mime_type);
  if (ok && !url && !err && row.file_id) void fetchBlob(`/files/${row.file_id}/download`).then((b) => setUrl(URL.createObjectURL(b)), (e) => setErr((e as ApiError).message));
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) { if (url) URL.revokeObjectURL(url); onClose(); } }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-scrim/60" />
        <Dialog.Content className="card fixed inset-x-0 top-[4vh] z-[70] mx-auto max-h-[92vh] w-[min(980px,96vw)] space-y-2 overflow-y-auto p-4" data-testid="lib-file-preview">
          <div className="flex items-center gap-2"><Dialog.Title className="flex-1 font-bold">{row.site_code} · {row.doc_code} · {row.file_name}</Dialog.Title><Dialog.Close className="btn px-2 py-1" aria-label={t('common.close')}><X size={16} /></Dialog.Close></div>
          <Dialog.Description className="sr-only">{t('lib.preview_file')}</Dialog.Description>
          {!ok ? <p className="text-sm text-mute">{t('lib.no_preview')}</p> : err ? <p className="text-sm text-lateInk">{err}</p> : url
            ? (row.mime_type === 'application/pdf' ? <iframe title={row.file_name ?? ''} sandbox="" src={url} className="h-[75vh] w-full rounded border border-line" /> : <img src={url} alt={row.file_name ?? ''} className="mx-auto max-h-[75vh]" />)
            : <p className="text-sm text-mute">{t('common.loading')}</p>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The versions of a file (GET /documents?file_group_id=, superseded ones included), each downloadable (audited). */
function VersionHistory({ row, onClose }: { row: LibraryArchiveRow; onClose: () => void }) {
  const gate = useDownloadGate();
  const { t } = useTranslation();
  const toast = useToast();
  const q = useDocuments({ file_group_id: row.file_group_id ?? undefined, include_superseded: true });
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-scrim/60" />
        <Dialog.Content className="card fixed inset-x-0 top-[10vh] z-[70] mx-auto w-[min(640px,94vw)] space-y-2 p-4" data-testid="lib-history">
          <div className="flex items-center gap-2"><Dialog.Title className="flex-1 font-bold">{t('lib.history_title', { name: `${row.site_code} ${row.doc_code}` })}</Dialog.Title><Dialog.Close className="btn px-2 py-1" aria-label={t('common.close')}><X size={16} /></Dialog.Close></div>
          <Dialog.Description className="sr-only">{t('lib.history')}</Dialog.Description>
          {!q.data ? <QueryFallback queries={[q]} /> : (
            <ul className="divide-y divide-line text-sm">
              {[...q.data].sort((a, b) => b.file.version - a.file.version).map((d) => (
                <li key={d.file.id} className="flex items-center gap-2 py-2" data-testid={`lib-history-v${d.file.version}`}>
                  <span className="chip bg-card2 text-mute">v{d.file.version}</span>{d.file.is_current && <span className="chip bg-doneBg text-doneInk">{t('lib.current')}</span>}
                  <span className="flex-1 truncate">{d.file.download_name}</span><span className="text-mute">{String(d.file.uploaded_at).slice(0, 10)}</span>
                  <button type="button" className="btn px-2 py-1" aria-label={t('lib.download')} disabled={gate.filesLocked} title={gate.note(gate.filesLocked)} onClick={() => void downloadFile(`/files/${d.file.id}/download`).catch((e) => toast((e as ApiError).message, 'err'))}><Download size={14} /></button>
                </li>
              ))}
            </ul>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** One row of the Archive list. */
function Row({ r, n, tbl, onPreview, onHistory }: { r: LibraryArchiveRow; n: number; tbl: TableApi; onPreview: (r: LibraryArchiveRow) => void; onHistory: (r: LibraryArchiveRow) => void }) {
  const gate = useDownloadGate();
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const ar = i18n.language === 'ar';
  const cell = (id: string): ReactNode => {
    switch (id) {
      case 'rowno': return <RowNo n={n} />;
      case 'site': return <Link to={`/sites/${r.site_id}?tab=documents`} className="mono font-semibold" data-testid={`lib-row-site-${r.site_code}`}>{r.site_code}</Link>;
      case 'site_name': return r.site_name ? <Trunc text={r.site_name} /> : <Empty />;
      case 'region': return r.region_name ? <Trunc text={(ar && r.region_name_ar) || r.region_name} /> : <Empty />;
      case 'cluster': return r.cluster ? <span className="mono">{r.cluster}</span> : <Empty />;
      case 'doc_type': return <span className="block min-w-0"><span className="mono">{r.doc_code}</span> <Trunc text={((ar && r.doc_name_ar) || r.doc_name_en) + (r.candidate_label ? ` · ${r.candidate_label}` : '')} /></span>;
      case 'doc_number': return r.doc_number ? <span className="mono">{r.doc_number}</span> : <Empty />;
      case 'version': return r.version ? <span className="chip bg-card2 text-mute">v{r.version}</span> : <Empty />;
      case 'status': return <StatusChip status={r.status} />;
      case 'task': return r.task_code ? <span className="block min-w-0"><span className="mono">{r.task_code}</span> <Trunc text={(ar && r.task_name_ar) || r.task_name_en || ''} /></span> : r.register_key ? <span className="mono">{r.register_key}</span> : <Empty />;
      case 'uploaded_by': return r.uploaded_by ? <Trunc text={r.uploaded_by.display_name} /> : <Empty />;
      case 'uploaded_at': return r.uploaded_at ? String(r.uploaded_at).slice(0, 10) : <Empty />;
      case 'approved_by': return r.approved_by ? <Trunc text={r.approved_by.display_name} /> : <Empty />;
      case 'approved_at': return r.approved_at ?? <Empty />;
      default: return (
        <span className="flex items-center gap-1">
          {r.file_id && <Tip text={t('lib.preview_file')}><button type="button" className="btn px-1.5 py-0.5" aria-label={t('lib.preview_file')} data-testid={`lib-row-preview-${r.key}`} onClick={() => onPreview(r)}><Eye size={14} /></button></Tip>}
          {r.file_id && <Tip text={t('lib.download')}><button type="button" className="btn px-1.5 py-0.5" aria-label={t('lib.download')} disabled={gate.filesLocked} title={gate.note(gate.filesLocked)} onClick={() => void downloadFile(`/files/${r.file_id}/download`).catch((e) => toast((e as ApiError).message, 'err'))}><Download size={14} /></button></Tip>}
          {r.file_group_id && <Tip text={t('lib.history')}><button type="button" className="btn px-1.5 py-0.5" aria-label={t('lib.history')} data-testid={`lib-row-history-${r.key}`} onClick={() => onHistory(r)}><History size={14} /></button></Tip>}
          {r.form_id && (r.status === 'due' || r.status === 'generated' || r.status === 'rejected') && (
            <Tip text={t('lib.generate')}><Link className="btn px-1.5 py-0.5" aria-label={t('lib.generate')} data-testid={`lib-row-generate-${r.key}`} to={`/library/forms?form=${r.form_id}&site=${r.site_id}&site_code=${encodeURIComponent(r.site_code)}`}><FilePlus2 size={14} /></Link></Tip>)}
        </span>
      );
    }
  };
  return (
    <div role="row" data-testid={`lib-row-${r.key}`} data-status={r.status} data-zebra={n % 2 === 0 ? '1' : '0'} className={`gx-row grid items-center border-b border-line text-sm ${rowPad(tbl.density)}`}
      style={{ gridTemplateColumns: tracks(tbl.cols, false), minWidth: totalWidth(tbl.cols, false) }}>
      {tbl.cols.map((c) => { const p = pin(c, false, tbl.cols); return <div key={c.id} role="cell" data-col={c.id} className={`min-w-0 px-2 ${p.className}`} style={p.style}>{cell(c.id)}</div>; })}
    </div>
  );
}

/** The list of one document type for every site of the caller's regions (W5-3), with the shared table standard of W8. */
export function ArchiveList() {
  const gate = useDownloadGate();
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { docCode = '' } = useParams();
  const [sp, setSp] = useSearchParams();
  const setting = useArchiveSetting();
  const cards = useArchive();
  const q = sp.get('q') ?? '', adv = sp.get('adv') ?? '', superseded = sp.get('superseded') === 'true';
  const advTree = decodeFilter(adv);
  const query: ArchiveQuery = { doc_code: docCode, q, filter: adv || undefined, include_superseded: superseded };
  const rows = useArchiveRows(query);
  const defaults = setting.data?.default_columns;
  const defs = COLS.map((c) => (c.pinned || c.id === 'rowno' || c.id === 'actions' || !defaults ? c : { ...c, off: !defaults.includes(c.id as never) }));
  const tbl = useTablePrefs(`library-archive-${defaults ? 'set' : 'seed'}`, defs);
  const [preview, setPreview] = useState<LibraryArchiveRow | null>(null);
  const [history, setHistory] = useState<LibraryArchiveRow | null>(null);
  const [zipping, setZipping] = useState(false);
  const label = (id: string) => t(`lib.col.${id}`);
  const setParams = (kv: Record<string, string>) => setSp((p) => { const n = new URLSearchParams(p); for (const [k, v] of Object.entries(kv)) { if (v) n.set(k, v); else n.delete(k); } return n; }, { replace: true });
  const items = rows.data?.pages.flatMap((p) => p.items) ?? [];
  const counts = rows.data?.pages[0]?.counts;
  const active = !!(q.trim() || adv || superseded);
  const card = cards.data?.groups.flatMap((g) => g.cards).find((c) => c.doc_code === docCode);
  const title = card ? `${(i18n.language === 'ar' && card.name_ar) || card.name_en}` : docCode;
  const exportView = async () => {
    try {
      const all = await allArchiveRows(query);
      const cols = tbl.cols.filter((c) => c.id !== 'actions' && c.id !== 'rowno');
      const val = (r: LibraryArchiveRow, id: string): string => ({
        site: r.site_code, site_name: r.site_name ?? '', region: r.region_name ?? '', cluster: r.cluster ?? '', doc_type: `${r.doc_code} ${r.doc_name_en}`, doc_number: r.doc_number ?? '',
        version: r.version ? String(r.version) : '', status: t(`lib.status.${r.status}`), task: r.task_code ?? r.register_key ?? '', uploaded_by: r.uploaded_by?.display_name ?? '',
        uploaded_at: r.uploaded_at ? String(r.uploaded_at).slice(0, 10) : '', approved_by: r.approved_by?.display_name ?? '', approved_at: r.approved_at ?? '',
      } as Record<string, string>)[id] ?? '';
      const blob = new Blob(['\ufeff', toCsv(['#', ...cols.map((c) => label(c.id))], all.map((r, i) => [i + 1, ...cols.map((c) => val(r, c.id))]))], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `archive-${docCode}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 0);
    } catch (e) { toast((e as ApiError).message, 'err'); }
  };
  const zip = async () => {
    setZipping(true);
    toast(t('lib.zip_started'));
    try { const name = await archiveZip(query); toast(t('lib.zip_done', { name })); }
    catch (e) { toast((e as ApiError).problem?.errors?.[0]?.message ?? (e as ApiError).message ?? t('lib.zip_failed'), 'err'); } finally { setZipping(false); }
  };
  let n = 0;
  return (
    <div data-testid="page-library-archive-list" data-doc={docCode}>
      <PageHeader title={title} subtitle={t('lib.lifecycle_note')} context={<Link to="/library/archive" className="btn ms-auto px-2 py-1 text-xs" data-testid="lib-back"><ArrowLeft size={14} className="rtl:rotate-180" />{t('lib.back')}</Link>} />
      <TableToolbar testid="lib-archive-toolbar"
        views={<SavedViews screen="library-archive" value={{ q, superseded: superseded ? 'true' : '', ...(advTree ? { advanced: advTree } : {}) }} empty={EMPTY} table={tbl}
          onApply={(v) => { const x = v as Record<string, unknown>; setParams({ q: String(x.q ?? ''), superseded: String(x.superseded ?? ''), adv: encodeFilter((v as { advanced?: FilterTree }).advanced) }); }} />}
        search={<SearchBox testid="lib-archive-search" value={q} onChange={(v) => setParams({ q: v })} placeholder={t('lib.search_docs')} />}
        filter={<UnifiedFilter screen="library-archive" value={advTree} onChange={(tree) => setParams({ adv: encodeFilter(tree) })} onClearAll={() => setParams({ adv: '', superseded: '' })}
          extras={[{ key: 'superseded', label: t('lib.include_superseded'), group: 'fields', kind: 'bool', value: superseded ? '1' : '', set: (v) => setParams({ superseded: v ? 'true' : '' }) }]} />}
        extra={<PastedChip search={rows.data?.pages[0]?.search} />}
        count={<TableCount testid="lib-archive-count" noun="documents" total={counts?.total} filtered={counts?.filtered} active={active} onClear={() => setParams({ q: '', adv: '', superseded: '' })} />}
        primary={<Tip text={t('lib.zip')}><button type="button" className="btn" data-testid="lib-archive-zip" aria-label={t('lib.zip')} disabled={zipping || gate.exportLocked || !items.some((r) => r.file_id)} title={gate.note(gate.exportLocked)} onClick={() => void zip()}><FileArchive size={16} /></button></Tip>}
        columns={<ColumnMenu api={tbl} label={label} />}
        density={<DensityToggle api={tbl} />}
        display={<DisplayMenu api={tbl} />}
        exporter={<Tip text={t('tstd.export_view')}><button type="button" className="btn" data-testid="lib-archive-export" aria-label={t('tstd.export_view')} disabled={gate.exportLocked} title={gate.note(gate.exportLocked)} onClick={() => void exportView()}><Download size={16} /></button></Tip>} />
      <div className="card gx overflow-auto" {...displayAttrs(tbl.display)} data-testid="lib-archive-table" role="table" aria-label={title}>
        <div className="sticky top-0 z-20"><HeaderRow api={tbl} label={label} testid="lib-archive-head" /></div>
        <div role="rowgroup" style={{ minWidth: totalWidth(tbl.cols, false) }}>
          {items.map((r) => <Row key={r.key} r={r} n={++n} tbl={tbl} onPreview={setPreview} onHistory={setHistory} />)}
        </div>
        {rows.isSuccess && !items.length && <EmptyState testid="lib-archive-none" title={t('lib.no_rows')} />}
        {!rows.data && <QueryFallback queries={[rows]} />}
      </div>
      <ShownFooter testid="lib-archive-shown" shown={items.length} filtered={counts?.filtered}>
        {rows.hasNextPage && <button type="button" className="btn" data-testid="lib-archive-more" disabled={rows.isFetchingNextPage} onClick={() => void rows.fetchNextPage()}>{t('logs.load_more')}</button>}
      </ShownFooter>
      {preview && <FilePreview row={preview} onClose={() => setPreview(null)} />}
      {history && <VersionHistory row={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

/** W5-5: the lifecycle of every document of a site, shown on its Documents tab (the same rows as the Archive). */
export function SiteLifecycle({ siteId }: { siteId: string }) {
  const { t, i18n } = useTranslation();
  const rows = useArchiveRows({ site_id: siteId });
  const items = rows.data?.pages.flatMap((p) => p.items) ?? [];
  if (!rows.data || !items.length) return null;
  const by = new Map<LibraryDocStatus, number>();
  for (const r of items) by.set(r.status, (by.get(r.status) ?? 0) + 1);
  return (
    <section className="card mb-3 p-3" data-testid="site-doc-lifecycle" aria-labelledby="site-doc-lifecycle-h">
      <h3 id="site-doc-lifecycle-h" className="font-bold">{t('lib.lifecycle')}</h3>
      <p className="text-xs text-mute">{t('lib.lifecycle_note')}</p>
      <div className="mt-2 flex flex-wrap gap-1" data-testid="site-doc-lifecycle-counts">
        {DOC_STATUSES.filter((s) => by.get(s)).map((s) => <span key={s} className={`chip ${STATUS_TONE[s]}`} data-testid={`site-doc-lifecycle-${s}`}>{t(`lib.status.${s}`)} · {by.get(s)}</span>)}
      </div>
      <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
        {items.map((r) => (
          <li key={r.key} className="flex items-center gap-2" data-testid={`site-doc-life-${r.doc_code}`}>
            <span className="mono">{r.doc_code}</span><span className="flex-1 truncate">{(i18n.language === 'ar' && r.doc_name_ar) || r.doc_name_en}{r.doc_number ? ` · ${r.doc_number}` : ''}</span><StatusChip status={r.status} />
          </li>
        ))}
      </ul>
    </section>
  );
}
