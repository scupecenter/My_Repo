import * as Popover from '@radix-ui/react-popover';
import { Copy, Download, Search, SlidersHorizontal } from 'lucide-react';
import type { ClipboardEvent, ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useMe } from '@/api/hooks';
import type { Me } from '@/api/types';
import { DENSITIES, type ColDef, type Display } from '@/lib/tablePrefs';
import type { TableApi } from './TableKit';
import { Tip } from './Tip';

/**
 * W8 of plan 2026-11-23-next-ui-cleanup: the one table standard of every screen that shows site data. The same toolbar, in the same order, on
 * every such screen: saved views, search, + Filter (with its chips), the count, the view switcher where it applies, columns, density, Display,
 * Export and More. Each piece is a slot so a screen passes its own components (its saved-view screen, its filter fields, its export source);
 * the order and the look come from here. The guard test (tableStandard.test.tsx) fails when a site-data table renders without it.
 */
export type TableNoun = 'sites' | 'records' | 'issues' | 'tasks' | 'items' | 'documents';

export function TableToolbar({ testid, views, search, filter, extra, count, switcher, columns, density, display, exporter, primary, more, kind = 'grid' }: {
  testid: string;
  /** `grid` = a table with columns (columns and density are part of the standard); `list` = a master-detail card list (Approvals), where they do not apply */
  kind?: 'grid' | 'list';
  views?: ReactNode;
  search?: ReactNode;
  filter?: ReactNode;
  /** screen-specific quick filters that sit with the filters (for example "show N/A sites") */
  extra?: ReactNode;
  count: ReactNode;
  /** the layouts of the screen (Map, Board, Wide table, Timeline), where they apply */
  switcher?: ReactNode;
  columns?: ReactNode;
  density?: ReactNode;
  display?: ReactNode;
  exporter?: ReactNode;
  /** the main action of the screen (New record), placed before the tools */
  primary?: ReactNode;
  more?: ReactNode;
}) {
  return (
    <div role="toolbar" className="mb-3 flex flex-wrap items-center gap-2" data-testid={testid} data-table-standard={kind}
      data-has-search={search ? '' : undefined} data-has-filter={filter ? '' : undefined} data-has-views={views ? '' : undefined}
      data-has-columns={columns ? '' : undefined} data-has-density={density ? '' : undefined} data-has-display={display ? '' : undefined}
      data-has-export={exporter ? '' : undefined}>
      {views}
      {search}
      {filter}
      {extra}
      <span className="ms-auto flex flex-wrap items-center gap-2">
        {count}
        {switcher}
        {primary}
        {columns}
        {density}
        {display}
        {exporter}
        {more}
      </span>
    </div>
  );
}

/**
 * The count of the toolbar (W8 item 6), from the server, never from the loaded rows: "469 sites" when nothing is filtered, "120 of 469 sites"
 * (the filtered number in bold) with a "Clear filters" link when a filter or a search applies, and "· 3 selected" when rows are picked.
 */
export function TableCount({ total, filtered, active, noun, selected = 0, onClear, testid = 'table-count' }: {
  total: number | undefined;
  filtered: number | undefined;
  /** a filter or a search applies */
  active: boolean;
  noun: TableNoun;
  selected?: number;
  onClear?: () => void;
  testid?: string;
}) {
  const { t } = useTranslation();
  const all = total ?? filtered ?? 0;
  const hit = filtered ?? all;
  const nounText = t(`tstd.noun_${noun}`);
  return (
    <span className="flex items-center gap-1 text-sm text-mute" data-testid={testid} data-table-count="" data-total={all} data-filtered={hit} aria-live="polite">
      {active ? (
        <span data-testid={`${testid}-text`}><Trans i18nKey="tstd.count_of" values={{ filtered: hit, total: all, noun: nounText }} components={{ b: <b className="text-ink" data-testid={`${testid}-filtered`} /> }} /></span>
      ) : <span data-testid={`${testid}-text`}>{t('tstd.count_all', { total: all, noun: nounText })}</span>}
      {selected > 0 && <span data-testid={`${testid}-selected`}>· {t('tstd.selected', { count: selected })}</span>}
      {active && onClear && <button type="button" className="text-xs text-link underline-offset-2 hover:underline" data-testid={`${testid}-clear`} onClick={onClear}>{t('tstd.clear')}</button>}
    </span>
  );
}

