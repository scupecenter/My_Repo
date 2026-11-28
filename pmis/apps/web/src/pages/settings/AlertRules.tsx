import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAlertRules, useCreateAlertRule, useUpdateAlertRule } from '@/api/settings';
import type { AlertRule, AlertRuleInput } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';
import { QueryFallback } from '@/components/States';

/**
 * Settings, Alerts, Rules (admin only): the generic if/then alert rules (contract 0.15.242, migration 0342; item 13 of the 2026-11-27
 * improvement research). NOTIFICATIONS ONLY: a rule never changes a record, a state or a holder. The database owns the closed kinds,
 * params, audiences and templates; this screen only shapes the form and shows the field errors the database answers.
 */
interface Form {
  id: string | null;
  version: number;
  code: string;
  kind: string;
  register_key: string;
  date_field: string;
  state: string;
  days: string;
  audience: string;
  module: string;
  title_en: string;
  title_ar: string;
  body_en: string;
  body_ar: string;
  link: string;
  enabled: boolean;
  kpi: string;
  op: string;
  value: string;
  locked: boolean;
}

const EMPTY: Form = {
  id: null, version: 0, code: '', kind: 'weekly_status_missing', register_key: '', date_field: '', state: '', days: '7',
  audience: 'system_admin', module: '', title_en: '', title_ar: '', body_en: '', body_ar: '', link: '', enabled: true,
  kpi: '', op: 'above', value: '', locked: false,
};

const toForm = (r: AlertRule): Form => ({
  id: r.id, version: r.version, code: r.code, kind: r.kind,
  register_key: String(r.params.register_key ?? ''), date_field: String(r.params.date_field ?? ''), state: String(r.params.state ?? ''), days: String(r.kind === 'date_approaching' ? (r.params.days_before ?? '7') : (r.params.days ?? '7')),
  audience: String(r.audience.type ?? 'system_admin'), module: String(r.audience.module ?? ''),
  title_en: r.title_en, title_ar: r.title_ar, body_en: r.body_en, body_ar: r.body_ar, link: r.link ?? '', enabled: r.enabled,
  kpi: String(r.params.kpi ?? ''), op: String(r.params.op ?? 'above'), value: r.params.value === undefined ? '' : String(r.params.value), locked: r.locked,
});

const toBody = (f: Form): AlertRuleInput => ({
  code: f.code.trim(),
  kind: f.kind as AlertRuleInput['kind'],
  params: f.kind === 'record_idle' ? { register_key: f.register_key, state: f.state.trim(), days: Number(f.days) }
    : f.kind === 'date_approaching' ? { register_key: f.register_key, date_field: f.date_field, days_before: Number(f.days) }
    : (f.kind === 'advance_unsettled' || f.kind === 'invoice_due_soon') && f.days.trim() !== '' ? { days: Number(f.days) }
    : f.kind === 'kpi_threshold' ? { kpi: f.kpi, op: f.op, value: Number(f.value) } : {},
  audience: f.audience === 'module' ? { type: 'module', module: f.module } : { type: 'system_admin' },
  title_en: f.title_en.trim(), title_ar: f.title_ar.trim(), body_en: f.body_en.trim(), body_ar: f.body_ar.trim(),
  link: f.link.trim() === '' ? null : f.link.trim(),
  enabled: f.enabled,
  locked: f.locked,
});

