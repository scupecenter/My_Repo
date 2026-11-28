import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { useCapacityPlan } from '@/api/settings';
import { useRegions } from '@/api/sites';
import type { CapacityCell } from '@/api/types';
import { PageHeader, Toolbar } from '@/components/PageHeader';
import { EmptyState, ErrorState, LoadingSkeleton, NoPermission } from '@/components/States';

const TONE: Record<CapacityCell['status'], string> = { none: 'bg-card2 text-mute', ok: 'bg-openBg text-openInk', tight: 'bg-waitBg text-waitInk', over: 'bg-lateBg text-lateInk' };

/** Short date of a week's Monday, in the language of the page. */
const weekLabel = (d: string, lang: string) => new Intl.DateTimeFormat(lang === 'ar' ? 'ar-LY' : 'en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));

/**
 * Capacity planning (migration 0666, contract 0.15.595): per region and skill, the days the crews can work each week against the days the open tasks
 * need. Green up to 85 %, amber up to 100 %, red above. The crews, skills and efforts come from Settings > Screens > Capacity planning.
 */
export function Capacity() {
  const { t, i18n } = useTranslation();
  const [region, setRegion] = useState('');
  const regions = useRegions();
  const q = useCapacityPlan(region);
  const lang = i18n.language;
  const body = () => {
    if (q.isLoading) return <LoadingSkeleton testid="capacity-loading" />;
    if (q.error instanceof ApiError && q.error.status === 403) return <NoPermission testid="capacity-forbidden" />;
    if (q.isError || !q.data) return <ErrorState onRetry={() => void q.refetch()} testid="capacity-error" />;
    const p = q.data;
    if (!p.regions.length) return <EmptyState title={t('capacity.empty')} hint={t('capacity.empty_hint')} testid="capacity-empty" />;
    return (
      <div className="space-y-4">
        <p className="flex flex-wrap gap-2 text-xs" data-testid="capacity-legend">
          {(['ok', 'tight', 'over'] as const).map((s) => <span key={s} className={`chip ${TONE[s]}`}>{t(`capacity.status_${s}`)}</span>)}
          {p.undated_tasks > 0 && <span className="chip bg-card2 text-mute" data-testid="capacity-undated">{t('capacity.undated', { n: p.undated_tasks })}</span>}
        </p>
        {p.regions.map((r) => (
          <section key={r.region_id} className="card overflow-x-auto p-3" data-testid={`capacity-region-${r.region_id}`}>
            <h2 className="mb-2 font-bold">{(lang === 'ar' && r.name_ar) || r.name_en} <span className="text-xs font-normal text-mute">{t('capacity.crews', { n: r.crews })}</span></h2>
            <table className="w-full text-sm">
              <thead><tr><th scope="col" className="p-1 text-start">{t('capacity.skill')}</th>{p.weeks.map((w) => <th key={w} scope="col" className="p-1 text-center text-xs font-semibold text-mute">{weekLabel(w, lang)}</th>)}</tr></thead>
              <tbody>
                {r.skills.map((s) => (
                  <tr key={s.skill} data-testid={`capacity-row-${r.region_id}-${s.skill}`}>
                    <th scope="row" className="p-1 text-start font-semibold">{(lang === 'ar' && s.name_ar) || s.name_en}</th>
                    {s.cells.map((c, i) => (
                      <td key={i} className="p-1 text-center">
                        <span className={`chip w-full justify-center ${TONE[c.status]}`} data-testid={`capacity-cell-${r.region_id}-${s.skill}-${i}`} data-status={c.status}
                          title={t('capacity.cell_tip', { demand: c.demand_days, capacity: c.capacity_days })}>
                          {c.status === 'none' ? '-' : c.load_pct === null ? t('capacity.no_crew') : `${c.load_pct}%`}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
                {r.unestimated.some((n) => n > 0) && (
                  <tr data-testid={`capacity-unest-${r.region_id}`}>
                    <th scope="row" className="p-1 text-start text-xs font-semibold text-mute" title={t('capacity.unest_tip')}>{t('capacity.unest')}</th>
                    {r.unestimated.map((n, i) => <td key={i} className="p-1 text-center text-xs text-mute">{n || ''}</td>)}
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    );
  };
  return (
    <div className="space-y-4" data-testid="page-capacity">
      <PageHeader title={t('capacity.title')} subtitle={t('capacity.subtitle')} settings="capacity" />
      <Toolbar filters={
        <select className="input w-auto" aria-label={t('sites.all_regions')} data-testid="capacity-region" value={region} onChange={(e) => setRegion(e.target.value)}>
          <option value="">{t('sites.all_regions')}</option>
          {(regions.data ?? []).map((r) => <option key={r.id} value={r.id}>{(lang === 'ar' && r.name_ar) || r.name_en}</option>)}
        </select>
      } tools={<Link className="btn" to="/admin/settings/screens/capacity" data-testid="capacity-edit">{t('capacity.edit')}</Link>} />
      {body()}
    </div>
  );
}
