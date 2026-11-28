import { Snowflake, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRegions } from '@/api/sites';
import { useCreatePlanFreeze, useHidePlanFreeze, usePlanFreezeReport, usePlanFreezes } from '@/api/x';
import { errText } from './FormDialog';
import { EmptyState, ErrorState, LoadingSkeleton } from './States';

const days = (n: number | null | undefined) => (n === null || n === undefined ? '-' : n > 0 ? `+${n}` : String(n));

/**
 * Plan baselines (0.15.480): a System Admin freezes the plan (the approved baseline dates of every site) under a name; anyone with the dashboard view reads
 * the variance of what was done against it, per stage and region, and the worst rows. The official baselines are not touched; nothing here changes a date.
 */
export function PlanBaselines({ region }: { region: string }) {
  const { t, i18n } = useTranslation();
  const list = usePlanFreezes();
  const regions = useRegions();
  const create = useCreatePlanFreeze();
  const hide = useHidePlanFreeze();
  const [pick, setPick] = useState('');
  const [label, setLabel] = useState('');
  const items = list.data?.items ?? [];
  const id = pick || items[0]?.id || '';
  const report = usePlanFreezeReport(id, region);
  const regionName = (rid: number) => { const r = (regions.data ?? []).find((x) => Number(x.id) === rid); return (r && ((i18n.language === 'ar' && r.name_ar) || r.name_en)) || String(rid); };
  if (list.isLoading) return <LoadingSkeleton rows={3} testid="planfreeze-loading" />;
  if (list.isError || !list.data) return <ErrorState onRetry={() => void list.refetch()} />;
  const r = report.data;
  return (
    <section className="card space-y-3 p-3" data-testid="plan-baselines" aria-label={t('planfreeze.title')}>
      <header>
        <h2 className="font-semibold">{t('planfreeze.title')}</h2>
        <p className="text-xs text-mute">{t('planfreeze.subtitle')}</p>
      </header>
      <div className="flex flex-wrap items-end gap-2">
        {items.length > 0 && (
          <label>{t('planfreeze.version')}
            <select className="input ms-1" data-testid="planfreeze-select" value={id} onChange={(e) => setPick(e.target.value)}>
              {items.map((f) => <option key={f.id} value={f.id}>{f.label} ({f.frozen_at.slice(0, 10)})</option>)}
            </select>
          </label>
        )}
        {list.data.can_freeze && (
          <>
            <label title={t('planfreeze.freeze_tip')}>{t('planfreeze.name')}
              <input className="input ms-1" data-testid="planfreeze-label" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <button type="button" className="btn btn-primary" data-testid="planfreeze-create" title={t('planfreeze.freeze_tip')} disabled={create.isPending || label.trim().length === 0}
              onClick={() => create.mutate({ label: label.trim() }, { onSuccess: (x) => { setLabel(''); setPick(x.id); } })}><Snowflake size={14} />{t('planfreeze.freeze')}</button>
            {id && <button type="button" className="btn btn-ghost" data-testid="planfreeze-hide" title={t('planfreeze.hide_tip')} disabled={hide.isPending} onClick={() => hide.mutate(id, { onSuccess: () => setPick('') })}><Trash2 size={14} />{t('planfreeze.hide')}</button>}
          </>
        )}
      </div>
      {(create.isError || hide.isError) && <p role="alert" className="text-sm text-lateInk" data-testid="planfreeze-error">{errText(create.error ?? hide.error, t)}</p>}
      {items.length === 0 && <EmptyState title={t('planfreeze.empty')} />}
      {id && report.isLoading && <LoadingSkeleton rows={3} testid="planfreeze-report-loading" />}
      {id && report.isError && <ErrorState onRetry={() => void report.refetch()} />}
      {r && (
        <div className="space-y-3" data-testid="planfreeze-report">
          <p className="text-sm" data-testid="planfreeze-totals">{t('planfreeze.totals', { rows: r.totals.rows ?? 0, done: r.totals.done ?? 0, late: r.totals.done_late ?? 0, overdue: r.totals.open_overdue ?? 0, avg: days(r.totals.avg_days) })}</p>
          <p className="text-xs text-mute">{t('planfreeze.unit')}</p>
          <table className="w-full text-sm" data-testid="planfreeze-stages">
            <thead><tr className="text-start text-mute"><th className="text-start">{t('planfreeze.stage')}</th><th>{t('planfreeze.done')}</th><th>{t('planfreeze.late')}</th><th>{t('planfreeze.overdue')}</th><th>{t('planfreeze.avg')}</th><th>{t('planfreeze.worst')}</th></tr></thead>
            <tbody>{r.stages.map((s) => (
              <tr key={s.code} data-testid={`planfreeze-stage-${s.code}`}><td>{(i18n.language === 'ar' && s.name_ar) || s.name_en || s.code}</td><td className="text-center">{s.done}/{s.rows}</td><td className="text-center">{s.done_late}</td><td className="text-center">{s.open_overdue}</td><td className="text-center">{days(s.avg_days)}</td><td className="text-center">{days(s.worst_days)}</td></tr>
            ))}</tbody>
          </table>
          <table className="w-full text-sm" data-testid="planfreeze-regions">
            <thead><tr><th className="text-start">{t('planfreeze.region')}</th><th>{t('planfreeze.done')}</th><th>{t('planfreeze.late')}</th><th>{t('planfreeze.overdue')}</th><th>{t('planfreeze.avg')}</th></tr></thead>
            <tbody>{r.regions.map((x) => (
              <tr key={x.region_id}><td>{regionName(x.region_id)}</td><td className="text-center">{x.done}/{x.rows}</td><td className="text-center">{x.done_late}</td><td className="text-center">{x.open_overdue}</td><td className="text-center">{days(x.avg_days)}</td></tr>
            ))}</tbody>
          </table>
          {r.worst.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold">{t('planfreeze.worst_rows')}</h3>
              <ul className="text-sm" data-testid="planfreeze-worst">{r.worst.map((w) => (
                <li key={`${w.site_id}-${w.code}`}>{w.site_code} · {w.code} · {w.base}{w.open ? ` · ${t('planfreeze.still_open')}` : ` → ${w.actual ?? ''}`} · {days(w.days)}</li>
              ))}</ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
