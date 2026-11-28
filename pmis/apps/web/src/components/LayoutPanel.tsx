import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, LayoutGrid } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useMe } from '@/api/hooks';
import { DENSITIES } from '@/lib/tablePrefs';
import type { TableApi } from './TableKit';
import { canEditDisplayDefaults } from './TableStandard';
import { FormatRulesEditor, type FormatCol } from './FormatRulesEditor';
import { Tip } from './Tip';

export type ViewOption = { id: string; label: string; hint?: string; icon: ReactNode; testid: string };

/**
 * The one Layout panel of every screen that shows views (decision V1 of 2026-11-27): the view switcher, the options of the current view and the
 * Display options (density, text size, alignment, wrap, frozen columns, zebra) live in one place, the same component everywhere. The panel shows
 * the options of the view that is on: the Display section only when the current view is a table (`table`), the per-view options (`options`) only
 * for their view. Everything keeps its old storage: the view follows the screen's own mechanism (server draft or URL), the Display options stay
 * with the column prefs per user and per screen (so saved views keep them) and unset options follow the defaults of Settings > Screens > Tables.
 *
 * New view modes and new per-view options plug in without touching the panel: a screen adds a ViewOption and passes the view's controls as
 * `options` when that view is on.
 *
 * The keyboard model is the one the view menu had: Enter or Space opens, the arrows, Home and End move over the view items, Enter picks, Escape
 * closes and the focus returns to the button. Every view item keeps the test id its layout button had.
 */
export function LayoutPanel({ testid, views, options, table, grouped, formatCols }: {
  testid: string;
  /** the layouts of the screen (list, wide table, grid, board, timeline, map) */
  views?: { value: string; options: ViewOption[]; onChange: (id: string) => void };
  /** the controls of the current view (the board's grouping and swimlanes, …), only while that view is on */
  options?: ReactNode;
  /** the table's prefs api; the Display section shows only when it is passed (the current view is a table) */
  table?: TableApi;
  /** the table has group header rows: the Display section then offers the group summary (count and status bar) */
  grouped?: boolean;
  /** the columns a conditional formatting rule can look at; the Formatting section shows only when it is passed */
  formatCols?: FormatCol[];
}) {
  const { t } = useTranslation();
  const me = useMe(true).data;
  const [open, setOpen] = useState(false);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const items = useMemo(() => views?.options ?? [], [views?.options]);
  const current = items.find((o) => o.id === views?.value) ?? items[0];
  const focusAt = (i: number) => refs.current[(i + items.length) % items.length]?.focus();
  useEffect(() => {
    if (!open || !items.length) return;
    const at = Math.max(0, items.findIndex((o) => o.id === views?.value));
    const h = window.setTimeout(() => refs.current[at]?.focus(), 0);
    return () => window.clearTimeout(h);
  }, [open, items, views?.value]);
  const onKey = (e: KeyboardEvent, i: number) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
    else if (e.key === 'End') { e.preventDefault(); focusAt(items.length - 1); }
  };
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
  const label = current?.label ?? t('layout.title');
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tip text={t('layout.title')}>
        <Popover.Trigger asChild>
          <button type="button" className="btn px-2 py-1 text-xs" data-testid={testid} aria-haspopup="dialog" aria-expanded={open}
            aria-label={current ? `${t('layout.title')}: ${current.label}` : t('layout.title')} >
            <LayoutGrid size={14} aria-hidden /><span className="hidden sm:inline">{label}</span><ChevronDown size={12} aria-hidden />
          </button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} role="dialog" aria-label={t('layout.title')} className="card z-50 w-72 space-y-3 p-3 text-sm shadow-lg" data-testid={`${testid}-panel`}>
          {views && current && (
            <div className="space-y-1" role="radiogroup" aria-label={t('view.title')} data-testid={`${testid}-views`}>
              <div className="text-xs font-semibold text-mute">{t('view.title')}</div>
              {items.map((o, i) => (
                <button key={o.id} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={o.id === current.id} data-testid={o.testid}
                  className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-hover focus-visible:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  onKeyDown={(e) => onKey(e, i)} onClick={() => { setOpen(false); if (o.id !== current.id) views.onChange(o.id); }}>
                  <span className="mt-0.5">{o.icon}</span>
                  <span className="flex-1"><span className="block">{o.label}</span>{o.hint && <span className="block text-xs text-mute">{o.hint}</span>}</span>
                  {o.id === current.id && <Check size={14} aria-hidden className="mt-0.5" />}
                </button>
              ))}
            </div>
          )}
          {options && (
            <div className="space-y-2 border-t border-line pt-2" data-testid={`${testid}-options`}>
              <div className="text-xs font-semibold text-mute">{t('layout.options')}</div>
              {options}
            </div>
          )}
          {table && (
            <div className="space-y-3 border-t border-line pt-2" data-testid={`${testid}-display`}>
              <div className="text-xs font-semibold text-mute">{t('tstd.display')}</div>
              {radio('size', ['sm', 'md', 'lg'] as const, table.display.size, (v) => table.setDisplay({ size: v }), (v) => t(`tstd.size_${v}`))}
              {radio('align', ['start', 'center'] as const, table.display.align, (v) => table.setDisplay({ align: v }), (v) => t(`tstd.align_${v}`))}
              {radio('density', DENSITIES, table.display.density, (v) => table.setDensity(v), (v) => t(`table.${v}`))}
              <label className="flex items-center gap-2"><input type="checkbox" data-testid="display-wrap" checked={table.display.wrap} onChange={(e) => table.setDisplay({ wrap: e.target.checked })} />{t('tstd.display_wrap')}</label>
              <label className="flex items-center gap-2"><input type="checkbox" data-testid="display-pin" checked={!table.prefs.unpinned} onChange={(e) => table.setPinned(e.target.checked)} />{t('tstd.display_pin')}</label>
              <label className="flex items-center gap-2"><input type="checkbox" data-testid="display-zebra" checked={table.display.zebra} onChange={(e) => table.setDisplay({ zebra: e.target.checked })} />{t('tstd.display_zebra')}</label>
              {grouped && <label className="flex items-center gap-2"><input type="checkbox" data-testid="display-groupbar" checked={table.display.groupbar} onChange={(e) => table.setDisplay({ groupbar: e.target.checked })} />{t('tstd.display_groupbar')}</label>}
              <label className="flex items-center gap-2"><input type="checkbox" data-testid="display-colors" checked={table.display.colors} onChange={(e) => table.setDisplay({ colors: e.target.checked })} />{t('tstd.display_colors')}</label>
              <div className="flex items-center gap-2 border-t border-line pt-2">
                <button type="button" className="btn px-2 py-1 text-xs" data-testid="display-reset" onClick={table.resetDisplay}>{t('tstd.display_reset')}</button>
                {canEditDisplayDefaults(me) && <Link to="/admin/settings/screens/tables" className="ms-auto text-xs text-link" data-testid="display-settings-link">{t('tstd.display_settings')}</Link>}
              </div>
            </div>
          )}
          {table && formatCols && formatCols.length > 0 && <FormatRulesEditor testid={`${testid}-format`} rules={table.rules ?? []} cols={formatCols} onChange={table.setRules} />}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
