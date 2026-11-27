import { useQueries } from '@tanstack/react-query';
import { ArrowRightLeft, ChevronLeft, ChevronRight, Lock } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useDailyPlan, useDailyPlanOps, type DailyPlanDay } from '@/api/dailyPlan';
import { api } from '@/api/client';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { buildWeek, carryCandidates, dayTotals, shiftWeek, weekDays, type CellState } from '@/lib/weekCycle';

const GLYPH: Record<CellState, string> = { none: '', planned: '●', below: '▲', done: '✓' };
const TONE: Record<CellState, string> = { none: 'text-mute', planned: 'bg-accentSoft text-accentText', below: 'bg-lateBg text-lateInk', done: 'bg-doneBg text-doneInk' };

/** The carry-over of one day: the rows below target that the next working day does not have yet, added there with the daily plan's own add-site call. */
function CarryOver({ from, regions, onClose }: { from: DailyPlanDay; regions: number[]; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const ops = useDailyPlanOps();
  const to = useDailyPlan(from.next_working_day);
  const items = carryCandidates(from, to.data, regions);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canEdit = (region: number) => !!to.data?.plans.find((p) => p.region_id === region)?.can_edit;
  const blocked = items.filter((i) => !canEdit(i.region_id));
  const run = async () => {
    setBusy(true); setError(null);
    let done = 0;
    try {
      // each call returns the new plan version of the day; a later site of the same region uses it
      let cur: DailyPlanDay | undefined = to.data;
      for (const i of items) {
        if (!canEdit(i.region_id)) continue;
        const v = cur?.plans.find((p) => p.region_id === i.region_id)?.version;
        if (v === undefined) continue;
        cur = await ops.add.mutateAsync({ date: from.next_working_day, region: i.region_id, version: v, site_code: i.site_code });
        done++;
      }
      toast(t('week.carried', { n: done }));
      onClose();
    } catch (e) { setError(errText(e, t)); } finally { setBusy(false); }
  };
  return (
    <FormDialog open withReason={false} onClose={onClose} testid="week-carry-dialog" title={t('week.carry_title', { from: from.date, to: from.next_working_day })}
      submitLabel={t('week.carry_do', { n: items.length - blocked.length })} busy={busy} disabled={items.length === 0 || items.length === blocked.length || to.isLoading} error={error} onSubmit={() => void run()}>
      <p className="text-sm text-mute">{t('week.carry_hint')}</p>
      {items.length === 0 ? <p className="text-sm" data-testid="week-carry-none">{t('week.carry_none')}</p> : (
        <ul className="space-y-1 text-sm" data-testid="week-carry-list">
          {items.map((i) => <li key={i.site_id} className="flex items-center gap-2"><b className="mono">{i.site_code}</b>{!canEdit(i.region_id) && <span className="chip bg-lockBg text-lockInk"><Lock size={12} aria-hidden />{t('week.carry_locked')}</span>}</li>)}
        </ul>
      )}
    </FormDialog>
  );
}

/**
 * The weekly cycle plan (item 10): the seven days of the week of My Work > Daily Plan, one row per site, with where each site stands every day
 * (planned, done, below target) and a carry-over per day that adds the rows below target to the next working day. Computed from the daily plans the
 * server returns; the add-site call decides who may edit (L1 of the region, unlocked day), so nothing is widened.
 */
export function WeekCycle({ date, regions, onDate }: { date: string; regions: number[]; onDate: (d: string) => void }) {
  const { t, i18n } = useTranslation();
  const dates = weekDays(date, 0);
  const results = useQueries({ queries: dates.map((d) => ({ queryKey: ['daily-plan', d], queryFn: () => api.get<DailyPlanDay>('/daily-plans', { query: { date: d } }) })) });
  const days: Record<string, DailyPlanDay | undefined> = Object.fromEntries(dates.map((d, i) => [d, results[i]?.data]));
  const today = results.find((r) => r.data)?.data?.today ?? date;
  const rows = buildWeek(dates, days, regions, today);
  const [carry, setCarry] = useState<DailyPlanDay | null>(null);
  const fmt = (d: string) => new Intl.DateTimeFormat(i18n.language.startsWith('ar') ? 'ar-LY-u-nu-latn' : 'en-GB', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
  const loading = results.some((r) => r.isLoading);
  return (
    <section className="card space-y-3 p-3" data-testid="week-cycle" aria-label={t('week.title')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold">{t('week.title')}</h2>
        <span className="inline-flex items-center gap-1">
          <button type="button" className="btn px-2" aria-label={t('week.previous')} data-testid="week-prev" onClick={() => onDate(shiftWeek(date, -1))}><ChevronLeft size={16} className="rtl:rotate-180" aria-hidden /></button>
          <span className="tnum text-sm" dir="ltr" data-testid="week-range">{dates[0]} → {dates[6]}</span>
          <button type="button" className="btn px-2" aria-label={t('week.next')} data-testid="week-next" onClick={() => onDate(shiftWeek(date, 1))}><ChevronRight size={16} className="rtl:rotate-180" aria-hidden /></button>
        </span>
      </div>
      <p className="flex flex-wrap gap-3 text-xs text-mute" data-testid="week-legend">
        {(['planned', 'done', 'below'] as const).map((k) => <span key={k} className="inline-flex items-center gap-1"><span className={`chip ${TONE[k]}`} aria-hidden>{GLYPH[k]}</span>{t(`week.state_${k}`)}</span>)}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="text-mute">
              <th className="p-1 text-start">{t('week.site')}</th>
              {dates.map((d) => {
                const tot = dayTotals(days[d], regions);
                const has = days[d] && carryCandidates(days[d], undefined, regions).length > 0;
                return (
                  <th key={d} className={`p-1 text-center font-semibold ${days[d]?.is_workday === false ? 'opacity-60' : ''}`} data-testid={`week-day-${d}`}>
                    <div className="tnum" dir="ltr">{fmt(d)}</div>
                    <div className="text-xs font-normal tnum">{tot.rows}{tot.below > 0 && <span className="text-lateInk"> · ▲{tot.below}</span>}</div>
                    {has && <button type="button" className="btn mt-1 px-1.5 py-0.5 text-xs" data-testid={`week-carry-${d}`} onClick={() => days[d] && setCarry(days[d]!)}><ArrowRightLeft size={12} className="rtl:rotate-180" aria-hidden />{t('week.carry')}</button>}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.site_id} className="border-t border-line" data-testid={`week-row-${r.site_code}`}>
                <td className="p-1"><Link className="mono font-semibold text-link" to={`/sites/${r.site_id}`}>{r.site_code}</Link>{r.site_name && <span className="ms-2 text-mute">{r.site_name}</span>}</td>
                {dates.map((d) => {
                  const s = r.cells[d] ?? 'none';
                  return <td key={d} className="p-1 text-center" data-testid={`week-cell-${r.site_code}-${d}`} data-state={s}>{s !== 'none' && <span className={`chip ${TONE[s]}`} aria-label={t(`week.state_${s}`)}>{GLYPH[s]}</span>}</td>;
                })}
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="p-3 text-mute" data-testid="week-empty">{loading ? t('common.loading') : t('week.empty')}</td></tr>}
          </tbody>
        </table>
      </div>
      {carry && <CarryOver from={carry} regions={regions} onClose={() => setCarry(null)} />}
    </section>
  );
}
