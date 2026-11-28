import { useTranslation } from 'react-i18next';
import type { components } from '@/api/schema';
import { buildGantt, pos } from '@/lib/gantt';

type SiteDetail = components['schemas']['SiteDetail'];

/** Read-only timeline of the stages: baseline (hollow), planned (outline) and actual (filled) dates, the dependency between each stage and the one it waits for, and a line for today. No editing: a date changes only through the existing change and approval flow. */
export function SiteGantt({ site, today }: { site: SiteDetail; today?: string }) {
  const { t, i18n } = useTranslation();
  const m = buildGantt(site.pipeline, today ?? new Date().toISOString().slice(0, 10));
  if (!m) return null;
  const nm = (n: { name_en: string; name_ar?: string | null }) => (i18n.language === 'ar' && n.name_ar) || n.name_en;
  const dot = (d: number | null, cls: string, label: string) => d === null ? null : (
    <span key={label} title={label} className={`absolute top-1/2 z-10 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ${cls}`} style={{ left: `${pos(m, d)}%` }} />
  );
  const conflicts = m.deps.filter((d) => d.conflict).length;
  const depOf = (code: string) => m.deps.find((d) => d.to === code);
  const crit = m.critical;
  const isCrit = (code: string) => crit.codes.includes(code);
  const iso = (d: number) => new Date(d * 86_400_000).toISOString().slice(0, 10);
  const driverRow = crit.driver ? m.rows.find((r) => r.code === crit.driver) : null;
  return (
    <details className="card my-3 p-3" data-testid="site-gantt">
      <summary className="cursor-pointer text-sm font-semibold">
        {t('gantt.title')}
        {conflicts > 0 && <span className="ms-2 rounded bg-late/10 px-1.5 py-0.5 text-xs font-normal text-late" data-testid="gantt-conflicts">{t('gantt.conflicts', { count: conflicts })}</span>}
      </summary>
      <p className="mb-2 mt-1 text-xs text-mute">{t('gantt.legend')}</p>
      {crit.finish !== null && crit.codes.length > 0 && (
        <p className="mb-2 rounded border border-line bg-card2 px-2 py-1 text-xs" data-testid="gantt-critical-summary" title={t('gantt.critical_tip')}>
          <span className="font-semibold">{t('gantt.critical')}</span>{' '}
          {t('gantt.critical_finish', { date: iso(crit.finish), count: crit.codes.length })}
          {crit.varianceDays !== null && <> {t(crit.varianceDays > 0 ? 'gantt.critical_late' : 'gantt.critical_ontime', { days: Math.abs(crit.varianceDays) })}</>}
          {driverRow && <> {t('gantt.critical_driver', { name: nm(driverRow.node), days: crit.added[driverRow.code] })}</>}
        </p>
      )}
      <div className="relative">
        <ul className="space-y-1">
          {m.rows.map((r) => {
            const dep = depOf(r.code);
            const lo = dep ? Math.min(pos(m, dep.fromDay), pos(m, dep.toDay)) : 0;
            const hi = dep ? Math.max(pos(m, dep.fromDay), pos(m, dep.toDay)) : 0;
            return (
              <li key={r.code} className="flex items-center gap-2 text-sm" data-testid={`gantt-row-${r.code}`} data-critical={isCrit(r.code) ? 'true' : 'false'}>
                <span className={`w-40 shrink-0 truncate ${isCrit(r.code) ? 'border-s-2 border-late ps-1 font-semibold' : ''}`} title={isCrit(r.code) ? t('gantt.critical_row') : undefined}>{nm(r.node)}</span>
                <span className="relative h-5 flex-1 rounded bg-card2" dir="ltr">
                  {dep && (
                    <span
                      data-testid={`gantt-dep-${r.code}`}
                      data-conflict={dep.conflict ? 'true' : 'false'}
                      title={dep.conflict ? t('gantt.dep_conflict') : t('gantt.dep_ok')}
                      className={`absolute top-1/2 h-0.5 -translate-y-1/2 ${dep.conflict ? 'bg-late' : 'bg-accent/40'}`}
                      style={{ left: `${lo}%`, width: `${hi - lo}%` }}
                    />
                  )}
                  {dot(r.baseline, 'border-2 border-mute bg-card', t('gantt.baseline'))}
                  {dot(r.planned, 'border-2 border-accent bg-card', t('gantt.planned'))}
                  {dot(r.actual, 'bg-accent', t('gantt.actual'))}
                </span>
              </li>
            );
          })}
        </ul>
        {m.today !== null && (
          <div className="pointer-events-none absolute inset-y-0 end-0 start-[10.5rem]" aria-hidden="true">
            <span data-testid="gantt-today" title={t('gantt.today')} className="absolute inset-y-0 w-px bg-late" style={{ left: `${pos(m, m.today)}%` }}>
              <span className="absolute -top-4 -translate-x-1/2 rounded bg-late px-1 text-[10px] leading-4 text-white">{t('gantt.today')}</span>
            </span>
          </div>
        )}
      </div>
    </details>
  );
}