/** The footer beside "Load more": "Showing 50 of 120"; nothing once every row is loaded. */
export function ShownFooter({ shown, filtered, testid = 'table-shown', children }: { shown: number; filtered: number | undefined; testid?: string; children?: ReactNode }) {
  const { t } = useTranslation();
  const n = filtered ?? shown;
  if (shown >= n && !children) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 p-2 text-sm text-mute" data-testid={`${testid}-bar`}>
      {children}
      {shown < n && <span data-testid={testid}>{t('tstd.showing', { shown, filtered: n })}</span>}
    </div>
  );
}

/** Text pasted from Excel cells keeps its codes apart: new lines and tabs become spaces (a one-line input would otherwise drop them and join the codes). */
export function pasteAsTokens(e: ClipboardEvent<HTMLInputElement>, value: string, onChange: (v: string) => void) {
  const text = e.clipboardData?.getData('text') ?? '';
  if (!/[\r\n\t]/.test(text)) return;
  e.preventDefault();
  const el = e.currentTarget;
  const flat = text.replace(/[\r\n\t]+/g, ' ').trim();
  const start = el.selectionStart ?? value.length, end = el.selectionEnd ?? value.length;
  onChange(`${value.slice(0, start)}${start > 0 && !/\s$/.test(value.slice(0, start)) ? ' ' : ''}${flat}${value.slice(end)}`);
}

/** The search box of a site-data list (W8 item 5): one word searches code and name; several Site IDs pasted from Excel find each of them (on the server). */
export function SearchBox({ value, onChange, testid, placeholder, label }: { value: string; onChange: (v: string) => void; testid: string; placeholder?: string; label?: string }) {
  const { t } = useTranslation();
  const ph = placeholder ?? t('tstd.search_sites');
  return (
    <span className="relative inline-flex max-w-72 flex-1 items-center" title={t('tstd.search_hint')}>
      <Search size={14} className="pointer-events-none absolute start-2 text-mute" aria-hidden />
      <input className="input w-full ps-7" data-testid={testid} data-table-search="" placeholder={ph} aria-label={label ?? ph} value={value}
        onChange={(e) => onChange(e.target.value)} onPaste={(e) => pasteAsTokens(e, value, onChange)} />
    </span>
  );
}

export type PastedSearch = { pasted: number; found: number; not_found: string[] };
/** The chip of a pasted list: "Sites: 3 pasted, 2 found" and the codes not found, which the user can copy. */
export function PastedChip({ search, testid = 'pasted-chip' }: { search: PastedSearch | undefined | null; testid?: string }) {
  const { t } = useTranslation();
  if (!search) return null;
  return (
    <span className="chip gap-1 bg-accentSoft text-accentText" data-testid={testid}>
      <span data-testid={`${testid}-text`}>{t('tstd.pasted', { pasted: search.pasted, found: search.found })}</span>
      {search.not_found.length > 0 && (
        <Popover.Root>
          <Popover.Trigger asChild>
            <button type="button" className="underline underline-offset-2" data-testid={`${testid}-missing`}>{t('tstd.not_found', { count: search.not_found.length })}</button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content align="start" sideOffset={6} className="card z-50 max-h-72 w-64 overflow-auto p-3 text-sm shadow-lg" data-testid={`${testid}-panel`}>
              <div className="mb-2 flex items-center gap-2"><b className="flex-1">{t('tstd.not_found_title')}</b>
                <button type="button" className="btn px-1.5 py-0.5" aria-label={t('table.copy_codes')} data-testid={`${testid}-copy`} onClick={() => void navigator.clipboard?.writeText(search.not_found.join('\n'))}><Copy size={12} /></button></div>
              <ul className="mono space-y-0.5" data-testid={`${testid}-list`}>{search.not_found.map((c) => <li key={c}>{c}</li>)}</ul>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )}
    </span>
  );
}

/** The `#` column (W8 item 1): first of the frozen columns, 1..n in the current sort and filter, continuing across "Load more" pages. */
export const ROWNO_ID = 'rowno';
export const ROWNO_COL: ColDef = { id: ROWNO_ID, w: 52, min: 40, max: 80, pinned: true };
export function RowNo({ n }: { n: number }) {
  return <span className="mono block text-end text-mute tabular-nums" data-testid="row-no" data-row-no={n}>{n}</span>;
}

