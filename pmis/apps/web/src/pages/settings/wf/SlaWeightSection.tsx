import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRemoveSlaRule, useSaveSlaRule, useSetEstimate, useSetWeight, type SlaRuleInput, type WeightTotal } from '../../../api/workflowEditor';
import { groupWarnings, type WeightState } from './slaWeightModel';

type Props = {
  version: number; etag: number; code: string; canEdit: boolean; why?: string | null;
  sla?: { min: number; max: number; rule_id?: string; unit?: 'working' | 'calendar'; start_event?: string; calendar_code?: string; warning_pct?: number | null;
    breach_owner_role?: string | null; escalation_role?: string | null; pause_on_client_wait?: boolean };
  weight: WeightState; totals: WeightTotal[];
  /** Migration 0542: estimated man-days / planned duration and the group-share weight they suggest (advice only). */
  estimate?: { man_days: number | null; duration: number | null; suggested: number | null };
  /** What the live version holds (the Studio): a saved value that differs shows an amber "Changed from X". */
  base?: { min?: number; max?: number; start_event?: string; weight?: number } | null;
};

/** F14 (migration 0099): the SLA and the project weight of a task, inside the workflow editor. Draft and published versions save; a draft warns when a weight group is not 100. */
export function SlaWeightSection(p: Props) {
  const { t } = useTranslation();
  const saveSla = useSaveSlaRule(p.version, p.etag), removeSla = useRemoveSlaRule(p.version, p.etag), setWeight = useSetWeight(p.version, p.etag), setEstimate = useSetEstimate(p.version, p.etag);
  const [sla, setSla] = useState<SlaRuleInput>({
    min_working_days: p.sla?.min ?? 0, max_working_days: p.sla?.max ?? 0, start_event: p.sla?.start_event ?? 'PRED', unit: p.sla?.unit ?? 'working',
    calendar_code: p.sla?.calendar_code ?? 'default', warning_pct: p.sla?.warning_pct ?? null, breach_owner_role: p.sla?.breach_owner_role ?? '',
    escalation_role: p.sla?.escalation_role ?? '', pause_on_client_wait: p.sla?.pause_on_client_wait ?? false, reason: '',
  });
  const [w, setW] = useState<WeightState & { reason: string }>({ ...p.weight, reason: '' });
  const [est, setEst] = useState<{ man_days: number | null; duration: number | null }>({ man_days: p.estimate?.man_days ?? null, duration: p.estimate?.duration ?? null });
  const [reason, setReason] = useState('');
  const warnings = groupWarnings(p.totals, p.weight, { counts: w.counts, value: w.counts ? w.value : 0, group: w.group });
  const disabled = !p.canEdit;
  const onlyWhy = p.canEdit ? undefined : p.why ?? undefined;
  const clean = (x: string | null | undefined) => (x && x.trim() ? x.trim() : null);
  const valid = reason.trim().length >= 3;
  const was = (key: string, now: unknown, old: unknown) => (p.base && old !== undefined && now !== undefined && String(now) !== String(old)
    ? <span className="mt-1 block rounded bg-waitBg px-1.5 py-0.5 text-xs font-normal text-waitInk" data-testid={`wfe-changed-${key}`}>{t('studio.changed_from', { value: String(old) })}</span> : null);
  return (
    <div className="space-y-2 rounded border border-line p-2" data-testid="wfe-sla-weight">
      <p className="text-sm font-semibold">{t('wfe.sla_section.title')}</p>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <label>{t('wfe.sla_section.min')}<input className="input" dir="ltr" type="number" min={0} max={365} data-testid="wfe-sla-min" disabled={disabled} title={onlyWhy} value={sla.min_working_days} onChange={(e) => setSla({ ...sla, min_working_days: Number(e.target.value) })} />{was('min', p.sla?.min, p.base?.min)}</label>
        <label>{t('wfe.sla_section.max')}<input className="input" dir="ltr" type="number" min={0} max={365} data-testid="wfe-sla-max" disabled={disabled} title={onlyWhy} value={sla.max_working_days} onChange={(e) => setSla({ ...sla, max_working_days: Number(e.target.value) })} />{was('max', p.sla?.max, p.base?.max)}</label>
        <label>{t('wfe.sla_section.unit')}<select className="input" data-testid="wfe-sla-unit" disabled={disabled} value={sla.unit} onChange={(e) => setSla({ ...sla, unit: e.target.value as 'working' | 'calendar' })}>
          <option value="working">{t('wfe.sla_section.unit_working')}</option><option value="calendar">{t('wfe.sla_section.unit_calendar')}</option></select></label>
        <label>{t('wfe.sla_section.start')}<select className="input" data-testid="wfe-sla-start" disabled={disabled} value={sla.start_event} onChange={(e) => setSla({ ...sla, start_event: e.target.value })}>
          <option value="PRED">{t('wfe.sla_section.start_pred')}</option><option value="OPEN">{t('wfe.sla_section.start_open')}</option>
          {sla.start_event !== 'PRED' && sla.start_event !== 'OPEN' && <option value={sla.start_event}>{t('wfe.sla_section.start_gate')} {sla.start_event}</option>}</select>{was('start', p.sla?.start_event, p.base?.start_event)}</label>
        <label>{t('wfe.sla_section.warning')}<input className="input" dir="ltr" type="number" min={0} max={100} data-testid="wfe-sla-warning" disabled={disabled} value={sla.warning_pct ?? ''} onChange={(e) => setSla({ ...sla, warning_pct: e.target.value === '' ? null : Number(e.target.value) })} /></label>
        <label>{t('wfe.sla_section.owner')}<input className="input" data-testid="wfe-sla-owner" disabled={disabled} value={sla.breach_owner_role ?? ''} onChange={(e) => setSla({ ...sla, breach_owner_role: e.target.value })} /></label>
        <label>{t('wfe.sla_section.escalation')}<input className="input" data-testid="wfe-sla-escalation" disabled={disabled} value={sla.escalation_role ?? ''} onChange={(e) => setSla({ ...sla, escalation_role: e.target.value })} /></label>
        <label className="flex items-center gap-2"><input type="checkbox" data-testid="wfe-sla-pause" disabled={disabled} checked={sla.pause_on_client_wait} onChange={(e) => setSla({ ...sla, pause_on_client_wait: e.target.checked })} />{t('wfe.sla_section.pause')}</label>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn" data-testid="wfe-sla-save" disabled={disabled || !valid || sla.min_working_days > sla.max_working_days}
          onClick={() => saveSla.mutate({ code: p.code, ...sla, breach_owner_role: clean(sla.breach_owner_role), escalation_role: clean(sla.escalation_role), reason: reason.trim() })}>{t('wfe.sla_section.save_sla')}</button>
        {p.sla?.rule_id && <button type="button" className="btn" data-testid="wfe-sla-remove" disabled={disabled || !valid} onClick={() => removeSla.mutate({ code: p.code, rule: p.sla!.rule_id!, reason: reason.trim() })}>{t('wfe.sla_section.remove_sla')}</button>}
      </div>
      <p className="text-sm font-semibold pt-2">{t('wfe.sla_section.weight_title')}</p>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <label className="flex items-center gap-2 col-span-2"><input type="checkbox" data-testid="wfe-weight-counts" disabled={disabled} checked={w.counts} onChange={(e) => setW({ ...w, counts: e.target.checked })} />{t('wfe.sla_section.counts')}</label>
        <label>{t('wfe.sla_section.weight_value')}<input className="input" dir="ltr" type="number" min={0} max={100} step={0.001} data-testid="wfe-weight-value" disabled={disabled || !w.counts} value={w.value} onChange={(e) => setW({ ...w, value: Number(e.target.value) })} />{was('weight', p.weight.counts ? p.weight.value : undefined, p.base?.weight)}</label>
        <label>{t('wfe.sla_section.weight_group')}<input className="input" data-testid="wfe-weight-group" disabled={disabled || !w.counts} value={w.group ?? ''} onChange={(e) => setW({ ...w, group: e.target.value.toUpperCase() })} /></label>
      </div>
      {warnings.length > 0 && <ul role="alert" className="text-xs text-lateInk" data-testid="wfe-weight-warn">{warnings.map((x) => <li key={x.group}>{t('wfe.sla_section.warn_group', { group: x.group, total: x.total })}</li>)}</ul>}
      {p.estimate?.suggested != null && <p className="text-xs text-muted" data-testid="wfe-weight-suggested">{t('wfe.sla_section.suggested_weight', { value: p.estimate.suggested })}</p>}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex-1 text-sm">{t('wfe.sla_section.reason')}<input className="input w-full" data-testid="wfe-sla-reason" disabled={disabled} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <button type="button" className="btn" data-testid="wfe-weight-save" disabled={disabled || !valid || (w.counts && (!w.group || w.value < 0 || w.value > 100))}
          onClick={() => setWeight.mutate({ code: p.code, counts_in_weight: w.counts, weight_value: w.counts ? w.value : 0, weight_group: w.counts ? clean(w.group) : null, reason: reason.trim() })}>{t('wfe.sla_section.save_weight')}</button>
      </div>
      <p className="text-sm font-semibold pt-2">{t('wfe.sla_section.estimate_title')}</p>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <label>{t('wfe.sla_section.est_man_days')}<input className="input" dir="ltr" type="number" min={0} step={0.5} data-testid="wfe-est-man-days" disabled={disabled} value={est.man_days ?? ''} onChange={(e) => setEst({ ...est, man_days: e.target.value === '' ? null : Number(e.target.value) })} /></label>
        <label>{t('wfe.sla_section.planned_duration')}<input className="input" dir="ltr" type="number" min={1} data-testid="wfe-est-duration" disabled={disabled} value={est.duration ?? ''} onChange={(e) => setEst({ ...est, duration: e.target.value === '' ? null : Number(e.target.value) })} /></label>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn" data-testid="wfe-estimate-save" disabled={disabled || !valid || (est.duration != null && est.duration < 1) || (est.man_days != null && est.man_days < 0)}
          onClick={() => setEstimate.mutate({ code: p.code, est_man_days: est.man_days, planned_duration_days: est.duration, reason: reason.trim() })}>{t('wfe.sla_section.save_estimate')}</button>
      </div>
    </div>
  );
}
