import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRegisterOrderWarnings, useSetRegisterOrderWarnings, type RegisterOrderWarningsInput } from '@/api/p4c';
import { useRegisterDefs } from '@/api/registers';
import { errText, FormDialog } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';
import { UnsavedGuard } from '@/lib/unsavedGuard';

/**
 * Settings > Registers > Order warnings (contract 0.15.464, M1). The GECOL screen of Q151, generic: each chain lists date fields of the chosen register in their
 * expected order; a later step dated before an earlier one warns the reviewer and never blocks. Off by default. Also: the billing field must not be before the
 * event it follows (GECOL: the billing conversion, fixed). The warnings run on the reviewer list of the register, not on import validation.
 * `fixed` is the register of the old GECOL tab, which is hidden and kept.
 */
export function RegisterOrderWarnings({ fixed }: { fixed?: string }) {
  const { t, i18n } = useTranslation();
  const defs = useRegisterDefs();
  const [pick, setPick] = useState('gecol');
  const key = fixed ?? pick;
  return (
    <section className="card space-y-3 p-4" data-testid={fixed ? 'page-gecol-order' : 'page-register-order'}>
      <h2 className="font-bold">{fixed ? t('gecolOrder.title') : t('regOrder.title')}</h2>
      <p className="text-sm text-mute">{fixed ? t('gecolOrder.note') : t('regOrder.note')}</p>
      {!fixed && (
        <label className="block text-sm font-semibold">{t('regOrder.register')}
          <select className="input mt-1 w-auto font-normal" data-testid="rgo-register" value={pick} onChange={(e) => setPick(e.target.value)}>
            {(defs.data ?? []).map((d) => <option key={d.register_key} value={d.register_key}>{(i18n.language === 'ar' && d.name_ar) || d.name_en || d.register_key}</option>)}
          </select>
        </label>
      )}
      <OrderPanel key={key} register={key} />
    </section>
  );
}

