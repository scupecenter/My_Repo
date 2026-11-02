import { Download, FileDown, FileUp, Plus, RotateCcw, Warehouse as WarehouseIcon, Ruler } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { downloadFile } from '@/api/client';
import { useRegisterDefs, useRegisterRecords, useTemplates, useUploadBatch, type RecordFilters } from '@/api/registers';
import { useRegions } from '@/api/sites';
import type { RegisterDefinition } from '@/api/types';
import { ExportViewButton } from '@/components/ExportDialog';
import { Holders } from '@/components/HolderChip';
import { fieldLabel, showValue } from '@/components/RegisterFields';
import { RegisterDrawer, STATE_TONE } from '@/components/RegisterDrawer';
import { useToast } from '@/components/Toast';
import { MoreMenu, PageHeader, Toolbar } from '@/components/PageHeader';
import { ActiveChips, BulkBar, ColumnMenu, Empty, HeaderRow, pin, rowPad, SelectBox, totalWidth, tracks, Trunc, useTablePrefs } from '@/components/TableKit';
import type { ColDef } from '@/lib/tablePrefs';
import { EmptyState, ErrorState, LoadingSkeleton, NoResults } from '@/components/States';
import { registerErrorMessage } from '@/lib/registerErrors';
import { isLive, OWNER_NOTE } from '@/lib/registerForms';