/** A Master column header without the "Group / " (or "Section / ") prefix that some sources repeat: the group sits in its own header row (W8 item 2). */
export function bareHeader(c: { header: string; group_top?: string | null; group_mid?: string | null }): string {
  let h = c.header.trim();
  for (const g of [c.group_mid, c.group_top]) {
    if (!g) continue;
    const p = `${g.trim()} /`;
    if (h.toLowerCase().startsWith(p.toLowerCase())) h = h.slice(p.length).trim();
  }
  return h || c.header;
}

export type HeaderRun = { key: string; label: string; span: number; ids: string[]; pinned: boolean };
/**
 * Adjacent columns with the same value merge into one header cell (W8 item 2). Frozen columns never merge with the columns after them, so the
 * merged cell can stay frozen with them. `level` reads the section (row 1) or the group (row 2) of a column id; null = no value.
 * With `parent`, a run also breaks where the parent changes, so a group never crosses two sections.
 */
export function headerRuns(cols: { id: string; pinned?: boolean }[], level: (id: string) => string | null, parent?: (id: string) => string | null): HeaderRun[] {
  const runs: HeaderRun[] = [];
  for (const c of cols) {
    const label = level(c.id) ?? '';
    const pinned = !!c.pinned;
    const last = runs[runs.length - 1];
    const sameParent = !parent || !last || (parent(last.ids[0]!) ?? '') === (parent(c.id) ?? '');
    if (last && last.label === label && last.pinned === pinned && sameParent) { last.span += 1; last.ids.push(c.id); }
    else runs.push({ key: `${runs.length}-${c.id}`, label, span: 1, ids: [c.id], pinned });
  }
  return runs;
}

/**
 * The section and group rows above the column headers of a grouped list (W8 item 2): row 1 the section, row 2 the group, then the header row of
 * the list shows the column name only. Adjacent equal headers merge; a column without a group leaves its group cell empty and open towards its
 * column header, so the name reads as spanning both rows. The tracks are the list's own, so the cells line up with the columns.
 */
export function GroupBands({ cols, sel, section, group, selW, testid = 'list-bands' }: {
  cols: { id: string; px: number; pinned?: boolean }[];
  sel: boolean;
  selW: number;
  section: (id: string) => string | null;
  group: (id: string) => string | null;
  testid?: string;
}) {
  const tracksCss = `${sel ? `${selW}px ` : ''}${cols.map((c) => `${c.px}px`).join(' ')}`;
  const minWidth = cols.reduce((n, c) => n + c.px, sel ? selW : 0);
  // a frozen run sticks where its first column sticks: after the select box and the frozen columns before it
  const at = (id: string) => { let x = sel ? selW : 0; for (const c of cols) { if (c.id === id) break; if (c.pinned) x += c.px; } return x; };
  const row = (runs: HeaderRun[], kind: 'section' | 'group') => (
    <div role="row" className={`gx-head grid items-stretch text-xs font-semibold ${kind === 'section' ? 'text-mute' : ''}`} style={{ gridTemplateColumns: tracksCss, minWidth, height: 26 }} data-testid={`${testid}-${kind}`}>
      {sel && <div className="sticky start-0 z-10 bg-inherit" aria-hidden />}
      {runs.map((r) => (
        <div key={r.key} role="columnheader" aria-colspan={r.span} data-testid={`${testid}-${kind}-cell`} data-span={r.span}
          className={`truncate border-e border-line px-2 leading-[26px] ${r.label || kind === 'section' ? 'border-b' : ''} ${r.pinned ? 'sticky z-10 bg-inherit' : ''}`}
          style={{ gridColumn: `span ${r.span}`, ...(r.pinned ? { insetInlineStart: at(r.ids[0]!) } : {}) }} title={r.label || undefined}>
          {r.label}
        </div>
      ))}
    </div>
  );
  return (
    <>
      {row(headerRuns(cols, section), 'section')}
      {row(headerRuns(cols, group, section), 'group')}
    </>
  );
}

/** A System Admin, or a delegate of admin.settings edit: who sees the link to Settings > Display (the server checks the right again on save). */
export const canEditDisplayDefaults = (me: Me | undefined) => !!me && (!!me.is_system_admin || me.effective.grants.some((g) => g.module_key === 'admin.settings' && (g.action as string) === 'edit'));

