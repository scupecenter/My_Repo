import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { RegisterRecord } from '@/api/types';
import { computeTotal, fmtTotal, TOTAL_FNS, type TotalFn } from '@/lib/columnTotals';
import { loadPref, savePref } from '@/lib/localPref';
import { useExtra } from '@/lib/uiExtras';
import { EvidenceDot } from './EvidenceDot';

export interface GridColumn { id: string; label: string }
/** Totals row (item 1): which columns are numeric, and the number a record has in one. `storeKey` keeps each person's choice of sum, average, count, min or max per column. */
export interface GridTotals { numeric: (columnId: string) => boolean; value: (columnId: string, r: RegisterRecord) => number | null | undefined; storeKey: string }

function TotalCell({ col, label, rows, totals }: { col: string; label: string; rows: RegisterRecord[]; totals: GridTotals }) {
  const { t, i18n } = useTranslation();
  const k = `pmis.totals.${totals.storeKey}.${col}`;
  const [fn, setFn] = useState<TotalFn>(() => { const v = loadPref<string>(k, 'sum'); return (TOTAL_FNS as readonly string[]).includes(v) ? (v as TotalFn) : 'sum'; });
  const n = computeTotal(rows.map((r) => totals.value(col, r)), fn);
  return (
    <div className="flex items-center gap-1 whitespace-nowrap" data-testid={`totals-cell-${col}`}>
      <select className="input w-auto px-1 py-0 text-xs" aria-label={t('totals.fn_for', { col: label })} data-testid={`totals-fn-${col}`} value={fn}
        onChange={(e) => { const v = e.target.value as TotalFn; setFn(v); savePref(k, v); }}>
        {TOTAL_FNS.map((f) => <option key={f} value={f}>{t(`totals.${f}`)}</option>)}
      </select>
      <span className="font-semibold tabular-nums" data-testid={`totals-value-${col}`} data-fn={fn}>{fmtTotal(n, i18n.language)}</span>
    </div>
  );
}

/**
 * The Grid view of a register list (F16): the records the list already loaded, one row each, one column per shown field, in a table with a
 * sticky header and first column. It reads the same records as the Vertical list, so it adds no store and no request; a click or Enter opens
 * the record drawer like the list does. A cell that canEdit takes an inline editor on click (the save goes through the record update).
 */
export function RegisterGrid({ columns, rows, cell, onOpen, canEdit, editing, onStartEdit, renderEditor, totals, testid = 'register-grid' }: {
  columns: GridColumn[];
  rows: RegisterRecord[];
  cell: (columnId: string, r: RegisterRecord) => ReactNode;
  onOpen: (id: string) => void;
  /** Inline edit: true when the cell takes an editor (the record allows edit and the field is a simple type). */
  canEdit?: (columnId: string, r: RegisterRecord) => boolean;
  editing?: { id: string; col: string } | null;
  onStartEdit?: (id: string, col: string) => void;
  renderEditor?: (columnId: string, r: RegisterRecord) => ReactNode;
  totals?: GridTotals;
  testid?: string;
}) {
  const { t } = useTranslation();
  const showTotals = useExtra('totals_row');
  const numeric = showTotals && totals ? columns.filter((c) => totals.numeric(c.id)) : [];
  return (
    <div className="card relative max-h-[calc(100vh-18rem)] min-h-40 overflow-auto" data-testid={testid}>
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{t('viewMode.grid')}</caption>
        <thead className="sticky top-0 z-10 bg-card">
          <tr>
            <th scope="col" data-col="#" className="whitespace-nowrap border-b border-line px-2 py-2 text-end font-semibold">#</th>
            {columns.map((c, i) => (
              <th key={c.id} scope="col" data-col={c.id} className={`whitespace-nowrap border-b border-line px-2 py-2 text-start font-semibold ${i === 0 ? 'sticky start-0 bg-card' : ''}`}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={r.id} data-testid={`reg-grid-row-${r.id}`} data-state={r.state} tabIndex={0} className="cursor-pointer border-b border-line hover:bg-hover focus-visible:bg-hover"
              onClick={() => onOpen(r.id)}
              onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onOpen(r.id); } }}>
              <td data-testid="reg-grid-no" className="px-2 py-2 text-end tabular-nums text-mute">{idx + 1}<EvidenceDot docs={r.docs} testid={`${testid}-dot-${r.id}`} /></td>
              {columns.map((c, i) => {
                const on = editing?.id === r.id && editing.col === c.id;
                const editable = !!onStartEdit && !on && !!canEdit?.(c.id, r);
                return (
                  <td key={c.id} data-col={c.id} data-editable={editable || undefined}
                    onClick={editable ? (e) => { e.stopPropagation(); onStartEdit?.(r.id, c.id); } : undefined}
                    className={`min-w-0 px-2 py-2 align-middle ${i === 0 ? 'sticky start-0 bg-card' : ''} ${editable ? 'cursor-text' : ''}`}>
                    {on && renderEditor ? renderEditor(c.id, r) : cell(c.id, r)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        {numeric.length > 0 && totals && (
          <tfoot className="sticky bottom-0 z-10 bg-card" data-testid={`${testid}-totals`}>
            <tr className="border-t-2 border-line">
              <th scope="row" className="px-2 py-2 text-end text-xs font-semibold text-mute" title={t('totals.of_rows', { count: rows.length })}>{t('totals.label')}</th>
              {columns.map((c, i) => (
                <td key={c.id} data-col={c.id} className={`px-2 py-2 align-middle ${i === 0 ? 'sticky start-0 bg-card' : ''}`}>
                  {totals.numeric(c.id) ? <TotalCell col={c.id} label={c.label} rows={rows} totals={totals} /> : i === 0 ? <span className="text-xs text-mute">{t('totals.of_rows', { count: rows.length })}</span> : null}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
