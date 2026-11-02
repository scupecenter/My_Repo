import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/States';
import { HeaderRow, pin, rowPad, totalWidth, tracks, type TableApi } from '@/components/TableKit';

/** Grid table with column control (order, width, hide, density). The first column is pinned. Rows open a drawer with Enter or click. */
export function LogTable<T>({ tbl, label, rows, rowId, cell, onOpen, activeId, testid, loading, error, onRetry, hasMore, onMore, loadingMore, empty }: {
  tbl: TableApi; label: (id: string) => string; rows: T[]; rowId: (r: T) => string; cell: (r: T, col: string) => ReactNode; onOpen?: (r: T) => void; activeId?: string | null; testid: string;
  loading?: boolean; error?: boolean; onRetry?: () => void; hasMore?: boolean; onMore?: () => void; loadingMore?: boolean; empty?: string;
}) {
  const { t } = useTranslation();
  if (error) return <ErrorState onRetry={onRetry} />;
  if (loading) return <LoadingSkeleton />;
  return (
    <div data-testid={testid}>
      <div className="card overflow-x-auto" role="table" aria-label={testid}>
        <HeaderRow api={tbl} label={label} testid={`${testid}-head`} />
        <div role="rowgroup" data-testid={`${testid}-body`}>
          {rows.map((r) => {
            const id = rowId(r), on = id === activeId;
            return (
              <div key={id} role="row" tabIndex={onOpen ? 0 : undefined} data-testid={`${testid}-row-${id}`} aria-selected={onOpen ? on : undefined}
                onClick={onOpen ? () => onOpen(r) : undefined} onKeyDown={onOpen ? (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(r); } : undefined}
                style={{ gridTemplateColumns: tracks(tbl.cols, false), minWidth: totalWidth(tbl.cols, false) }}
                className={`grid items-center border-b border-line text-sm ${rowPad(tbl.density)} ${onOpen ? 'cursor-pointer' : ''} ${on ? 'bg-accentSoft' : 'bg-card hover:bg-hover'}`}>
                {tbl.cols.map((c) => {
                  const p = pin(c, false);
                  return <div key={c.id} role="cell" data-col={c.id} className={`min-w-0 truncate px-2 ${p.className}`} style={p.style}>{cell(r, c.id)}</div>;
                })}
              </div>
            );
          })}
        </div>
      </div>
      {!rows.length && <EmptyState title={empty ?? t('logs.empty')} testid={`${testid}-empty`} />}
      {hasMore && <div className="mt-3 text-center"><button className="btn" data-testid={`${testid}-more`} disabled={loadingMore} onClick={onMore}>{t('logs.load_more')}</button></div>}
    </div>
  );
}
