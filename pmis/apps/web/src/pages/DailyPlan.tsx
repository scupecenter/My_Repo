import { ChevronLeft, ChevronRight, ClipboardCopy, Download, FileSpreadsheet, Lock, LockOpen, Pencil, Plus, Search, Trash2, Upload } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { downloadDailyPlanTemplate, exportDailyPlan, useDailyPlan, useImportDailyPlan, useDailyPlanOps, useDailyPlanSettings, type DailyPlanDay, type DailyPlanRegion, type DailyPlanRow } from '@/api/dailyPlan';
import { errText, FormDialog } from '@/components/FormDialog';
import { MoreMenu, PageHeader } from '@/components/PageHeader';
import { SavedViews } from '@/components/SavedViews';
import { ErrorState, LoadingSkeleton } from '@/components/States';
import { LayoutPanel } from '@/components/LayoutPanel';
import { ColumnMenu, useTablePrefs } from '@/components/TableKit';
import { displayAttrs } from '@/components/TableStandard';
import { useToast } from '@/components/Toast';
import { WeekCycle } from '@/components/WeekCycle';
import { UnifiedFilter } from '@/components/UnifiedFilter';
import {
  cellValue, copyToClipboard, emailContent, EMPTY_FILTERS, filterRows, localToday, optionsOf, OVERRIDE_KEYS, OWNER_COLUMNS, type DailyPlanTab, type DpColumn, type DpFilters,
} from '@/lib/dailyPlan';
import type { ColDef } from '@/lib/tablePrefs';
import { DateInput } from '@/components/DateInput';

const SCREEN = 'daily-plan';
const WIDE = new Set<DpColumn>(['planned_work', 'actual_work', 'reason', 'remark', 'sow', 'contractor', 'aat_se']);
const colDefs = (cols: DpColumn[]): ColDef[] => cols.map((id) => ({ id, w: id === 'no' ? 56 : WIDE.has(id) ? 220 : 130, pinned: id === 'no' || id === 'site_code' }));

/**
 * My Work > Daily Plan (plan W7, owner decisions 2026-11-23): Daily Progress of a day and Tomorrow Plan of the next working day, one plan per region per day.
 * The rows come filled from system data; L1 changes them by hand (audited), adds or removes sites and gives the Reason and Remark; L2 locks the day.
 * Toolbar: saved views, + Filter (region, contractor, AAT SE, SOW), search, count, density, columns, Export (Excel in the owner's column order) and Copy for email.
 * The table is a plain <table> so the shared table toolbar of W8 can wrap it later.
 */