const RF_KEYS = ['q', 'region_id', 'state', 'record_type'] as const;
const STATES = ['entry', 'in_review', 'in_approval', 'approved', 'voided'];
/** Template per register until the contract's Template carries a register key (it has only module_key, which the seed does not fill yet). */
const TEMPLATE_OF: Record<string, string> = { procurement: 'TPL-PO', gecol: 'TPL-GECOL', hlc: 'TPL-HLC', permits_hse: 'TPL-PRM' };

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
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const regions = useRegions();
  const list = useRegisterRecords(key, f);
  const templates = useTemplates();
  const upload = useUploadBatch();
  const file = useRef<HTMLInputElement>(null);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.page.total ?? items.length;
  // The catalogue only lists fields the caller may see, so a permission-hidden field never becomes a column (plan G1).
  const fieldCols = def.fields.filter((x) => x.in_list);
  const defs: ColDef[] = [{ id: 'site', w: 100, min: 70, pinned: true }, { id: 'region', w: 110, min: 70 }, { id: 'type', w: 80, min: 60 }, ...fieldCols.map((c, i) => ({ id: `f:${c.code}`, w: 150, min: 70, off: i >= 4 })), { id: 'state', w: 130, min: 90 }, { id: 'ball', w: 180, min: 90 }];
  const tbl = useTablePrefs(`register-${key}`, defs);

  const tpl = templates.data?.find((x) => x.template_id === TEMPLATE_OF[key]) ?? templates.data?.find((x) => x.module_key === def.module_key);
  const setRecord = (id: string | null) => setSp((p) => { const n = new URLSearchParams(p); if (id) n.set('record', id); else n.delete('record'); return n; }, { replace: true });
  const rname = (id?: number | null) => { const r = regions.data?.find((x) => x.id === id); return (i18n.language === 'ar' && r?.name_ar) || r?.name_en || '—'; };
  const name = (i18n.language === 'ar' && def.name_ar) || def.name_en;

  const down = () => tpl && downloadFile(`/templates/${tpl.template_id}/download`).then((n) => toast(t('grid.downloaded', { name: n })), (e) => toast(registerErrorMessage(t, e), 'err'));
  const up = (x?: File) => {
    if (!x || !tpl) return;
    upload.mutate({ file: x, template_id: tpl.template_id }, { onSuccess: (b) => nav(`/registers/${key}/batches/${b.id}`), onError: (e) => toast(registerErrorMessage(t, e), 'err') });
  };
  const label = (id: string) => { const fc = fieldCols.find((c) => `f:${c.code}` === id); return fc ? fieldLabel(fc, i18n.language) : t({ site: 'sites.code', region: 'sites.region', type: 'registers.record_type', state: 'registers.state', ball: 'grid.ball' }[id] ?? id); };
  const W = totalWidth(tbl.cols, true);
  const real = items.filter((r) => !r.id.startsWith('tmp-'));
  const flip = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allPicked = real.length > 0 && real.every((r) => picked.has(r.id));
  const chips = [
    ...(f.q ? [{ key: 'q', label: t('table.filter_q', { v: f.q }), onRemove: () => set('q')('') }] : []),
    ...(f.region_id ? [{ key: 'region_id', label: t('table.filter_region', { v: rname(Number(f.region_id)) }), onRemove: () => set('region_id')('') }] : []),
    ...(f.state ? [{ key: 'state', label: t('table.filter_state', { v: t(`regState.${f.state}`) }), onRemove: () => set('state')('') }] : []),
    ...(f.record_type ? [{ key: 'record_type', label: t('table.filter_type', { v: f.record_type.toUpperCase() }), onRemove: () => set('record_type')('') }] : []),
  ];
  const cell = (id: string, r: (typeof items)[number]) => {
    if (id.startsWith('f:')) { const c = fieldCols.find((x) => `f:${x.code}` === id); const txt = c ? showValue(c, r.data[c.code], i18n.language, t) : '—'; return txt === '—' ? <Empty /> : <Trunc text={txt} />; }
    switch (id) {
      case 'site': return <b className="mono">{r.site_code ?? '—'}</b>;
      case 'region': return <Trunc text={rname(r.region_id as number | null)} />;
      case 'type': return r.record_type ? <span>{r.record_type.toUpperCase()}</span> : <Empty />;
      case 'state': return <span className={`chip ${STATE_TONE[r.state]}`} data-testid={`reg-state-${r.id}`}>{t(`regState.${r.state}`)}</span>;
      default: return r.ball_in_court && (r.state === 'in_review' || r.state === 'in_approval') ? <Holders holders={r.ball_in_court.holders} /> : <Empty />;
    }
  };

  return (
    <div data-testid={`page-register-${key}`}>
      <PageHeader title={name} />
      {OWNER_NOTE[key] && <p className="mb-3 text-mute" data-testid="register-owner-note">{t(OWNER_NOTE[key])}</p>}
      <Toolbar activeFilters={activeFilters} activeLabel={t('states.filters')}
        filters={<>
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
        <ColumnMenu api={tbl} label={label} />
        <ExportViewButton testid="register-export" source={key} filters={Object.fromEntries(Object.entries(f).filter(([, x]) => x))} columns={['site_code', 'region', 'record_type', 'state', ...tbl.cols.filter((c) => c.id.startsWith('f:')).map((c) => c.id.slice(2))]} />
        <MoreMenu items={[
          { id: 'tpl-down', label: t('registers.template_download'), icon: <FileDown size={16} />, testid: 'register-template-download', disabled: !tpl, onSelect: () => void down() },
          { id: 'tpl-up', label: t('registers.template_upload'), icon: <FileUp size={16} />, testid: 'register-template-upload', disabled: !tpl || upload.isPending, onSelect: () => file.current?.click() },
          ...(key === 'as_built' ? [{ id: 'items', label: t('asb.items_link'), icon: <Ruler size={16} />, testid: 'register-asbuilt-items', onSelect: () => nav('/as-built/items') }] : []),
          ...(key === 'warehouse' ? [{ id: 'wh', label: t('wh.title'), icon: <WarehouseIcon size={16} />, testid: 'register-warehouse-screen', onSelect: () => nav('/warehouse') }] : []),
          { id: 'reset', label: t('table.reset'), icon: <RotateCcw size={16} />, testid: 'register-reset-cols', onSelect: tbl.reset },
        ]} />
        <input ref={file} type="file" accept=".xlsx" hidden data-testid="register-template-file" onChange={(e) => { up(e.target.files?.[0]); e.target.value = ''; }} />
        </>} />
      <ActiveChips chips={chips} onClear={clearAll} />
      <div className="card overflow-hidden" data-density={tbl.density}>
        <div className="relative max-h-[calc(100vh-18rem)] min-h-40 overflow-auto" data-testid="register-scroll">
          <HeaderRow api={tbl} label={label} select={{ checked: allPicked, indeterminate: picked.size > 0, onChange: () => setPicked(allPicked ? new Set() : new Set(real.map((r) => r.id))), label: t('table.select_all'), testid: 'register-select-all' }} />
          <div data-testid="register-list" role="list" style={{ minWidth: W }}>
            {items.map((r) => {
              const tmp = r.id.startsWith('tmp-'), on = picked.has(r.id), cur = recordId === r.id;
              return (
                <div key={r.id} role="listitem" tabIndex={0} aria-selected={on || cur} onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); if (!tmp) setRecord(r.id); } }} data-testid={`reg-row-${r.id}`} data-state={r.state} data-current={cur || undefined} onClick={() => !tmp && setRecord(r.id)}
                  style={{ gridTemplateColumns: tracks(tbl.cols, true) }}
                  className={`grid w-full cursor-pointer items-center border-b border-line text-start text-sm ${rowPad(tbl.density)} ${on ? 'bg-accentSoft' : 'bg-card hover:bg-hover'} ${cur ? 'ring-2 ring-inset ring-accent' : ''} ${tmp ? 'opacity-60' : ''}`}>
                  <div className="sticky start-0 z-10 flex justify-center bg-inherit">{!tmp && <SelectBox checked={on} onChange={() => flip(r.id)} label={t('table.select_row', { code: r.site_code ?? r.id })} testid={`reg-select-${r.id}`} />}</div>
                  {tbl.cols.map((c) => { const p = pin(c, true); return <div key={c.id} data-col={c.id} className={`min-w-0 px-2 ${p.className}`} style={p.style}>{cell(c.id, r)}</div>; })}
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
        {picked.size === 1 && <button type="button" className="btn" data-testid="register-bulk-open" onClick={() => setRecord([...picked][0])}>{t('table.open_selected')}</button>}
        <button type="button" className="btn" data-testid="register-bulk-copy" onClick={() => { void navigator.clipboard?.writeText(real.filter((r) => picked.has(r.id)).map((r) => r.site_code ?? r.id).join('\n')); toast(t('table.copied', { count: picked.size })); }}>{t('table.copy_codes')}</button>
      </BulkBar>
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
