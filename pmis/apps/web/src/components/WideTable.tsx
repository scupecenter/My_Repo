import { Pencil } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { errText } from '@/components/FormDialog';
import { EmptyState, NoResults } from '@/components/States';
import { displayAttrs } from '@/components/TableStandard';
import type { Display } from '@/lib/tablePrefs';

/** The editor of one cell of the wide table. */
export type WideInput = 'date' | 'number' | 'list' | 'text' | 'boolean';

/** A column of the wide table: its key, its name, and the section (header row 1) and group (header row 2) it sits under. */
export interface WideColumn { key: string; header: string; top?: string | null; mid?: string | null; title?: string; minWidth?: number }

/**
 * One row: its id, the code shown in the frozen second column, its number (1..n in the current sort and filter, across pages) and, when the code is
 * not unique (several records of one site), the key that names the row in the selection and the test ids (default: the code).
 */
export interface WideTableRow { id: string; code: string; rowNo?: number | null; key?: string }

/**
 * What a cell shows and whether it can be edited inline. `edit` is set only when the screen's own rules allow editing that field of that row (the
 * same rights, locks and state as its other editors); the save then goes through the screen's own save path (`onSave`). `reason` says why a
 * cell is read-only (a tooltip). `target` marks a cell backed by a stored value (the cell gets its test id).
 */
export interface WideCell {
  text: string;
  /** what to draw instead of the plain text (a chip); `text` stays the value of the empty check */
  node?: ReactNode;
  edit?: { input: WideInput; initial: string; options?: { value: string; label: string }[]; hint?: string } | null;
  reason?: string;
  target?: boolean;
}

const HEAD = 30; // px: height of one header row, so the second and third header rows stick right under the first
const NUM_W = 80, ID_W = 110;

/**
 * The shared wide table (owner request 2026-11-22; generalised for every register and log by W2 of plan 2026-11-23-next-ui-cleanup): one row per
 * record, the columns of the screen left to right, the section and group headers above the column names (adjacent equal headers merge; a column
 * without a group spans the group and name rows). Not a spreadsheet: no cell selection, no fill-down, no range or multi-cell paste. The table and
 * its scroller are LTR in both locales, so the columns read left to right; # and the first column (Site ID) are frozen.
 * Editing: a cell whose adapter gives an `edit` opens a typed inline editor (click or Enter), Save or Esc. One edit changes only that cell, through
 * `onSave`, the screen's existing save path (its rights, locks, version check and errors); a refusal keeps the editor open and says why.
 */
