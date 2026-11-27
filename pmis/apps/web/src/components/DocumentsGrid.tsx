import { AlertTriangle, CheckCircle2, Circle, Clock, Lock, Minus, MinusCircle, PlayCircle, XCircle } from 'lucide-react';
import { UnsavedGuard } from '@/lib/unsavedGuard';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { GRID_STATUSES, useDocsGrid, useDocsGridView, useMarkNotRequired, useSaveDocsGridView, type GridColumn, type GridRow, type GridStatus } from '@/api/docsGrid';
import { useToast } from './Toast';
import { DateInput } from '@/components/DateInput';

/** Status colour, icon and label of a grid cell: the icon carries the meaning too, so the colour is never the only cue. */
const LOOK: Record<GridStatus, { tone: string; Icon: typeof Circle }> = {
  approved: { tone: 'bg-doneBg text-doneInk', Icon: CheckCircle2 },
  pending: { tone: 'bg-waitBg text-waitInk', Icon: Clock },
  missing: { tone: 'bg-lockBg text-lockInk', Icon: Circle },
  expired: { tone: 'bg-lateBg text-lateInk', Icon: AlertTriangle },
  rejected: { tone: 'bg-lateBg text-lateInk', Icon: XCircle },
  not_required: { tone: 'bg-card2 text-mute', Icon: MinusCircle },
  generatable: { tone: 'bg-openBg text-openInk', Icon: PlayCircle },
  blocked: { tone: 'bg-lockBg text-lockInk', Icon: Lock },
  not_applicable: { tone: 'bg-card2 text-mute', Icon: Minus },
};

/**
 * The documents grid (contract 0.15.14, migration 0097): sites in rows, document types in columns, one status per cell. Paste many Site IDs,
 * filter by cell status and upload dates, choose the visible columns (saved per user), and mark a document not required for one site with a reason.
 */