function OrderPanel({ register }: { register: string }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useRegisterOrderWarnings(register), set = useSetRegisterOrderWarnings(register);
  const [draft, setDraft] = useState<RegisterOrderWarningsInput | null>(null);
  const [open, setOpen] = useState(false);
  const cur: RegisterOrderWarningsInput | null = draft ?? (q.data ? { enabled: q.data.enabled, chains: q.data.chains, billing_after: q.data.billing_after ?? null, billing_field: q.data.billing_field ?? null } : null);
  const errs = fieldErrors(set.error);
  if (!cur || !q.data) return <QueryFallback queries={[q]} testid="gow-loading" />;
  const gecol = register === 'gecol';
  const fields = q.data.fields;
  const label = (code: string) => { const f = fields.find((x) => x.code === code); return (i18n.language === 'ar' && f?.label_ar) || f?.label_en || code; };
  const setChain = (i: number, chain: string[]) => setDraft({ ...cur, chains: cur.chains.map((c, j) => (j === i ? chain : c)) });
  // GECOL sends no billing field of its own: the database fixes it to the billing conversion date
  const body = (reason: string) => ({ ...cur, billing_field: gecol ? null : cur.billing_field, reason });
  const billingOk = gecol || (!!cur.billing_after === !!cur.billing_field);

  return (
    <div className="space-y-3" data-testid="rgo-panel">
      <p className="mono text-xs text-mute" data-testid="gow-version">{t('scopeMatch.version', { version: q.data.version })}{draft && <span className="chip ms-2">{t('scopeMatch.unsaved')}</span>}</p>
      {fields.length === 0 && <p className="text-sm text-mute" data-testid="rgo-no-dates">{t('regOrder.no_dates')}</p>}
      <label className="flex items-center gap-2 text-sm font-semibold">
        <input type="checkbox" data-testid="gow-enabled" checked={cur.enabled} onChange={(e) => setDraft({ ...cur, enabled: e.target.checked })} />{t('regOrder.enabled')}
      </label>
      {cur.chains.map((chain, i) => (
        <fieldset key={i} className="rounded-md border border-line p-2" data-testid={`gow-chain-${i}`}>
          <legend className="px-1 text-sm font-semibold">{t('gecolOrder.chain', { n: i + 1 })}</legend>
          <ol className="flex flex-wrap items-center gap-1 text-sm">
            {chain.map((code, j) => (
              <li key={`${code}-${j}`} className="chip bg-card2" data-testid={`gow-step-${i}-${j}`}>
                {j > 0 && <span aria-hidden className="text-mute">≤ </span>}{label(code)}
                <button type="button" className="btn btn-ghost p-0.5" title={t('scopeMatch.remove', { name: label(code) })} aria-label={t('scopeMatch.remove', { name: label(code) })} data-testid={`gow-remove-${i}-${j}`}
                  onClick={() => setChain(i, chain.filter((_, k) => k !== j))}><X size={12} /></button>
              </li>
            ))}
            <li>
              <select className="input w-auto" aria-label={t('gecolOrder.add_step')} data-testid={`gow-add-${i}`} value="" onChange={(e) => e.target.value && setChain(i, [...chain, e.target.value])}>
                <option value="">{t('gecolOrder.add_step')}</option>
                {fields.filter((f) => !chain.includes(f.code)).map((f) => <option key={f.code} value={f.code}>{label(f.code)}</option>)}
              </select>
            </li>
          </ol>
          {errs[`/chains/${i}`] && <p role="alert" className="text-xs text-lateInk">{t(`fieldError.${errs[`/chains/${i}`]}`)}</p>}
          <button type="button" className="btn btn-ghost mt-1 text-sm" data-testid={`gow-remove-chain-${i}`} onClick={() => setDraft({ ...cur, chains: cur.chains.filter((_, k) => k !== i) })}>{t('gecolOrder.remove_chain')}</button>
        </fieldset>
      ))}
      <button type="button" className="btn" data-testid="gow-add-chain" disabled={cur.chains.length >= 10 || fields.length < 2} onClick={() => setDraft({ ...cur, chains: [...cur.chains, []] })}><Plus size={14} />{t('gecolOrder.add_chain')}</button>
      <label className="block text-sm font-semibold">{gecol ? t('gecolOrder.billing_after') : t('regOrder.billing_after')}
        <select className="input mt-1 font-normal" data-testid="gow-billing" value={cur.billing_after ?? ''} onChange={(e) => setDraft({ ...cur, billing_after: e.target.value || null })}>
          <option value="">{t('gecolOrder.billing_none')}</option>
          {fields.filter((f) => f.code !== (gecol ? 'billing_conversion_date' : cur.billing_field)).map((f) => <option key={f.code} value={f.code}>{label(f.code)}</option>)}
        </select>
      </label>
      {!gecol && (
        <label className="block text-sm font-semibold">{t('regOrder.billing_field')}
          <select className="input mt-1 font-normal" data-testid="rgo-billing-field" value={cur.billing_field ?? ''} onChange={(e) => setDraft({ ...cur, billing_field: e.target.value || null })}>
            <option value="">{t('regOrder.billing_field_none')}</option>
            {fields.filter((f) => f.code !== cur.billing_after).map((f) => <option key={f.code} value={f.code}>{label(f.code)}</option>)}
          </select>
          {errs['/billing_field'] && <span role="alert" className="block text-xs text-lateInk">{t(`fieldError.${errs['/billing_field']}`)}</span>}
        </label>
      )}
      <button className="btn btn-accent" data-testid="gow-save" disabled={!draft || cur.chains.some((c) => c.length < 2) || !billingOk} onClick={() => setOpen(true)}>{t('scopeMatch.save')}</button>
      <UnsavedGuard scope="settings" dirty={!!draft} needsReason label={t('ui.guard_settings')} onSave={(reason) => new Promise<boolean>((res) => set.mutate({ version: q.data!.version, body: body(reason) }, { onSuccess: () => res(true), onError: () => res(false) }))} />
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="gow-dialog" title={t('regOrder.title')} busy={set.isPending} error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ version: q.data!.version, body: body(reason) }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setDraft(null); } })} />
      )}
    </div>
  );
}
