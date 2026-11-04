import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RULES_WITH_SEVERITY, SEVERITIES, useAlertSettings, useSetAlertSettings, type AlertSettings, type Severity } from '@/api/logs';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';

const rank = (s: string | undefined) => SEVERITIES.indexOf((s ?? 'low') as Severity);
const CIDR = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$|^[0-9a-f:]+\/\d{1,3}$/i;

/** True when the change lowers a protection (the server then asks for a step-up and raises `alert_settings_weakened`). */
export function weakens(cur: AlertSettings, sev: Record<string, Severity>, floor: Severity, nets: string[]): boolean {
  return rank(floor) > rank(cur.email_min_severity)
    || Object.entries(sev).some(([k, v]) => rank(v) < rank((cur.severity as Record<string, string> | undefined)?.[k]))
    || nets.some((n) => !(cur.trusted_networks ?? []).includes(n));
}

/**
 * Alert rules (owner answers Q167 and Q168, contract 0.12.3): the severity of each rule, the lowest severity that is mailed to the System Admins, and
 * the trusted networks that soften a new-address alert by one level. The thresholds of 0.10.0 are sent back unchanged.
 */
export function AlertRules() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useAlertSettings(), set = useSetAlertSettings();
  const [edit, setEdit] = useState<{ sev: Record<string, Severity>; floor: Severity; nets: string } | null>(null);
  const [open, setOpen] = useState(false);
  const cur = q.data;
  if (!cur) return null;
  const v = edit ?? { sev: { ...(cur.severity as Record<string, Severity>) }, floor: (cur.email_min_severity ?? 'low') as Severity, nets: (cur.trusted_networks ?? []).join('\n') };
  const nets = v.nets.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  const badNets = nets.filter((n) => !CIDR.test(n));
  const weaker = weakens(cur, v.sev, v.floor, nets);
  return (
    <section className="card space-y-3 p-4" aria-labelledby="alert-rules-h" data-testid="alert-rules">
      <h2 id="alert-rules-h" className="font-bold">{t('rules.title')}</h2>
      <p className="text-sm text-mute">{t('rules.hint')}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {RULES_WITH_SEVERITY.map((r) => (
          <label key={r} className="flex items-center justify-between gap-2 text-sm">
            <span className="mono text-xs" dir="ltr">{r}</span>
            <select className="input w-36" data-testid={`rules-sev-${r}`} value={v.sev[r] ?? 'medium'} onChange={(e) => setEdit({ ...v, sev: { ...v.sev, [r]: e.target.value as Severity } })}>
              {SEVERITIES.map((s) => <option key={s} value={s}>{t(`logs.sev_${s}`)}</option>)}
            </select>
          </label>))}
      </div>
      <p className="text-xs text-mute">{t('rules.mandatory')}</p>
      <label className="block text-sm font-semibold">{t('rules.floor')}
        <select className="input mt-1 w-48 font-normal" data-testid="rules-floor" value={v.floor} onChange={(e) => setEdit({ ...v, floor: e.target.value as Severity })}>
          {SEVERITIES.map((s) => <option key={s} value={s}>{t(`logs.sev_${s}`)}</option>)}
        </select></label>
      <label className="block text-sm font-semibold">{t('rules.networks')}
        <textarea className="input mono mt-1 min-h-16 font-normal" dir="ltr" data-testid="rules-networks" value={v.nets} placeholder="10.20.0.0/16" onChange={(e) => setEdit({ ...v, nets: e.target.value })} />
        <span className="text-xs font-normal text-mute">{t('rules.networks_hint')}</span></label>
      {badNets.length > 0 && <p role="alert" className="text-sm text-lateInk" data-testid="rules-bad-net" dir="ltr">{t('rules.bad_net')} {badNets.join(', ')}</p>}
      {weaker && <p role="alert" className="rounded-md bg-waitBg p-2 text-sm text-waitInk" data-testid="rules-weaker">{t('rules.weaker')}</p>}
      <button className="btn btn-accent" data-testid="rules-save" disabled={!edit || badNets.length > 0} onClick={() => setOpen(true)}>{t('common.save')}</button>
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="rules-dialog" title={t('rules.title')} busy={set.isPending} error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({
            version: cur.version,
            body: { reason, failed_sign_ins: cur.failed_sign_ins, failed_by_ip: cur.failed_by_ip, large_export_rows: cur.large_export_rows, new_ip: cur.new_ip, severity: v.sev, email_min_severity: v.floor, trusted_networks: nets },
          }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setEdit(null); } })}>
          {weaker && <p className="text-sm text-mute">{t('rules.weaker')}</p>}
        </FormDialog>
      )}
    </section>
  );
}
