import { Lock, PanelRightOpen } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RegisterDefinition, RegisterField, RegisterRecord } from '@/api/types';
import { BoardGrid, type BoardColumn } from '@/components/Board';
import { CalendarGrid } from '@/components/CalendarGrid';
import { INLINE_TYPES } from '@/components/GridCellEditor';
import { Holders } from '@/components/HolderChip';
import { fieldLabel, showValue } from '@/components/RegisterFields';
import { STATE_TONE } from '@/components/RegisterDrawer';
import { SiteMap } from '@/components/SiteMap';
import { ChartView, type ChartKind } from '@/components/ChartView';
import { StatusChip } from '@/components/TableKit';
import { WideTable, type WideCell, type WideColumn, type WideInput, type WideTableRow } from '@/components/WideTable';
import { isHidden, sectionIdOf, typeHides } from '@/lib/registerForms';
import { measureBreakdown } from '@/lib/viewAnalytics';
import type { Display } from '@/lib/tablePrefs';

/**
 * W2 of plan 2026-11-23-next-ui-cleanup: the view options of Site Master on every register and log. The list stays the default; the wide table,
 * the board and the map are the same shared components as Site Master (WideTable, BoardGrid, SiteMap), fed by the register's own list
 * (GET /registers/{key}/records with the same filters, so every layout shows the same records, with the caller's rights and field rules).
 */
export type RegisterLayout = 'list' | 'wide' | 'board' | 'map' | 'calendar' | 'chart';
export const REGISTER_LAYOUTS: readonly RegisterLayout[] = ['list', 'wide', 'board', 'map', 'calendar', 'chart'];

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
    the calendar (decision V2) where the definition has at least one date field. */
export const layoutsOf = (def: RegisterDefinition): RegisterLayout[] => [
  'list', 'wide', 'board',
  ...(def.site_scoped ? (['map'] as const) : []),
  ...(dateFields(def).length ? (['calendar'] as const) : []),
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
  const section = (f: RegisterField) => t(`regSections.${sectionIdOf(f.section)}`, { defaultValue: f.section ?? t('regSections.details') });
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
export function RegisterBoard({ def, records, by, lane, regionName, onOpen, partial }: {
  def: RegisterDefinition; records: RegisterRecord[]; by: string; lane: RegisterLane;
  regionName: (id: number | null | undefined) => string; onOpen: (id: string) => void;
  /** the board holds only the first records of a larger filtered set */
  partial: { shown: number; total: number } | null;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [open, setOpen] = useState<Set<string>>(new Set());
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
  const title = (r: RegisterRecord) => {
    const f = def.fields.find((y) => y.in_list && y.code !== groupBy && r.data[y.code] !== undefined && r.data[y.code] !== null && r.data[y.code] !== '');
    return f ? valueText(f, r.data[f.code], lang, t) : '';
  };
  return (
    <section className="space-y-2" data-testid="register-board" data-by={groupBy} aria-label={t('regviews.board_label', { name: (lang === 'ar' && def.name_ar) || def.name_en })}>
      <div className="flex flex-wrap items-center gap-2">
        {partial && <span className="chip bg-waitBg text-waitInk" role="note" data-testid="register-board-partial">{t('regviews.partial', { shown: partial.shown, total: partial.total })}</span>}
        <span className="ms-auto text-xs text-mute">{t('regviews.board_read_only')}</span>
      </div>
      <BoardGrid<RegisterRecord> testid="register-board-scroll" emptyTestid="register-board-empty" empty={t('registers.empty')} total={records.length} showLanes={lane !== 'none'}
        columns={columns} lanes={laneIds.map((l) => ({ key: laneKey.get(l)!, name: laneName(l), count: records.filter((r) => laneOf(r) === l).length }))}
        label={(c, l) => `${c.name} · ${l.name}`}
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
