import { FileSignature, Send } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFieldForms, useSiteFieldForms } from '@/api/fieldForms';
import type { FieldFormKind } from '@/api/types';
import { SignaturePad } from '@/components/SignaturePad';

export type FormDraft = { formCode: string; formLabel: string; answers: Record<string, unknown>; signature: string | null; signerName: string | null };

/** Required fields filled, a number is a number, a choice is one of the options; the kind's signature needs the drawing and the name. Same rules as the server (checkAnswers). */
export function formProblems(form: FieldFormKind, answers: Record<string, unknown>, signature: string | null, signer: string): string[] {
  const out: string[] = [];
  for (const f of form.fields) {
    const v = answers[f.key];
    const empty = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    if (empty && f.required) out.push(f.key);
    else if (!empty && f.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) out.push(f.key);
    else if (!empty && f.type === 'choice' && (typeof v !== 'string' || !f.options.includes(v))) out.push(f.key);
  }
  if (form.signature && (!signature || !signer.trim())) out.push('signature');
  return out;
}

/**
 * Field mode > Forms (contract 0.15.596): the person picks a form kind, fills it, signs on the screen and queues it. It is saved on the device and sent when there is a
 * connection (the same queue as the photos and the fixes). Below, the forms already sent for the site (read online only).
 */
export function FieldFormsPanel({ siteId, online, onQueue }: { siteId: string | null; online: boolean; onQueue: (d: FormDraft) => Promise<boolean> }) {
  const { t, i18n } = useTranslation();
  const kinds = useFieldForms();
  const sent = useSiteFieldForms(online ? siteId : null);
  const enabled = useMemo(() => (kinds.data?.forms ?? []).filter((f) => f.enabled), [kinds.data]);
  const [code, setCode] = useState('');
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [sig, setSig] = useState<string | null>(null);
  const [signer, setSigner] = useState('');
  const [tried, setTried] = useState(false);
  const [padKey, setPadKey] = useState(0);
  const ar = i18n.language === 'ar';
  const form = enabled.find((f) => f.code === code) ?? null;
  const bad = form ? formProblems(form, answers, sig, signer) : [];
  const name = (f: { name_en: string; name_ar: string }) => (ar && f.name_ar) || f.name_en;
  const submit = async () => {
    if (!form) return;
    setTried(true);
    if (bad.length) return;
    const ok = await onQueue({ formCode: form.code, formLabel: name(form), answers, signature: form.signature ? sig : null, signerName: form.signature ? signer.trim() : null });
    if (ok) { setAnswers({}); setSig(null); setSigner(''); setTried(false); setPadKey((k) => k + 1); }
  };
  return (
    <section className="card space-y-3 p-4" data-testid="field-forms">
      <h2 className="flex items-center gap-2 font-bold"><FileSignature size={16} aria-hidden />{t('field.forms_title')}</h2>
      {!siteId && <p className="text-sm text-mute" data-testid="field-forms-nosite">{t('field.forms_pick_site')}</p>}
      {siteId && kinds.data && enabled.length === 0 && <p className="text-sm text-mute" data-testid="field-forms-none">{t('field.forms_none')}</p>}
      {siteId && enabled.length > 0 && (
        <>
          <select className="input" aria-label={t('field.forms_pick')} data-testid="field-form-kind" value={code} onChange={(e) => { setCode(e.target.value); setAnswers({}); setSig(null); setSigner(''); setTried(false); setPadKey((k) => k + 1); }}>
            <option value="">{t('field.forms_pick')}</option>
            {enabled.map((f) => <option key={f.code} value={f.code}>{name(f)}</option>)}
          </select>
          {form && (
            <div className="space-y-3" data-testid="field-form-body">
              {form.fields.map((f) => {
                const err = tried && bad.includes(f.key);
                const label = `${(ar && f.label_ar) || f.label_en}${f.required ? ' *' : ''}`;
                const common = { id: `ff-${f.key}`, 'data-testid': `ff-${f.key}`, 'aria-invalid': err || undefined } as const;
                return (
                  <div key={f.key}>
                    <label className="block text-xs font-semibold text-mute" htmlFor={`ff-${f.key}`}>{label}</label>
                    {f.type === 'text' && <input {...common} className="input mt-1 w-full" maxLength={200} value={String(answers[f.key] ?? '')} onChange={(e) => setAnswers({ ...answers, [f.key]: e.target.value })} />}
                    {f.type === 'longtext' && <textarea {...common} rows={3} className="input mt-1 w-full" maxLength={4000} value={String(answers[f.key] ?? '')} onChange={(e) => setAnswers({ ...answers, [f.key]: e.target.value })} />}
                    {f.type === 'number' && <input {...common} type="number" inputMode="decimal" className="input mt-1 w-full" value={answers[f.key] === undefined ? '' : String(answers[f.key])} onChange={(e) => setAnswers({ ...answers, [f.key]: e.target.value === '' ? undefined : Number(e.target.value) })} />}
                    {f.type === 'yesno' && (
                      <select {...common} className="input mt-1 w-full" value={answers[f.key] === undefined ? '' : String(answers[f.key])} onChange={(e) => setAnswers({ ...answers, [f.key]: e.target.value === '' ? undefined : e.target.value === 'true' })}>
                        <option value="">-</option><option value="true">{t('common.yes')}</option><option value="false">{t('common.no')}</option>
                      </select>
                    )}
                    {f.type === 'choice' && (
                      <select {...common} className="input mt-1 w-full" value={String(answers[f.key] ?? '')} onChange={(e) => setAnswers({ ...answers, [f.key]: e.target.value === '' ? undefined : e.target.value })}>
                        <option value="">-</option>{f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    )}
                    {err && <p role="alert" className="mt-1 text-xs text-danger">{t('field.forms_required')}</p>}
                  </div>
                );
              })}
              {form.signature && (
                <div className="space-y-2" data-testid="field-form-signature">
                  <label className="block text-xs font-semibold text-mute" htmlFor="ff-signer">{t('field.forms_signer')} *</label>
                  <input id="ff-signer" data-testid="ff-signer" className="input w-full" maxLength={120} value={signer} onChange={(e) => setSigner(e.target.value)} />
                  <p className="text-xs font-semibold text-mute">{t('field.forms_sign_here')} *</p>
                  <SignaturePad key={padKey} onChange={setSig} />
                  {tried && bad.includes('signature') && <p role="alert" className="text-xs text-danger" data-testid="field-form-sig-err">{t('field.forms_sign_required')}</p>}
                </div>
              )}
              <button type="button" className="btn btn-accent gap-1" data-testid="field-form-queue" onClick={() => void submit()}><Send size={14} aria-hidden />{t('field.forms_queue')}</button>
            </div>
          )}
        </>
      )}
      {siteId && online && sent.data && sent.data.length > 0 && (
        <div className="space-y-1 border-t border-line pt-2" data-testid="field-forms-sent">
          <h3 className="text-sm font-semibold">{t('field.forms_sent')}</h3>
          {sent.data.slice(0, 20).map((s) => {
            const k = (kinds.data?.forms ?? []).find((x) => x.code === s.form_code);
            return <p key={s.id} className="text-sm text-mute" data-testid="field-form-sent">{k ? name(k) : s.form_code}{s.signed && s.signer_name ? `, ${s.signer_name}` : ''} <span className="text-xs">{new Date(s.submitted_at).toLocaleString(ar ? 'ar-LY' : 'en-GB')}</span></p>;
          })}
        </div>
      )}
    </section>
  );
}
