import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAlertRuleRuns, useAlertRules, useCreateAlertRule } from '@/api/settings';
import type { AlertRule, AlertRuleTemplate } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';
import { fmtDateTime } from '@/lib/time';

/**
 * Settings, Alerts, Automation (admin only): the "when ... do" view over the alert rules (contract 0.15.473, migration 0614). It adds no engine: a
 * rule is an alert rule (0.15.242), the only action is a notification, and a template only creates a normal alert rule through the same call as the
 * Rules screen, with a reason. Runs are done by the system (no actor) and show here and in the Audit Log as `alert_rule_run`.
 */
export function AutomationCentre() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const rules = useAlertRules();
  const runs = useAlertRuleRuns();
  const create = useCreateAlertRule();
  const [pick, setPick] = useState<AlertRuleTemplate | null>(null);
  if (!rules.data) return <section className="card p-4" data-testid="page-automation"><QueryFallback queries={[rules]} testid="au-loading" /></section>;
  const { rules: list, catalogue } = rules.data;
  const ar = i18n.language === 'ar';
  const lastRun = (id: string) => runs.data?.runs.find((r) => r.rule_id === id);
  const regName = (key: string) => { const r = catalogue.registers.find((x) => x.register_key === key); return r ? (ar && r.name_ar ? r.name_ar : r.name_en) : key; };
  const kpiName = (code: string) => { const k = catalogue.kpis.find((x) => x.code === code); return k ? (ar ? k.label_ar : k.label_en) : code; };
  const when = (r: AlertRule) => {
    const p = r.params as Record<string, unknown>;
    return t(`automation.when_${r.kind}`, {
      register: regName(String(p.register_key ?? '')), state: String(p.state ?? ''), days: String(p.days ?? ''), kpi: kpiName(String(p.kpi ?? '')),
      op: t(`alertRules.op_${String(p.op ?? 'above')}`), value: String(p.value ?? ''), min: String(p.min_rows ?? p.min_sites ?? 1), defaultValue: t(`alertRules.kind_${r.kind}`),
    });
  };
  const then = (r: AlertRule) => r.audience.type === 'module'
    ? t('automation.then_module', { module: catalogue.modules.find((m) => m.key === r.audience.module)?.name_en ?? String(r.audience.module ?? '') })
    : t('automation.then_admins');
  const freeCode = (id: string) => { let c = `tpl-${id}`; let i = 2; while (list.some((x) => x.code === c)) { c = `tpl-${id}-${i}`; i += 1; } return c; };
  const add = (reason: string) => {
    if (!pick) return;
    create.mutate({
      code: freeCode(pick.id), kind: pick.kind as never, params: pick.params, audience: pick.audience,
      title_en: pick.title_en, title_ar: pick.title_ar, body_en: pick.body_en, body_ar: pick.body_ar, link: pick.link, enabled: true, reason,
    }, { onSuccess: () => { toast(t('automation.added')); setPick(null); } });
  };
  return (
    <section className="space-y-4" data-testid="page-automation">
      <header className="card space-y-1 p-4">
        <h2 className="text-lg font-bold">{t('automation.title')}</h2>
        <p className="text-sm text-mute">{t('automation.note')}</p>
      </header>

      <div className="card space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">{t('automation.active')}</h3>
          <Link className="btn" to="/admin/settings/alerts/rules" data-testid="au-manage">{t('automation.manage')}</Link>
        </div>
        {list.length === 0 && <p className="text-sm text-mute" data-testid="au-empty">{t('automation.empty')}</p>}
        <ul className="grid gap-3 md:grid-cols-2">
          {list.map((r) => {
            const run = lastRun(r.id);
            return (
              <li key={r.id} className="rounded-lg border border-line p-3" data-testid={`au-rule-${r.code}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-mute">{r.code}</span>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${r.enabled ? 'bg-accent/10 text-accent' : 'bg-card2 text-mute'}`}>{r.enabled ? t('automation.on') : t('automation.off')}{r.locked ? ` · ${t('automation.locked')}` : ''}</span>
                </div>
                <p className="mt-2 text-sm"><span className="font-semibold">{t('automation.when')}</span> {when(r)}</p>
                <p className="text-sm"><span className="font-semibold">{t('automation.then')}</span> {then(r)}</p>
                <p className="mt-2 text-xs text-mute" data-testid={`au-last-${r.code}`}>
                  {run ? t('automation.last_run', { at: fmtDateTime(run.run_at, i18n.language), count: run.fired }) : t('automation.never_run')}
                </p>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="card space-y-3 p-4">
        <h3 className="font-semibold">{t('automation.templates')}</h3>
        <p className="text-xs text-mute">{t('automation.templates_note')}</p>
        <ul className="grid gap-3 md:grid-cols-2">
          {catalogue.templates.map((x) => (
            <li key={x.id} className="flex flex-col justify-between gap-2 rounded-lg border border-dashed border-line p-3" data-testid={`au-tpl-${x.id}`}>
              <div>
                <p className="text-sm font-semibold">{ar ? x.title_ar : x.title_en}</p>
                <p className="text-sm"><span className="font-semibold">{t('automation.when')}</span> {t(`alertRules.kind_${x.kind}`)}</p>
                <p className="text-xs text-mute">{ar ? x.body_ar : x.body_en}</p>
              </div>
              <button className="btn btn-accent self-start" data-testid={`au-use-${x.id}`} onClick={() => setPick(x)}>{t('automation.use')}</button>
            </li>
          ))}
        </ul>
      </div>

      <div className="card space-y-2 p-4">
        <h3 className="font-semibold">{t('automation.runs')}</h3>
        <p className="text-xs text-mute">{t('automation.runs_note')}</p>
        <table className="w-full text-sm">
          <thead><tr className="text-mute">
            <th className="p-1 text-start">{t('automation.col_time')}</th><th className="p-1 text-start">{t('alertRules.col_code')}</th>
            <th className="p-1 text-start">{t('automation.col_fired')}</th><th className="p-1 text-start">{t('automation.col_actor')}</th>
          </tr></thead>
          <tbody>
            {(runs.data?.runs ?? []).map((r) => (
              <tr key={r.id} className="border-t border-line" data-testid={`au-run-${r.id}`}>
                <td className="p-1">{fmtDateTime(r.run_at, i18n.language)}</td>
                <td className="p-1 font-mono text-xs">{r.rule_code}</td>
                <td className="p-1">{r.fired}</td>
                <td className="p-1">{t('automation.system')}</td>
              </tr>
            ))}
            {runs.data && runs.data.runs.length === 0 && <tr><td colSpan={4} className="p-2 text-center text-mute" data-testid="au-no-runs">{t('automation.no_runs')}</td></tr>}
          </tbody>
        </table>
        <Link className="text-xs underline" to="/admin/logs/audit" data-testid="au-audit-link">{t('automation.audit_link')}</Link>
      </div>

      {pick && (
        <FormDialog open onClose={() => setPick(null)} testid="au-dialog" title={t('automation.use_title', { name: ar ? pick.title_ar : pick.title_en })} busy={create.isPending}
          error={create.isError ? errText(create.error, t) : null} onSubmit={add}>
          <p className="text-sm text-mute">{t('automation.use_note', { code: freeCode(pick.id) })}</p>
        </FormDialog>
      )}
    </section>
  );
}
