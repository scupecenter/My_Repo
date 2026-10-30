import { Download, FileDown, FileUp, Plus } from 'lucide-react';
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
import { registerErrorMessage } from '@/lib/registerErrors';
import { isLive, OWNER_NOTE } from '@/lib/registerForms';

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
  const [f, setF] = useState<RecordFilters>({ q: '', region_id: '', state: '', record_type: '' });
  const set = (k: keyof RecordFilters) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const regions = useRegions();
  const list = useRegisterRecords(key, f);
  const templates = useTemplates();
  const upload = useUploadBatch();
  const file = useRef<HTMLInputElement>(null);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.page.total ?? items.length;
  const cols = def.fields.filter((x) => x.in_list).slice(0, 4);
  const tpl = templates.data?.find((x) => x.template_id === TEMPLATE_OF[key]) ?? templates.data?.find((x) => x.module_key === def.module_key);
  const setRecord = (id: string | null) => setSp((p) => { const n = new URLSearchParams(p); if (id) n.set('record', id); else n.delete('record'); return n; }, { replace: true });
  const rname = (id?: number | null) => { const r = regions.data?.find((x) => x.id === id); return (i18n.language === 'ar' && r?.name_ar) || r?.name_en || '—'; };
  const name = (i18n.language === 'ar' && def.name_ar) || def.name_en;

  const down = () => tpl && downloadFile(`/templates/${tpl.template_id}/download`).then((n) => toast(t('grid.downloaded', { name: n })), (e) => toast(registerErrorMessage(t, e), 'err'));
  const up = (x?: File) => {
    if (!x || !tpl) return;
    upload.mutate({ file: x, template_id: tpl.template_id }, { onSuccess: (b) => nav(`/registers/${key}/batches/${b.id}`), onError: (e) => toast(registerErrorMessage(t, e), 'err') });
  };
  const ncols = 'grid items-center gap-3 px-4';
  const gtc = { gridTemplateColumns: `90px 100px 70px ${cols.map(() => 'minmax(90px,1fr)').join(' ')} 120px minmax(120px,1fr)` };

  return (
    <div data-testid={`page-register-${key}`}>
      <h1 className="text-2xl font-bold">{name}</h1>
      {OWNER_NOTE[key] && <p className="mb-3 text-mute" data-testid="register-owner-note">{t(OWNER_NOTE[key])}</p>}
      <div className="mb-3 flex flex-wrap items-center gap-2">
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
        <span className="ms-auto text-sm text-mute" data-testid="register-count">{t('sites.count', { count: total })}</span>
        <button className="btn btn-primary" data-testid="register-new" onClick={() => setRecord('new')}><Plus size={16} />{t('registers.new')}</button>
        <button className="btn" data-testid="register-template-download" disabled={!tpl} onClick={() => void down()}><FileDown size={16} />{t('registers.template_download')}</button>
        <button className="btn" data-testid="register-template-upload" disabled={!tpl || upload.isPending} onClick={() => file.current?.click()}><FileUp size={16} />{t('registers.template_upload')}</button>
        <input ref={file} type="file" accept=".xlsx" hidden data-testid="register-template-file" onChange={(e) => { up(e.target.files?.[0]); e.target.value = ''; }} />
        <ExportViewButton testid="register-export" source={key} filters={Object.fromEntries(Object.entries(f).filter(([, x]) => x))} columns={['site_code', 'region', 'record_type', 'state', ...cols.map((c) => c.code)]} />
      </div>
      <div className="card overflow-x-auto">
        <div className="min-w-[860px]">
          <div className={`${ncols} border-b border-line bg-card2 py-2 text-sm font-semibold text-mute`} role="row" style={gtc}>
            <span>{t('sites.code')}</span><span>{t('sites.region')}</span><span>{t('registers.record_type')}</span>
            {cols.map((c) => <span key={c.code}>{fieldLabel(c, i18n.language)}</span>)}<span>{t('registers.state')}</span><span>{t('grid.ball')}</span>
          </div>
          <div data-testid="register-list" role="list">
            {items.map((r) => (
              <div key={r.id} role="listitem" tabIndex={0} onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); if (!r.id.startsWith('tmp-')) setRecord(r.id); } }} data-testid={`reg-row-${r.id}`} data-state={r.state} onClick={() => !r.id.startsWith('tmp-') && setRecord(r.id)} style={gtc}
                className={`${ncols} w-full cursor-pointer border-b border-line py-3 text-start text-sm hover:bg-hover ${r.id.startsWith('tmp-') ? 'opacity-60' : ''}`}>
                <b className="mono">{r.site_code ?? '—'}</b><span>{rname(r.region_id as number | null)}</span><span>{r.record_type ? r.record_type.toUpperCase() : '—'}</span>
                {cols.map((c) => <span key={c.code} className="truncate">{showValue(c, r.data[c.code], i18n.language, t)}</span>)}
                <span><span className={`chip ${STATE_TONE[r.state]}`} data-testid={`reg-state-${r.id}`}>{t(`regState.${r.state}`)}</span></span>
                <span>{r.ball_in_court && (r.state === 'in_review' || r.state === 'in_approval') ? <Holders holders={r.ball_in_court.holders} /> : '—'}</span>
              </div>
            ))}
            {list.isSuccess && !items.length && <p className="p-6 text-center text-mute" data-testid="register-empty">{t('registers.empty')}</p>}
            {list.isError && <p role="alert" className="p-6 text-center text-lateInk">{t('errors.generic')}</p>}
          </div>
        </div>
      </div>
      {list.hasNextPage && <button className="btn mt-3" data-testid="register-more" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}><Download size={16} />{t('registers.more')}</button>}
      <RegisterDrawer def={def} recordId={recordId} onClose={() => setRecord(null)} onOpen={setRecord} />
    </div>
  );
}

export function RegisterPage() {
  const { t } = useTranslation();
  const { key = '' } = useParams();
  const defs = useRegisterDefs();
  if (!isLive(key)) return <RegisterSoon name={t(`nav.reg_${key}`, { defaultValue: key })} />;
  if (defs.isLoading) return <p className="text-mute">{t('common.loading')}</p>;
  const def = defs.data?.find((d) => d.register_key === key);
  if (!def) return defs.isError ? <p role="alert" className="text-lateInk">{t('errors.generic')}</p> : <Navigate to="/my-work" replace />;
  return <RegisterList key={key} def={def} />;
}