export function WideTable<R extends WideTableRow>({
  testid, tableTestid, scrollTestid, label, dataMenu, idHeader, idCell, columns, rows, cell, onSave, errorText, depth, display, busy, height, sel,
  picked, onPick, onPickAll, hasMore, loadingMore, onMore, moreTestid, loaded, filtered, onClear, emptyTestid, emptyTitle,
}: {
  testid: string; tableTestid: string; scrollTestid: string; label: string; dataMenu?: string;
  /** the header of the frozen second column (Site ID) */
  idHeader: string;
  /** what the frozen second cell shows after the bold code (a link to the site, or a button that opens the record) */
  idCell?: (row: R) => ReactNode;
  columns: WideColumn[]; rows: R[]; cell: (row: R, col: WideColumn) => WideCell;
  onSave: (row: R, col: WideColumn, value: string | number | boolean) => Promise<unknown>;
  /** the screen's own text for a refused save; the default reads the API's field errors */
  errorText?: (e: unknown) => string;
  /** header rows: 3 = section, group and name; 2 = section and name; 1 = name only. Default: what the columns carry. */
  depth?: 1 | 2 | 3;
  display?: Display; busy?: boolean; height: number; sel?: string;
  /** the selected rows (by key) for the bulk bar: a checkbox in the frozen # cell of each row and a select-all in its header */
  picked: Set<string>; onPick: (code: string) => void; onPickAll: () => void;
  hasMore: boolean; loadingMore: boolean; onMore: () => void; moreTestid: string;
  loaded: boolean; filtered: boolean; onClear: () => void; emptyTestid: string; emptyTitle: string;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<{ row: string; col: string; draft: string; error: string | null; pending: boolean } | null>(null);
  const cols = columns;
  const levels = depth ?? (cols.some((c) => c.mid?.trim()) ? 3 : cols.some((c) => c.top?.trim()) ? 2 : 1);
  // W8 item 2: up to three header rows: the section (row 1), the group (row 2), the column name only (row 3). Adjacent equal headers merge; a
  // column without a group spans rows 2 and 3; a group never crosses two sections.
  const groups: { top: string; n: number }[] = [];
  for (const c of cols) { const top = c.top ?? ''; const last = groups[groups.length - 1]; if (last && last.top === top) last.n += 1; else groups.push({ top, n: 1 }); }
  const mids: { top: string; mid: string | null; n: number; key: string }[] = [];
  for (const c of cols) {
    const top = c.top ?? '', mid = c.mid?.trim() ? c.mid : null, last = mids[mids.length - 1];
    if (last && mid !== null && last.mid === mid && last.top === top) last.n += 1; else mids.push({ top, mid, n: 1, key: c.key });
  }
  const noGroup = new Set(cols.filter((c) => !c.mid?.trim()).map((c) => c.key));
  const defaultError = (e: unknown) => {
    // a field problem of the API: its own translated text when the app has one for the code, else the API's message, else the general message of the error
    const fields = e instanceof ApiError ? e.problem.errors ?? [] : [];
    const known = fields.map((x) => t(`errors.${x.code}`)).find((x, i) => x !== `errors.${fields[i]!.code}`);
    const api = fields.find((x) => x.message)?.message;
    return known ?? api ?? errText(e, t as (k: string) => string);
  };
  // the edit keeps the editor open when the save path refuses it, and says why next to the cell (a version conflict, a lock, a rule, a bad value)
  const save = async (row: R, col: WideColumn, c: WideCell) => {
    if (!editing || editing.pending || !c.edit) return;
    const kind = c.edit.input;
    const d = editing.draft;
    if (d === c.edit.initial) { setEditing(null); return; }
    if (kind === 'number' && d !== '' && !Number.isFinite(Number(d))) { setEditing({ ...editing, error: t('sites.wide_bad_number') }); return; }
    const value: string | number | boolean = kind === 'number' && d !== '' ? Number(d) : kind === 'boolean' ? d === 'true' : d;
    setEditing({ ...editing, pending: true, error: null });
    try { await onSave(row, col, value); setEditing(null); } catch (e) {
      const m = (errorText ?? defaultError)(e);
      setEditing((cur) => (cur ? { ...cur, pending: false, error: m } : cur));
    }
  };
  const stick = (left: number, z: number) => ({ position: 'sticky' as const, insetInlineStart: left, zIndex: z });
  const th = 'border-b border-e border-line bg-card2 px-2 text-xs font-semibold whitespace-nowrap';
  const minW = (c: WideColumn) => c.minWidth ?? 150;
  const name = (c: WideColumn, top: number, extra = '') => (
    <th key={c.key} scope="col" title={c.title} className={`${th} text-start ${extra}`} style={{ position: 'sticky', top, zIndex: 30, height: HEAD, minWidth: minW(c) }} data-testid={`wide-col-${c.key}`}>{c.header}</th>
  );
  return (
    <div className="card overflow-hidden" data-testid={testid} {...(display ? displayAttrs(display) : {})}>
      {/* dir=ltr on the scroller too: in the Arabic UI an RTL scroller would open the LTR table at its right end (the last columns) */}
      <div dir="ltr" className="overflow-auto" style={{ maxHeight: height }} data-testid={scrollTestid}>
        <table dir="ltr" aria-label={label} className="border-separate border-spacing-0 text-sm" data-menu={dataMenu} data-depth={levels} data-testid={tableTestid}>
          <thead>
            <tr style={{ height: HEAD }}>
              <th rowSpan={levels} scope="col" className={`${th} text-center`} style={{ ...stick(0, 40), top: 0, width: NUM_W, minWidth: NUM_W }} data-testid="wide-col-num"><span className="flex items-center justify-center gap-1"><input type="checkbox" className="h-4 w-4" aria-label={t('table.select_all')} data-testid="wide-select-all" checked={rows.length > 0 && rows.every((r) => picked.has(r.key ?? r.code))} onChange={onPickAll} />#</span></th>
              <th rowSpan={levels} scope="col" className={`${th} text-start`} style={{ ...stick(NUM_W, 40), top: 0, width: ID_W, minWidth: ID_W }} data-testid="wide-col-site">{idHeader}</th>
              {levels === 1
                ? cols.map((c) => name(c, 0))
                : groups.map((g, i) => <th key={i} colSpan={g.n} scope="colgroup" className={`${th} text-start text-mute`} style={{ position: 'sticky', top: 0, zIndex: 30, height: HEAD }} data-testid="wide-group">{g.top}</th>)}
            </tr>
            {levels === 2 && <tr style={{ height: HEAD }}>{cols.map((c) => name(c, HEAD, 'font-normal'))}</tr>}
            {levels === 3 && (
              <>
                <tr style={{ height: HEAD }}>
                  {mids.map((g) => {
                    const col = cols.find((c) => c.key === g.key)!;
                    return g.mid === null
                      ? <th key={g.key} rowSpan={2} scope="col" title={col.title} className={`${th} text-start`} style={{ position: 'sticky', top: HEAD, zIndex: 30, height: HEAD * 2, minWidth: minW(col) }} data-testid={`wide-col-${col.key}`} data-span-rows="2">{col.header}</th>
                      : <th key={g.key} colSpan={g.n} scope="colgroup" className={`${th} text-start`} style={{ position: 'sticky', top: HEAD, zIndex: 30, height: HEAD }} data-testid="wide-subgroup" data-span={g.n}>{g.mid}</th>;
                  })}
                </tr>
                <tr style={{ height: HEAD }}>{cols.filter((c) => !noGroup.has(c.key)).map((c) => name(c, HEAD * 2, 'font-normal'))}</tr>
              </>
            )}
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const k = r.key ?? r.code;
              const cur = !!sel && sel === k;
              const bg = cur ? 'bg-accentSoft' : i % 2 && display?.zebra !== false ? 'bg-card2' : 'bg-card';
              const n = r.rowNo ?? i + 1;
              return (
                <tr key={r.id} data-testid={`wide-row-${k}`} data-selected={cur || undefined} className={`hover:bg-hover ${bg}`}>
                  <td className={`border-b border-e border-line px-2 text-center text-mute ${bg}`} style={stick(0, 20)}><span className="flex items-center justify-center gap-1"><input type="checkbox" className="h-4 w-4" aria-label={t('table.select_row', { code: r.code })} data-testid={`wide-select-${k}`} checked={picked.has(k)} onChange={() => onPick(k)} /><span data-wide-row-no={n}>{n}</span></span></td>
                  <td className={`border-b border-e border-line px-2 ${bg}`} style={stick(NUM_W, 20)}><span className="flex items-center gap-1"><b className="mono">{r.code}</b>{idCell?.(r)}</span></td>
                  {cols.map((c) => {
                    const x = cell(r, c);
                    const shown = x.node && x.text ? x.node : <span className={x.text ? '' : 'text-mute'}>{x.text || t('sites.wide_not_entered')}</span>;
                    const isEditing = !!x.edit && editing?.row === r.id && editing.col === c.key;
                    return (
                      <td key={c.key} data-col={c.key} data-editable={x.edit ? 'true' : undefined} title={x.reason} className={`border-b border-e border-line px-2 ${display?.density === 'compact' ? 'py-0.5' : display?.density === 'normal' ? 'py-1' : 'py-1.5'} ${display?.wrap ? 'max-w-72 whitespace-normal' : 'whitespace-nowrap'}`} data-testid={x.target ? `wide-cell-${k}-${c.key}` : undefined}>
                        {isEditing && x.edit && editing ? (
                          <span className="flex flex-col gap-0.5">
                          <span className="flex items-center gap-1">
                            {(() => {
                              const kind = x.edit.input;
                              const common = { autoFocus: true, 'aria-label': c.header, 'aria-invalid': editing.error ? true : undefined, disabled: editing.pending, 'data-testid': `wide-input-${k}-${c.key}`, 'data-input': kind } as const;
                              const keys = (e: React.KeyboardEvent) => { if (e.key === 'Enter') void save(r, c, x); if (e.key === 'Escape') setEditing(null); };
                              if (kind === 'list') {
                                const opts = x.edit.options ?? [];
                                return (
                                  <>
                                  <select {...common} className="input h-7 w-40 px-1 py-0 text-xs" value={editing.draft} onChange={(e) => setEditing({ ...editing, draft: e.target.value, error: null })} onKeyDown={keys}>
                                    <option value="">{t('sites.wide_none')}</option>
                                    {editing.draft && !opts.some((o) => o.value === editing.draft) && <option value={editing.draft}>{editing.draft}</option>}
                                    {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                  </select>
                                  {x.edit.hint && <span className="text-xs text-mute" data-testid={`wide-parent-hint-${k}-${c.key}`}>{x.edit.hint}</span>}
                                  </>
                                );
                              }
                              if (kind === 'boolean') {
                                return <input {...common} type="checkbox" className="h-4 w-4" checked={editing.draft === 'true'} onChange={(e) => setEditing({ ...editing, draft: e.target.checked ? 'true' : 'false', error: null })} onKeyDown={keys} />;
                              }
                              return <input {...common} type={kind} step={kind === 'number' ? 'any' : undefined} className="input h-7 w-36 px-1 py-0 text-xs" value={editing.draft} onChange={(e) => setEditing({ ...editing, draft: e.target.value, error: null })} onKeyDown={keys} />;
                            })()}
                            <button type="button" disabled={editing.pending} className="btn px-2 py-0.5 text-xs" data-testid={`wide-save-${k}-${c.key}`} onClick={() => void save(r, c, x)}>{t('common.save')}</button>
                            <button type="button" disabled={editing.pending} className="btn px-2 py-0.5 text-xs" data-testid={`wide-cancel-${k}-${c.key}`} onClick={() => setEditing(null)}>{t('common.cancel')}</button>
                          </span>
                          {editing.error && <span role="alert" className="max-w-72 whitespace-normal text-xs text-red-600" data-testid={`wide-error-${k}-${c.key}`}>{editing.error}</span>}
                          </span>
                        ) : x.edit ? (
                          <button type="button" disabled={busy} className="group flex w-full items-center gap-1 text-start hover:text-accentText focus-visible:ring-2 focus-visible:ring-accent" aria-label={`${t('sites.wide_edit')}: ${c.header}`} data-testid={`wide-edit-${k}-${c.key}`}
                            onClick={() => setEditing({ row: r.id, col: c.key, draft: x.edit!.initial, error: null, pending: false })}>
                            {shown}<Pencil size={12} className="ms-auto text-mute opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden />
                          </button>
                        ) : shown}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        {loaded && !rows.length && (filtered ? <NoResults testid={emptyTestid} onClear={onClear} /> : <EmptyState testid={emptyTestid} title={emptyTitle} />)}
      </div>
      {hasMore && <button type="button" className="btn m-2" data-testid={moreTestid} disabled={loadingMore} onClick={onMore}>{t('site360.more')}</button>}
    </div>
  );
}
