import { ExternalLink, Pencil } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { Site360MenuItem } from '@/api/site360';
import type { Site360CellTarget } from '@/components/Site360Grid';
import { EmptyState, NoResults } from '@/components/States';
import { fmtDate } from '@/lib/time';

export interface WideRow { site_id: string; site_code: string; row_no?: number | null; values: Record<string, string | null>; cells?: Record<string, Site360CellTarget> }

/** One typed edit of one cell of one site: the same target and value the grid sends to the same save path (PATCH /tasks/{task_id}, If-Match the version). */
export interface WideEdit { row: WideRow; ord: number; target: Site360CellTarget; value: string }

const STATUSES = ['not_started', 'in_progress', 'on_hold', 'completed', 'cancelled'];
const HEAD = 32; // px: height of one header row, so the second header row sticks right under the first
const NUM_W = 56, ID_W = 110;

/**
 * Wide table (owner request 2026-11-22): one row per site, the Master columns of the menu left to right in Master order, section headers above the column
 * headers. Not a spreadsheet: no cell selection, no fill-down, no range or multi-cell paste. The table is LTR even in the Arabic UI so the Master order reads
 * left to right; # and Site ID are frozen, and the open icon in the Site ID cell opens the site page.
 * Editing (owner decision 2026-11-22): a task-backed cell the API marks editable opens a typed inline editor (click or Enter), Save or Esc; one edit changes
 * only that site's cell, through the same save path as the grid (the same rights, locks, gate rules and errors). Other cells stay plain, with the reason in a tooltip.
 */
