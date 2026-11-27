import { Check, CircleAlert, Copy, Download, Search, TriangleAlert, Undo2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ImportBatch, ImportRow } from '@/api/types';
import { Tip } from './Tip';
import { batchTotals, pct } from './BatchProgress';

/** P8 (data-entry review 2026-11-27): the building blocks of the redesigned upload review. Presentation only: every number is a server count of the batch, every row action is the existing decision door. */

export type BatchShow = 'all' | 'valid' | 'invalid' | 'duplicate' | 'held' | 'warnings';
export type BatchSort = 'row' | 'result' | 'key';
export const isDuplicate = (r: Pick<ImportRow, 'action' | 'errors'>): boolean => r.action === 'error' && !!r.errors?.some((e) => e.code === 'duplicate_in_file');

/** The rows a tab shows. `invalid` leaves the duplicates out: they have a tab of their own. */
export function filterRows(rows: ImportRow[], show: BatchShow): ImportRow[] {
  switch (show) {
    case 'valid': return rows.filter((r) => r.action !== 'error');
    case 'invalid': return rows.filter((r) => r.action === 'error' && !isDuplicate(r));
    case 'duplicate': return rows.filter(isDuplicate);
    case 'held': return rows.filter((r) => (r.action === 'create' || r.action === 'update') && r.decision === 'pending_previous_approval');
    case 'warnings': return rows.filter((r) => !!r.warnings?.length);
    default: return rows;
  }
}

/** Instant search over the loaded rows: row number, key (Site ID or record key), site code, the reason of each error and the values of the diff. */
export function searchRows(rows: ImportRow[], q: string): ImportRow[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => {
    const hay = [String(r.row_no), r.key ?? '', r.site_code ?? '', r.task_code ?? '', ...(r.errors ?? []).flatMap((e) => [e.column ?? '', e.message ?? '', e.code]),
      ...Object.values(r.diff ?? {}).flatMap((v) => [String(v.new ?? ''), String(v.old ?? '')])].join(' ').toLowerCase();
    return hay.includes(needle);
  });
}

export function sortRows(rows: ImportRow[], by: BatchSort): ImportRow[] {
  if (by === 'row') return rows;
  const out = [...rows];
  if (by === 'key') return out.sort((a, b) => (a.key ?? '').localeCompare(b.key ?? '', 'en') || a.row_no - b.row_no);
  const rank = (r: ImportRow) => (r.action === 'error' ? 0 : r.decision === 'pending_previous_approval' ? 1 : r.warnings?.length ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b) || a.row_no - b.row_no);
}

/** Five big numbers: checked, valid (with its split), duplicates, rejected, held. Colour is never the only signal: each card has a label and an icon. */
export function BatchKpiCards({ batch: b }: { batch: ImportBatch }) {
  const { t } = useTranslation();
  const c = batchTotals(b.counts);
  const dup = b.counts.duplicate ?? 0, rejected = Math.max(0, c.error - dup);
  const legacy: Record<string, string> = { valid: t('batch.valid', { count: c.valid }), invalid: t('batch.invalid', { count: Math.max(0, c.error - (b.counts.duplicate ?? 0)) }), held: t('batch.held_count', { count: c.held }) };
  const card = (key: string, n: number, tone: string, label: string, sub?: ReactNode, icon?: ReactNode, hint?: string) => (
    <Tip text={hint ?? label}>
      <li data-testid={`batch-kpi-${key}`} data-count={n} className={`rounded-lg border border-line p-3 ${tone}`}>
        <p className="flex items-center gap-1 text-xs font-semibold">{icon}{label}</p>
        <p className="mono text-3xl font-bold leading-tight"><span aria-hidden>{n}</span><span className="sr-only" data-testid={`batch-count-${key}`}>{legacy[key] ?? n}</span></p>
        {sub && <p className="text-xs opacity-80">{sub}</p>}
      </li>
    </Tip>
  );
  return (
    <ul className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" data-testid="batch-kpis" aria-label={t('batchReview.kpis')}>
      {card('rows', c.rows, 'bg-card', t('batchReview.kpi_rows'), pct(c.valid, c.rows) ? t('batchReview.kpi_rows_sub', { pct: pct(c.valid, c.rows) }) : undefined, undefined, t('batchReview.hint_rows'))}
      {card('valid', c.valid, 'bg-doneBg text-doneInk', t('batchReview.kpi_valid'), <span data-testid="batch-count-diff">{t('batch.diff', { create: c.create, update: c.update, unchanged: c.unchanged })}</span>, <Check size={14} aria-hidden />, t('batchReview.hint_valid'))}
      {card('duplicate', dup, dup ? 'bg-waitBg text-waitInk' : 'bg-card text-mute', t('batchReview.kpi_duplicate'), undefined, <Copy size={14} aria-hidden />, t('batchReview.hint_duplicate'))}
      {card('invalid', rejected, rejected ? 'bg-lateBg text-lateInk' : 'bg-card text-mute', t('batchReview.kpi_invalid'), undefined, <CircleAlert size={14} aria-hidden />, t('batchReview.hint_invalid'))}
      {card('held', c.held, c.held ? 'bg-lockBg text-lockInk' : 'bg-card text-mute', t('batchReview.kpi_held'), undefined, <TriangleAlert size={14} aria-hidden />, t('batchReview.hint_held'))}
    </ul>
  );
}

