import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCompanyDocumentTypes, useSaveCompanyDocumentTypes, type CompanyDocumentType } from '@/api/companies';
import { errText, FormDialog } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';
import { UnsavedGuard } from '@/lib/unsavedGuard';
import { fieldErrors } from '@/lib/fields';

/**
 * Settings > Registers > Contractors > Documents (Companies K3): the one list of document types of a company (commercial registration, tax, insurance, safety, trade licence,
 * ISO, staff certificates): label EN/AR, the company types it is required for (empty until set), the alert lead days. A type is hidden, never deleted.
 */
export function CompanyDocumentTypes() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useCompanyDocumentTypes(), save = useSaveCompanyDocumentTypes();
  const [rows, setRows] = useState<CompanyDocumentType[] | null>(null);
  const [open, setOpen] = useState(false);
  const [n, setN] = useState({ code: '', label_en: '', label_ar: '' });
  if (!q.data) return <section className="card p-4" data-testid="page-company-doc-types"><QueryFallback queries={[q]} testid="cdt-loading" /></section>;
  const list = rows ?? q.data.types;
  const can = q.data.can_edit;
  const errs = fieldErrors(save.error);
  const set = (code: string, p: Partial<CompanyDocumentType>) => setRows(list.map((x) => (x.code === code ? { ...x, ...p } : x)));
  const body = (reason: string) => ({ version: q.data.version, body: { reason, types: list } });
  const addable = /^[a-z][a-z0-9_]{1,40}$/.test(n.code) && n.label_en.trim() !== '' && !list.some((x) => x.code === n.code);
  return (
    <section className="card space-y-3 p-4" data-testid="page-company-doc-types">
      <h2 className="font-bold">{t('companyDocs.types_title')}</h2>
      <p className="text-sm text-mute">{t('companyDocs.types_note')}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-start"><th className="text-start">{t('companyDocs.label_en')}</th><th className="text-start">{t('companyDocs.label_ar')}</th><th className="text-start">{t('companyDocs.required_for')}</th><th className="text-start">{t('companyDocs.lead_days')}</th><th className="text-start">{t('companyDocs.shown')}</th></tr></thead>
          <tbody>
            {list.map((x) => (
              <tr key={x.code} data-testid={`cdt-row-${x.code}`} className={x.is_active ? '' : 'opacity-60'}>
                <td><input className="input" disabled={!can} data-testid={`cdt-en-${x.code}`} value={x.label_en} onChange={(e) => set(x.code, { label_en: e.target.value })} /></td>
                <td><input className="input" dir="rtl" disabled={!can} data-testid={`cdt-ar-${x.code}`} value={x.label_ar ?? ''} onChange={(e) => set(x.code, { label_ar: e.target.value })} /></td>
                <td>
                  <div className="flex flex-wrap gap-2">
                    {q.data.party_types.map((pt) => (
                      <label key={pt} className="flex items-center gap-1"><input type="checkbox" disabled={!can} data-testid={`cdt-req-${x.code}-${pt}`} checked={x.required_for.includes(pt)}
                        onChange={(e) => set(x.code, { required_for: e.target.checked ? [...x.required_for, pt] : x.required_for.filter((v) => v !== pt) })} />{pt}</label>
                    ))}
                  </div>
                </td>
                <td><input type="number" min={0} max={365} className="input w-20" disabled={!can} data-testid={`cdt-lead-${x.code}`} value={x.lead_days} onChange={(e) => set(x.code, { lead_days: Number(e.target.value) })} /></td>
                <td><input type="checkbox" disabled={!can} data-testid={`cdt-active-${x.code}`} checked={x.is_active} onChange={(e) => set(x.code, { is_active: e.target.checked })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {can && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm font-semibold">{t('companyDocs.code')}<input className="input mt-1 font-normal" data-testid="cdt-new-code" value={n.code} onChange={(e) => setN({ ...n, code: e.target.value })} /></label>
          <label className="text-sm font-semibold">{t('companyDocs.label_en')}<input className="input mt-1 font-normal" data-testid="cdt-new-en" value={n.label_en} onChange={(e) => setN({ ...n, label_en: e.target.value })} /></label>
          <label className="text-sm font-semibold">{t('companyDocs.label_ar')}<input className="input mt-1 font-normal" dir="rtl" data-testid="cdt-new-ar" value={n.label_ar} onChange={(e) => setN({ ...n, label_ar: e.target.value })} /></label>
          <button className="btn" data-testid="cdt-new-add" disabled={!addable}
            onClick={() => { setRows([...list, { code: n.code, label_en: n.label_en.trim(), label_ar: n.label_ar.trim() || null, required_for: [], lead_days: 30, has_expiry: true, is_active: true }]); setN({ code: '', label_en: '', label_ar: '' }); }}>{t('companyDocs.add')}</button>
        </div>
      )}
      {Object.entries(errs).map(([p, c]) => <p key={p} role="alert" className="text-xs text-lateInk">{p}: {t(`fieldError.${c}`, { defaultValue: c })}</p>)}
      <p className="mono text-xs text-mute" data-testid="cdt-version">{t('scopeMatch.version', { version: q.data.version })}</p>
      <button className="btn btn-accent" data-testid="cdt-save" disabled={!can || !rows} onClick={() => setOpen(true)}>{t('common.save')}</button>
      <UnsavedGuard scope="settings" dirty={!!rows} needsReason label={t('ui.guard_settings')} onSave={(reason) => new Promise<boolean>((res) => save.mutate(body(reason), { onSuccess: () => res(true), onError: () => res(false) }))} />
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="cdt-dialog" title={t('companyDocs.types_title')} busy={save.isPending} error={save.isError && !Object.keys(errs).length ? errText(save.error, t) : null}
          onSubmit={(reason) => save.mutate(body(reason), { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setRows(null); } })} />
      )}
    </section>
  );
}
