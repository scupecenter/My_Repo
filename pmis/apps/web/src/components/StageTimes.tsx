import { useTranslation } from 'react-i18next';
import { useStageTimesReport, useSiteStageTimes } from '@/api/x';
import { ErrorState, LoadingSkeleton } from '@/components/States';

/**
 * Time in stage (contract 0.15.482, migration 0623). Read only. A stage runs from its first start to the approval of its last counted task that applies;
 * days are calendar days and an open stage counts up to today. The bars are scaled to the slowest stage shown; the server decides what a caller may see.
 */
const bar = (v: number, max: number) => `${Math.max(2, Math.round((v / Math.max(max, 1)) * 100))}%`;

export function SiteStageTimes({ siteId }: { siteId: string }) {
  const { t, i18n } = useTranslation();
  const q = useSiteStageTimes(siteId);
  const ar = i18n.language === 'ar';
  if (q.isLoading) return <LoadingSkeleton rows={4} testid="st-loading" />;
  if (q.isError || !q.data) return <ErrorState onRetry={() => void q.refetch()} testid="st-error" />;
  const rows = q.data.stages;
  const max = Math.max(0, ...rows.map((r) => r.days ?? 0));
  const ranked = [...rows].filter((r) => r.rank != null).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  return (
    <section className="card space-y-3 p-4" data-testid="site-stage-times" aria-label={t('stageTimes.title')}>
      <header>
        <h2 className="text-lg font-bold" title={t('stageTimes.tip')}>{t('stageTimes.title')}</h2>
        <p className="text-xs text-mute">{t('stageTimes.note')}</p>
      </header>
      {ranked[0] && <p className="text-sm" data-testid="st-slowest">{t('stageTimes.slowest', { name: ar && ranked[0].name_ar ? ranked[0].name_ar : ranked[0].name_en, days: ranked[0].days ?? 0 })}</p>}
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.code} data-testid={`st-row-${r.code}`}>
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="font-semibold">{r.code} · {ar && r.name_ar ? r.name_ar : r.name_en}</span>
              <span className="text-mute">
                {t(`stageTimes.state_${r.state}`)}
                {r.days != null && ` · ${t('stageTimes.days', { count: r.days })}`}
                {r.planned_days != null && ` · ${t('stageTimes.planned', { count: r.planned_days })}`}
                {r.rank != null && ` · #${r.rank}`}
              </span>
            </div>
            {r.days != null && (
              <div className="mt-1 h-2 rounded bg-card2" aria-hidden="true">
                <div className={`h-2 rounded ${r.state === 'open' ? 'bg-warn' : 'bg-accent'}`} style={{ width: bar(r.days, max) }} />
              </div>
            )}
            {(r.over_plan_days ?? 0) > 0 && <p className="text-xs text-danger" data-testid={`st-over-${r.code}`}>{t('stageTimes.over', { count: r.over_plan_days ?? 0 })}</p>}
          </li>
        ))}
        {rows.length === 0 && <li className="text-sm text-mute" data-testid="st-empty">{t('stageTimes.empty')}</li>}
      </ul>
    </section>
  );
}

export function StageTimesRanking({ region }: { region: string }) {
  const { t, i18n } = useTranslation();
  const q = useStageTimesReport(region);
  const ar = i18n.language === 'ar';
  if (q.isLoading) return <LoadingSkeleton rows={3} testid="str-loading" />;
  if (q.isError || !q.data) return <ErrorState onRetry={() => void q.refetch()} testid="str-error" />;
  const d = q.data;
  const nm = (x: { name_en: string; name_ar?: string | null }) => (ar && x.name_ar ? x.name_ar : x.name_en);
  return (
    <section aria-label={t('stageTimes.rank_title')} data-testid="stage-times-ranking">
      <h2 className="mb-1 font-bold" title={t('stageTimes.tip')}>{t('stageTimes.rank_title')}</h2>
      <p className="mb-2 text-xs text-mute">{t('stageTimes.rank_note')}</p>
      <table className="w-full text-sm">
        <thead><tr className="text-mute">
          <th className="p-1 text-start">#</th><th className="p-1 text-start">{t('stageTimes.col_stage')}</th><th className="p-1 text-start">{t('stageTimes.col_done')}</th>
          <th className="p-1 text-start">{t('stageTimes.col_avg')}</th><th className="p-1 text-start">{t('stageTimes.col_p85')}</th><th className="p-1 text-start">{t('stageTimes.col_worst')}</th>
          <th className="p-1 text-start">{t('stageTimes.col_open')}</th>
        </tr></thead>
        <tbody>
          {d.stages.map((s) => (
            <tr key={s.code} className="border-t border-line" data-testid={`str-row-${s.code}`}>
              <td className="p-1">{s.rank ?? '—'}</td><td className="p-1">{s.code} · {nm(s)}</td><td className="p-1">{s.finished}</td>
              <td className="p-1">{s.avg_days ?? '—'}</td><td className="p-1">{s.p85_days ?? '—'}</td><td className="p-1">{s.worst_days ?? '—'}</td>
              <td className="p-1">{s.open}{s.open_avg_days != null ? ` (${t('stageTimes.avg_age', { days: s.open_avg_days })})` : ''}</td>
            </tr>
          ))}
          {d.stages.length === 0 && <tr><td colSpan={7} className="p-2 text-center text-mute" data-testid="str-empty">{t('stageTimes.empty')}</td></tr>}
        </tbody>
      </table>
      {d.slowest_sites.length > 0 && (
        <>
          <h3 className="mt-3 text-sm font-semibold">{t('stageTimes.slow_sites')}</h3>
          <ul className="mt-1 grid gap-1 text-sm md:grid-cols-2" data-testid="str-sites">
            {d.slowest_sites.slice(0, 10).map((w) => <li key={`${w.site_id}-${w.code}`}>{w.site_code} · {nm(w)}: {t('stageTimes.days', { count: w.days })}{w.open ? ` · ${t('stageTimes.state_open')}` : ''}</li>)}
          </ul>
        </>
      )}
    </section>
  );
}