const STEP_OF: Record<string, number> = { validated: 1, processing: 2, in_approval: 2, partially_approved: 2, in_review: 2, approved: 3, rejected: 3, discarded: 3, applied: 3 };

/** Three numbered stages with what happened in each. The first says how many rows were checked and when; the current one is marked. */
export function BatchStepper({ batch: b }: { batch: ImportBatch }) {
  const { t, i18n } = useTranslation();
  const step = STEP_OF[b.status] ?? 1;
  const c = batchTotals(b.counts);
  const when = b.uploaded_at ? new Intl.DateTimeFormat(i18n.language === 'ar' ? 'ar-LY-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(b.uploaded_at)) : '';
  const sub: Record<number, string> = {
    1: t('batchReview.step1_sub', { rows: c.rows, when }),
    2: step >= 2 ? t('batchReview.step2_sub', { open: c.pending, held: c.held }) : t('batchReview.step_waiting'),
    3: step >= 3 ? t('batchReview.step3_sub', { approved: c.approved, rejected: c.rejected }) : t('batchReview.step_waiting'),
  };
  return (
    <ol className="mb-3 flex flex-wrap items-start gap-x-6 gap-y-2" data-testid="batch-steps" aria-label={t('batch.steps')}>
      {[1, 2, 3].map((n) => {
        const done = step > n || (n === 3 && step === 3), current = step === n && !(n === 3);
        return (
          <li key={n} aria-current={step === n ? 'step' : undefined} data-step={n} className="flex min-w-40 items-start gap-2">
            <span aria-hidden className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-sm font-bold ${done ? 'bg-done text-white' : current ? 'bg-accent text-white' : 'bg-card2 text-mute'}`}>{done ? <Check size={14} /> : n}</span>
            <span className="text-sm"><span className={`block font-semibold ${step === n ? 'text-accentText' : step > n ? 'text-doneInk' : 'text-mute'}`}>{n}. {t(`batch.step_${n}`)}</span><span className="block text-xs text-mute" data-testid={`batch-step-sub-${n}`}>{sub[n]}</span></span>
          </li>
        );
      })}
    </ol>
  );
}

/** Search, filter tabs with counts, sort and the error report button. */
export function BatchToolbar({ show, onShow, counts, query, onQuery, sort, onSort, onReport, reportBusy, reportable }: {
  show: BatchShow; onShow: (s: BatchShow) => void; counts: Record<BatchShow, number>; query: string; onQuery: (q: string) => void; sort: BatchSort; onSort: (s: BatchSort) => void;
  onReport: () => void; reportBusy: boolean; reportable: boolean;
}) {
  const { t } = useTranslation();
  const tabs = (['all', 'valid', 'invalid', 'duplicate', 'held', 'warnings'] as const).filter((s) => s === 'all' || s === 'valid' || s === 'invalid' || counts[s] > 0);
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="batch-toolbar">
      <label className="relative flex min-w-52 flex-1 items-center">
        <span className="sr-only">{t('batchReview.search')}</span>
        <Search size={14} aria-hidden className="pointer-events-none absolute start-2 text-mute" />
        <input type="search" className="input w-full ps-7" data-testid="batch-search" placeholder={t('batchReview.search_ph')} value={query} onChange={(e) => onQuery(e.target.value)} />
      </label>
      <div role="tablist" aria-label={t('batchReview.filters')} className="flex flex-wrap gap-1">
        {tabs.map((s) => (
          <button key={s} role="tab" aria-selected={show === s} data-testid={`batch-show-${s}`} className={`btn px-3 py-1 text-xs ${show === s ? 'btn-primary' : ''}`} onClick={() => onShow(s)}>
            {t(`batchReview.show_${s}`)} <span className="mono opacity-80" data-testid={`batch-show-count-${s}`}>{counts[s]}</span>
          </button>
        ))}
      </div>
      <label className="flex items-center gap-1 text-xs text-mute">
        {t('batchReview.sort')}
        <select className="input py-1 text-sm" data-testid="batch-sort" value={sort} onChange={(e) => onSort(e.target.value as BatchSort)}>
          {(['row', 'result', 'key'] as const).map((s) => <option key={s} value={s}>{t(`batchReview.sort_${s}`)}</option>)}
        </select>
      </label>
      <Tip text={reportable ? t('batchReview.report_hint') : t('batchReview.report_none')}>
        <button type="button" className="btn" data-testid="batch-error-report" disabled={!reportable || reportBusy} aria-label={t('batchReview.report')} onClick={onReport}><Download size={16} aria-hidden />{t('batchReview.report')}</button>
      </Tip>
    </div>
  );
}

/** The bar over the table while rows are ticked: approve or return only those. Same L2 doors as the row buttons; the bar only batches them. */
export function SelectionBar({ count, busy, onApprove, onReturn, onClear }: { count: number; busy: boolean; onApprove: () => void; onReturn: () => void; onClear: () => void }) {
  const { t } = useTranslation();
  if (!count) return null;
  return (
    <div role="region" aria-label={t('batchReview.selection')} className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-accent bg-accentSoft p-2 text-sm" data-testid="batch-selection">
      <span className="flex-1 font-semibold text-accentText" data-testid="batch-selection-count" data-count={count}>{t('batchReview.selected', { count })}</span>
      <button type="button" className="btn" data-testid="batch-selection-clear" onClick={onClear}><X size={14} aria-hidden />{t('batchReview.clear')}</button>
      <button type="button" className="btn btn-danger" data-testid="batch-selection-return" disabled={busy} onClick={onReturn}><Undo2 size={14} aria-hidden />{t('batchReview.return_selected')}</button>
      <button type="button" className="btn btn-primary" data-testid="batch-selection-approve" disabled={busy} onClick={onApprove}><Check size={14} aria-hidden />{t('batchReview.approve_selected', { count })}</button>
    </div>
  );
}

/** Placeholder rows while the first page loads, instead of a bare "...". */
export function BatchSkeleton() {
  return (
    <div className="card space-y-2 p-4" data-testid="batch-skeleton" role="status" aria-busy="true">
      {[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-6 animate-pulse rounded bg-card2" style={{ width: `${95 - i * 7}%` }} />)}
    </div>
  );
}

/** Designed empty and failed states: what happened and what to do next. */
export function BatchEmpty({ show, query, onClear }: { show: BatchShow; query: string; onClear: () => void }) {
  const { t } = useTranslation();
  const key = query ? 'search' : show;
  return (
    <div className="p-6 text-center" data-testid="batch-empty" data-kind={key}>
      <p className="font-semibold">{t(`batchReview.empty_${['search', 'invalid', 'duplicate', 'held', 'warnings'].includes(key) ? key : 'all'}`)}</p>
      {(query || show !== 'all') && <button type="button" className="btn mt-2" data-testid="batch-empty-clear" onClick={onClear}>{t('batchReview.show_everything')}</button>}
    </div>
  );
}