export function AlertRules() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useAlertRules();
  const create = useCreateAlertRule();
  const update = useUpdateAlertRule();
  const [f, setF] = useState<Form | null>(null);
  const [askReason, setAskReason] = useState(false);
  if (!q.data) return <section className="card p-4" data-testid="page-alert-rules"><QueryFallback queries={[q]} testid="ar-loading" /></section>;

  const { rules, catalogue } = q.data;
  const errs = fieldErrors(create.error ?? update.error);
  const busy = create.isPending || update.isPending;
  const v = f;
  const kindDef = catalogue.kinds.find((k) => k.kind === v?.kind);
  const bad = !v || v.code.trim().length < 2
    || (v.kind === 'record_idle' && (v.register_key === '' || v.state.trim() === '' || !/^[0-9]+$/.test(v.days) || Number(v.days) < 1 || Number(v.days) > 3650))
    || (v.kind === 'date_approaching' && (v.register_key === '' || v.date_field === '' || !/^[0-9]+$/.test(v.days) || Number(v.days) > 365))
    || ((v.kind === 'advance_unsettled' || v.kind === 'invoice_due_soon') && v.days.trim() !== '' && (!/^[0-9]+$/.test(v.days) || Number(v.days) > 365 || (v.kind === 'advance_unsettled' && Number(v.days) < 1)))
    || (v.kind === 'kpi_threshold' && (v.kpi === '' || v.value.trim() === '' || isNaN(Number(v.value)) || Number(v.value) < 0 || Number(v.value) > 100000))
    || (v.audience === 'module' && v.module === '')
    || v.title_en.trim() === '' || v.title_ar.trim() === '' || v.body_en.trim() === '' || v.body_ar.trim() === '';
  const fe = (p: string) => errs[p] ? <p role="alert" className="text-xs text-lateInk">{t(`fieldError.${errs[p]}`, { defaultValue: errs[p] })}</p> : null;
  const save = (reason: string) => {
    if (!v) return;
    // on a field error the dialog closes so the error shows at its field in the form (a modal would hide it)
    if (v.id) update.mutate({ id: v.id, version: v.version, body: { ...toBody(v), reason } }, { onSuccess: () => { toast(t('settings.audited')); setAskReason(false); setF(null); }, onError: () => setAskReason(false) });
    else create.mutate({ ...toBody(v), reason }, { onSuccess: () => { toast(t('settings.audited')); setAskReason(false); setF(null); }, onError: () => setAskReason(false) });
  };
  return (
    <section className="card space-y-3 p-4" data-testid="page-alert-rules">
      <h2 className="font-bold">{t('alertRules.title')}</h2>
      <p className="text-sm text-mute">{t('alertRules.note')}</p>
      <table className="w-full text-sm">
        <thead><tr className="text-start text-mute">
          <th className="p-1 text-start">{t('alertRules.col_code')}</th>
          <th className="p-1 text-start">{t('alertRules.col_kind')}</th>
          <th className="p-1 text-start">{t('alertRules.col_title')}</th>
          <th className="p-1 text-start">{t('alertRules.col_enabled')}</th>
          <th className="p-1 text-start">{t('alertRules.col_locked')}</th>
          <th className="p-1" />
        </tr></thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id} className="border-t border-line" data-testid={`ar-row-${r.code}`}>
              <td className="p-1 font-mono text-xs">{r.code}</td>
              <td className="p-1">{t(`alertRules.kind_${r.kind}`)}</td>
              <td className="p-1">{i18n.language === 'ar' ? r.title_ar : r.title_en}</td>
              <td className="p-1">{r.enabled ? t('common.yes') : t('common.no')}</td>
              <td className="p-1">{r.locked ? t('common.yes') : t('common.no')}</td>
              <td className="p-1"><button className="btn" data-testid={`ar-edit-${r.code}`} onClick={() => setF(toForm(r))}>{t('common.edit')}</button></td>
            </tr>
          ))}
          {rules.length === 0 && <tr><td colSpan={6} className="p-2 text-center text-mute" data-testid="ar-empty">{t('alertRules.empty')}</td></tr>}
        </tbody>
      </table>
      {!v && <button className="btn btn-accent" data-testid="ar-new" onClick={() => setF(EMPTY)}>{t('alertRules.new')}</button>}
      {v && (
        <fieldset className="space-y-3 rounded border border-line p-3" data-testid="ar-form">
          <legend className="text-sm font-semibold">{v.id ? t('alertRules.edit') : t('alertRules.new')}</legend>
          <div className="flex flex-wrap gap-3">
            <label className="text-sm font-semibold">{t('alertRules.code')}
              <input className="input mt-1 font-normal" data-testid="ar-code" value={v.code} disabled={v.id !== null} onChange={(e) => setF({ ...v, code: e.target.value })} /></label>
            <label className="text-sm font-semibold">{t('alertRules.kind')}
              <select className="input mt-1 font-normal" data-testid="ar-kind" value={v.kind} disabled={v.id !== null}
                onChange={(e) => setF({ ...v, kind: e.target.value })}>
                {catalogue.kinds.map((k) => <option key={k.kind} value={k.kind}>{t(`alertRules.kind_${k.kind}`)}</option>)}
              </select></label>
            <label className="text-sm font-semibold">{t('alertRules.audience')}
              <select className="input mt-1 font-normal" data-testid="ar-audience" value={v.audience} onChange={(e) => setF({ ...v, audience: e.target.value })}>
                <option value="system_admin">{t('alertRules.audience_system_admin')}</option>
                <option value="module">{t('alertRules.audience_module')}</option>
              </select></label>
            {v.audience === 'module' && (
              <label className="text-sm font-semibold">{t('alertRules.module')}
                <select className="input mt-1 font-normal" data-testid="ar-module" value={v.module} onChange={(e) => setF({ ...v, module: e.target.value })}>
                  <option value="">{t('registers.choose')}</option>
                  {catalogue.modules.map((m) => <option key={m.key} value={m.key}>{m.name_en}</option>)}
                </select></label>
            )}
          </div>
          {v.kind === 'record_idle' && (
            <div className="flex flex-wrap gap-3">
              <label className="text-sm font-semibold">{t('alertRules.register')}
                <select className="input mt-1 font-normal" data-testid="ar-register" value={v.register_key} onChange={(e) => setF({ ...v, register_key: e.target.value })}>
                  <option value="">{t('registers.choose')}</option>
                  {catalogue.registers.map((r) => <option key={r.register_key} value={r.register_key}>{i18n.language === 'ar' && r.name_ar ? r.name_ar : r.name_en}</option>)}
                </select></label>
              <label className="text-sm font-semibold">{t('alertRules.state')}
                <input className="input mt-1 w-36 font-normal" data-testid="ar-state" value={v.state} onChange={(e) => setF({ ...v, state: e.target.value })} /></label>
              <label className="text-sm font-semibold">{t('alertRules.days')}
                <input type="number" min={1} max={3650} className="input mt-1 w-28 font-normal" data-testid="ar-days" value={v.days} onChange={(e) => setF({ ...v, days: e.target.value })} /></label>
            </div>
          )}
          {v.kind === 'date_approaching' && (
            <div className="flex flex-wrap gap-3">
              <label className="text-sm font-semibold">{t('alertRules.register')}
                <select className="input mt-1 font-normal" data-testid="ar-register" value={v.register_key} onChange={(e) => setF({ ...v, register_key: e.target.value, date_field: '' })}>
                  <option value="">{t('registers.choose')}</option>
                  {catalogue.registers.filter((r) => (catalogue.date_fields ?? []).some((d) => d.register_key === r.register_key)).map((r) => <option key={r.register_key} value={r.register_key}>{i18n.language === 'ar' && r.name_ar ? r.name_ar : r.name_en}</option>)}
                </select></label>
              <label className="text-sm font-semibold">{t('alertRules.date_field')}
                <select className="input mt-1 font-normal" data-testid="ar-date-field" value={v.date_field} onChange={(e) => setF({ ...v, date_field: e.target.value })}>
                  <option value="">{t('registers.choose')}</option>
                  {(catalogue.date_fields ?? []).filter((d) => d.register_key === v.register_key).map((d) => <option key={d.code} value={d.code}>{i18n.language === 'ar' && d.label_ar ? d.label_ar : d.label_en}</option>)}
                </select></label>
              <label className="text-sm font-semibold">{t('alertRules.days_before')}
                <input type="number" min={0} max={365} className="input mt-1 w-28 font-normal" data-testid="ar-days" value={v.days} onChange={(e) => setF({ ...v, days: e.target.value })} /></label>
            </div>
          )}
          {(v.kind === 'advance_unsettled' || v.kind === 'invoice_due_soon') && (
            <label className="block text-sm font-semibold">{t('alertRules.days')}
              <input type="number" min={v.kind === 'advance_unsettled' ? 1 : 0} max={365} className="input mt-1 w-28 font-normal" data-testid="ar-days" placeholder={v.kind === 'advance_unsettled' ? t('alertRules.days_hub') : '7'} value={v.days} onChange={(e) => setF({ ...v, days: e.target.value })} /></label>
          )}
          {v.kind === 'kpi_threshold' && (
            <div className="flex flex-wrap gap-3">
              <label className="text-sm font-semibold">{t('alertRules.kpi')}
                <select className="input mt-1 font-normal" data-testid="ar-kpi" value={v.kpi} onChange={(e) => setF({ ...v, kpi: e.target.value })}>
                  <option value="">{t('registers.choose')}</option>
                  {catalogue.kpis.map((k) => <option key={k.code} value={k.code}>{i18n.language === 'ar' ? k.label_ar : k.label_en} ({k.unit})</option>)}
                </select></label>
              <label className="text-sm font-semibold">{t('alertRules.op')}
                <select className="input mt-1 font-normal" data-testid="ar-op" value={v.op} onChange={(e) => setF({ ...v, op: e.target.value })}>
                  <option value="above">{t('alertRules.op_above')}</option>
                  <option value="below">{t('alertRules.op_below')}</option>
                </select></label>
              <label className="text-sm font-semibold">{t('alertRules.value')}
                <input type="number" min={0} max={100000} step="any" className="input mt-1 w-28 font-normal" data-testid="ar-value" value={v.value} onChange={(e) => setF({ ...v, value: e.target.value })} /></label>
            </div>
          )}
          {kindDef && <p className="text-xs text-mute">{t(`alertRules.kind_${v.kind}_help`)}</p>}
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm font-semibold">{t('alertRules.title_en')}
              <input className="input mt-1 font-normal" data-testid="ar-title_en" dir="ltr" value={v.title_en} onChange={(e) => setF({ ...v, title_en: e.target.value })} /></label>
            <label className="text-sm font-semibold">{t('alertRules.title_ar')}
              <input className="input mt-1 font-normal" data-testid="ar-title_ar" dir="rtl" value={v.title_ar} onChange={(e) => setF({ ...v, title_ar: e.target.value })} /></label>
            <label className="text-sm font-semibold">{t('alertRules.body_en')}
              <textarea className="input mt-1 font-normal" rows={2} data-testid="ar-body_en" dir="ltr" value={v.body_en} onChange={(e) => setF({ ...v, body_en: e.target.value })} /></label>
            <label className="text-sm font-semibold">{t('alertRules.body_ar')}
              <textarea className="input mt-1 font-normal" rows={2} data-testid="ar-body_ar" dir="rtl" value={v.body_ar} onChange={(e) => setF({ ...v, body_ar: e.target.value })} /></label>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm font-semibold">{t('alertRules.link')}
              <input className="input mt-1 w-64 font-normal" data-testid="ar-link" dir="ltr" placeholder="/registers/issues" value={v.link} onChange={(e) => setF({ ...v, link: e.target.value })} /></label>
            <label className="mt-5 flex items-center gap-2 text-sm font-semibold">
              <input type="checkbox" data-testid="ar-enabled" checked={v.enabled} onChange={(e) => setF({ ...v, enabled: e.target.checked })} />{t('alertRules.enabled')}</label>
            <label className="mt-5 flex items-center gap-2 text-sm font-semibold">
              <input type="checkbox" data-testid="ar-locked" checked={v.locked} onChange={(e) => setF({ ...v, locked: e.target.checked })} />{t('alertRules.locked')}</label>
          </div>
          {['/code', '/kind', '/params/register_key', '/params/date_field', '/params/days_before', '/params/state', '/params/days', '/params/kpi', '/params/op', '/params/value', '/audience', '/title_en', '/title_ar', '/body_en', '/body_ar', '/link', '/locked'].map((p) => <span key={p}>{fe(p)}</span>)}
          <div className="flex gap-2">
            <button className="btn btn-accent" data-testid="ar-save" disabled={bad || busy} onClick={() => setAskReason(true)}>{t('common.save')}</button>
            <button className="btn" data-testid="ar-cancel" onClick={() => setF(null)}>{t('common.cancel')}</button>
          </div>
        </fieldset>
      )}
      {askReason && (
        <FormDialog open onClose={() => setAskReason(false)} testid="ar-dialog" title={t('alertRules.title')} busy={busy}
          error={(create.isError || update.isError) && !Object.keys(errs).length ? errText((create.error ?? update.error)!, t) : null}
          onSubmit={save} />
      )}
    </section>
  );
}
