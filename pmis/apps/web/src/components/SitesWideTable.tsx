import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { Site360MenuItem } from '@/api/site360';
import type { Site360CellTarget } from '@/components/Site360Grid';
import { bareHeader } from '@/components/TableStandard';
import { WideTable, type WideCell, type WideColumn, type WideInput } from '@/components/WideTable';
import type { Display } from '@/lib/tablePrefs';
import { optionsOf } from '@/lib/siteBulkEdit';
import { fmtDate } from '@/lib/time';

export type { WideInput } from '@/components/WideTable';
export interface WideRow { site_id: string; site_code: string; row_no?: number | null; values: Record<string, string | null>; cells?: Record<string, Site360CellTarget> }

/**
 * One typed edit of one cell of one site: the same target and value the grid sends to the same save path (PATCH /tasks/{task_id}, If-Match the version).
 * The value has the type of the editor: a date or text as a string, a number as a number, a yes or no as a boolean; an empty string clears the value.
 */
export interface WideEdit { row: WideRow; ord: number; target: Site360CellTarget; value: string | number | boolean }

/** The editor of a cell: the API's `input_type`; an older answer without it falls back to a date for a date key or a date-shaped value, else text. */
export function inputOf(target: Site360CellTarget, raw: string): WideInput {
  if (target.input_type) return target.input_type;
  return target.field || /^\d{4}-\d{2}-\d{2}$/.test(raw) ? 'date' : 'text';
}

const STATUSES = ['not_started', 'in_progress', 'on_hold', 'completed', 'cancelled'];
type Row = WideRow & { id: string; code: string; rowNo?: number | null };

/**
 * The wide table of Site Master and its sub-menus (owner request 2026-11-22): the shared WideTable (components/WideTable.tsx) with the Master
 * columns of the menu in Master order (# and Site ID frozen, the open icon of the Site ID cell opens the site page) and this adapter for its cells.
 * Editing (owner decision 2026-11-22): a task-backed cell the API marks editable opens a typed inline editor; one edit changes only that site's cell,
 * through the same save path as the grid (the same rights, locks, gate rules and errors). Other cells stay plain, with the reason in a tooltip.
 */
export function SitesWideTable({ display, menu, rows, hasMore, loadingMore, onMore, loaded, filtered, onClear, sel, onEdit, busy, height, picked, onPick, onPickAll }: {
  /** W8 item 4: the Display options of the screen (text size, alignment, density, wrap, zebra) */
  display?: Display;
  menu: Site360MenuItem; rows: WideRow[]; hasMore: boolean; loadingMore: boolean; onMore: () => void; loaded: boolean; filtered: boolean; onClear: () => void;
  sel: string; onEdit: (e: WideEdit) => Promise<unknown>; busy?: boolean; height: number;
  /** the selected sites (Site IDs) for the bulk bar: a checkbox in the frozen # cell of each row and a select-all in its header */
  picked: Set<string>; onPick: (code: string) => void; onPickAll: () => void;
}) {
  const { t, i18n } = useTranslation();
  // # (ord 1) and Site ID (ord 2) are the two frozen columns; every other column of the menu follows in Master order
  const cols: WideColumn[] = [...menu.columns].filter((c) => c.ord !== 1 && c.ord !== 2).sort((a, b) => a.ord - b.ord)
    .map((c) => ({ key: String(c.ord), header: bareHeader(c), top: c.group_top, mid: c.group_mid, title: [c.group_top, c.group_mid].filter(Boolean).join(' / ') || undefined, minWidth: c.ord === 4 ? 220 : 150 }));
  const derived = new Set(menu.columns.filter((c) => c.source_kind === 'derived').map((c) => String(c.ord)));
  const text = (ord: number, r: WideRow): string => {
    const raw = r.values[String(ord)] ?? '';
    if (!raw) return '';
    if (ord === 182 && STATUSES.includes(raw)) return t(`status.${raw}`);
    if (raw.startsWith('[') && raw.endsWith(']')) { try { const a: unknown = JSON.parse(raw); if (Array.isArray(a)) return a.map((x) => fmtDate(String(x), i18n.language)).join(', '); } catch { /* plain text */ } }
    return fmtDate(raw, i18n.language);
  };
  const label = (o: { value: string; label_en: string; label_ar: string | null }) => (i18n.language === 'ar' && o.label_ar) || o.label_en;
  const cell = (r: Row, c: WideColumn): WideCell => {
    const ord = Number(c.key);
    const target = r.cells?.[c.key];
    const x = r.values[c.key] ?? '';
    let shown = text(ord, r);
    if (target && x) {
      const kind = inputOf(target, x);
      if (kind === 'list') { const o = target.options?.find((e) => e.value === x); if (o) shown = label(o); }
      if (kind === 'boolean') shown = /^(true|yes|1)$/i.test(x) ? t('common.yes') : t('common.no');
    }
    const reason = target && !target.editable ? t('sites.wide_locked') : !target && derived.has(c.key) ? t('sites.wide_computed') : undefined;
    if (!target?.editable) return { text: shown, reason, target: !!target };
    // the draft starts from the stored value, not the displayed text: a date is YYYY-MM-DD, a list is its code, a yes or no is true or false
    const kind = inputOf(target, x);
    const opts = optionsOf(target, r.values);
    const noParent = kind === 'list' && target.parent_ord !== undefined && !opts.length;
    return {
      text: shown, target: true,
      edit: { input: kind, initial: kind === 'boolean' ? (/^(true|yes|1)$/i.test(x) ? 'true' : 'false') : x, options: opts.map((o) => ({ value: o.value, label: label(o) })), hint: noParent ? t('sites.wide_pick_parent') : undefined },
    };
  };
  const wide: Row[] = rows.map((r) => ({ ...r, id: r.site_id, code: r.site_code, rowNo: r.row_no }));
  const idCol = menu.columns.find((x) => x.ord === 2);
  return (
    <WideTable<Row> testid="sites-wide" tableTestid="sites-wide-table" scrollTestid="sites-wide-scroll" label={t('sites.wide_label')} dataMenu={menu.key} depth={3}
      idHeader={idCol ? bareHeader(idCol) : t('sites.code')}
      idCell={(r) => <Link to={`/sites/${r.site_id}`} className="rounded p-0.5 text-link hover:bg-hover" aria-label={t('sites.wide_open', { code: r.site_code })} title={t('sites.wide_open', { code: r.site_code })} data-testid={`site-row-${r.site_code}`}><ExternalLink size={14} /></Link>}
      columns={cols} rows={wide} cell={cell} display={display} busy={busy} height={height} sel={sel}
      onSave={(r, c, value) => onEdit({ row: r, ord: Number(c.key), target: r.cells![c.key]!, value })}
      picked={picked} onPick={onPick} onPickAll={onPickAll} hasMore={hasMore} loadingMore={loadingMore} onMore={onMore} moreTestid="site360-more"
      loaded={loaded} filtered={filtered} onClear={onClear} emptyTestid="sites-empty" emptyTitle={t('sites.empty')} />
  );
}