export function DocumentsGrid() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [paste, setPaste] = useState('');
  const [status, setStatus] = useState<GridStatus | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [draft, setDraft] = useState<string[] | null>(null);
  const [open, setOpen] = useState<{ row: GridRow; col: GridColumn } | null>(null);
  const [reason, setReason] = useState('');
  const view = useDocsGridView();
  const saveView = useSaveDocsGridView();
  const mark = useMarkNotRequired();
  const g = useDocsGrid({ site_code: paste || undefined, status: status || undefined, uploaded_from: from || undefined, uploaded_to: to || undefined });
  const pages = g.data?.pages ?? [];
  const columns = pages[0]?.columns ?? [];
  const rows = pages.flatMap((p) => p.rows);
  const saved = view.data ?? [];
  const chosen = draft ?? saved;
  const visible = columns.filter((c) => chosen.length === 0 || chosen.includes(c.doc_code));
  const name = (c: GridColumn) => (i18n.language === 'ar' && c.name_ar) || c.name_en;
  const label = (s: GridStatus) => t(`docsGrid.status_values.${s}`);
  const toggleCol = (code: string) => {
    const base = draft ?? (saved.length ? saved : columns.map((c) => c.doc_code));
    setDraft(base.includes(code) ? base.filter((x) => x !== code) : [...base, code]);
  };
  const submitMark = () => {
    if (!open || reason.trim().length < 3) return;
    mark.mutate({ site_id: open.row.site_id, doc_code: open.col.doc_code, reason: reason.trim() }, {
      onSuccess: () => { toast(t('docsGrid.mark_done')); setOpen(null); setReason(''); },
      onError: (e) => toast(e instanceof ApiError && e.status === 403 ? t('docsGrid.forbidden') : t('docsGrid.error'), 'err'),
    });
  };
  const cellOpen = open ? open.row.cells[open.col.doc_code] : undefined;
  const canMark = !!cellOpen && cellOpen.status !== 'not_required' && cellOpen.status !== 'not_applicable';
  return (
    <section data-testid="docs-grid" aria-label={t('docsGrid.title')} className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex-1 text-sm">{t('docsGrid.paste')}
          <textarea className="input mt-1 h-16 w-full font-mono" data-testid="docs-grid-paste" value={paste} onChange={(e) => setPaste(e.target.value)} />
          <span className="text-xs text-mute">{t('docsGrid.paste_hint')}</span></label>
        <label className="text-sm">{t('docsGrid.status')}
          <select className="input mt-1" data-testid="docs-grid-status" value={status} onChange={(e) => setStatus(e.target.value as GridStatus | '')}>
            <option value="">{t('docsGrid.all_statuses')}</option>
            {GRID_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
          </select></label>
        <label className="text-sm">{t('docsGrid.from')}<DateInput className="input mt-1" data-testid="docs-grid-from" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="text-sm">{t('docsGrid.to')}<DateInput className="input mt-1" data-testid="docs-grid-to" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <details className="card p-2 text-sm" data-testid="docs-grid-columns">
        <summary className="cursor-pointer">{t('docsGrid.columns')}</summary>
        <div className="mt-2 flex flex-wrap gap-3">
          {columns.map((c) => (
            <label key={c.doc_code} className="flex items-center gap-1">
              <input type="checkbox" data-testid={`docs-grid-col-${c.doc_code}`} checked={chosen.length === 0 || chosen.includes(c.doc_code)} onChange={() => toggleCol(c.doc_code)} />
              {name(c)}
            </label>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <UnsavedGuard scope="inline" dirty={draft !== null} label={t('docsGrid.save_columns')} onSave={() => new Promise<boolean>((res) => saveView.mutate(draft ?? [], { onSuccess: () => { toast(t('docsGrid.columns_saved')); setDraft(null); res(true); }, onError: () => res(false) }))} />
          <button type="button" className="btn btn-accent" data-testid="docs-grid-save-columns" disabled={saveView.isPending || draft === null}
            onClick={() => saveView.mutate(draft ?? [], { onSuccess: () => { toast(t('docsGrid.columns_saved')); setDraft(null); } })}>{t('docsGrid.save_columns')}</button>
          <button type="button" className="btn" onClick={() => setDraft([])}>{t('docsGrid.show_all')}</button>
        </div>
      </details>
      {g.isError && <p role="alert" className="text-lateInk" data-testid="docs-grid-error">{g.error instanceof ApiError && g.error.status === 403 ? t('docsGrid.forbidden') : t('docsGrid.error')}</p>}
      {g.isLoading ? <p className="text-mute">{t('docsGrid.loading')}</p> : (
        <div className="card overflow-auto" style={{ maxHeight: '70vh' }}>
          <table className="w-full border-collapse text-sm" data-testid="docs-grid-table">
            <thead className="sticky top-0 bg-card">
              <tr className="text-start text-mute">
                <th scope="col" className="sticky start-0 bg-card p-2 text-start">{t('docsGrid.site')}</th>
                {visible.map((c) => <th key={c.doc_code} scope="col" className="whitespace-nowrap p-2 text-start" title={c.group_label}>{name(c)}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.site_id} className="border-t border-line" data-testid={`docs-grid-row-${r.site_code}`}>
                  <th scope="row" className="sticky start-0 bg-card p-2 text-start font-mono">{r.site_code}{r.site_name ? <span className="ms-2 font-sans text-mute">{r.site_name}</span> : null}</th>
                  {visible.map((c) => {
                    const cell = r.cells[c.doc_code];
                    if (!cell) return <td key={c.doc_code} className="p-1" />;
                    const { tone, Icon } = LOOK[cell.status];
                    return (
                      <td key={c.doc_code} className="p-1">
                        <button type="button" data-testid={`docs-grid-cell-${r.site_code}-${c.doc_code}`} data-status={cell.status}
                          onClick={() => { setOpen({ row: r, col: c }); setReason(''); }}
                          className={`chip ${tone} inline-flex items-center gap-1`} title={cell.reason ?? label(cell.status)}>
                          <Icon size={12} aria-hidden="true" />{label(cell.status)}{cell.files > 0 ? ` (${cell.files})` : ''}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {g.isSuccess && rows.length === 0 && <tr><td className="p-4 text-mute" colSpan={visible.length + 1} data-testid="docs-grid-empty">{t('docsGrid.empty')}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {g.hasNextPage && (
        <button type="button" className="btn" data-testid="docs-grid-more" disabled={g.isFetchingNextPage} onClick={() => void g.fetchNextPage()}>{t('docsGrid.load_more')}</button>
      )}
      {open && cellOpen && (
        <aside role="dialog" aria-modal="false" aria-label={t('docsGrid.cell_title')} className="card space-y-2 p-3 text-sm" data-testid="docs-grid-panel">
          <p><span className="font-mono">{open.row.site_code}</span> · {name(open.col)} · <strong>{label(cellOpen.status)}</strong></p>
          {cellOpen.reason && <p className="text-mute">{cellOpen.reason}</p>}
          {!open.row.download_allowed && <p className="text-mute">{t('docsGrid.download_denied')}</p>}
          {canMark && (
            <div className="space-y-2">
              <label className="block">{t('docsGrid.reason')}
                <input className="input mt-1 w-full" data-testid="docs-grid-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('docsGrid.reason_hint')} />
              </label>
              <button type="button" className="btn btn-accent" data-testid="docs-grid-mark" disabled={mark.isPending || reason.trim().length < 3} onClick={submitMark}>{t('docsGrid.mark_not_required')}</button>
            </div>
          )}
          <button type="button" className="btn" onClick={() => setOpen(null)}>{t('docsGrid.close')}</button>
        </aside>
      )}
    </section>
  );
}
