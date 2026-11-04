import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useContractorRules, useSetContractorRules, useTeamScopeMatch } from '@/api/settings';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';

type Form = { lead: string; roles: string; scopes: string[]; internal: string; closed: string };
const list = (s: string) => s.split(/[,;،]/).map((x) => x.trim()).filter(Boolean);

/**
 * Settings, contractor rules (contract 0.12.9, P4b): the safety certificate alert lead time (D145b, information only), the roles alerted
 * ("Procurement"), the scopes of the CW Delivery Model and the internal team types (Q147; a change of these needs a step-up), and the order
 * statuses that end an order (Q145, the mismatch report).
 */
export function ContractorRules() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useContractorRules(), set = useSetContractorRules(), m = useTeamScopeMatch();
  const [f, setF] = useState<Form | null>(null);
  const [open, setOpen] = useState(false);
  const v: Form = f ?? {
    lead: String(q.data?.safety_cert_lead_days ?? 30), roles: (q.data?.recipient_roles ?? []).join(', '), scopes: q.data?.cw_delivery_scopes ?? [],
    internal: (q.data?.internal_team_types ?? []).join(', '), closed: (q.data?.closed_order_statuses ?? []).join(', '),
  };
  const errs = fieldErrors(set.error);
  const n = Number(v.lead), bad = !Number.isInteger(n) || n < 0 || n > 365;
  const err = (p: string) => errs[p] && <p role="alert" className="text-xs text-lateInk">{t(`fieldError.${errs[p]}`, { defaultValue: errs[p] })}</p>;
  return (
    <section className="card space-y-3 p-4" data-testid="page-contractor-rules">
      <h2 className="font-bold">{t('contractorRules.title')}</h2>
      <p className="text-sm text-mute">{t('contractorRules.note')}</p>
      <label className="block max-w-56 text-sm font-semibold">{t('contractorRules.lead_days')}
        <input type="number" min={0} max={365} className="input mt-1 font-normal" aria-invalid={bad} data-testid="cr-lead" value={v.lead} onChange={(e) => setF({ ...v, lead: e.target.value })} />
        <span className="text-xs font-normal text-mute">{t('contractorRules.lead_note')}</span>{err('/safety_cert_lead_days')}</label>
      <label className="block text-sm font-semibold">{t('contractorRules.roles')}
        <input className="input mt-1 font-normal" data-testid="cr-roles" value={v.roles} onChange={(e) => setF({ ...v, roles: e.target.value })} />{err('/recipient_roles')}</label>
      <fieldset className="space-y-1">
        <legend className="text-sm font-semibold">{t('contractorRules.cw_scopes')}</legend>
        <p className="text-xs text-mute">{t('contractorRules.cw_scopes_note')}</p>
        <div className="flex flex-wrap gap-3">
          {(m.data?.scopes ?? []).map((s) => (
            <label key={s.scope} className="flex items-center gap-1 text-sm">
              <input type="checkbox" data-testid={`cr-scope-${s.scope}`} checked={v.scopes.includes(s.scope)}
                onChange={(e) => setF({ ...v, scopes: e.target.checked ? [...v.scopes, s.scope] : v.scopes.filter((x) => x !== s.scope) })} />{s.scope}
            </label>
          ))}
        </div>
        {err('/cw_delivery_scopes')}
      </fieldset>
      <label className="block text-sm font-semibold">{t('contractorRules.internal_types')}
        <input className="input mt-1 font-normal" data-testid="cr-internal" value={v.internal} onChange={(e) => setF({ ...v, internal: e.target.value })} />{err('/internal_team_types')}</label>
      <label className="block text-sm font-semibold">{t('contractorRules.closed')}
        <input className="input mt-1 font-normal" data-testid="cr-closed" value={v.closed} onChange={(e) => setF({ ...v, closed: e.target.value })} />{err('/closed_order_statuses')}</label>
      <p className="mono text-xs text-mute" data-testid="cr-version">{t('scopeMatch.version', { version: q.data?.version })}</p>
      <button className="btn btn-accent" data-testid="cr-save" disabled={bad || !q.data || !f} onClick={() => setOpen(true)}>{t('common.save')}</button>
      {open && q.data && (
        <FormDialog open onClose={() => setOpen(false)} testid="cr-dialog" title={t('contractorRules.title')} busy={set.isPending} error={set.isError && !Object.keys(errs).length ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ version: q.data.version, body: {
            reason, safety_cert_lead_days: n, recipient_roles: list(v.roles), cw_delivery_scopes: v.scopes, internal_team_types: list(v.internal), closed_order_statuses: list(v.closed),
          } }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setF(null); } })} />
      )}
    </section>
  );
}
