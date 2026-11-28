import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCompanyOnboardingItems, useSaveCompanyOnboardingItems, type CompanyOnboardingItem } from '@/api/companies';
import { errText, FormDialog } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';
import { UnsavedGuard } from '@/lib/unsavedGuard';
import { fieldErrors } from '@/lib/fields';

/**
 * Settings > Registers > Contractors > Onboarding (Companies K4): the checklist items a company goes through (documents received, safety induction, insurance, reference
 * check): label EN/AR and the company types each applies to (empty until set, so nothing shows before the owner picks). An item is hidden, never deleted.
 */
export function CompanyOnboardingItems() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useCompanyOnboardingItems(), save = useSaveCompanyOnboardingItems();
  const [rows, setRows] = useState<CompanyOnboardingItem[] | null>(null);
  const [open, setOpen] = useState(false);
  const [n, setN] = useState({ code: '', label_en: '', label_ar: '' });
  if (!q.data) return <section className="card p-4" data-testid="page-company-onb-items"><QueryFallback queries={[q]} testid="coi-loading" /></section>;
  const list = rows ?? q.data.items;
  const can = q.data.can_edit;
  const errs = fieldErrors(save.error);
  const set = (code: string, p: Partial<CompanyOnboardingItem>) => setRows(list.map((x) => (x.code === code ? { ...x, ...p } : x)));
  const body = (reason: string) => ({ version: q.data.version, body: { reason, items: list } });
  const addable = /^[a-z][a-z0-9_]{1,40}$/.test(n.code) && n.label_en.trim() !== '' && !list.some((x) => x.code === n.code);
  return (
    <section className="card space-y-3 p-4" data-testid="page-company-onb-items">
      <h2 className="font-bold">{t('companyOnb.items_title')}</h2>
      <p className="text-sm text-mute">{t('companyOnb.items_note')}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr><th className="text-start">{t('companyDocs.label_en')}</th><th className="text-start">{t('companyDocs.label_ar')}</th><th className="text-start">{t('companyOnb.applies_to')}</th><th className="text-start">{t('companyDocs.shown')}</th></tr></thead>
          <tbody>
            {list.map((x) => (
              <tr key={x.code} data-testid={`coi-row-${x.code}`} className={x.is_active ? '' : 'opacity-60'}>
                <td><input className="input" disabled={!can} data-testid={`coi-en-${x.code}`} value={x.label_en} onChange={(e) => set(x.code, { label_en: e.target.value })} /></td>
                <td><input className="input" dir="rtl" disabled={!can} data-testid={`coi-ar-${x.code}`} value={x.label_ar ?? ''} onChange={(e) => set(x.code, { label_ar: e.target.value })} /></td>
                <td>
                  <div className="flex flex-wrap gap-2">
                    {q.data.party_types.map((pt) => (
                      <label key={pt} className="flex items-center gap-1"><input type="checkbox" disabled={!can} data-testid={`coi-req-${x.code}-${pt}`} checked={x.required_for.includes(pt)}
                        onChange={(e) => set(x.code, { required_for: e.target.checked ? [...x.required_for, pt] : x.required_for.filter((v) => v !== pt) })} />{pt}</label>
                    ))}
                  </div>
                </td>
                <td><input type="checkbox" disabled={!can} data-testid={`coi-active-${x.code}`} checked={x.is_active} onChange={(e) => set(x.code, { is_active: e.target.checked })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {can && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm font-semibold">{t('companyDocs.code')}<input className="input mt-1 font-normal" data-testid="coi-new-code" value={n.code} onChange={(e) => setN({ ...n, code: e.target.value })} /></label>
          <label className="text-sm font-semibold">{t('companyDocs.label_en')}<input className="input mt-1 font-normal" data-testid="coi-new-en" value={n.label_en} onChange={(e) => setN({ ...n, label_en: e.target.value })} /></label>
          <label className="text-sm font-semibold">{t('companyDocs.label_ar')}<input className="input mt-1 font-normal" dir="rtl" data-testid="coi-new-ar" value={n.label_ar} onChange={(e) => setN({ ...n, label_ar: e.target.value })} /></label>
          <button className="btn" data-testid="coi-new-add" disabled={!addable}
            onClick={() => { setRows([...list, { code: n.code, label_en: n.label_en.trim(), label_ar: n.label_ar.trim() || null, required_for: [], is_active: true }]); setN({ code: '', label_en: '', label_ar: '' }); }}>{t('companyDocs.add')}</button>
        </div>
      )}
      {Object.entries(errs).map(([p, c]) => <p key={p} role="alert" className="text-xs text-lateInk">{p}: {t(`fieldError.${c}`, { defaultValue: c })}</p>)}
      <p className="mono text-xs text-mute" data-testid="coi-version">{t('scopeMatch.version', { version: q.data.version })}</p>
      <button className="btn btn-accent" data-testid="coi-save" disabled={!can || !rows} onClick={() => setOpen(true)}>{t('common.save')}</button>
      <UnsavedGuard scope="settings" dirty={!!rows} needsReason label={t('ui.guard_settings')} onSave={(reason) => new Promise<boolean>((res) => save.mutate(body(reason), { onSuccess: () => res(true), onError: () => res(false) }))} />
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="coi-dialog" title={t('companyOnb.items_title')} busy={save.isPending} error={save.isError && !Object.keys(errs).length ? errText(save.error, t) : null}
          onSubmit={(reason) => save.mutate(body(reason), { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setRows(null); } })} />
      )}
    </section>
  );
}
