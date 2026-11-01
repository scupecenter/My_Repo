import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { useMe } from '@/api/hooks';
import type { AsBuiltItem } from '@/api/types';
import { useAsBuiltItems, useSaveItem, useWhItems } from '@/api/warehouse';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { isAdmin } from '@/lib/perm';
import { registerErrorMessage } from '@/lib/registerErrors';

type Dlg = { mode: 'new' } | { mode: 'edit' | 'off'; item: AsBuiltItem } | null;
type Form = { code: string; section: 'cw' | 'te'; name_en: string; name_ar: string; unit: string; warehouse_item_code: string };
const EMPTY: Form = { code: '', section: 'cw', name_en: '', name_ar: '', unit: '', warehouse_item_code: '' };

export function AsBuiltItems() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const admin = isAdmin(useMe(true).data);
  const [section, setSection] = useState('');
  const [inactive, setInactive] = useState(false);
  const list = useAsBuiltItems({ section, include_inactive: inactive });
  const wh = useWhItems({ q: '', include_inactive: false }, admin); // codes offered for the optional link
  const save = useSaveItem<AsBuiltItem>('/as-built/items', 'asbuilt-items');
  const [dlg, setDlg] = useState<Dlg>(null);
  const [f, setF] = useState<Form>(EMPTY);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const items = list.data?.items ?? [];
  const close = () => { setDlg(null); setFe({}); setErr(null); };
  const open = (d: Dlg) => {
    setF(d && d.mode === 'edit' ? { code: d.item.code, section: d.item.section, name_en: d.item.name_en ?? '', name_ar: d.item.name_ar ?? '', unit: d.item.unit ?? '', warehouse_item_code: d.item.warehouse_item_code ?? '' } : EMPTY);
    setFe({}); setErr(null); setDlg(d);
  };
  const set = (k: keyof Form) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  const submit = (reason: string) => {
    if (!dlg) return;
    const item = dlg.mode === 'new' ? undefined : dlg.item;
    let body: Record<string, unknown>;
    if (dlg.mode === 'off') body = { is_active: false, reason };
    else {
      const all = { name_en: f.name_en.trim(), name_ar: f.name_ar.trim() || null, unit: f.unit.trim(), warehouse_item_code: f.warehouse_item_code.trim() || null };
      const cur = dlg.mode === 'edit' ? dlg.item : null;
      body = { ...(cur ? Object.fromEntries(Object.entries(all).filter(([k, v]) => v !== ((cur as Record<string, unknown>)[k] ?? null))) : { code: f.code.trim(), section: f.section, ...all }), reason };
      if (cur && Object.keys(body).length === 1) return close();
    }
    save.mutate({ item, body }, {
      onSuccess: close,
      onError: (e) => {
        if (e instanceof ApiError && e.code === 'item_in_use' && 'unit' in body) return setFe({ unit: registerErrorMessage(t, e) });
        if (dlg.mode === 'off') { close(); return toast(registerErrorMessage(t, e), 'err'); }
        setErr(e instanceof ApiError && e.code === 'item_in_use' ? registerErrorMessage(t, e) : errText(e, t));
      },
    });
  };
  const Fld = ({ k, label, dir, disabled, list: dl }: { k: Exclude<keyof Form, 'section'>; label: string; dir?: string; disabled?: boolean; list?: string }) => (
    <label className="block text-sm font-semibold">{label}
      <input className="input mt-1 font-normal" dir={dir} list={dl} data-testid={`asb-f-${k}`} disabled={disabled} value={f[k]} onChange={(e) => set(k)(e.target.value)} />
      {fe[k] && <span role="alert" data-testid={`asb-error-${k}`} className="mt-1 block font-normal text-lateInk">{fe[k]}</span>}
    </label>
  );

  return (
    <div data-testid="page-asbuilt-items">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="me-3 text-2xl font-bold">{t('asb.title')}</h1>
        <select className="input w-auto" aria-label={t('asb.section')} data-testid="asb-filter-section" value={section} onChange={(e) => setSection(e.target.value)}>
          <option value="">{t('asb.all_sections')}</option><option value="cw">{t('asb.cw')}</option><option value="te">{t('asb.te')}</option>
        </select>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="asb-show-inactive" checked={inactive} onChange={(e) => setInactive(e.target.checked)} />{t('wh.show_inactive')}</label>
        <Link className="btn ms-auto" to="/registers/as_built">{t('asb.back')}</Link>
        {admin && <button className="btn btn-primary" data-testid="asb-new" onClick={() => open({ mode: 'new' })}><Plus size={16} />{t('wh.new_item')}</button>}
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line bg-card2 text-mute">{[['code', 'wh.code'], ['section', 'asb.section'], ['name', 'wh.name'], ['unit', 'asb.unit'], ['link', 'asb.link'], ['status', 'wh.status']].map(([c, l]) => <th key={c} className="px-3 py-2 text-start font-semibold">{t(l!)}</th>)}<th /></tr></thead>
          <tbody data-testid="asb-list">
            {items.map((x) => (
              <tr key={x.id} data-testid={`asb-item-${x.code}`} className="border-b border-line">
                <td className="mono px-3 py-2 font-bold">{x.code}</td><td className="px-3 py-2">{t(`asb.${x.section}`)}</td>
                <td className="px-3 py-2">{(i18n.language === 'ar' && x.name_ar) || x.name_en}</td><td className="px-3 py-2">{x.unit}</td><td className="mono px-3 py-2">{x.warehouse_item_code ?? '—'}</td>
                <td className="px-3 py-2"><span className={`chip ${x.is_active ? 'bg-doneBg text-doneInk' : 'bg-lockBg text-lockInk'}`}>{t(x.is_active ? 'wh.active' : 'wh.inactive')}</span></td>
                <td className="px-3 py-2 text-end">{admin && x.is_active && <>
                  <button className="btn" data-testid={`asb-edit-${x.code}`} onClick={() => open({ mode: 'edit', item: x })}>{t('wh.edit')}</button>{' '}
                  <button className="btn" data-testid={`asb-off-${x.code}`} onClick={() => open({ mode: 'off', item: x })}>{t('wh.deactivate')}</button></>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.isSuccess && !items.length && <p className="p-6 text-center text-mute" data-testid="asb-empty">{t('wh.empty')}</p>}
        {list.isError && <p role="alert" className="p-6 text-center text-lateInk">{t('errors.generic')}</p>}
      </div>
      {dlg && (
        <FormDialog open onClose={close} testid="asb-dialog" busy={save.isPending} error={err} onSubmit={submit}
          title={t(dlg.mode === 'new' ? 'asb.new_title' : dlg.mode === 'edit' ? 'asb.edit_title' : 'asb.deactivate_title')}
          disabled={dlg.mode !== 'off' && (!f.code.trim() || !f.name_en.trim() || !f.unit.trim())}>
          {dlg.mode === 'off' ? <p>{dlg.item.name_en} ({dlg.item.code})</p> : <>
            {Fld({ k: 'code', label: t('wh.code'), disabled: dlg.mode === 'edit' })}
            <label className="block text-sm font-semibold">{t('asb.section')}
              <select className="input mt-1 font-normal" data-testid="asb-f-section" disabled={dlg.mode === 'edit'} value={f.section} onChange={(e) => set('section')(e.target.value)}><option value="cw">{t('asb.cw')}</option><option value="te">{t('asb.te')}</option></select>
            </label>
            {Fld({ k: 'name_en', label: t('wh.name_en') })}
            {Fld({ k: 'name_ar', label: t('wh.name_ar'), dir: 'rtl' })}
            {Fld({ k: 'unit', label: t('asb.unit') })}
            {Fld({ k: 'warehouse_item_code', label: t('asb.link'), list: 'asb-wh-codes' })}
            <datalist id="asb-wh-codes">{(wh.data?.items ?? []).map((w) => <option key={w.id} value={w.code}>{w.name_en}</option>)}</datalist>
          </>}
        </FormDialog>
      )}
    </div>
  );
}
