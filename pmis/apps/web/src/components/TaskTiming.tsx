import { Building2, Hourglass, TimerOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TaskSummary } from '@/api/types';

/**
 * F2 (contract 0.15.30): the timing of a task, read only. Ball in court since when and for how many working days, the SLA overrun in working
 * days ("+N wd late" / "N wd left") in the rule's traffic colour (green up to the minimum, amber up to the maximum, red above), and the stale
 * badge (idle for the stale limit, a setting). Every number comes from the server; nothing here counts days.
 */
const TONE: Record<string, string> = { green: 'bg-doneBg text-doneInk', amber: 'bg-waitBg text-waitInk', red: 'bg-lateBg text-lateInk', none: 'bg-lockBg text-lockInk' };

export function SlaOverrun({ task, testid }: { task: TaskSummary; testid?: string }) {
  const { t } = useTranslation();
  const s = task.sla;
  if (!s || s.measured === false || s.late_wd == null) return null;
  const late = s.late_wd > 0;
  if (!late && s.left_wd == null) return null; // approved within the SLA: nothing to flag
  const text = late ? t('timing.late', { count: s.late_wd }) : t('timing.left', { count: s.left_wd ?? 0 });
  return (
    <span className={`chip ${TONE[s.colour ?? 'none']}`} data-testid={testid ?? `overrun-${task.id}`} data-colour={s.colour} title={t('timing.overrun_title', { min: s.min_wd ?? '–', max: s.max_wd ?? '–', elapsed: s.elapsed_wd ?? '–' })}>
      <bdi dir="auto">{text}</bdi>
    </span>
  );
}

export function BallSince({ task, testid }: { task: TaskSummary; testid?: string }) {
  const { t } = useTranslation();
  const b = task.ball_in_court;
  if (!b || b.held_wd == null) return null;
  const date = b.since ? b.since.slice(0, 10) : '';
  return (
    <span className="inline-flex items-center gap-1 text-xs text-mute" data-testid={testid ?? `ball-since-${task.id}`} title={t('timing.held_title', { date, count: b.held_wd })}>
      <Hourglass size={12} aria-hidden />{t('timing.held', { count: b.held_wd })}{date && <> · <span className="mono" dir="ltr">{date}</span></>}
    </span>
  );
}

export function ExternalParty({ task }: { task: TaskSummary }) {
  const { t } = useTranslation();
  const p = task.ball_in_court?.external_party;
  if (!p) return null;
  return <span className="chip bg-card2 text-ink" data-testid={`ball-party-${task.id}`} title={t('timing.party_title')}><Building2 size={12} className="me-1" aria-hidden />{p.name}</span>;
}

export function StaleBadge({ task, testid }: { task: TaskSummary; testid?: string }) {
  const { t } = useTranslation();
  if (!task.stale) return null;
  return (
    <span className="chip bg-waitBg text-waitInk" data-testid={testid ?? `stale-${task.id}`} title={t('timing.stale_title', { count: task.idle_working_days ?? 0, limit: task.stale_after_wd ?? 2 })}>
      <TimerOff size={12} className="me-1" aria-hidden />{t('timing.stale')}
    </span>
  );
}

/** The people, roles or groups holding the ball now: the claimant when there is one, otherwise the holders of the level. */
export function ballHolders(task: TaskSummary): { id: string; label: string }[] {
  const b = task.ball_in_court;
  if (!b) return [];
  if (b.claimed_by) return [{ id: b.claimed_by.id, label: b.claimed_by.display_name }];
  return b.holders.map((h) => ({ id: h.ref_id, label: h.label }));
}

export type TimingSort = '' | 'held' | 'overrun';
export const TIMING_SORTS: TimingSort[] = ['', 'held', 'overrun'];

/** Longest held first, or most overdue first (late working days, then fewest left); ties keep the server order. */
export function sortByTiming<T>(list: T[], key: TimingSort, of: (x: T) => TaskSummary): T[] {
  if (!key) return list;
  const score = (x: T): number => {
    const t = of(x);
    if (key === 'held') return t.ball_in_court?.held_wd ?? -1;
    const s = t.sla;
    if (!s || s.late_wd == null) return -1e6;
    return s.late_wd > 0 ? s.late_wd * 1000 : -(s.left_wd ?? 0);
  };
  return list.map((x, i) => ({ x, i, s: score(x) })).sort((a, b) => b.s - a.s || a.i - b.i).map((r) => r.x);
}
