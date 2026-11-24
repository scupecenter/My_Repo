import * as Popover from '@radix-ui/react-popover';
import { Copy, Search } from 'lucide-react';
import type { ClipboardEvent, ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { ColDef } from '@/lib/tablePrefs';

/**
 * W8 of plan 2026-11-23-next-ui-cleanup: the one table standard of every screen that shows site data. The same toolbar, in the same order, on
 * every such screen: saved views, search, + Filter (with its chips), the count, the view switcher where it applies, columns, density, Display,
 * Export and More. Each piece is a slot so a screen passes its own components (its saved-view screen, its filter fields, its export source);
 * the order and the look come from here. The guard test (tableStandard.test.tsx) fails when a site-data table renders without it.
 */
export type TableNoun = 'sites' | 'records' | 'issues' | 'tasks' | 'items';

export function TableToolbar({ testid, views, search, filter, extra, count, switcher, columns, density, display, exporter, primary, more }: {
  testid: string;
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
    <div role="toolbar" className="mb-3 flex flex-wrap items-center gap-2" data-testid={testid} data-table-standard=""
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