export function DailyPlan() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const isWeek = sp.get('tab') === 'week';
  const tab: DailyPlanTab = sp.get('tab') === 'tomorrow' ? 'tomorrow' : 'progress';
  const date = sp.get('date') || localToday();
  const setParams = (kv: Record<string, string>) => setSp((prev) => { const n = new URLSearchParams(prev); for (const [k, v] of Object.entries(kv)) { if (v) n.set(k, v); else n.delete(k); } return n; }, { replace: true });

  const settings = useDailyPlanSettings();
  const progress = useDailyPlan(date);
  const next = progress.data?.next_working_day;
  const tomorrow = useDailyPlan(next);
  const day = tab === 'progress' ? progress : tomorrow;
  const ops = useDailyPlanOps();

  const cols = (settings.data?.columns?.[tab] as DpColumn[] | undefined) ?? OWNER_COLUMNS[tab];
  const colKey = cols.join(',');
  const defs = useMemo(() => colDefs(colKey.split(',') as DpColumn[]), [colKey]);
  const table = useTablePrefs(`${SCREEN}-${tab}`, defs);

  // the region scope: absent = the default of the settings (mine = the regions where the caller holds the Daily Plan), "all", "mine" or one region id
  const defaultScope = settings.data?.default_region_scope === 'all' ? '' : 'mine';
  const regionParam = sp.get('region');
  const filters: DpFilters = {
    region: regionParam === null ? defaultScope : regionParam === 'all' ? '' : regionParam,
    contractor: sp.get('contractor') ?? '', aat_se: sp.get('aat_se') ?? '', sow: sp.get('sow') ?? '', q: sp.get('q') ?? '',
  };
  const mine = progress.data?.my_region_ids ?? [];
  const scope = (d: DailyPlanDay | undefined): number[] => filters.region === 'mine' ? mine : filters.region ? [Number(filters.region)] : (d?.plans.map((p) => p.region_id) ?? []);
  const rowsOf = (d: DailyPlanDay | undefined) => (d ? filterRows(d.rows, filters, scope(d)) : []);
  const rows = rowsOf(day.data);
  const plans = (day.data?.plans ?? []).filter((p) => scope(day.data).includes(p.region_id));
  const planOf = (region: number): DailyPlanRegion | undefined => day.data?.plans.find((p) => p.region_id === region);
  const regionName = (p: DailyPlanRegion) => (i18n.language === 'ar' && p.region_name_ar) || p.region_name_en || p.region_code || String(p.region_id);
  const allRows = [...(progress.data?.rows ?? []), ...(tomorrow.data?.rows ?? [])];
  const opt = (xs: string[]) => xs.map((x) => ({ value: x, label: x }));

  const [edit, setEdit] = useState<DailyPlanRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [unlocking, setUnlocking] = useState<DailyPlanRegion | null>(null);
  const [locking, setLocking] = useState<DailyPlanRegion | null>(null);
  const fail = (e: unknown) => toast(errText(e, t), 'err');
  const shownDate = tab === 'progress' ? date : (next ?? '');

  const copy = async () => {
    if (!progress.data || !tomorrow.data) return;
    const c = emailContent(
      { title: `Daily Progress ${progress.data.date}`, tab: 'progress', rows: rowsOf(progress.data) },
      { title: `Tomorrow Plan ${tomorrow.data.date}`, tab: 'tomorrow', rows: rowsOf(tomorrow.data) },
    );
    try {
      const how = await copyToClipboard(c.html, c.text);
      toast(t(how === 'rich' ? 'dailyPlan.copied' : 'dailyPlan.copied_text'));
    } catch {
      toast(t('dailyPlan.copy_failed'), 'err');
    }
  };
  const importer = useImportDailyPlan();
  const importInput = useRef<HTMLInputElement>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const doTemplate = () => { downloadDailyPlanTemplate(date, scope(progress.data)).then((n) => toast(t('grid.downloaded', { name: n })), fail); };
  const doExport = () => {
    const filtered = Object.entries(filters).some(([k, v]) => k !== 'region' && !!v);
    const sites = filtered ? [...new Set([...rowsOf(progress.data), ...rowsOf(tomorrow.data)].map((r) => r.site_id))] : undefined;
    exportDailyPlan(date, scope(progress.data), sites).catch(fail);
  };
  const shift = (n: number) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    setParams({ date: d.toISOString().slice(0, 10) });
  };

  return (
    <div className="space-y-3" data-testid="page-daily-plan">
      <PageHeader title={t('dailyPlan.title')} subtitle={t('dailyPlan.subtitle')} testid="daily-plan-header" />

      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label={t('dailyPlan.title')} className="inline-flex gap-1" data-testid="daily-plan-tabs">
          {(['progress', 'tomorrow', 'week'] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={k === 'week' ? isWeek : !isWeek && tab === k} data-testid={`daily-plan-tab-${k}`} className={`btn ${(k === 'week' ? isWeek : !isWeek && tab === k) ? 'btn-accent' : ''}`}
              onClick={() => setParams({ tab: k === 'progress' ? '' : k })}>{t(`dailyPlan.tab_${k}`)}</button>
          ))}
        </div>
        <span className="inline-flex items-center gap-1">
          <button type="button" className="btn px-2" aria-label={t('dailyPlan.previous_day')} onClick={() => shift(-1)}><ChevronLeft size={16} className="rtl:rotate-180" aria-hidden /></button>
          <DateInput className="input w-auto" aria-label={t('dailyPlan.date')} data-testid="daily-plan-date" value={date} onChange={(e) => e.target.value && setParams({ date: e.target.value })} />
          <button type="button" className="btn px-2" aria-label={t('dailyPlan.next_day')} onClick={() => shift(1)}><ChevronRight size={16} className="rtl:rotate-180" aria-hidden /></button>
        </span>
        <span className="text-sm text-mute" data-testid="daily-plan-shown-date">{t(isWeek ? 'week.of' : tab === 'progress' ? 'dailyPlan.progress_of' : 'dailyPlan.tomorrow_of', { date: shownDate })}</span>
      </div>
      {isWeek ? <WeekCycle date={date} regions={scope(progress.data)} onDate={(d) => setParams({ date: d })} /> : <>

      <div role="toolbar" className="flex flex-wrap items-center gap-2" data-testid="daily-plan-toolbar">
        <SavedViews screen={SCREEN} sharedScreen value={filters} empty={{ ...EMPTY_FILTERS, region: defaultScope }} table={table}
          onApply={(v) => setParams({ region: v.region || 'all', contractor: v.contractor, aat_se: v.aat_se, sow: v.sow, q: v.q })} />
        <UnifiedFilter screen={SCREEN} value={null} onChange={() => undefined} onClearAll={() => setParams({ region: 'all', contractor: '', aat_se: '', sow: '', q: '' })}
          extras={[
            { key: 'region', label: t('dailyPlan.col.region'), group: 'site', kind: 'enum', value: filters.region, set: (v) => setParams({ region: v || 'all' }),
              options: [{ value: 'mine', label: t('dailyPlan.my_regions') }, ...(progress.data?.plans ?? []).map((p) => ({ value: String(p.region_id), label: regionName(p) }))] },
            { key: 'contractor', label: t('dailyPlan.col.contractor'), group: 'work', kind: 'enum', value: filters.contractor, set: (v) => setParams({ contractor: v }), options: opt(optionsOf(allRows, 'contractor')) },
            { key: 'aat_se', label: t('dailyPlan.col.aat_se'), group: 'work', kind: 'enum', value: filters.aat_se, set: (v) => setParams({ aat_se: v }), options: opt(optionsOf(allRows, 'aat_se')) },
            { key: 'sow', label: t('dailyPlan.col.sow'), group: 'site', kind: 'enum', value: filters.sow, set: (v) => setParams({ sow: v }), options: opt(optionsOf(allRows, 'sow')) },
          ]} />
        <label className="relative">
          <Search size={14} className="pointer-events-none absolute start-2 top-1/2 -translate-y-1/2 text-mute" aria-hidden />
          <input className="input w-48 ps-7" type="search" placeholder={t('dailyPlan.search')} aria-label={t('dailyPlan.search')} data-testid="daily-plan-search"
            value={filters.q} onChange={(e) => setParams({ q: e.target.value })} />
        </label>
        <span className="ms-auto flex flex-wrap items-center gap-2">
          <span className="text-sm text-mute" data-testid="daily-plan-count">{t('dailyPlan.count', { count: rows.length })}</span>
          {plans.some((p) => p.can_edit) && <button type="button" className="btn btn-accent" data-testid="daily-plan-add" onClick={() => setAdding(true)}><Plus size={16} aria-hidden />{t('dailyPlan.add_site')}</button>}
          <LayoutPanel testid="daily-plan-layout" table={table} />
          <ColumnMenu density={false} api={table} label={(id) => t(`dailyPlan.col.${id}`)} />
          <MoreMenu
            settings="daily_plan"
            items={[
              { id: 'export', label: t('dailyPlan.export'), icon: <Download size={16} aria-hidden />, testid: 'daily-plan-export', disabled: !progress.data, onSelect: doExport },
              { id: 'template', label: t('dailyPlan.template'), icon: <FileSpreadsheet size={16} aria-hidden />, testid: 'daily-plan-template', disabled: !progress.data, onSelect: doTemplate },
              ...(plans.some((p) => p.can_edit) ? [{ id: 'import', label: t('dailyPlan.import'), icon: <Upload size={16} aria-hidden />, testid: 'daily-plan-import', onSelect: () => importInput.current?.click() }] : []),
              { id: 'copy', label: t('dailyPlan.copy'), icon: <ClipboardCopy size={16} aria-hidden />, testid: 'daily-plan-copy', disabled: !progress.data || !tomorrow.data, onSelect: () => void copy() },
            ]} />
        </span>
      </div>

      {plans.length > 0 && (
        <ul className="flex flex-wrap gap-2" data-testid="daily-plan-regions">
          {plans.map((p) => (
            <li key={p.region_id} className="card flex items-center gap-2 px-3 py-1.5 text-sm" data-testid={`daily-plan-region-${p.region_id}`}>
              <b>{regionName(p)}</b>
              <span className="text-mute">{t('dailyPlan.count', { count: p.row_count })}</span>
              {p.locked
                ? <span className="chip bg-lockBg text-lockInk" data-testid={`daily-plan-locked-${p.region_id}`}><Lock size={12} aria-hidden />{t(p.lock_kind === 'auto' ? 'dailyPlan.locked_auto' : 'dailyPlan.locked', { name: p.locked_by?.display_name ?? '' })}</span>
                : p.reason_missing_count > 0 && <span className="chip bg-lateBg text-lateInk">{t('dailyPlan.reasons_missing', { count: p.reason_missing_count })}</span>}
              {p.can_lock && <button type="button" className="btn px-2 py-1 text-xs" data-testid={`daily-plan-lock-${p.region_id}`} onClick={() => setLocking(p)}><Lock size={12} aria-hidden />{t('dailyPlan.lock')}</button>}
              {p.can_unlock && <button type="button" className="btn px-2 py-1 text-xs" data-testid={`daily-plan-unlock-${p.region_id}`} onClick={() => setUnlocking(p)}><LockOpen size={12} aria-hidden />{t('dailyPlan.unlock')}</button>}
            </li>
          ))}
        </ul>
      )}

      {day.isLoading || (tab === 'tomorrow' && !next && progress.isLoading) ? <LoadingSkeleton /> : day.isError ? <ErrorState onRetry={() => void day.refetch()} message={errText(day.error, t)} /> : (
        <div className="card overflow-x-auto" dir="ltr" data-testid="daily-plan-table-wrap" {...displayAttrs(table.display)}>
          <table className={`w-full text-sm ${table.density === 'compact' ? 'leading-tight' : ''}`} data-testid="daily-plan-table" data-tab={tab}>
            <thead className="sticky top-0 bg-card text-mute">
              <tr>
                {table.cols.map((c) => <th key={c.id} scope="col" className="whitespace-nowrap border-b border-line p-2 text-start" style={{ minWidth: c.px }} data-testid={`daily-plan-th-${c.id}`}>{t(`dailyPlan.col.${c.id}`)}</th>)}
                <th scope="col" className="border-b border-line p-2"><span className="sr-only">{t('dailyPlan.actions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={table.cols.length + 1} className="p-6 text-center text-mute" data-testid="daily-plan-empty">{t('dailyPlan.empty')}</td></tr>}
              {rows.map((r, i) => {
                const p = planOf(r.region_id);
                return (
                  <tr key={`${r.region_id}-${r.site_id}`} className={`border-t border-line align-top ${r.reason_missing ? 'bg-lateBg/40' : ''}`} data-testid={`daily-plan-row-${r.site_code}`}>
                    {table.cols.map((c) => {
                      const id = c.id as DpColumn;
                      const manual = (r.overridden as string[]).includes(id);
                      const v = cellValue(r, id, i + 1);
                      return (
                        <td key={id} className={`${table.density === 'compact' ? 'p-1' : 'p-2'} whitespace-pre-line`} data-testid={`daily-plan-cell-${r.site_code}-${id}`}>
                          {id === 'site_code' ? <Link className="mono font-semibold text-accentText hover:underline" to={`/sites/${r.site_id}`}>{v}</Link> : v}
                          {manual && <span className="ms-1 inline-block align-middle text-accentText" title={t('dailyPlan.manual_value', { auto: (r.auto as Record<string, string | null>)[id] ?? '' })} data-testid={`daily-plan-manual-${r.site_code}-${id}`}><Pencil size={11} aria-label={t('dailyPlan.manual')} /></span>}
                          {id === 'reason' && r.reason_missing && <span className="chip ms-1 bg-lateBg text-lateInk" data-testid={`daily-plan-reason-missing-${r.site_code}`}>{t('dailyPlan.reason_needed')}</span>}
                        </td>
                      );
                    })}
                    <td className="whitespace-nowrap p-1 text-end">
                      {p?.can_edit && <>
                        <button type="button" className="btn px-1.5 py-1" aria-label={t('dailyPlan.edit_row', { site: r.site_code })} data-testid={`daily-plan-edit-${r.site_code}`} onClick={() => setEdit(r)}><Pencil size={14} aria-hidden /></button>
                        <button type="button" className="btn px-1.5 py-1" aria-label={t('dailyPlan.remove_row', { site: r.site_code })} data-testid={`daily-plan-remove-${r.site_code}`}
                          onClick={() => ops.remove.mutate({ date: shownDate, region: r.region_id, site: r.site_id, version: p.version }, { onSuccess: () => toast(t('dailyPlan.removed')), onError: fail })}><Trash2 size={14} aria-hidden /></button>
                      </>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <input ref={importInput} type="file" accept=".xlsx" className="sr-only" tabIndex={-1} data-testid="daily-plan-import-file" aria-label={t('dailyPlan.import')}
        onChange={(e) => { setImportFile(e.target.files?.[0] ?? null); importer.reset(); e.target.value = ''; }} />
      {importFile && (
        <FormDialog open withReason={false} onClose={() => setImportFile(null)} testid="daily-plan-import-dialog" title={t('dailyPlan.import')} submitLabel={t('dailyPlan.import_apply')} busy={importer.isPending}
          error={importer.isError ? errText(importer.error, t) : null}
          onSubmit={() => importer.mutate({ file: importFile }, { onSuccess: (r) => { setImportFile(null); toast(t('dailyPlan.imported', { updated: r.updated, added: r.added, removed: r.removed, unchanged: r.unchanged })); } })}>
          <p className="mono text-sm" dir="ltr" data-testid="daily-plan-import-name">{importFile.name}</p>
          <p className="mt-2 text-sm text-mute">{t('dailyPlan.import_note')}</p>
        </FormDialog>
      )}
      {edit && <RowDialog row={edit} tab={tab} onClose={() => setEdit(null)} busy={ops.save.isPending} error={ops.save.isError ? errText(ops.save.error, t) : null}
        onSave={(body) => { const p = planOf(edit.region_id); if (p) ops.save.mutate({ date: shownDate, region: edit.region_id, site: edit.site_id, version: p.version, body }, { onSuccess: () => { setEdit(null); toast(t('dailyPlan.saved')); } }); }} />}
      {adding && <AddDialog plans={plans.filter((p) => p.can_edit)} name={regionName} onClose={() => setAdding(false)} busy={ops.add.isPending} error={ops.add.isError ? errText(ops.add.error, t) : null}
        onAdd={(region, code) => { const p = planOf(region); if (p) ops.add.mutate({ date: shownDate, region, version: p.version, site_code: code }, { onSuccess: () => { setAdding(false); toast(t('dailyPlan.added')); } }); }} />}
      {locking && (
        <FormDialog open withReason={false} onClose={() => setLocking(null)} testid="daily-plan-lock-dialog" title={t('dailyPlan.lock_title', { region: regionName(locking), date: shownDate })}
          submitLabel={t('dailyPlan.lock')} busy={ops.lock.isPending} error={ops.lock.isError ? errText(ops.lock.error, t) : null}
          onSubmit={() => ops.lock.mutate({ date: shownDate, region: locking.region_id, version: locking.version }, { onSuccess: () => { setLocking(null); toast(t('dailyPlan.locked_done')); } })}>
          <p className="text-sm text-mute">{t('dailyPlan.lock_hint')}</p>
        </FormDialog>
      )}
      {unlocking && (
        <FormDialog open onClose={() => setUnlocking(null)} testid="daily-plan-unlock-dialog" title={t('dailyPlan.unlock_title', { region: regionName(unlocking), date: shownDate })}
          submitLabel={t('dailyPlan.unlock')} busy={ops.unlock.isPending} error={ops.unlock.isError ? errText(ops.unlock.error, t) : null}
          onSubmit={(reason) => ops.unlock.mutate({ date: shownDate, region: unlocking.region_id, version: unlocking.version, reason }, { onSuccess: () => { setUnlocking(null); toast(t('settings.audited')); } })}>
          <p className="text-sm text-mute">{t('dailyPlan.unlock_hint')}</p>
        </FormDialog>
      )}
      </>}
    </div>
  );
}

/** The manual values of a row: each auto-filled column (empty = back to the auto value), Reason and Remark. */
function RowDialog({ row, tab, onClose, onSave, busy, error }: {
  row: DailyPlanRow; tab: DailyPlanTab; onClose: () => void; onSave: (body: { overrides: Record<string, string | null>; reason: string | null; remark: string | null }) => void; busy: boolean; error: string | null;
}) {
  const { t } = useTranslation();
  const vals = row.values as Record<string, string | null | undefined>;
  const auto = row.auto as Record<string, string | null>;
  const [f, setF] = useState<Record<string, string>>(() => Object.fromEntries(OVERRIDE_KEYS.map((k) => [k, vals[k] ?? ''])));
  const [reason, setReason] = useState(row.reason ?? '');
  const [remark, setRemark] = useState(row.remark ?? '');
  const lines = (s: string) => s.split('\n').filter((x) => x.trim()).length;
  const below = tab === 'progress' && lines(f.actual_work ?? '') < lines(f.planned_work ?? '');
  const submit = () => {
    const overrides: Record<string, string | null> = {};
    for (const k of OVERRIDE_KEYS) {
      const v = (f[k] ?? '').trim();
      if (v === (vals[k] ?? '')) continue;
      overrides[k] = v === (auto[k] ?? '') ? null : v;
    }
    onSave({ overrides, reason: reason.trim() || null, remark: remark.trim() || null });
  };
  return (
    <FormDialog open wide withReason={false} onClose={onClose} testid="daily-plan-row-dialog" title={t('dailyPlan.edit_row', { site: row.site_code })} busy={busy} error={error} onSubmit={submit}>
      <p className="text-sm text-mute">{t('dailyPlan.edit_hint')}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {OVERRIDE_KEYS.map((k) => {
          const multi = k === 'planned_work' || k === 'actual_work';
          return (
            <label key={k} className={`text-sm font-semibold ${multi ? 'sm:col-span-2' : ''}`}>
              {t(`dailyPlan.col.${k}`)}
              {multi
                ? <textarea className="input mt-1 min-h-16 font-normal" data-testid={`daily-plan-field-${k}`} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
                : <input className="input mt-1 font-normal" data-testid={`daily-plan-field-${k}`} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}
              {(f[k] ?? '') !== (auto[k] ?? '') && (
                <button type="button" className="mt-0.5 text-xs font-normal text-accentText hover:underline" data-testid={`daily-plan-reset-${k}`} onClick={() => setF({ ...f, [k]: auto[k] ?? '' })}>
                  {t('dailyPlan.reset_auto', { auto: auto[k] ?? t('dailyPlan.empty_value') })}
                </button>
              )}
            </label>
          );
        })}
        <label className="text-sm font-semibold sm:col-span-2">{t('dailyPlan.col.reason')}{below && <span className="ms-1 text-lateInk">*</span>}
          <textarea className="input mt-1 min-h-12 font-normal" data-testid="daily-plan-field-reason" aria-required={below} value={reason} onChange={(e) => setReason(e.target.value)} />
          {below && !reason.trim() && <span role="alert" className="text-xs font-normal text-lateInk" data-testid="daily-plan-reason-required">{t('dailyPlan.reason_required')}</span>}
        </label>
        <label className="text-sm font-semibold sm:col-span-2">{t('dailyPlan.col.remark')}
          <textarea className="input mt-1 min-h-12 font-normal" data-testid="daily-plan-field-remark" value={remark} onChange={(e) => setRemark(e.target.value)} />
        </label>
      </div>
    </FormDialog>
  );
}

function AddDialog({ plans, name, onClose, onAdd, busy, error }: {
  plans: DailyPlanRegion[]; name: (p: DailyPlanRegion) => string; onClose: () => void; onAdd: (region: number, code: string) => void; busy: boolean; error: string | null;
}) {
  const { t } = useTranslation();
  const [region, setRegion] = useState(plans[0]?.region_id ?? 0);
  const [code, setCode] = useState('');
  return (
    <FormDialog open withReason={false} onClose={onClose} testid="daily-plan-add-dialog" title={t('dailyPlan.add_site')} busy={busy} error={error} disabled={!code.trim() || !region}
      submitLabel={t('dailyPlan.add')} onSubmit={() => onAdd(region, code.trim())}>
      <label className="block text-sm font-semibold">{t('dailyPlan.col.region')}
        <select className="input mt-1 font-normal" data-testid="daily-plan-add-region" value={region} onChange={(e) => setRegion(Number(e.target.value))}>
          {plans.map((p) => <option key={p.region_id} value={p.region_id}>{name(p)}</option>)}
        </select>
      </label>
      <label className="block text-sm font-semibold">{t('dailyPlan.col.site_code')}
        <input className="input mt-1 font-normal" data-testid="daily-plan-add-code" value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
    </FormDialog>
  );
}
