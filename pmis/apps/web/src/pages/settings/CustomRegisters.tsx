import { Eye, EyeOff, Pencil, Plus, Power } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useCreateCustomRegister, useCustomRegisters, useEnableCustomRegister, useUpdateCustomRegister, type CustomRegister } from '@/api/customRegisters';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';

type Dlg = { k: 'create' } | { k: 'rename'; r: CustomRegister } | { k: 'enable'; r: CustomRegister } | { k: 'hide'; r: CustomRegister };

/**
 * Settings, custom registers (contract 0.15.533): the admin creates a register without code, adds its columns on the Register columns screen, enables it (menu entry,
 * template, permission module) and may hide it. Nothing is deleted. The permission grid, the matrix and the limit (registers.custom_max) are the ordinary ones.
 */
export function CustomRegisters() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useCustomRegisters();
  const create = useCreateCustomRegister();
  const update = useUpdateCustomRegister();
  const enable = useEnableCustomRegister();
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nameEn, setNameEn] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [siteScoped, setSiteScoped] = useState(true);
  const [multiple, setMultiple] = useState(true);
  const close = () => { setDlg(null); setErr(null); };
  const open = (d: Dlg) => {
    setErr(null);
    setNameEn(d.k === 'rename' ? d.r.name_en : '');
    setNameAr(d.k === 'rename' ? d.r.name_ar ?? '' : '');
    setSiteScoped(true); setMultiple(true);
    setDlg(d);
  };
  const run = async (fn: () => Promise<unknown>, ok: string) => { setErr(null); try { await fn(); toast(ok); close(); } catch (e) { setErr(errText(e, t)); } };
  const items = q.data?.items ?? [];
  const lim = q.data?.limit;
  const atLimit = !!lim && lim.active >= lim.max;
  const label = (r: CustomRegister) => (i18n.language.startsWith('ar') && r.name_ar ? r.name_ar : r.name_en);

  return (
    <section className="card space-y-4 p-4" data-testid="page-custom-registers">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-bold">{t('custreg.title')}</h2>
          <p className="text-sm text-mute">{t('custreg.note')}</p>
          {lim && <p className="text-xs text-mute" data-testid="custreg-limit">{t('custreg.limit', { active: lim.active, max: lim.max })}</p>}
        </div>
        <button type="button" className="btn btn-accent" data-testid="custreg-new" disabled={atLimit} title={atLimit ? t('custreg.at_limit') : undefined} onClick={() => open({ k: 'create' })}>
          <Plus size={14} aria-hidden /> {t('custreg.new')}
        </button>
      </div>
      {q.isLoading ? <p className="text-sm text-mute">{t('common.loading')}</p> : items.length === 0 ? (
        <p className="text-sm text-mute" data-testid="custreg-empty">{t('custreg.empty')}</p>
      ) : (
        <table className="w-full text-sm" data-testid="custreg-table">
          <thead>
            <tr className="text-start text-mute">
              <th className="p-1 text-start">{t('custreg.col_name')}</th><th className="p-1 text-start">{t('custreg.col_key')}</th><th className="p-1 text-start">{t('custreg.col_status')}</th>
              <th className="p-1 text-start">{t('custreg.col_columns')}</th><th className="p-1 text-start">{t('custreg.col_records')}</th><th className="p-1 text-start">{t('custreg.col_actions')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.register_key} className="border-t border-line" data-testid={`custreg-row-${r.register_key}`}>
                <td className="p-1 font-semibold">{label(r)}</td>
                <td className="p-1 font-mono text-xs">{r.register_key}</td>
                <td className="p-1"><span className="chip" data-testid={`custreg-status-${r.register_key}`}>{!r.is_active ? t('custreg.s_hidden') : r.enabled ? t('custreg.s_enabled') : t('custreg.s_draft')}</span></td>
                <td className="p-1">{r.field_count}</td>
                <td className="p-1">{r.record_count}</td>
                <td className="flex flex-wrap gap-1 p-1">
                  <Link className="btn px-2 py-1 text-xs" data-testid={`custreg-columns-${r.register_key}`} to={`/admin/settings/registers/columns?register=${r.register_key}`}>{t('custreg.columns')}</Link>
                  <button type="button" className="btn px-2 py-1 text-xs" data-testid={`custreg-rename-${r.register_key}`} onClick={() => open({ k: 'rename', r })}><Pencil size={12} aria-hidden /> {t('custreg.rename')}</button>
                  {!r.enabled && r.is_active && <button type="button" className="btn px-2 py-1 text-xs" data-testid={`custreg-enable-${r.register_key}`} disabled={r.field_count === 0 || r.required_count === 0} title={r.field_count === 0 || r.required_count === 0 ? t('custreg.enable_needs') : undefined} onClick={() => open({ k: 'enable', r })}><Power size={12} aria-hidden /> {t('custreg.enable')}</button>}
                  <button type="button" className="btn px-2 py-1 text-xs" data-testid={`custreg-hide-${r.register_key}`} onClick={() => open({ k: 'hide', r })}>
                    {r.is_active ? <EyeOff size={12} aria-hidden /> : <Eye size={12} aria-hidden />} {r.is_active ? t('custreg.hide') : t('custreg.show')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <FormDialog open={dlg?.k === 'create'} onClose={close} title={t('custreg.new')} testid="custreg-dialog-create" busy={create.isPending} error={err} disabled={nameEn.trim().length < 2}
        onSubmit={(reason) => void run(() => create.mutateAsync({ name_en: nameEn.trim(), name_ar: nameAr.trim() || null, site_scoped: siteScoped, multiple_per_site: siteScoped ? multiple : true, reason }), t('custreg.created'))}>
        <label className="block text-sm">{t('custreg.name_en')}<input className="input mt-1 w-full" data-testid="custreg-name-en" value={nameEn} maxLength={80} onChange={(e) => setNameEn(e.target.value)} /></label>
        <label className="block text-sm">{t('custreg.name_ar')}<input className="input mt-1 w-full" dir="rtl" data-testid="custreg-name-ar" value={nameAr} maxLength={80} onChange={(e) => setNameAr(e.target.value)} /></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="custreg-site-scoped" checked={siteScoped} onChange={(e) => setSiteScoped(e.target.checked)} /> {t('custreg.site_scoped')}</label>
        {siteScoped && <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="custreg-multiple" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} /> {t('custreg.multiple')}</label>}
        <p className="text-xs text-mute">{t('custreg.key_note')}</p>
      </FormDialog>

      <FormDialog open={dlg?.k === 'rename'} onClose={close} title={t('custreg.rename')} testid="custreg-dialog-rename" busy={update.isPending} error={err} disabled={nameEn.trim().length < 2}
        onSubmit={(reason) => dlg?.k === 'rename' && void run(() => update.mutateAsync({ key: dlg.r.register_key, version: dlg.r.version, patch: { name_en: nameEn.trim(), name_ar: nameAr.trim() || null, reason } }), t('custreg.saved'))}>
        <label className="block text-sm">{t('custreg.name_en')}<input className="input mt-1 w-full" data-testid="custreg-name-en" value={nameEn} maxLength={80} onChange={(e) => setNameEn(e.target.value)} /></label>
        <label className="block text-sm">{t('custreg.name_ar')}<input className="input mt-1 w-full" dir="rtl" data-testid="custreg-name-ar" value={nameAr} maxLength={80} onChange={(e) => setNameAr(e.target.value)} /></label>
      </FormDialog>

      <FormDialog open={dlg?.k === 'enable'} onClose={close} title={t('custreg.enable')} testid="custreg-dialog-enable" busy={enable.isPending} error={err}
        onSubmit={(reason) => dlg?.k === 'enable' && void run(() => enable.mutateAsync({ key: dlg.r.register_key, version: dlg.r.version, reason }), t('custreg.enabled'))}>
        <p className="text-sm">{t('custreg.enable_note')}</p>
      </FormDialog>

      <FormDialog open={dlg?.k === 'hide'} onClose={close} title={dlg?.k === 'hide' && !dlg.r.is_active ? t('custreg.show') : t('custreg.hide')} testid="custreg-dialog-hide" busy={update.isPending} error={err}
        onSubmit={(reason) => dlg?.k === 'hide' && void run(() => update.mutateAsync({ key: dlg.r.register_key, version: dlg.r.version, patch: { is_active: !dlg.r.is_active, reason } }), t('custreg.saved'))}>
        <p className="text-sm">{dlg?.k === 'hide' && !dlg.r.is_active ? t('custreg.show_note') : t('custreg.hide_note')}</p>
      </FormDialog>
    </section>
  );
}