export function SitesWideTable({ menu, rows, hasMore, loadingMore, onMore, loaded, filtered, onClear, sel, onEdit, busy, height }: {
  menu: Site360MenuItem; rows: WideRow[]; hasMore: boolean; loadingMore: boolean; onMore: () => void; loaded: boolean; filtered: boolean; onClear: () => void;
  sel: string; onEdit: (e: WideEdit) => void; busy?: boolean; height: number;
}) {
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState<{ site: string; ord: number; draft: string } | null>(null);
  // # (ord 1) and Site ID (ord 2) are the two frozen columns; every other column of the menu follows in Master order
  const cols = [...menu.columns].filter((c) => c.ord !== 1 && c.ord !== 2).sort((a, b) => a.ord - b.ord);
  const groups: { top: string; n: number }[] = [];
  for (const c of cols) { const top = c.group_top ?? ''; const last = groups[groups.length - 1]; if (last && last.top === top) last.n += 1; else groups.push({ top, n: 1 }); }
  const text = (ord: number, r: WideRow): string => {
    const raw = r.values[String(ord)] ?? '';
    if (!raw) return '';
    if (ord === 182 && STATUSES.includes(raw)) return t(`status.${raw}`);
    if (raw.startsWith('[') && raw.endsWith(']')) { try { const a: unknown = JSON.parse(raw); if (Array.isArray(a)) return a.map((x) => fmtDate(String(x), i18n.language)).join(', '); } catch { /* plain text */ } }
    return fmtDate(raw, i18n.language);
  };
  const kind = (target: Site360CellTarget, current: string) => (target.field || /^\d{4}-\d{2}-\d{2}$/.test(current) ? 'date' : 'text');
  const save = (row: WideRow, ord: number, target: Site360CellTarget, current: string) => {
    if (!editing) return;
    const draft = editing.draft;
    setEditing(null);
    if (draft !== current) onEdit({ row, ord, target, value: draft });
  };
  const stick = (left: number, z: number) => ({ position: 'sticky' as const, insetInlineStart: left, zIndex: z });
  const th = 'border-b border-e border-line bg-card2 px-2 text-xs font-semibold whitespace-nowrap';
  return (
    <div className="card overflow-hidden" data-testid="sites-wide">
      <div className="overflow-auto" style={{ maxHeight: height }} data-testid="sites-wide-scroll">
        <table dir="ltr" aria-label={t('sites.wide_label')} className="border-separate border-spacing-0 text-sm" data-menu={menu.key} data-testid="sites-wide-table">
          <thead>
            <tr style={{ height: HEAD }}>
              <th rowSpan={2} scope="col" className={`${th} text-center`} style={{ ...stick(0, 40), top: 0, width: NUM_W, minWidth: NUM_W }} data-testid="wide-col-num">#</th>
              <th rowSpan={2} scope="col" className={`${th} text-start`} style={{ ...stick(NUM_W, 40), top: 0, width: ID_W, minWidth: ID_W }} data-testid="wide-col-site">{menu.columns.find((c) => c.ord === 2)?.header ?? t('sites.code')}</th>
              {groups.map((g, i) => <th key={i} colSpan={g.n} scope="colgroup" className={`${th} text-start text-mute`} style={{ position: 'sticky', top: 0, zIndex: 30, height: HEAD }} data-testid="wide-group">{g.top}</th>)}
            </tr>
            <tr style={{ height: HEAD }}>
              {cols.map((c) => <th key={c.ord} scope="col" title={c.group_mid ?? undefined} className={`${th} text-start`} style={{ position: 'sticky', top: HEAD, zIndex: 30, height: HEAD, minWidth: c.ord === 4 ? 220 : 150 }} data-testid={`wide-col-${c.ord}`}>{c.header}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const cur = sel === r.site_code;
              const bg = cur ? 'bg-accentSoft' : i % 2 ? 'bg-card2' : 'bg-card';
              return (
                <tr key={r.site_id} data-testid={`wide-row-${r.site_code}`} data-selected={cur || undefined} className={`hover:bg-hover ${bg}`} onClick={() => undefined}>
                  <td className={`border-b border-e border-line px-2 text-center text-mute ${bg}`} style={stick(0, 20)}>{r.row_no ?? i + 1}</td>
                  <td className={`border-b border-e border-line px-2 ${bg}`} style={stick(NUM_W, 20)}><span className="flex items-center gap-1"><b className="mono">{r.site_code}</b>
                    <Link to={`/sites/${r.site_id}`} className="rounded p-0.5 text-link hover:bg-hover" aria-label={t('sites.wide_open', { code: r.site_code })} title={t('sites.wide_open', { code: r.site_code })} data-testid={`site-row-${r.site_code}`}><ExternalLink size={14} /></Link></span></td>
                  {cols.map((c) => {
                    const v = text(c.ord, r);
                    const target = r.cells?.[String(c.ord)];
                    const shown = <span className={v ? '' : 'text-mute'}>{v || t('sites.wide_not_entered')}</span>;
                    const isEditing = !!target && editing?.site === r.site_id && editing.ord === c.ord;
                    const reason = target && !target.editable ? t('sites.wide_locked') : !target && c.source_kind === 'derived' ? t('sites.wide_computed') : undefined;
                    return (
                      <td key={c.ord} data-col={c.ord} data-editable={target?.editable ? 'true' : undefined} title={reason} className="border-b border-e border-line px-2 py-1.5 whitespace-nowrap" data-testid={target ? `wide-cell-${r.site_code}-${c.ord}` : undefined}>
                        {isEditing && target ? (
                          <span className="flex items-center gap-1">
                            <input autoFocus type={kind(target, v)} aria-label={c.header} data-testid={`wide-input-${r.site_code}-${c.ord}`} className="input h-7 w-36 px-1 py-0 text-xs" value={editing.draft}
                              onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
                              onKeyDown={(e) => { if (e.key === 'Enter') save(r, c.ord, target, text(c.ord, r)); if (e.key === 'Escape') setEditing(null); }} />
                            <button type="button" className="btn px-2 py-0.5 text-xs" data-testid={`wide-save-${r.site_code}-${c.ord}`} onClick={() => save(r, c.ord, target, text(c.ord, r))}>{t('common.save')}</button>
                            <button type="button" className="btn px-2 py-0.5 text-xs" data-testid={`wide-cancel-${r.site_code}-${c.ord}`} onClick={() => setEditing(null)}>{t('common.cancel')}</button>
                          </span>
                        ) : target?.editable ? (
                          <button type="button" disabled={busy} className="group flex w-full items-center gap-1 text-start hover:text-accentText focus-visible:ring-2 focus-visible:ring-accent" aria-label={`${t('sites.wide_edit')}: ${c.header}`} data-testid={`wide-edit-${r.site_code}-${c.ord}`}
                            onClick={() => setEditing({ site: r.site_id, ord: c.ord, draft: v })}>
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
        {loaded && !rows.length && (filtered ? <NoResults testid="sites-empty" onClear={onClear} /> : <EmptyState testid="sites-empty" title={t('sites.empty')} />)}
      </div>
      {hasMore && <button type="button" className="btn m-2" data-testid="site360-more" disabled={loadingMore} onClick={onMore}>{t('site360.more')}</button>}
    </div>
  );
}
