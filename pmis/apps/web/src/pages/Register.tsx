import { ArrowRightLeft, Columns3, Download, FileDown, FileSpreadsheet, FileUp, ListChecks, Lock, Plus, RotateCcw, Unlock, Warehouse as WarehouseIcon, Ruler } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMe } from '@/api/hooks';
import { downloadTemplate, useColumnLock, useRecordLock, useRecordOp, useRegisterDefs, useRegisterRecords, useTemplates, useUpdateRecord, type RecordFilters } from '@/api/registers';
import { useRegions } from '@/api/sites';
import type { RegisterDefinition, RegisterRecord } from '@/api/types';
import { ExportViewButton } from '@/components/ExportDialog';
import { GridCellEditor, INLINE_TYPES } from '@/components/GridCellEditor';
import { RegisterGrid } from '@/components/RegisterGrid';
import { RejectDialog } from '@/components/RejectDialog';
import { TemplateUploadDialog } from '@/components/TemplateUploadDialog';
import { ViewModeToggle, type ViewMode } from '@/components/ViewModeToggle';
import { Holders } from '@/components/HolderChip';
import { canEditColumns, useGridColumnMenu } from '@/components/GridColumnAdmin';
import { HlcLegacyDialog } from '@/components/P4cPanels';
import { fieldLabel, showValue } from '@/components/RegisterFields';
import { RegisterDrawer, STATE_TONE } from '@/components/RegisterDrawer';
import { useToast } from '@/components/Toast';
import { MoreMenu, PageHeader, Toolbar } from '@/components/PageHeader';
import { ActiveChips, BulkBar, ColumnMenu, DensityToggle, Empty, gxRow, HeaderRow, pin, rowPad, SelectBox, StatusChip, totalWidth, tracks, Trunc, useAutoFit, useTablePrefs } from '@/components/TableKit';
import type { ColDef, FitSample } from '@/lib/tablePrefs';
import { EmptyState, ErrorState, LoadingSkeleton, NoResults } from '@/components/States';
import { registerErrorMessage } from '@/lib/registerErrors';
import { isLive, OWNER_NOTE } from '@/lib/registerForms';

const RF_KEYS = ['q', 'region_id', 'state', 'record_type'] as const;
const STATES = ['entry', 'in_review', 'in_approval', 'approved', 'voided'];
const VIEW_EMPTY: RecordFilters = { q: '', region_id: '', state: '', record_type: '' };
// P10: the saved-views control (and its share dialog, people picker and role/group queries) loads on its own, after the records, so it never
// delays the first paint of the list.
const SavedViews = lazy(() => import('@/components/SavedViews').then((m) => ({ default: m.SavedViews<RecordFilters> })));

export function RegisterSoon({ name }: { name: string }) {
  const { t } = useTranslation();
  return <div data-testid="page-register-soon"><h1 className="text-2xl font-bold">{name}</h1><p className="card mt-3 p-6 text-mute">{t('registers.soon_body')}</p></div>;
}

