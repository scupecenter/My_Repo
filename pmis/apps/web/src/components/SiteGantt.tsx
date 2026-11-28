import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { components } from '@/api/schema';
import { buildGantt, pos, whatIf } from '@/lib/gantt';

type SiteDetail = components['schemas']['SiteDetail'];

/** Read-only timeline of the stages: baseline (hollow), planned (outline) and actual (filled) dates, the dependency between each stage and the one it waits for, and a line for today. No editing: a date changes only through the existing change and approval flow. */
export function SiteGantt({ site, today }: { site: SiteDetail; today?: string }) {
  const { t, i18n } = useTranslation();
  const m = buildGantt(site.pipeline, today ?? new Date().toISOString().slice(0, 10));
  const [wiCode, setWiCode] = useState('');
  const [wiDays, setWiDays] = useState(0);
  if (!m) return null;
  const wi = wiCode && wiDays !== 0 ? whatIf(m, wiCode, wiDays) : null;
  // the scale widens to hold the moved dates, so the real dates and the ghosts share one ruler
  const sm = wi ? { ...m, min: Math.min(m.min, ...Object.values(wi.moved)), max: Math.max(m.max, ...Object.values(wi.moved)) } : m;
  const movable = m.rows.filter((r) => r.actual === null && (r.actual ?? r.planned ?? r.baseline) !== null);
  const nm = (n: { name_en: string; name_ar?: string | null }) => (i18n.language === 'ar' && n.name_ar) || n.name_en;
  const dot = (d: number | null, cls: string, label: string) => d === null ? null : (
    <span key={label} title={label} className={`absolute top-1/2 z-10 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ${cls}`} style={{ left: `${pos(sm, d)}%` }} />
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
      <div className="mb-2 flex flex-wrap items-end gap-2 rounded border border-dashed border-line p-2 text-xs" data-testid="gantt-whatif" title={t('gantt.whatif_tip')}>
        <span className="font-semibold">{t('gantt.whatif')}</span>
        <label>{t('gantt.whatif_stage')}
          <select className="input ms-1" data-testid="gantt-whatif-stage" value={wiCode} onChange={(e) => setWiCode(e.target.value)}>
            <option value="" />
            {movable.map((r) => <option key={r.code} value={r.code}>{nm(r.node)}</option>)}
          </select>
        </label>
        <label>{t('gantt.whatif_days')}
          <input type="number" className="input ms-1 w-20" data-testid="gantt-whatif-days" min={-365} max={365} value={wiDays} onChange={(e) => setWiDays(Math.max(-365, Math.min(365, Math.trunc(Number(e.target.value) || 0))))} />
        </label>
        <button type="button" className="btn btn-ghost" data-testid="gantt-whatif-reset" disabled={!wiCode && wiDays === 0} onClick={() => { setWiCode(''); setWiDays(0); }}>{t('gantt.whatif_reset')}</button>
        {wi && (
          <span className="basis-full" data-testid="gantt-whatif-result" role="status">
            {t('gantt.whatif_result', { count: Object.keys(wi.moved).length, shift: wi.finishShift > 0 ? `+${wi.finishShift}` : String(wi.finishShift), date: wi.finish === null ? '' : iso(wi.finish) })}
            {wi.varianceDays !== null && <> {t(wi.varianceDays > 0 ? 'gantt.critical_late' : 'gantt.critical_ontime', { days: Math.abs(wi.varianceDays) })}</>}
            {wi.conflicts.length > 0 && <span className="ms-1 text-late" data-testid="gantt-whatif-conflicts">{t('gantt.whatif_conflicts', { count: wi.conflicts.length })}</span>}
            <span className="ms-1 text-mute">{t('gantt.whatif_note')}</span>
          </span>
        )}
      </div>
      <div className="relative">
        <ul className="space-y-1">
          {m.rows.map((r) => {
            const dep = depOf(r.code);
            const lo = dep ? Math.min(pos(sm, dep.fromDay), pos(sm, dep.toDay)) : 0;
            const hi = dep ? Math.max(pos(sm, dep.fromDay), pos(sm, dep.toDay)) : 0;
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
                  {wi?.moved[r.code] !== undefined && (
                    <span data-testid={`gantt-ghost-${r.code}`} title={t('gantt.whatif_ghost')} className="absolute top-1/2 z-10 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-dashed border-late bg-card" style={{ left: `${pos(sm, wi.moved[r.code]!)}%` }} />
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        {m.today !== null && (
          <div className="pointer-events-none absolute inset-y-0 end-0 start-[10.5rem]" aria-hidden="true">
            <span data-testid="gantt-today" title={t('gantt.today')} className="absolute inset-y-0 w-px bg-late" style={{ left: `${pos(sm, m.today)}%` }}>
              <span className="absolute -top-4 -translate-x-1/2 rounded bg-late px-1 text-[10px] leading-4 text-white">{t('gantt.today')}</span>
            </span>
          </div>
        )}
      </div>
    </details>
  );
}
