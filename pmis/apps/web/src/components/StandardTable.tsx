import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/States';
import type { ColDef } from '@/lib/tablePrefs';
import { ColumnMenu, DensityToggle, HeaderRow, pin, rowPad, totalWidth, tracks, useTablePrefs } from './TableKit';
import { DisplayMenu, displayAttrs, ExportCsvButton, SearchBox, TableCount, TableToolbar, type TableNoun } from './TableStandard';

/**
 * The table standard for the small tables of a detail page (the tabs of the site page, and any table with a few dozen rows that is read from one
 * request): the same toolbar as every site-data screen (search, count, columns, density, Display, export of the view), the same header row (reorder,
 * resize, hide), the same Display options and the same row look, all kept per user and screen like the big tables. Saved views and the + Filter tree
 * are not part of it: a table of one site has a search and, where it needs one, its own quick filters in the `extra` slot.
 */
export type StdCol<T> = {
  id: string;
  /** header text, also the CSV head */
  label: string;
  w: number;
  min?: number;
  max?: number;
  pinned?: boolean;
  /** hidden until the person turns it on in the column menu */
  off?: boolean;
  cell: (r: T) => ReactNode;
  /** plain text of the cell: searched and exported */
  text: (r: T) => string;
  /** the cell is not exported or searched (a button column) */
  action?: boolean;
  /** the cell holds several lines (chips, details): it is not cut to one line */
  multi?: boolean;
};

export function StandardTable<T>({ screen, testid, cols, rows, rowId, rowTestId, rowAttrs, noun = 'items', loading, error, onRetry, empty, onOpen, activeId, extra, primary, more, exportName, query, onQuery, searchTestId, hasMore, onMore, loadingMore, total, children }: {
  screen: string;
  testid: string;
  cols: StdCol<T>[];
  rows: T[];
  rowId: (r: T) => string;
  rowTestId?: (r: T) => string;
  rowAttrs?: (r: T) => Record<string, string | undefined>;
  noun?: TableNoun;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  empty?: string;
  onOpen?: (r: T) => void;
  activeId?: string | null;
  /** quick filters of the screen, placed with the search */
  extra?: ReactNode;
  primary?: ReactNode;
  more?: ReactNode;
  exportName: string;
  /** a search the server applies (the screen owns the text): no client-side filtering then */
  query?: string;
  onQuery?: (v: string) => void;
  searchTestId?: string;
  hasMore?: boolean;
  onMore?: () => void;
  loadingMore?: boolean;
  /** the server total when only a page is loaded */
  total?: number;
  /** content under the toolbar (summaries) */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [own, setOwn] = useState('');
  const server = onQuery !== undefined;
  const q = server ? query ?? '' : own;
  const setQ = server ? onQuery : setOwn;
  const defs: ColDef[] = useMemo(() => cols.map((c) => ({ id: c.id, w: c.w, min: c.min, max: c.max, pinned: c.pinned, off: c.off })), [cols]);
  const tbl = useTablePrefs(screen, defs);
  const byId = useMemo(() => new Map(cols.map((c) => [c.id, c])), [cols]);
  const needle = server ? '' : q.trim().toLowerCase();
  const shown = useMemo(() => (needle ? rows.filter((r) => cols.some((c) => !c.action && c.text(r).toLowerCase().includes(needle))) : rows), [rows, cols, needle]);
  const label = (id: string) => byId.get(id)?.label ?? id;
  const exportCols = tbl.cols.map((c) => byId.get(c.id)).filter((c): c is StdCol<T> => !!c && !c.action);
  const bar = (
    <TableToolbar testid={`${testid}-toolbar`} kind="grid"
      search={<SearchBox value={q} onChange={setQ} testid={searchTestId ?? `${testid}-search`} placeholder={t('tstd.search_table')} />}
      extra={extra}
      count={<TableCount testid={`${testid}-count`} noun={noun} total={total ?? rows.length} filtered={needle ? shown.length : total ?? rows.length} active={!!q.trim()} onClear={() => setQ('')} />}
      primary={primary}
      columns={<ColumnMenu api={tbl} label={label} />}
      density={<DensityToggle api={tbl} />}
      display={<DisplayMenu api={tbl} />}
      exporter={<ExportCsvButton testid={`${testid}-export`} name={exportName} head={exportCols.map((c) => c.label)} rows={() => shown.map((r) => exportCols.map((c) => c.text(r)))} />}
      more={more} />
  );
  if (error) return <>{bar}<ErrorState onRetry={onRetry} /></>;
  if (loading) return <>{bar}<LoadingSkeleton /></>;
  return (
    <div data-testid={testid}>
      {bar}
      {children}
      <div className="card overflow-x-auto" role="table" aria-label={testid} {...displayAttrs(tbl.display)}>
        <HeaderRow api={tbl} label={label} testid={`${testid}-head`} />
        <div role="rowgroup" data-testid={`${testid}-body`}>
          {shown.map((r) => {
            const id = rowId(r), on = id === activeId;
            return (
              <div key={id} role="row" tabIndex={onOpen ? 0 : undefined} data-testid={rowTestId ? rowTestId(r) : `${testid}-row-${id}`} aria-selected={onOpen ? on : undefined} {...rowAttrs?.(r)}
                onClick={onOpen ? () => onOpen(r) : undefined} onKeyDown={onOpen ? (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(r); } : undefined}
                style={{ gridTemplateColumns: tracks(tbl.cols, false), minWidth: totalWidth(tbl.cols, false) }}
                className={`grid items-start border-b border-line text-sm ${rowPad(tbl.density)} ${onOpen ? 'cursor-pointer' : ''} ${on ? 'bg-accentSoft' : 'bg-card hover:bg-hover'}`}>
                {tbl.cols.map((c) => {
                  const p = pin(c, false);
                  return <div key={c.id} role="cell" data-col={c.id} className={`min-w-0 px-2 ${byId.get(c.id)?.multi ? 'py-1' : 'truncate'} ${p.className}`} style={p.style}>{byId.get(c.id)?.cell(r)}</div>;
                })}
              </div>
            );
          })}
        </div>
      </div>
      {!shown.length && <EmptyState title={empty ?? t('tstd.empty')} testid={`${testid}-empty`} />}
      {hasMore && <div className="mt-3 text-center"><button className="btn" data-testid={`${testid}-more`} disabled={loadingMore} onClick={onMore}>{t('logs.load_more')}</button></div>}
    </div>
  );
}