/** The data attributes that draw the Display options on a table container (styles in index.css, `[data-tsize]` and the others). */
export function displayAttrs(d: Display): Record<string, string> {
  return { 'data-tsize': d.size, 'data-talign': d.align, 'data-twrap': d.wrap ? '1' : '0', 'data-tzebra': d.zebra ? '1' : '0', 'data-density': d.density };
}

/** Extra pixels of a virtualised row when long text wraps on two lines. */
export const WRAP_EXTRA = 18;

/**
 * The Display menu of the toolbar (W8 item 4): text size, alignment of text cells, row density, wrap long text, zebra rows. Stored per user and per
 * screen with the column prefs (so saved views keep it); unset options follow the defaults of Administration > Settings > Display, which the menu
 * links to for the users who may change them.
 */
export function DisplayMenu({ api }: { api: TableApi }) {
  const { t } = useTranslation();
  const me = useMe(true).data;
  const d = api.display;
  const radio = <T extends string>(name: string, values: readonly T[], cur: T, set: (v: T) => void, label: (v: T) => string) => (
    <div className="space-y-1" role="radiogroup" aria-label={t(`tstd.display_${name}`)}>
      <div className="text-xs font-semibold text-mute">{t(`tstd.display_${name}`)}</div>
      <div className="flex flex-wrap gap-1">
        {values.map((v) => (
          <button key={v} type="button" role="radio" aria-checked={cur === v} data-testid={`display-${name}-${v}`} onClick={() => set(v)}
            className={`btn px-2 py-1 text-xs ${cur === v ? 'bg-accentSoft text-accentText' : ''}`}>{label(v)}</button>
        ))}
      </div>
    </div>
  );
  return (
    <Popover.Root>
      <Tip text={t('tstd.display')}>
        <Popover.Trigger asChild>
          <button type="button" className="btn" data-testid="display-menu" aria-label={t('tstd.display')}><SlidersHorizontal size={16} /></button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="card z-50 w-72 space-y-3 p-3 text-sm shadow-lg" data-testid="display-panel">
          {radio('size', ['sm', 'md', 'lg'] as const, d.size, (v) => api.setDisplay({ size: v }), (v) => t(`tstd.size_${v}`))}
          {radio('align', ['start', 'center'] as const, d.align, (v) => api.setDisplay({ align: v }), (v) => t(`tstd.align_${v}`))}
          {radio('density', DENSITIES, d.density, (v) => api.setDensity(v), (v) => t(`table.${v}`))}
          <label className="flex items-center gap-2"><input type="checkbox" data-testid="display-wrap" checked={d.wrap} onChange={(e) => api.setDisplay({ wrap: e.target.checked })} />{t('tstd.display_wrap')}</label>
          <label className="flex items-center gap-2"><input type="checkbox" data-testid="display-pin" checked={!api.prefs.unpinned} onChange={(e) => api.setPinned(e.target.checked)} />{t('tstd.display_pin')}</label>
          <label className="flex items-center gap-2"><input type="checkbox" data-testid="display-zebra" checked={d.zebra} onChange={(e) => api.setDisplay({ zebra: e.target.checked })} />{t('tstd.display_zebra')}</label>
          <div className="flex items-center gap-2 border-t border-line pt-2">
            <button type="button" className="btn px-2 py-1 text-xs" data-testid="display-reset" onClick={api.resetDisplay}>{t('tstd.display_reset')}</button>
            {canEditDisplayDefaults(me) && <Link to="/admin/settings/screens/tables" className="ms-auto text-xs text-link" data-testid="display-settings-link">{t('tstd.display_settings')}</Link>}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** One cell of a CSV line: quoted when it holds a separator, a quote or a new line; a leading formula sign is neutralised (CSV injection). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsv = (head: string[], rows: unknown[][]) => [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');

/**
 * Export current view of a list that the server export service does not cover (My Work, Approvals): the rows of the view as they stand (the
 * server's filtered set, every page loaded), as a UTF-8 CSV with a BOM so Excel reads Arabic. The download stays in the browser.
 */
export function ExportCsvButton({ testid, name, head, rows }: { testid: string; name: string; head: string[]; rows: () => unknown[][] }) {
  const { t } = useTranslation();
  const go = () => {
    const blob = new Blob(['﻿', toCsv(head, rows())], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <Tip text={t('tstd.export_view')}>
      <button type="button" className="btn" data-testid={testid} aria-label={t('tstd.export_view')} onClick={go}><Download size={16} /></button>
    </Tip>
  );
}
