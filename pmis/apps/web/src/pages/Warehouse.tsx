import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { useMe } from '@/api/hooks';
import type { WarehouseItem } from '@/api/types';
import { useMovements, useSaveItem, useStock, useWhItems } from '@/api/warehouse';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { isAdmin } from '@/lib/perm';
import { registerErrorMessage } from '@/lib/registerErrors';

type Tab = 'items' | 'movements' | 'stock';
type Dlg = { mode: 'new' } | { mode: 'edit' | 'off'; item: WarehouseItem } | null;
type Form = { code: string; name_en: string; name_ar: string; uom: string; category: string; serial_tracked: boolean };
const EMPTY: Form = { code: '', name_en: '', name_ar: '', uom: '', category: '', serial_tracked: false };
const TONE: Record<string, string> = { pending: 'bg-lateBg text-lateInk', posted: 'bg-doneBg text-doneInk', cancelled: 'bg-lockBg text-lockInk' };
const useName = () => { const { i18n } = useTranslation(); return (x: { name_en?: string; name_ar?: string | null }) => (i18n.language === 'ar' && x.name_ar) || x.name_en || ''; };

function Items() {
  const { t } = useTranslation();
  const toast = useToast();
  const name = useName();
  const admin = isAdmin(useMe(true).data);
  const [q, setQ] = useState('');
  const [inactive, setInactive] = useState(false);
  const list = useWhItems({ q, include_inactive: inactive });
  const save = useSaveItem<WarehouseItem>('/warehouse/items', 'wh-items');
  const [dlg, setDlg] = useState<Dlg>(null);
  const [f, setF] = useState<Form>(EMPTY);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const items = list.data?.items ?? [];
  const close = () => { setDlg(null); setFe({}); setErr(null); };
  const open = (d: Dlg) => {
    setF(d && d.mode === 'edit' ? { code: d.item.code, name_en: d.item.name_en ?? '', name_ar: d.item.name_ar ?? '', uom: d.item.uom ?? '', category: d.item.category ?? '', serial_tracked: !!d.item.serial_tracked } : EMPTY);
    setFe({}); setErr(null); setDlg(d);
  };
  const set = (k: keyof Form) => (v: string | boolean) => setF((x) => ({ ...x, [k]: v }));

  const submit = (reason: string) => {
    if (!dlg) return;
    const item = dlg.mode === 'new' ? undefined : dlg.item;
    let body: Record<string, unknown>;
    if (dlg.mode === 'off') body = { is_active: false, reason };
    else {
      const all = { name_en: f.name_en.trim(), name_ar: f.name_ar.trim() || null, uom: f.uom.trim(), category: f.category.trim() || null, serial_tracked: f.serial_tracked };
      const cur = dlg.mode === 'edit' ? dlg.item : null;
      body = { ...(cur ? Object.fromEntries(Object.entries(all).filter(([k, v]) => v !== ((cur as Record<string, unknown>)[k] ?? null))) : { code: f.code.trim(), ...all }), reason };
      if (cur && Object.keys(body).length === 1) return close();
    }
    save.mutate({ item, body }, {
      onSuccess: close,
      onError: (e) => {
        if (e instanceof ApiError && e.code === 'item_in_use' && dlg.mode === 'edit') {
          const bad = ['uom', 'serial_tracked'].filter((k) => k in body);
          if (bad.length) return setFe(Object.fromEntries(bad.map((k) => [k, registerErrorMessage(t, e)])));
        }
        if (dlg.mode === 'off') { close(); return toast(registerErrorMessage(t, e), 'err'); }
        if (e instanceof ApiError && e.status === 409 && dlg.mode === 'new') return setFe({ code: t('wh.code_taken') });
        setErr(e instanceof ApiError && ['item_in_use', 'insufficient_stock'].includes(e.code) ? registerErrorMessage(t, e) : errText(e, t));
      },
    });
  };
  const Fld = ({ k, label, dir, disabled }: { k: Exclude<keyof Form, 'serial_tracked'>; label: string; dir?: string; disabled?: boolean }) => (
    <label className="block text-sm font-semibold">{label}
      <input className="input mt-1 font-normal" dir={dir} data-testid={`wh-f-${k}`} disabled={disabled} value={f[k]} onChange={(e) => set(k)(e.target.value)} />
      {fe[k] && <span role="alert" data-testid={`wh-error-${k}`} className="mt-1 block font-normal text-lateInk">{fe[k]}</span>}
    </label>
  );

  return (
    <div data-testid="wh-items">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input className="input max-w-64" data-testid="wh-search" placeholder={t('wh.search')} aria-label={t('wh.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="wh-show-inactive" checked={inactive} onChange={(e) => setInactive(e.target.checked)} />{t('wh.show_inactive')}</label>
        {admin && <button className="btn btn-primary ms-auto" data-testid="wh-new" onClick={() => open({ mode: 'new' })}><Plus size={16} />{t('wh.new_item')}</button>}
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line bg-card2 text-start text-mute">{['code', 'name', 'uom', 'category', 'serial', 'status'].map((c) => <th key={c} className="px-3 py-2 text-start font-semibold">{t(`wh.${c}`)}</th>)}<th /></tr></thead>
          <tbody data-testid="wh-item-list">
            {items.map((x) => (
              <tr key={x.id} data-testid={`wh-item-${x.code}`} className="border-b border-line">
                <td className="mono px-3 py-2 font-bold">{x.code}</td><td className="px-3 py-2">{name(x)}</td><td className="px-3 py-2">{x.uom}</td><td className="px-3 py-2">{x.category ?? '—'}</td>
                <td className="px-3 py-2">{x.serial_tracked ? t('wh.yes') : t('wh.no')}</td>
                <td className="px-3 py-2"><span className={`chip ${x.is_active ? 'bg-doneBg text-doneInk' : 'bg-lockBg text-lockInk'}`}>{t(x.is_active ? 'wh.active' : 'wh.inactive')}</span></td>
                <td className="px-3 py-2 text-end">{admin && x.is_active && <>
                  <button className="btn" data-testid={`wh-edit-${x.code}`} onClick={() => open({ mode: 'edit', item: x })}>{t('wh.edit')}</button>{' '}
                  <button className="btn" data-testid={`wh-off-${x.code}`} onClick={() => open({ mode: 'off', item: x })}>{t('wh.deactivate')}</button></>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.isSuccess && !items.length && <p className="p-6 text-center text-mute" data-testid="wh-empty">{t('wh.empty')}</p>}
        {list.isError && <p role="alert" className="p-6 text-center text-lateInk">{t('errors.generic')}</p>}
      </div>
      {dlg && (
        <FormDialog open onClose={close} testid="wh-dialog" busy={save.isPending} error={err} onSubmit={submit}
          title={t(dlg.mode === 'new' ? 'wh.new_title' : dlg.mode === 'edit' ? 'wh.edit_title' : 'wh.deactivate_title')}
          disabled={dlg.mode !== 'off' && (!f.code.trim() || !f.name_en.trim() || !f.uom.trim())}>
          {dlg.mode === 'off' ? <p>{name(dlg.item)} ({dlg.item.code})</p> : <>
            {Fld({ k: 'code', label: t('wh.code'), disabled: dlg.mode === 'edit' })}
            {Fld({ k: 'name_en', label: t('wh.name_en') })}
            {Fld({ k: 'name_ar', label: t('wh.name_ar'), dir: 'rtl' })}
            {Fld({ k: 'uom', label: t('wh.uom') })}
            {Fld({ k: 'category', label: t('wh.category') })}
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="wh-f-serial" checked={f.serial_tracked} onChange={(e) => set('serial_tracked')(e.target.checked)} />{t('wh.serial')}</label>
            {fe.serial_tracked && <p role="alert" data-testid="wh-error-serial_tracked" className="text-lateInk">{fe.serial_tracked}</p>}
          </>}
        </FormDialog>
      )}
    </div>
  );
}

function Movements() {
  const { t } = useTranslation();
  const [status, setStatus] = useState('');
  const list = useMovements(status);
  // DN and RN only: the other documents (PL, OPEN, ADJ) have no site and are kept in the register.
  const items = (list.data?.items ?? []).filter((m) => m.kind === 'issue' || m.kind === 'return');
  return (
    <div data-testid="wh-movements">
      <div className="mb-3 flex gap-2">
        <select className="input w-auto" aria-label={t('wh.status')} data-testid="wh-filter-status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('wh.all_statuses')}</option>{['pending', 'posted', 'cancelled'].map((s) => <option key={s} value={s}>{t(`wh.st_${s}`)}</option>)}
        </select>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line bg-card2 text-mute">{['doc_no', 'type', 'site', 'qty', 'status'].map((c) => <th key={c} className="px-3 py-2 text-start font-semibold">{t(`wh.${c}`)}</th>)}</tr></thead>
          <tbody data-testid="wh-movement-list">
            {items.map((m) => (
              <tr key={m.id} data-testid={`wh-mv-${m.doc_no ?? m.id}`} data-status={m.status} className="border-b border-line">
                <td className="mono px-3 py-2 font-bold">{m.register_record_id ? <Link className="underline" to={`/registers/warehouse?record=${m.register_record_id}`}>{m.doc_no ?? '—'}</Link> : (m.doc_no ?? '—')}</td>
                <td className="px-3 py-2">{(m.record_type ?? m.kind).toUpperCase()}</td><td className="px-3 py-2">{m.site_code ?? '—'}</td>
                <td className="px-3 py-2">{m.lines.reduce((a, l) => a + l.qty, 0)}</td>
                <td className="px-3 py-2"><span className={`chip ${TONE[m.status]}`} data-testid={`wh-mv-status-${m.doc_no ?? m.id}`}>{t(`wh.st_${m.status}`)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.isSuccess && !items.length && <p className="p-6 text-center text-mute" data-testid="wh-mv-empty">{t('wh.empty')}</p>}
        {list.isError && <p role="alert" className="p-6 text-center text-lateInk">{t('errors.generic')}</p>}
      </div>
    </div>
  );
}

function Stock() {
  const { t, i18n } = useTranslation();
  const [q, setQ] = useState('');
  const list = useStock(q);
  const items = list.data?.items ?? [];
  const cols = ['on_hand', 'reserved', 'pending_issue', 'pending_return', 'available'] as const;
  return (
    <div data-testid="wh-stock">
      <input className="input mb-3 max-w-64" data-testid="wh-stock-search" placeholder={t('wh.search')} aria-label={t('wh.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line bg-card2 text-mute"><th className="px-3 py-2 text-start font-semibold">{t('wh.code')}</th><th className="px-3 py-2 text-start font-semibold">{t('wh.uom')}</th>{cols.map((c) => <th key={c} className="px-3 py-2 text-start font-semibold">{t(`wh.${c}`)}</th>)}</tr></thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.item_id} data-testid={`wh-stock-${s.item_code}`} className="border-b border-line">
                <td className="px-3 py-2"><b className="mono">{s.item_code}</b> {s.item_name}</td><td className="px-3 py-2">{s.uom}</td>
                {cols.map((c) => <td key={c} data-testid={`wh-stock-${s.item_code}-${c}`} className="px-3 py-2">{s[c].toLocaleString(i18n.language)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {list.isSuccess && !items.length && <p className="p-6 text-center text-mute">{t('wh.empty')}</p>}
        {list.isError && <p role="alert" className="p-6 text-center text-lateInk">{t('errors.generic')}</p>}
      </div>
    </div>
  );
}

export function Warehouse() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('items');
  return (
    <div data-testid="page-warehouse">
      <div className="mb-3 flex items-center gap-3">
        <h1 className="text-2xl font-bold">{t('wh.title')}</h1>
        <Link className="btn ms-auto" data-testid="wh-register-link" to="/registers/warehouse">{t('wh.open_register')}</Link>
      </div>
      <div role="tablist" className="mb-3 flex gap-1 border-b border-line">
        {(['items', 'movements', 'stock'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} data-testid={`wh-tab-${k}`} onClick={() => setTab(k)}
            className={`px-3 py-2 text-sm ${tab === k ? 'border-b-2 border-accent font-semibold' : 'text-mute'}`}>{t(`wh.tab_${k}`)}</button>
        ))}
      </div>
      {tab === 'items' && <Items />}{tab === 'movements' && <Movements />}{tab === 'stock' && <Stock />}
    </div>
  );
}