function RegisterList({ def }: { def: RegisterDefinition }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const key = def.register_key;
  const recordId = sp.get('record');
  // Filters live in the URL beside `record`, so Back and shared links restore the view (plan F9).
  const f: RecordFilters = { q: sp.get('q') ?? '', region_id: sp.get('region_id') ?? '', state: sp.get('state') ?? '', record_type: sp.get('record_type') ?? '' };
  const activeFilters = Object.values(f).filter(Boolean).length;
  const setParams = (kv: Record<string, string>) => setSp((p) => { const n = new URLSearchParams(p); for (const [k, v] of Object.entries(kv)) { if (v) n.set(k, v); else n.delete(k); } return n; }, { replace: true });
  const set = (k: keyof RecordFilters) => (v: string) => setParams({ [k]: v });
  const clearAll = () => setParams(Object.fromEntries(RF_KEYS.map((k) => [k, ''])));
  // F16: the view is kept in the URL (view=grid; vertical is the default and leaves no parameter), so Back and shared links restore it.
  const view: ViewMode = sp.get('view') === 'grid' ? 'grid' : 'vertical';
  const setView = (v: ViewMode) => setParams({ view: v === 'grid' ? 'grid' : '' });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const regions = useRegions();
  // F16: As-Built splits CW BOQ / TE BOQ and Dismantle splits CW / TE by record_type (the server filter); the first tab is the default.
  // The first tab (All, value '') is the default: every row of the register, as the Excel master shows it.
  const tabDefs = key === 'as_built'
    ? [{ value: '', label: t('registers.tab_all') }, { value: 'cw_part', label: t('registers.tab_asb_cw') }, { value: 'te_part', label: t('registers.tab_asb_te') }]
    : key === 'dismantle' ? [{ value: '', label: t('registers.tab_all') }, { value: 'cw', label: t('registers.tab_dis_cw') }, { value: 'te', label: t('registers.tab_dis_te') }] : [];
  const tab = f.record_type;
  const list = useRegisterRecords(key, { ...f, record_type: tab });
  const save = useUpdateRecord(key);
  // 0.15.22: a System Admin edits a locked row or column (the database exempts admins too); everyone else sees it read-only.
  const me = useMe(true).data;
  const admin = !!me?.is_system_admin;
  const [editing, setEditing] = useState<{ id: string; col: string } | null>(null);
  const templates = useTemplates();
  const [uploading, setUploading] = useState(false);
  const [legacy, setLegacy] = useState(false);   // 0063 (Q139): the one-time migration of the legacy HLC requests
  // The saved-views control mounts once the first page has settled; the list keeps its previous data, so a filter change does not unmount it.
  const viewsReady = !list.isPending;
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.page.total ?? items.length;
  // The catalogue only lists fields the caller may see, so a permission-hidden field never becomes a column (plan G1).
  const fieldCols = def.fields.filter((x) => x.in_list);
  const defs: ColDef[] = [{ id: 'site', w: 100, min: 70, pinned: true }, { id: 'region', w: 110, min: 70, max: 240 }, { id: 'type', w: 80, min: 60 }, ...fieldCols.map((c, i) => ({ id: `f:${c.code}`, w: 150, min: 70, max: 320, off: i >= 4 })), { id: 'state', w: 130, min: 90 }, { id: 'ball', w: 180, min: 90, max: 320 }];
  const tbl = useTablePrefs(`register-${key}`, defs);
  const grid = useGridColumnMenu(key, tbl);   // header menu: hide and personal order for all, add, rename, delete and global order for the admin

  // contract 0.7.0: every register has its own approved template (Template.register_key)
  const tpl = templates.data?.find((x) => x.register_key === key);
  const setRecord = (id: string | null) => setSp((p) => { const n = new URLSearchParams(p); if (id) n.set('record', id); else n.delete('record'); return n; }, { replace: true });
  const rname = (id?: number | null) => { const r = regions.data?.find((x) => x.id === id); return (i18n.language === 'ar' && r?.name_ar) || r?.name_en || '—'; };
  const name = (i18n.language === 'ar' && def.name_ar) || def.name_en;

  const down = (prefill: boolean) => tpl && downloadTemplate(tpl.template_id, { prefill, regionId: f.region_id || undefined }).then((n) => toast(t('grid.downloaded', { name: n })), (e) => toast(registerErrorMessage(t, e), 'err'));
  const inlineField = (cid: string) => (cid.startsWith('f:') ? fieldCols.find((x) => `f:${x.code}` === cid) : undefined);
  const label = (id: string) => { const fc = fieldCols.find((c) => `f:${c.code}` === id); return fc ? fieldLabel(fc, i18n.language) : t({ site: 'sites.code', region: 'sites.region', type: 'registers.record_type', state: 'registers.state', ball: 'grid.ball' }[id] ?? id); };
  const W = totalWidth(tbl.cols, true);
  const real = items.filter((r) => !r.id.startsWith('tmp-'));
  const flip = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allPicked = real.length > 0 && real.every((r) => picked.has(r.id));
  // 0103 (0.15.22): lock, unlock and void. Lock and void take a reason; the database decides every row. A row that is not eligible or is refused is named, never skipped silently.
  const lockRec = useRecordLock(key);
  const lockCol = useColumnLock(key);
  const voidRec = useRecordOp(key);
  const [bulk, setBulk] = useState<null | 'lock' | 'unlock' | 'void'>(null);
  const [colDlg, setColDlg] = useState<null | { code: string; locked: boolean }>(null);
  const [colPick, setColPick] = useState('');
  const colLabel = (code: string) => { const x = def.fields.find((c) => c.code === code); return x ? fieldLabel(x, i18n.language) : code; };
  const runBulk = async (kind: 'lock' | 'unlock' | 'void', reason: string) => {
    const rows = real.filter((r) => picked.has(r.id));
    const eligible = (r: RegisterRecord) => (kind === 'void' ? !!r.allowed_actions?.includes('void') : (kind === 'lock') !== !!r.locked);
    let done = 0;
    const notDone: string[] = [];
    for (const r of rows) {
      if (!eligible(r)) { notDone.push(r.site_code ?? r.id.slice(0, 8)); continue; }
      try {
        if (kind === 'void') await voidRec.mutateAsync({ record: r, op: 'void', note: reason });
        else await lockRec.mutateAsync({ record: r, locked: kind === 'lock', reason });
        done += 1;
      } catch {
        notDone.push(r.site_code ?? r.id.slice(0, 8));
      }
    }
    toast(t('registers.bulk_result', { done, refused: notDone.length }));
    if (notDone.length) toast(t('registers.bulk_refused', { list: notDone.join(', ') }), 'err');
    setBulk(null);
  };
  const colLock = (code: string, locked: boolean, reason: string) => lockCol.mutate({ code, locked, reason }, {
    onSuccess: () => toast(t(locked ? 'registers.column_locked_ok' : 'registers.column_unlocked_ok')),
    onError: (e) => toast(registerErrorMessage(t, e), 'err'),
  });
  const chips = [
    ...(f.q ? [{ key: 'q', label: t('table.filter_q', { v: f.q }), onRemove: () => set('q')('') }] : []),
    ...(f.region_id ? [{ key: 'region_id', label: t('table.filter_region', { v: rname(Number(f.region_id)) }), onRemove: () => set('region_id')('') }] : []),
    ...(f.state ? [{ key: 'state', label: t('table.filter_state', { v: t(`regState.${f.state}`) }), onRemove: () => set('state')('') }] : []),
    ...(f.record_type ? [{ key: 'record_type', label: t('table.filter_type', { v: f.record_type.toUpperCase() }), onRemove: () => set('record_type')('') }] : []),
  ];
  // The text each cell shows, for sizing the columns to their content (null = not measurable here, e.g. the people chips of the ball column).
  const fitText = (id: string, r: (typeof items)[number]): FitSample | null => {
    if (id.startsWith('f:')) { const c = fieldCols.find((x) => `f:${x.code}` === id); const txt = c ? showValue(c, r.data[c.code], i18n.language, t) : ''; return txt === ', ' ? null : txt; }
    switch (id) {
      case 'site': return r.site_code ?? null;
      case 'region': return rname(r.region_id as number | null);
      case 'type': return r.record_type ? r.record_type.toUpperCase() : null;
      case 'state': return [t(`regState.${r.state}`), 24];
      default: return null;
    }
  };
  useAutoFit(tbl, label, items, fitText, i18n.language);
  const cell = (id: string, r: (typeof items)[number]) => {
    if (id.startsWith('f:')) { const c = fieldCols.find((x) => `f:${x.code}` === id); const txt = c ? showValue(c, r.data[c.code], i18n.language, t) : '—'; return txt === '—' ? <Empty /> : <Trunc text={txt} />; }
    switch (id) {
      case 'site': return <><b className="mono">{r.site_code ?? '-'}</b>{r.locked && <span data-testid="reg-locked-badge" className="ms-2 rounded bg-hover px-1.5 text-xs text-mute">{t('registers.locked_badge')}</span>}</>;
      case 'region': return <Trunc text={rname(r.region_id as number | null)} />;
      case 'type': return r.record_type ? <span>{r.record_type.toUpperCase()}</span> : <Empty />;
      case 'state': return <StatusChip tone={STATE_TONE[r.state]} testid={`reg-state-${r.id}`} text={t(`regState.${r.state}`)}>{t(`regState.${r.state}`)}</StatusChip>;
      default: return r.ball_in_court && (r.state === 'in_review' || r.state === 'in_approval') ? <Holders holders={r.ball_in_court.holders} /> : <Empty />;
    }
  };

  return (
    <div data-testid={`page-register-${key}`}>
      <PageHeader title={name} />
      {OWNER_NOTE[key] && <p className="mb-3 text-mute" data-testid="register-owner-note">{t(OWNER_NOTE[key])}</p>}
      <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="register-column-locks">
        <select className="input w-auto" aria-label={t('registers.column_lock_select')} data-testid="register-column-lock-select" value={colPick} onChange={(e) => setColPick(e.target.value)}>
          <option value="">{t('registers.column_lock_select')}</option>
          {def.fields.filter((x) => !x.read_only && !x.locked).map((x) => <option key={x.code} value={x.code}>{fieldLabel(x, i18n.language)}</option>)}
        </select>
        {canEditColumns(me) && <Link className="btn" to="/admin/settings/register-columns" data-testid="register-columns-settings">{t('settings.tab_register-columns')}</Link>}
        <button type="button" className="btn" disabled={!colPick} data-testid="register-column-lock" onClick={() => setColDlg({ code: colPick, locked: true })}><Lock size={16} />{t('registers.column_lock')}</button>
        {def.fields.filter((x) => x.locked).map((x) => (
          <button key={x.code} type="button" className="btn" data-testid={`register-column-unlock-${x.code}`} onClick={() => setColDlg({ code: x.code, locked: false })}>
            <Unlock size={16} />{t('registers.column_unlock', { field: fieldLabel(x, i18n.language) })}
          </button>
        ))}
      </div>
      <RejectDialog open={colDlg !== null} title={colDlg ? t(colDlg.locked ? 'registers.column_title_lock' : 'registers.column_title_unlock', { field: colLabel(colDlg.code) }) : ''}
        onClose={() => setColDlg(null)} onSend={(reason) => { if (colDlg) colLock(colDlg.code, colDlg.locked, reason); setColDlg(null); setColPick(''); }} />
      {tabDefs.length > 0 && (
        <div className="mb-3 flex gap-1" role="group" aria-label={name} data-testid="register-tabs">
          {tabDefs.map((x) => (
            <button key={x.value} type="button" className={`btn ${tab === x.value ? 'btn-accent' : ''}`} aria-pressed={tab === x.value}
              data-testid={`register-tab-${x.value || 'all'}`} onClick={() => set('record_type')(x.value)}>{x.label}</button>
          ))}
        </div>
      )}
      <Toolbar activeFilters={activeFilters} activeLabel={t('states.filters')}
        filters={<>
        {viewsReady && <Suspense fallback={null}><SavedViews screen={`register-${key}`} value={f} empty={VIEW_EMPTY} table={tbl}
          onApply={(v) => setParams(Object.fromEntries(RF_KEYS.map((k) => [k, String((v as Record<string, unknown>)[k] ?? '')])))} /></Suspense>}
        <input className="input max-w-64" data-testid="register-search" placeholder={t('registers.search')} aria-label={t('registers.search')} value={f.q} onChange={(e) => set('q')(e.target.value)} />
        <select className="input w-auto" aria-label={t('sites.all_regions')} data-testid="register-filter-region" value={f.region_id} onChange={(e) => set('region_id')(e.target.value)}>
          <option value="">{t('sites.all_regions')}</option>{(regions.data ?? []).map((r) => <option key={r.id} value={r.id}>{(i18n.language === 'ar' && r.name_ar) || r.name_en}</option>)}
        </select>
        <select className="input w-auto" aria-label={t('registers.all_states')} data-testid="register-filter-state" value={f.state} onChange={(e) => set('state')(e.target.value)}>
          <option value="">{t('registers.all_states')}</option>{STATES.map((s) => <option key={s} value={s}>{t(`regState.${s}`)}</option>)}
        </select>
        {!!def.record_types?.length && (
          <select className="input w-auto" aria-label={t('registers.record_type')} data-testid="register-filter-type" value={f.record_type} onChange={(e) => set('record_type')(e.target.value)}>
            <option value="">{t('registers.all_types')}</option>{def.record_types.map((x) => <option key={x} value={x}>{x.toUpperCase()}</option>)}
          </select>
        )}
        </>}
        count={<span className="text-sm text-mute" data-testid="register-count">{t('sites.count', { count: total })}</span>}
        primary={<button className="btn btn-primary" data-testid="register-new" onClick={() => setRecord('new')}><Plus size={16} />{t('registers.new')}</button>}
        tools={<>
        <ViewModeToggle value={view} onChange={setView} testid="register-view" />
        {view === 'vertical' && <DensityToggle api={tbl} />}
        {view === 'vertical' && <ColumnMenu api={tbl} label={label} />}
        <ExportViewButton testid="register-export" source={key} filters={Object.fromEntries(Object.entries(f).filter(([, x]) => x))} columns={['site_code', 'region', 'record_type', 'state', ...tbl.cols.filter((c) => c.id.startsWith('f:')).map((c) => c.id.slice(2))]} />
        <MoreMenu items={[
          { id: 'tpl-down', label: t('registers.template_download'), icon: <FileDown size={16} />, testid: 'register-template-download', disabled: !tpl, onSelect: () => void down(false) },
          { id: 'tpl-prefill', label: t('registers.template_prefill'), icon: <FileSpreadsheet size={16} />, testid: 'register-template-prefill', disabled: !tpl, onSelect: () => void down(true) },
          { id: 'tpl-up', label: t('registers.template_upload'), icon: <FileUp size={16} />, testid: 'register-template-upload', disabled: !tpl, onSelect: () => setUploading(true) },
          { id: 'tpl-batches', label: t('registers.template_batches'), icon: <ListChecks size={16} />, testid: 'register-template-batches', onSelect: () => nav(`/templates?register=${key}`) },
          ...(key === 'as_built' ? [{ id: 'items', label: t('asb.items_link'), icon: <Ruler size={16} />, testid: 'register-asbuilt-items', onSelect: () => nav('/as-built/items') }] : []),
          ...(key === 'hlc' ? [{ id: 'hlc-legacy', label: t('p4c.legacy_menu'), icon: <ArrowRightLeft size={16} />, testid: 'register-hlc-legacy', onSelect: () => setLegacy(true) }] : []),
          ...(key === 'warehouse' ? [{ id: 'wh', label: t('wh.title'), icon: <WarehouseIcon size={16} />, testid: 'register-warehouse-screen', onSelect: () => nav('/warehouse') }] : []),
          ...(grid.admin ? [
            { id: 'col-add', label: t('regcols.add'), icon: <Plus size={16} />, testid: 'register-column-add', onSelect: grid.openAdd },
            { id: 'col-manage', label: t('regcols.manage'), icon: <Columns3 size={16} />, testid: 'register-columns-manage', onSelect: () => nav(`/admin/settings/register-columns?register=${key}`) },
          ] : []),
          { id: 'reset', label: t('table.reset'), icon: <RotateCcw size={16} />, testid: 'register-reset-cols', onSelect: tbl.reset },
        ]} />
        </>} />
      {tpl && <TemplateUploadDialog open={uploading} onClose={() => setUploading(false)} templateId={tpl.template_id} templateName={`${name} · v${tpl.current_version}`}
        onDone={(b) => { setUploading(false); toast(t('grid.uploaded')); nav(`/registers/${key}/batches/${b.id}`); }} />}
      {grid.dialogs}
      {key === 'hlc' && <HlcLegacyDialog open={legacy} onClose={() => setLegacy(false)} />}
      <ActiveChips chips={chips} onClear={clearAll} />
      {view === 'grid' && (
        <RegisterGrid testid="register-grid" rows={real} columns={[{ id: 'site', label: label('site') }, { id: 'region', label: label('region') }, { id: 'type', label: label('type') },
          ...fieldCols.map((c) => ({ id: `f:${c.code}`, label: label(`f:${c.code}`) })), { id: 'state', label: label('state') }, { id: 'ball', label: label('ball') }]}
          cell={cell} onOpen={setRecord}
          canEdit={(cid, r) => { const fc = inlineField(cid); return !!fc && INLINE_TYPES.includes(fc.type) && !fc.read_only && (admin || (!fc.locked && !r.locked)) && !!r.allowed_actions?.includes('edit'); }}
          editing={editing} onStartEdit={(id, col) => setEditing({ id, col })}
          renderEditor={(cid, r) => {
            const fc = inlineField(cid);
            if (!fc) return null;
            return <GridCellEditor key={`${r.id}-${cid}`} field={fc} value={r.data[fc.code]} onClose={() => setEditing(null)}
              onSave={(v) => save.mutate({ record: r, patch: { data: { [fc.code]: v } } }, { onError: (e) => toast(registerErrorMessage(t, e), 'err') })} />;
          }} />
      )}
      {view === 'vertical' && <>
      <div className="card gx overflow-hidden" data-density={tbl.density}>
        <div className="relative max-h-[calc(100vh-18rem)] min-h-40 overflow-auto" data-testid="register-scroll">
          <HeaderRow api={tbl} label={label} colMenu={grid.colMenu} select={{ checked: allPicked, indeterminate: picked.size > 0, onChange: () => setPicked(allPicked ? new Set() : new Set(real.map((r) => r.id))), label: t('table.select_all'), testid: 'register-select-all' }} />
          <div data-testid="register-list" role="list" style={{ minWidth: W }}>
            {items.map((r, i) => {
              const tmp = r.id.startsWith('tmp-'), on = picked.has(r.id), cur = recordId === r.id;
              const g = gxRow(i, { picked: on, current: cur, muted: tmp });
              return (
                <div key={r.id} role="listitem" tabIndex={0} aria-selected={on || cur} onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); if (!tmp) setRecord(r.id); } }} data-testid={`reg-row-${r.id}`} data-state={r.state} data-locked={r.locked || undefined} data-current={cur || undefined} data-zebra={g['data-zebra']} data-picked={g['data-picked']} onClick={() => !tmp && setRecord(r.id)}
                  style={{ gridTemplateColumns: tracks(tbl.cols, true) }}
                  className={`grid w-full cursor-pointer items-center border-b border-line text-start text-sm ${rowPad(tbl.density)} ${g.className}`}>
                  <div className="sticky start-0 z-10 flex items-center justify-center gap-1 bg-inherit">{!tmp && <SelectBox checked={on} onChange={() => flip(r.id)} label={t('table.select_row', { code: r.site_code ?? r.id })} testid={`reg-select-${r.id}`} />}<span data-testid="reg-row-no" className="tabular-nums text-xs text-mute">{i + 1}</span></div>
                  {tbl.cols.map((c) => { const p = pin(c, true, tbl.cols); return <div key={c.id} data-col={c.id} className={`min-w-0 px-2 ${p.className}`} style={p.style}>{cell(c.id, r)}</div>; })}
                </div>
              );
            })}
            {list.isLoading && <LoadingSkeleton />}
            {list.isSuccess && !items.length && (activeFilters ? <NoResults testid="register-empty" onClear={clearAll} /> : <EmptyState testid="register-empty" title={t('registers.empty')} />)}
            {list.isError && <ErrorState onRetry={() => void list.refetch()} />}
          </div>
        </div>
      </div>
      <BulkBar testid="register-bulk" count={picked.size} loaded={real.length} total={total} onClear={() => setPicked(new Set())}>
        <button type="button" className="btn" data-testid="register-bulk-lock" onClick={() => setBulk('lock')}><Lock size={16} />{t('registers.lock_selected')}</button>
        <button type="button" className="btn" data-testid="register-bulk-unlock" onClick={() => setBulk('unlock')}><Unlock size={16} />{t('registers.unlock_selected')}</button>
        <button type="button" className="btn" data-testid="register-bulk-void" onClick={() => setBulk('void')}>{t('registers.void_selected')}</button>
        {picked.size === 1 && <button type="button" className="btn" data-testid="register-bulk-open" onClick={() => setRecord([...picked][0])}>{t('table.open_selected')}</button>}
        <button type="button" className="btn" data-testid="register-bulk-copy" onClick={() => { void navigator.clipboard?.writeText(real.filter((r) => picked.has(r.id)).map((r) => r.site_code ?? r.id).join('\n')); toast(t('table.copied', { count: picked.size })); }}>{t('table.copy_codes')}</button>
      </BulkBar>
      <RejectDialog open={bulk !== null} title={bulk ? t(`registers.bulk_title_${bulk}`, { count: picked.size }) : ''} onClose={() => setBulk(null)} onSend={(reason) => { if (bulk) void runBulk(bulk, reason); }} />
      </>}
      <p className="mt-2 text-sm text-mute" data-testid="register-footer-count">{t('registers.count_of', { shown: real.length, total })}</p>
      {list.hasNextPage && <button className="btn mt-3" data-testid="register-more" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}><Download size={16} />{t('registers.more')}</button>}
      <RegisterDrawer def={def} recordId={recordId} nav={real.map((r) => r.id)} onClose={() => setRecord(null)} onOpen={setRecord} />
    </div>
  );
}

export function RegisterPage() {
  const { t } = useTranslation();
  const { key = '' } = useParams();
  const defs = useRegisterDefs();
  if (!isLive(key)) return <RegisterSoon name={key} />;
  if (defs.isLoading) return <p className="text-mute">{t('common.loading')}</p>;
  const def = defs.data?.find((d) => d.register_key === key);
  if (!def) return defs.isError ? <p role="alert" className="text-lateInk">{t('errors.generic')}</p> : <Navigate to="/my-work" replace />;
  return <RegisterList key={key} def={def} />;
}
