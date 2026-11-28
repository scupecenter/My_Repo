import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFieldForms, useSetFieldForms } from '@/api/fieldForms';
import type { FieldFormField, FieldFormKind } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';
import { fmtDateTime } from '@/lib/time';
import { UnsavedGuard } from '@/lib/unsavedGuard';

const CODE = /^[a-z0-9_]{2,30}$/;
const TYPES = ['text', 'longtext', 'number', 'yesno', 'choice'] as const;
const clean = (forms: FieldFormKind[]): FieldFormKind[] => forms.map((f) => ({
  ...f, name_en: f.name_en.trim(), name_ar: f.name_ar.trim(),
  fields: f.fields.map((x) => ({ ...x, label_en: x.label_en.trim(), label_ar: x.label_ar.trim(), options: x.type === 'choice' ? x.options.map((o) => o.trim()) : [] })),
}));

/**
 * Settings > Screens > Field forms (migration 0667, contract 0.15.596): the kinds of form a site team fills in Field mode, with or without a connection: the fields
 * of each kind and whether it is signed on the screen. A System Admin or a delegate of settings edit for all regions saves it with a reason and a step-up (audited).
 */
export function FieldFormsSettings() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useFieldForms(), set = useSetFieldForms();
  const [draft, setDraft] = useState<FieldFormKind[] | null>(null);
  const [open, setOpen] = useState(false);
  if (!q.data) return <QueryFallback queries={[q]} testid="ffset-loading" />;
  const cur = q.data;
  const forms = draft ?? cur.forms;
  const dirty = JSON.stringify(clean(forms)) !== JSON.stringify(clean(cur.forms));
  const ro = !cur.can_edit;
  const ar = i18n.language === 'ar';
  const codes = forms.map((f) => f.code.trim());
  const ok = new Set(codes).size === codes.length && forms.every((f) => CODE.test(f.code.trim()) && f.name_en.trim()
    && new Set(f.fields.map((x) => x.key.trim())).size === f.fields.length
    && f.fields.every((x) => CODE.test(x.key.trim()) && x.label_en.trim() && (x.type !== 'choice' || (x.options.length >= 2 && x.options.every((o) => o.trim())))));
  const setForm = (i: number, p: Partial<FieldFormKind>) => setDraft(forms.map((f, j) => (j === i ? { ...f, ...p } : f)));
  const setField = (i: number, k: number, p: Partial<FieldFormField>) => setForm(i, { fields: forms[i]!.fields.map((x, j) => (j === k ? { ...x, ...p } : x)) });
  const save = (reason: string) => set.mutate({ version: cur.version, forms: clean(forms), reason }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setDraft(null); } });
  return (
    <section className="card space-y-4 p-4" data-testid="page-fieldforms-settings">
      <div>
        <h2 className="font-bold">{t('ffset.title')}</h2>
        <p className="text-sm text-mute">{t('ffset.note')}</p>
      </div>
      <div className="space-y-3">
        {forms.map((f, i) => (
          <div key={i} className="space-y-2 rounded-md border border-line p-3" data-testid={`ffset-form-${i}`}>
            <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
              <input className="input" dir="ltr" maxLength={30} placeholder={t('ffset.code')} aria-label={t('ffset.code')} data-testid={`ffset-form-${i}-code`} disabled={ro} value={f.code} onChange={(e) => setForm(i, { code: e.target.value })} />
              <input className="input" dir="ltr" maxLength={80} placeholder={t('ffset.name_en')} aria-label={t('ffset.name_en')} data-testid={`ffset-form-${i}-en`} disabled={ro} value={f.name_en} onChange={(e) => setForm(i, { name_en: e.target.value })} />
              <input className="input" dir="rtl" maxLength={80} placeholder={t('ffset.name_ar')} aria-label={t('ffset.name_ar')} data-testid={`ffset-form-${i}-ar`} disabled={ro} value={f.name_ar} onChange={(e) => setForm(i, { name_ar: e.target.value })} />
              <button type="button" className="btn btn-danger" disabled={ro} aria-label={t('ffset.remove_form')} data-testid={`ffset-form-${i}-remove`} onClick={() => setDraft(forms.filter((_, j) => j !== i))}><Trash2 size={15} aria-hidden /></button>
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2" title={t('ffset.enabled_tip')}><input type="checkbox" data-testid={`ffset-form-${i}-enabled`} disabled={ro} checked={f.enabled} onChange={(e) => setForm(i, { enabled: e.target.checked })} />{t('ffset.enabled')}</label>
              <label className="flex items-center gap-2" title={t('ffset.signature_tip')}><input type="checkbox" data-testid={`ffset-form-${i}-signature`} disabled={ro} checked={f.signature} onChange={(e) => setForm(i, { signature: e.target.checked })} />{t('ffset.signature')}</label>
            </div>
            <div className="space-y-2">
              {f.fields.map((x, k) => (
                <div key={k} className="space-y-1 rounded-md bg-card2 p-2" data-testid={`ffset-field-${i}-${k}`}>
                  <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_8rem_auto_auto]">
                    <input className="input" dir="ltr" maxLength={30} placeholder={t('ffset.key')} aria-label={t('ffset.key')} data-testid={`ffset-field-${i}-${k}-key`} disabled={ro} value={x.key} onChange={(e) => setField(i, k, { key: e.target.value })} />
                    <input className="input" dir="ltr" maxLength={80} placeholder={t('ffset.name_en')} aria-label={t('ffset.label_en')} data-testid={`ffset-field-${i}-${k}-en`} disabled={ro} value={x.label_en} onChange={(e) => setField(i, k, { label_en: e.target.value })} />
                    <input className="input" dir="rtl" maxLength={80} placeholder={t('ffset.name_ar')} aria-label={t('ffset.label_ar')} data-testid={`ffset-field-${i}-${k}-ar`} disabled={ro} value={x.label_ar} onChange={(e) => setField(i, k, { label_ar: e.target.value })} />
                    <select className="input" aria-label={t('ffset.type')} data-testid={`ffset-field-${i}-${k}-type`} disabled={ro} value={x.type} onChange={(e) => setField(i, k, { type: e.target.value as FieldFormField['type'], options: e.target.value === 'choice' ? x.options : [] })}>
                      {TYPES.map((ty) => <option key={ty} value={ty}>{t(`ffset.type_${ty}`)}</option>)}
                    </select>
                    <label className="flex items-center gap-1 text-xs"><input type="checkbox" data-testid={`ffset-field-${i}-${k}-required`} disabled={ro} checked={x.required} onChange={(e) => setField(i, k, { required: e.target.checked })} />{t('ffset.required')}</label>
                    <button type="button" className="btn btn-danger" disabled={ro} aria-label={t('ffset.remove_field')} data-testid={`ffset-field-${i}-${k}-remove`} onClick={() => setForm(i, { fields: f.fields.filter((_, j) => j !== k) })}><Trash2 size={15} aria-hidden /></button>
                  </div>
                  {x.type === 'choice' && (
                    <input className="input w-full" dir={ar ? 'rtl' : 'ltr'} placeholder={t('ffset.options_hint')} aria-label={t('ffset.options')} data-testid={`ffset-field-${i}-${k}-options`} disabled={ro}
                      defaultValue={x.options.join(', ')} onBlur={(e) => setField(i, k, { options: e.target.value.split(',').map((o) => o.trim()).filter(Boolean) })} />
                  )}
                </div>
              ))}
            </div>
            <button type="button" className="btn gap-1" data-testid={`ffset-form-${i}-field-add`} disabled={ro || f.fields.length >= 30}
              onClick={() => setForm(i, { fields: [...f.fields, { key: '', label_en: '', label_ar: '', type: 'text', required: false, options: [] }] })}><Plus size={15} aria-hidden />{t('ffset.add_field')}</button>
          </div>
        ))}
      </div>
      <button type="button" className="btn gap-1" data-testid="ffset-form-add" disabled={ro || forms.length >= 20}
        onClick={() => setDraft([...forms, { code: '', name_en: '', name_ar: '', enabled: true, signature: false, fields: [] }])}><Plus size={15} aria-hidden />{t('ffset.add_form')}</button>
      <p className="text-xs text-mute" data-testid="ffset-updated">
        {cur.updated_by && cur.updated_at ? t('ffset.updated', { name: cur.updated_by.display_name, when: fmtDateTime(cur.updated_at, ar ? 'ar' : 'en') }) : t('ffset.never')}
      </p>
      {ro
        ? <p className="text-sm text-mute" data-testid="ffset-readonly">{t('ffset.readonly')}</p>
        : <button className="btn btn-accent" data-testid="ffset-save" disabled={!dirty || !ok} onClick={() => setOpen(true)}>{t('common.save')}</button>}
      <UnsavedGuard scope="settings" dirty={dirty} needsReason label={t('ui.guard_settings')} onSave={(reason) => new Promise<boolean>((res) => set.mutate({ version: cur.version, forms: clean(forms), reason }, { onSuccess: () => res(true), onError: () => res(false) }))} />
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="ffset-dialog" title={t('ffset.title')} busy={set.isPending} error={set.isError ? errText(set.error, t) : null} onSubmit={save}>
          <p className="text-sm text-mute" data-testid="ffset-confirm">{t('ffset.confirm')}</p>
        </FormDialog>
      )}
    </section>
  );
}
