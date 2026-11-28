import { Lock, PanelRightOpen, CalendarRange } from 'lucide-react';
import { useMemo, useState, type DragEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import type { RegisterDefinition, RegisterField, RegisterRecord } from '@/api/types';
import { BoardGrid, type BoardColumn } from '@/components/Board';
import { CalendarGrid } from '@/components/CalendarGrid';
import { INLINE_TYPES } from '@/components/GridCellEditor';
import { Holders } from '@/components/HolderChip';
import { fieldLabel, showValue } from '@/components/RegisterFields';
import { STATE_TONE } from '@/components/RegisterDrawer';
import { SiteMap } from '@/components/SiteMap';
import { ChartView, type ChartKind } from '@/components/ChartView';
import { buildTimeline, posPct } from '@/lib/timeline';
import { fmtDate } from '@/lib/time';
import { StatusChip } from '@/components/TableKit';
import { EmptyState } from '@/components/States';
import { WideTable, type WideCell, type WideColumn, type WideInput, type WideTableRow } from '@/components/WideTable';
import { isHidden, sectionIdOf, typeHides } from '@/lib/registerForms';
import { measureBreakdown } from '@/lib/viewAnalytics';
import type { Display } from '@/lib/tablePrefs';

/**
 * W2 of plan 2026-11-23-next-ui-cleanup: the view options of Site Master on every register and log. The list stays the default; the wide table,
 * the board and the map are the same shared components as Site Master (WideTable, BoardGrid, SiteMap), fed by the register's own list
 * (GET /registers/{key}/records with the same filters, so every layout shows the same records, with the caller's rights and field rules).
 */
export type RegisterLayout = 'list' | 'wide' | 'board' | 'feed' | 'map' | 'calendar' | 'timeline' | 'chart';
export const REGISTER_LAYOUTS: readonly RegisterLayout[] = ['list', 'wide', 'board', 'feed', 'map', 'calendar', 'timeline', 'chart'];

/** The board's grouping on the approval state of the records (entry, in review, in approval, approved, voided), which every register has. */
export const BY_STATE = 'state';
export const RECORD_STATES = ['entry', 'in_review', 'in_approval', 'approved', 'voided'] as const;
/** At most this many records are loaded for the board and the map (the list pages on); above it the screen says so. */
export const ALL_CAP = 2000;
/** Cards drawn per board cell before "N more". */
const CELL_CARDS = 25;

/**
 * The status fields of a register (owner decision W2: the board's columns use the register's status field): its own single-value fields named
 * `status`, `..._status` or `stage` (Procurement Order Status, Permit Status, Issue Status, HLC Fiber Status, Quality Stage and so on), in the order
 * of the register's fields. The catalogue lists only the fields the caller may see, so a hidden field is never a board column.
 */
export function statusFields(def: RegisterDefinition): RegisterField[] {
  return def.fields.filter((f) => (f.type === 'list' || f.type === 'text') && (f.code === 'status' || f.code === 'stage' || f.code.endsWith('_status')));
}

/** The default grouping of the board: the register's first status field shown in the list, else its first status field, else the approval state. */
export function defaultBoardBy(def: RegisterDefinition): string {
  const s = statusFields(def);
  return (s.find((f) => f.in_list) ?? s[0])?.code ?? BY_STATE;
}

/** The chart's axes (decision V4): the approval state, plus every list or yes/no field the caller may see; the measure is a count or the sum of a number field. */
export const axisFields = (def: RegisterDefinition): RegisterField[] => def.fields.filter((f) => f.type === 'list' || f.type === 'yes_no');
export const numericFields = (def: RegisterDefinition): RegisterField[] => def.fields.filter((f) => f.type === 'number');

/** The date fields a register has: a date-typed field of the definition. */
export const dateFields = (def: RegisterDefinition): RegisterField[] => def.fields.filter((f) => f.type === 'date');

/** The layouts a register offers: list, wide table, board and chart on every register; the map only where the records carry a site (and its coordinates);
    the calendar (decision V2) and the timeline (decision V3) where the definition has at least one date field. */
export const layoutsOf = (def: RegisterDefinition): RegisterLayout[] => [
  'list', 'wide', 'board', 'feed',
  ...(def.site_scoped ? (['map'] as const) : []),
  ...(dateFields(def).length ? (['calendar', 'timeline'] as const) : []),
  'chart',
];

/** A key that is safe in a test id and an id attribute, unique among the keys already given. */
function keyOf(v: string, used: Set<string>): string {
  const base = v ? v.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'v' : '_none';
  let k = base, n = 2;
  while (used.has(k)) k = `${base}_${n++}`;
  used.add(k);
  return k;
}

/** What one record shows of one field: the field's own display, or nothing when it is empty. */
function valueText(f: RegisterField, v: unknown, lang: string, t: ReturnType<typeof useTranslation>['t']): string {
  if (v === undefined || v === null || v === '') return '';
  return showValue(f, v, lang, t);
}

/** The editor of a field in the wide table, by the types the register grid already edits inline (F16); null = edited in the record only. */
function inputOf(f: RegisterField): WideInput | null {
  if (!INLINE_TYPES.includes(f.type)) return null;
  if (f.type === 'list') return f.options?.length && !f.list?.allow_other ? 'list' : 'text';
  return f.type as WideInput;
}

type WRow = WideTableRow & { rec: RegisterRecord };

/**
 * The wide table of a register: one row per record, every field of the register the caller may see left to right in the register's order,
 * grouped under its form section (header row 1), with # and Site ID frozen. Inline edit only where the register already allows it (the same
 * rule as its grid: an inline field type, not read-only for the caller, the column and the record not locked unless a System Admin, and `edit` in
 * the record's own actions), saved through the register's own save path (`onSave`: PATCH with If-Match the record version).
 */
export function RegisterWide({ pending, def, records, admin, regionName, onOpen, onSave, errorText, display, height, current, picked, onPick, onPickAll, hasMore, loadingMore, onMore, loaded, filtered, onClear }: {
  /** Batch edit: the value waiting in the draft for a record and a field, shown in the cell with a Pending chip. */
  pending?: Record<string, Record<string, { to: unknown }>>;
  def: RegisterDefinition; records: RegisterRecord[]; admin: boolean; regionName: (id: number | null | undefined) => string;
  onOpen: (id: string) => void; onSave: (r: RegisterRecord, code: string, value: unknown) => Promise<unknown>; errorText: (e: unknown) => string;
  display: Display; height: number; current: string | null;
  picked: Set<string>; onPick: (id: string) => void; onPickAll: () => void;
  hasMore: boolean; loadingMore: boolean; onMore: () => void; loaded: boolean; filtered: boolean; onClear: () => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const key = def.register_key;
  const record = t('regviews.group_record'), flow = t('regviews.group_workflow');
  const section = (f: RegisterField) => t(`regSections.${sectionIdOf(f.section)}`, { defaultValue: (lang === 'ar' && f.section_ar) || f.section || t('regSections.details') });
  const fields = def.fields;
  const cols: WideColumn[] = [
    { key: 'region', header: t('sites.region'), top: record, minWidth: 120 },
    ...(def.record_types?.length ? [{ key: 'type', header: t('registers.record_type'), top: record, minWidth: 90 }] : []),
    ...fields.map((f) => ({ key: `f:${f.code}`, header: fieldLabel(f, lang), top: section(f), minWidth: 150 })),
    { key: 'state', header: t('registers.state'), top: flow, minWidth: 130 },
    { key: 'ball', header: t('grid.ball'), top: flow, minWidth: 180 },
  ];
  const byCode = new Map(fields.map((f) => [`f:${f.code}`, f]));
  const cell = (row: WRow, c: WideColumn): WideCell => {
    const r = row.rec;
    if (c.key === 'region') return { text: r.region_id ? regionName(r.region_id as number) : '' };
    if (c.key === 'type') return { text: r.record_type ? r.record_type.toUpperCase() : '' };
    if (c.key === 'state') { const s = t(`regState.${r.state}`); return { text: s, node: <StatusChip tone={STATE_TONE[r.state]} text={s}>{s}</StatusChip>, reason: t('regviews.why_flow') }; }
    if (c.key === 'ball') {
      const at = r.ball_in_court && (r.state === 'in_review' || r.state === 'in_approval') ? r.ball_in_court.holders : [];
      return { text: at.map((h) => h.label).join(', '), node: <Holders holders={at} />, reason: t('regviews.why_flow') };
    }
    const f = byCode.get(c.key);
    if (!f) return { text: '' };
    const wait = pending?.[r.id]?.[f.code];
    const v = wait ? wait.to : r.data[f.code];
    const text = valueText(f, v, lang, t);
    if (isHidden(key, f.code, r.data, def) || typeHides(key, r.record_type ?? '', f)) return { text, reason: t('regviews.why_not_applies') };
    const input = inputOf(f);
    const reason = f.read_only ? t('regviews.why_read_only')
      : !admin && f.locked ? t('regviews.why_column_locked')
      : !admin && r.locked ? t('regviews.why_record_locked')
      : !r.allowed_actions?.includes('edit') ? t('regviews.why_state', { state: t(`regState.${r.state}`) })
      : !input ? t('regviews.why_in_record') : undefined;
    if (reason || !input) return { text, reason, target: true };
    const initial = v === undefined || v === null ? '' : String(v);
    return { text, ...(wait ? { node: <span data-testid={`wide-pending-${r.id}-${f.code}`}>{text}<span className="chip ms-1 bg-waitBg text-waitInk">{t('batchedit.pending_chip')}</span></span> } : {}), target: true, edit: { input, initial, options: (f.options ?? []).map((o) => ({ value: o.value, label: (lang === 'ar' && o.label_ar) || o.label_en })) } };
  };
  const rows: WRow[] = records.map((r, i) => ({ id: r.id, key: r.id, code: r.site_code ?? '-', rowNo: i + 1, rec: r }));
  return (
    <WideTable<WRow> testid="register-wide" tableTestid="register-wide-table" scrollTestid="register-wide-scroll" label={t('regviews.wide_label', { name: (lang === 'ar' && def.name_ar) || def.name_en })}
      dataMenu={key} depth={2} idHeader={def.site_scoped ? t('sites.code') : t('regviews.record')} columns={cols} rows={rows} cell={cell} display={display} height={height}
      sel={current ?? undefined} errorText={errorText}
      idCell={(row) => (
        <>
          {row.rec.locked && <Lock size={12} className="text-mute" aria-label={t('registers.locked_badge')} data-testid={`reg-wide-locked-${row.id}`} />}
          <button type="button" className="rounded p-0.5 text-link hover:bg-hover" aria-label={t('regviews.open', { code: row.code })} title={t('regviews.open', { code: row.code })} data-testid={`reg-wide-open-${row.id}`} onClick={() => onOpen(row.id)}><PanelRightOpen size={14} /></button>
        </>
      )}
      onSave={(row, c, value) => {
        const f = byCode.get(c.key)!;
        // an empty editor clears the field (null), as the record form does; the server checks every rule again
        return onSave(row.rec, f.code, value === '' ? null : value);
      }}
      picked={picked} onPick={onPick} onPickAll={onPickAll} hasMore={hasMore} loadingMore={loadingMore} onMore={onMore} moreTestid="register-wide-more"
      loaded={loaded} filtered={filtered} onClear={onClear} emptyTestid="register-empty" emptyTitle={t('registers.empty')} />
  );
}

export type RegisterLane = 'none' | 'region' | 'type';

/**
 * The board of a register (owner decision W2: its columns are the register's status field): one column per value of the chosen status field in
 * the order of its list (values outside the list and "Not set" after them), or one per approval state. Swimlanes by region or by record type.
 * Read only, as the Site Master board: a card opens the record, and a record moves only through its own form and actions.
 */
export function RegisterBoard({ def, records, by, lane, regionName, onOpen, partial, admin, onMove, onRefused, onPreview }: {
  def: RegisterDefinition; records: RegisterRecord[]; by: string; lane: RegisterLane;
  regionName: (id: number | null | undefined) => string; onOpen: (id: string) => void;
  /** the board holds only the first records of a larger filtered set */
  partial: { shown: number; total: number } | null;
  /** a System Admin may edit a locked field or row (the database exempts admins too) */
  admin?: boolean;
  /** drag a card to another column: the page saves the status field through the normal edit path (If-Match). Without it the board stays read only. */
  onMove?: (r: RegisterRecord, code: string, value: string | null) => void;
  onRefused?: (reason: string) => void;
  /** Space on a focused card */
  onPreview?: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  const choices = statusFields(def);
  const field = by === BY_STATE ? undefined : choices.find((f) => f.code === by);
  const groupBy = field ? field.code : BY_STATE;
  const raw = (r: RegisterRecord): string => (field ? (r.data[field.code] === undefined || r.data[field.code] === null ? '' : String(r.data[field.code])) : r.state);
  // the columns: the values of the list in its order, then values found outside the list, then "Not set"
  const used = new Set<string>();
  const values: { v: string; name: string }[] = field
    ? [
      ...(field.options ?? []).map((o) => ({ v: o.value, name: (lang === 'ar' && o.label_ar) || o.label_en })),
      ...[...new Set(records.map(raw).filter((v) => v && !(field.options ?? []).some((o) => o.value === v)))].sort().map((v) => ({ v, name: v })),
      ...(records.some((r) => !raw(r)) ? [{ v: '', name: t('regviews.not_set') }] : []),
    ]
    : RECORD_STATES.map((s) => ({ v: s, name: t(`regState.${s}`) }));
  const keys = new Map(values.map((x) => [x.v, keyOf(x.v, used)]));
  const laneOf = (r: RegisterRecord): string => (lane === 'region' ? String(r.region_id ?? '') : lane === 'type' ? r.record_type ?? '' : 'all');
  const laneKeys = new Set<string>();
  const laneIds = lane === 'none' ? ['all'] : [...new Set(records.map(laneOf))].sort((a, b) => (lane === 'region' ? regionName(Number(a)).localeCompare(regionName(Number(b))) : a.localeCompare(b)));
  const laneKey = new Map(laneIds.map((l) => [l, keyOf(l || 'none', laneKeys)]));
  const laneName = (l: string) => (lane === 'region' ? (l ? regionName(Number(l)) : t('regviews.no_region')) : lane === 'type' ? (l ? t(`regTypes.${def.register_key}.${l}`, { defaultValue: l.toUpperCase() }) : t('regviews.not_set')) : t('regviews.all_records'));
  const cells = new Map<string, RegisterRecord[]>();
  for (const r of records) { const k = `${keys.get(raw(r)) ?? ''}|${laneKey.get(laneOf(r))}`; const a = cells.get(k); if (a) a.push(r); else cells.set(k, [r]); }
  const columns: BoardColumn[] = values.map((x) => ({ key: keys.get(x.v)!, name: x.name, count: records.filter((r) => raw(r) === x.v).length }));
  const valueOfKey = (k: string): string | undefined => values.find((x) => keys.get(x.v) === k)?.v;
  /** why a card may not go to this column (null = it may); the server still has the last word */
  const refusal = (r: RegisterRecord, k: string): string | null => {
    if (!field) return t('regviews.drag_state');
    const to = valueOfKey(k);
    if (to === undefined) return t('regviews.drag_state');
    if (raw(r) === to) return t('regviews.drag_same');
    if (r.locked && !admin) return t('regviews.drag_locked');
    if (field.read_only || (field.locked && !admin)) return t('regviews.drag_field_locked');
    if (!r.allowed_actions?.includes('edit')) return t('regviews.drag_no_edit');
    if (to === '' && field.required) return t('regviews.drag_required');
    return null;
  };
  const dragging = dragId ? records.find((x) => x.id === dragId) : undefined;
  const title = (r: RegisterRecord) => {
    const f = def.fields.find((y) => y.in_list && y.code !== groupBy && r.data[y.code] !== undefined && r.data[y.code] !== null && r.data[y.code] !== '');
    return f ? valueText(f, r.data[f.code], lang, t) : '';
  };
  return (
    <section className="space-y-2" data-testid="register-board" data-by={groupBy} aria-label={t('regviews.board_label', { name: (lang === 'ar' && def.name_ar) || def.name_en })}>
      <div className="flex flex-wrap items-center gap-2">
        {partial && <span className="chip bg-waitBg text-waitInk" role="note" data-testid="register-board-partial">{t('regviews.partial', { shown: partial.shown, total: partial.total })}</span>}
        <span className="ms-auto text-xs text-mute" data-testid="register-board-note">{onMove && field ? t('regviews.board_drag_note') : t('regviews.board_read_only')}</span>
      </div>
      <BoardGrid<RegisterRecord> testid="register-board-scroll" emptyTestid="register-board-empty" empty={t('registers.empty')} total={records.length} showLanes={lane !== 'none'}
        columns={columns} lanes={laneIds.map((l) => ({ key: laneKey.get(l)!, name: laneName(l), count: records.filter((r) => laneOf(r) === l).length }))}
        label={(c, l) => `${c.name} · ${l.name}`}
        {...(onMove ? {
          dropHint: (col: string) => { if (!dragging) return null; const why = refusal(dragging, col); return why ? { ok: false, reason: why } : { ok: true }; },
          onDropTo: (col: string, _ln: string, e: DragEvent) => {
            const r = records.find((x) => x.id === (e.dataTransfer.getData('text/plain') || dragId));
            setDragId(null);
            if (!r) return;
            const why = refusal(r, col);
            if (why) { if (raw(r) !== valueOfKey(col)) onRefused?.(why); return; }
            const to = valueOfKey(col);
            if (field && to !== undefined) onMove(r, field.code, to === '' ? null : to);
          },
        } : {})}
        cell={(col, ln) => {
          const all = cells.get(`${col}|${ln}`) ?? [];
          const k = `${col}|${ln}`;
          const shown = open.has(k) ? all : all.slice(0, CELL_CARDS);
          return { cards: shown, more: all.length > shown.length ? <button type="button" className="mt-1 block text-xs text-accentText underline" data-testid={`board-more-${col}-${ln}`} onClick={() => setOpen((p) => new Set(p).add(k))}>{t('board.more', { count: all.length - shown.length })}</button> : undefined };
        }}
        cardKey={(r) => r.id}
        card={(r) => {
          const tt = title(r);
          return (
            <button type="button" onClick={() => onOpen(r.id)} data-testid={`board-record-${r.id}`} data-state={r.state}
              {...(onMove && field ? { draggable: true, onDragStart: (e: DragEvent) => { e.dataTransfer.setData('text/plain', r.id); e.dataTransfer.effectAllowed = 'move'; setDragId(r.id); }, onDragEnd: () => setDragId(null) } : {})}
              {...(onPreview ? { onKeyDown: (e: KeyboardEvent) => { if (e.key === ' ') { e.preventDefault(); onPreview(r.id); } }, onKeyUp: (e: KeyboardEvent) => { if (e.key === ' ') e.preventDefault(); } } : {})}
              className="block w-full rounded-md border border-line bg-card p-2 text-start text-sm hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              aria-label={t('regviews.card', { code: r.site_code ?? '', title: tt })}>
              <div className="flex items-baseline gap-2">{r.site_code && <b className="mono" dir="ltr">{r.site_code}</b>}<span className="truncate">{tt}</span></div>
              <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-mute">
                {r.region_id ? <span>{regionName(r.region_id as number)}</span> : null}
                {r.record_type && <span className="chip border border-line">{r.record_type.toUpperCase()}</span>}
                {r.locked && <span className="chip bg-hover" data-testid={`board-record-locked-${r.id}`}>{t('registers.locked_badge')}</span>}
              </div>
              {groupBy !== BY_STATE && <div className="mt-1 text-xs"><span className={`chip ${STATE_TONE[r.state] ?? ''}`}>{t(`regState.${r.state}`)}</span></div>}
            </button>
          );
        }} />
    </section>
  );
}

/**
 * The map of a register (W2 item 3, only on a register whose records carry a site): the Site Master map, narrowed to the sites of the records of
 * the current filters. The map reads the sites the caller may see (GET /dashboard/site-map), so a record's site outside them is never drawn.
 */
export function RegisterMap({ records, regionId, partial }: { records: RegisterRecord[]; regionId: string; partial: { shown: number; total: number } | null }) {
  const { t } = useTranslation();
  const codes = [...new Set(records.map((r) => r.site_code).filter((c): c is string => !!c))].sort();
  const noSite = records.filter((r) => !r.site_code).length;
  return (
    <div className="space-y-2" data-testid="register-map-wrap" data-sites={codes.length}>
      <div className="flex flex-wrap items-center gap-2 text-sm text-mute">
        <span data-testid="register-map-note">{t('regviews.map_note', { records: records.length, sites: codes.length })}</span>
        {noSite > 0 && <span className="chip bg-card2" data-testid="register-map-no-site">{t('regviews.map_no_site', { count: noSite })}</span>}
        {partial && <span className="chip bg-waitBg text-waitInk" role="note" data-testid="register-map-partial">{t('regviews.partial', { shown: partial.shown, total: partial.total })}</span>}
      </div>
      <SiteMap testid="register-map" height={560} outer={{ region_id: regionId || undefined, site_codes: codes }} />
    </div>
  );
}

/**
 * The chart of a register (decision V4): the rows the view already shows, sliced by an axis (the approval state or a list or yes/no field) and
 * measured by a count or the sum of a number field, as bars or a ring. It reads the records the screen has already loaded (the same for the
 * list, the wide table, the board and the map), so it adds no request and shows nothing the caller cannot already see; when the view has more
 * rows than are loaded the note says how many it counted.
 */
export function RegisterChart({ def, records, axis, measure, kind, partial }: {
  def: RegisterDefinition; records: RegisterRecord[]; axis: string; measure: string; kind: ChartKind; partial?: { shown: number; total: number } | null;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const af = axis === BY_STATE ? undefined : axisFields(def).find((f) => f.code === axis);
  const mf = numericFields(def).find((f) => f.code === measure);
  const slices = measureBreakdown(
    records,
    (r) => (af ? (r.data[af.code] === undefined || r.data[af.code] === null || r.data[af.code] === '' ? '' : showValue(af, r.data[af.code], lang, t)) : t(`regState.${r.state}`)),
    (r) => (mf ? r.data[mf.code] : 1),
    t('analytics.none'), t('analytics.other'),
  );
  const axisLabel = af ? fieldLabel(af, lang) : t('analytics.by_state');
  const measureLabel = mf ? t('chartv.sum_of', { field: fieldLabel(mf, lang) }) : t('chartv.count');
  return (
    <section className="card p-3" data-testid="register-chart-card" aria-label={t('chartv.title')}>
      <ChartView testid="register-chart" slices={slices} kind={kind} label={t('chartv.label', { axis: axisLabel, measure: measureLabel })}
        head={partial ? <span className="chip bg-waitBg text-waitInk" role="note" data-testid="register-chart-partial">{t('regviews.partial', { shown: partial.shown, total: partial.total })}</span> : undefined} />
    </section>
  );
}

/** Decision V2: the register's records on a month calendar, read only, on the date field chosen in the Layout panel. */
export function RegisterCalendar({ def, records, field, onOpen, partial }: {
  def: RegisterDefinition; records: RegisterRecord[]; field: RegisterField | undefined; onOpen: (id: string) => void; partial?: { shown: number; total: number } | null;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  if (!field) return <div className="card p-3 text-sm text-mute" data-testid="register-calendar-empty">{t('calview.no_columns')}</div>;
  const items = records.map((r) => {
    const titleField = def.fields.find((y) => y.in_list && y.code !== field.code && r.data[y.code] !== undefined && r.data[y.code] !== null && r.data[y.code] !== '');
    const label = [r.site_code, titleField ? valueText(titleField, r.data[titleField.code], lang, t) : ''].filter(Boolean).join(' ') || r.id;
    return { id: r.id, label, date: String(r.data[field.code] ?? '').slice(0, 10), late: false };
  });
  return (
    <section className="card p-3" data-testid="register-calendar-card" aria-label={t('calview.title')}>
      <CalendarGrid testid="register-calendar" items={items} onOpen={onOpen}
        head={partial ? <span className="chip bg-waitBg text-waitInk" role="note" data-testid="register-calendar-partial">{t('regviews.partial', { shown: partial.shown, total: partial.total })}</span> : undefined} />
    </section>
  );
}

const TL_TONES = ['#0f766e', '#b45309', '#1d4ed8', '#9333ea', '#be123c', '#4d7c0f', '#0e7490', '#a16207'];
const TL_MAX = 8;
const TL_DEFAULT = 4;

/**
 * Decision V3 (0.15.575): the cross-site timeline generalized to every register with a date field — one row per record of the current filters
 * (the same records the list shows, up to ALL_CAP), one marker per chosen date field, a bar from the first to the last chosen date and a line for
 * today. Read only: a date changes through its record. The fields are chosen in the URL (`tl`, the date-field codes) as checkboxes, up to eight;
 * the picker stays inside the component (content like the filters, per V1), and `tl` rides the saved views like the other layout keys.
 */
export function RegisterTimeline({ def, records, onOpen, partial }: {
  def: RegisterDefinition; records: RegisterRecord[]; onOpen: (id: string) => void; partial?: { shown: number; total: number } | null;
}) {
  const { t, i18n } = useTranslation();
  const [sp, setSp] = useSearchParams();
  const dates = dateFields(def);
  const chosen = useMemo(() => {
    const want = (sp.get('tl') ?? '').split(',').filter((c) => dates.some((f) => f.code === c));
    return (want.length ? want : dates.slice(0, TL_DEFAULT).map((f) => f.code)).slice(0, TL_MAX);
  }, [sp, dates]);
  const today = new Date().toISOString().slice(0, 10);
  const model = useMemo(() => buildTimeline(
    records.map((r) => ({ id: r.id, code: r.site_code ?? r.id.slice(0, 8), values: r.data as Record<string, string | null> })),
    chosen, today), [records, chosen, today]);
  const name = (code: string) => { const f = dates.find((x) => x.code === code); return f ? fieldLabel(f, i18n.language) : code; };
  const toggle = (code: string) => setSp((p) => {
    const n = new URLSearchParams(p);
    const next = chosen.includes(code) ? chosen.filter((x) => x !== code) : [...chosen, code].slice(0, TL_MAX);
    if (next.length) n.set('tl', next.join(',')); else n.delete('tl');
    return n;
  }, { replace: true });

  return (
    <div className="card p-3" data-testid="register-timeline">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 text-sm font-semibold"><CalendarRange size={16} aria-hidden />{t('timeline.title')}</span>
        <span className="text-xs text-mute">{t('timeline.hint_records', { max: TL_MAX })}</span>
        {partial && <span className="chip bg-waitBg text-waitInk" role="note" data-testid="register-timeline-partial">{t('regviews.partial', { shown: partial.shown, total: partial.total })}</span>}
      </div>
      <fieldset className="mb-3 flex max-h-28 flex-wrap gap-x-4 gap-y-1 overflow-auto border-0 p-0" data-testid="register-timeline-cols">
        <legend className="sr-only">{t('timeline.columns')}</legend>
        {dates.map((f) => {
          const on = chosen.includes(f.code);
          const i = chosen.indexOf(f.code);
          return (
            <label key={f.code} className="inline-flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={on} disabled={!on && chosen.length >= TL_MAX} onChange={() => toggle(f.code)} data-testid={`timeline-col-${f.code}`} className="accent-[var(--accent)]" />
              {on && <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: TL_TONES[i % TL_TONES.length] }} />}
              {fieldLabel(f, i18n.language)}
            </label>
          );
        })}
        {!dates.length && <span className="text-sm text-mute">{t('timeline.no_columns')}</span>}
      </fieldset>
      {!model ? <EmptyState testid="register-timeline-empty" title={t('timeline.empty')} hint={t('timeline.empty_hint')} /> : (
        <div dir="ltr" className="overflow-x-auto">
          <div className="min-w-[640px]">
            <div className="relative ms-[12.5rem] me-2 h-6 border-b border-line text-[11px] text-mute" aria-hidden>
              {model.months.map((m) => <span key={m.day} className="absolute -translate-x-1/2" style={{ left: `${posPct(model, m.day)}%` }}>{m.label}</span>)}
            </div>
            <div className="relative">
            <span aria-hidden data-testid="register-timeline-today" title={t('timeline.today')} className="pointer-events-none absolute inset-y-0 z-10 w-px bg-late"
              style={{ left: `calc(12.5rem + (100% - 13rem) * ${posPct(model, Math.floor(Date.parse(`${today}T00:00:00Z`) / 86_400_000)) / 100})` }} />
            <ul data-testid="register-timeline-rows">
              {model.rows.map((r) => (
                <li key={r.id} className="flex items-center border-b border-line/60 py-1" data-testid={`register-timeline-row-${r.id}`}>
                  <button type="button" onClick={() => onOpen(r.id)} className="w-48 shrink-0 truncate pe-2 text-start text-sm text-ink hover:underline" data-testid={`register-timeline-open-${r.id}`}><b className="mono">{r.code}</b></button>
                  <div className="relative mx-2 h-5 flex-1">
                    <span className="absolute top-1/2 h-1 -translate-y-1/2 rounded bg-line" style={{ left: `${posPct(model, r.from)}%`, width: `${Math.max(posPct(model, r.to) - posPct(model, r.from), 0.4)}%` }} />
                    {r.points.map((p) => (
                      <span key={p.key} role="img" aria-label={`${name(p.key)}: ${fmtDate(p.iso, i18n.language)}`} title={`${name(p.key)}: ${fmtDate(p.iso, i18n.language)}`}
                        className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card" style={{ left: `${posPct(model, p.day)}%`, background: TL_TONES[chosen.indexOf(p.key) % TL_TONES.length] }} />
                    ))}
                  </div>
                </li>
              ))}
            </ul>
            </div>
          </div>
        </div>
      )}
      <p className="mt-2 text-xs text-mute" data-testid="register-timeline-note">{t('timeline.note_records', { shown: model?.rows.length ?? 0, total: records.length })}</p>
    </div>
  );
}

/** The moment a feed entry carries: the last update, else the creation. */
function feedTime(r: RegisterRecord): string {
  return r.updated_at ?? r.created_at ?? '';
}

/** "3 hours ago" in the caller's language; empty when the record carries no time. */
function relTime(iso: string, lang: string): string {
  if (!iso) return '';
  const sec = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (Number.isNaN(sec)) return '';
  const abs = Math.abs(sec);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  if (abs < 60) return rtf.format(sec, 'second');
  if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(sec / 86400), 'day');
  if (abs < 86400 * 365) return rtf.format(Math.round(sec / (86400 * 30)), 'month');
  return rtf.format(Math.round(sec / (86400 * 365)), 'year');
}

/**
 * Decision V10 (2026-11-28, 0.15.577): the feed, the records of the current filters latest-first (by the last update, else the creation),
 * one line each, on every register, up to ALL_CAP like the board and the map. A line shows the title (the first listed field with a value),
 * the site code, the state, the region, the record type and the time in the caller's language. Read only: a line opens its record (drawer or
 * page, per V5).
 */
export function RegisterFeed({ def, records, regionName, onOpen, partial }: {
  def: RegisterDefinition; records: RegisterRecord[]; regionName: (id: number | null | undefined) => string;
  onOpen: (id: string) => void; partial?: { shown: number; total: number } | null;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const sorted = [...records].sort((a, b) => feedTime(b).localeCompare(feedTime(a)));
  const titleOf = (r: RegisterRecord) => {
    const f = def.fields.find((y) => y.in_list && r.data[y.code] !== undefined && r.data[y.code] !== null && r.data[y.code] !== '');
    return f ? valueText(f, r.data[f.code], lang, t) : '';
  };
  return (
    <section className="space-y-2" data-testid="register-feed" aria-label={t('view.feed')}>
      <div className="flex flex-wrap items-center gap-2">
        {partial && <span className="chip bg-waitBg text-waitInk" role="note" data-testid="register-feed-partial">{t('regviews.partial', { shown: partial.shown, total: partial.total })}</span>}
        <span className="ms-auto text-xs text-mute">{t('regviews.board_read_only')}</span>
      </div>
      {!sorted.length ? <EmptyState testid="register-feed-empty" title={t('registers.empty')} /> : (
        <ol className="divide-y divide-line rounded-md border border-line bg-card" data-testid="register-feed-list">
          {sorted.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => onOpen(r.id)} data-testid={`register-feed-item-${r.id}`} data-state={r.state}
                className="flex w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2 text-start text-sm hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                aria-label={t('regviews.card', { code: r.site_code ?? '', title: titleOf(r) })}>
                {r.site_code && <b className="mono" dir="ltr">{r.site_code}</b>}
                <span className="font-medium" data-testid={`register-feed-title-${r.id}`}>{titleOf(r)}</span>
                <span className={`chip ${STATE_TONE[r.state] ?? ''}`} data-testid={`register-feed-value-${r.id}-state`}>{t(`regState.${r.state}`)}</span>
                {r.region_id ? <span className="text-xs text-mute" data-testid={`register-feed-value-${r.id}-site`}>{regionName(r.region_id as number)}</span> : null}
                {r.record_type && <span className="chip border border-line">{r.record_type.toUpperCase()}</span>}
                {r.locked && <span className="chip bg-hover" data-testid={`register-feed-locked-${r.id}`}>{t('registers.locked_badge')}</span>}
                <span className="ms-auto text-xs text-mute" data-testid={`register-feed-time-${r.id}`}>{relTime(feedTime(r), lang)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
