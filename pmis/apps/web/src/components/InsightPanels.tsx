import { Hourglass, Link2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useBlockedBy, useTimeInState } from '@/api/x';
import { fmtDateTime } from '@/lib/time';
import { fmtDuration } from '@/lib/x';
import { ErrorState, LoadingSkeleton } from './States';
import { PersonTag } from './PersonTag';

/** The unit words of `fmtDuration` in the language of the screen. */
export function useDurationUnits() {
  const { t } = useTranslation();
  return { d: t('tis.unit_d'), h: t('tis.unit_h'), min: t('tis.unit_min'), lt: t('tis.under_a_minute') };
}

/** X4: how long the task sat at each level (from its audit rows), and the visits one by one with the person who handled each. Readable by anyone who can read the task. */
export function TimeInStatePanel({ taskId }: { taskId: string }) {
  const { t, i18n } = useTranslation();
  const units = useDurationUnits();
  const q = useTimeInState(taskId);
  if (q.isLoading) return <LoadingSkeleton rows={3} testid="tis-loading" />;
  if (q.isError || !q.data) return <ErrorState onRetry={() => void q.refetch()} testid="tis-error" />;
  const d = q.data;
  // L1 and L2 always show; the old middle level only when a task was submitted before the two-level rule and sat there
  const rows = d.items.filter((i) => i.state !== 'review' || i.visits > 0);
  const none = d.segments.length === 0;
  return (
    <section aria-labelledby="dr-tis" data-testid="time-in-state">
      <h3 id="dr-tis" className="mb-1 flex items-center gap-1 font-semibold"><Hourglass size={14} aria-hidden />{t('tis.title')}</h3>
      <p className="mb-2 text-sm text-mute">{t('tis.hint')}</p>
      {d.current_state && <p className="mb-2 text-sm" data-testid="tis-current">{t('tis.now_at', { level: t(`level.${d.current_state}`) })}</p>}
      <table className="w-full text-sm" data-testid="tis-table">
        <thead><tr className="text-start text-mute"><th className="py-1 text-start font-semibold">{t('tis.level')}</th><th className="text-start font-semibold">{t('tis.visits')}</th><th className="text-start font-semibold">{t('tis.total')}</th><th className="text-start font-semibold">{t('tis.longest')}</th><th className="text-start font-semibold">{t('tis.working_days')}</th></tr></thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i.state} data-testid={`tis-row-${i.state}`} className="border-t border-line">
              <td className="py-1">{t(`level.${i.state}`)}</td><td className="mono">{i.visits}</td><td className="mono">{fmtDuration(i.total_seconds, units)}</td><td className="mono">{fmtDuration(i.longest_seconds, units)}</td><td className="mono">{i.working_days}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {none ? <p className="mt-2 text-mute" data-testid="tis-none">{t('tis.none')}</p> : (
        <ol className="mt-3 space-y-1 text-sm" data-testid="tis-segments">
          {d.segments.map((s, i) => (
            <li key={i} data-state={s.state} className="flex flex-wrap items-baseline gap-2">
              <span className="chip bg-card2">{t(`level.${s.state}`)}</span>
              <span className="mono">{fmtDuration(s.seconds, units)}</span>
              <span className="text-mute">{fmtDateTime(s.started_at, i18n.language)}{s.ended_at ? ` → ${fmtDateTime(s.ended_at, i18n.language)}` : ` → ${t('tis.open')}`}</span>
              {s.handled_by && <span className="text-mute">{t('tis.by')} <PersonTag name={s.handled_by.display_name} employeeId={s.handled_by.employee_id} /></span>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** X6: what the task waits for, one item per reason, with the predecessor task as a link to its own drawer. Shown only while the task has lock reasons. */
export function BlockedByPanel({ taskId, siteId }: { taskId: string; siteId: string }) {
  const { t } = useTranslation();
  const q = useBlockedBy(taskId);
  if (q.isLoading) return <LoadingSkeleton rows={2} testid="blocked-loading" />;
  if (q.isError || !q.data) return <ErrorState onRetry={() => void q.refetch()} testid="blocked-error" />;
  if (!q.data.blocked) return null;
  return (
    <section aria-labelledby="dr-blocked" data-testid="blocked-by" className="rounded-md border border-line p-3">
      <h3 id="dr-blocked" className="mb-1 flex items-center gap-1 font-semibold"><Link2 size={14} aria-hidden />{t('blocked.title')}</h3>
      <ol className="space-y-1 text-sm">
        {q.data.items.map((i, n) => (
          <li key={n} data-kind={i.kind} className="flex flex-wrap items-baseline gap-2">
            <span className="chip bg-lockBg text-lockInk">{t(`blocked.kind_${i.kind}`, { defaultValue: t('blocked.kind_other') })}</span>
            <span>{i.message}</span>
            {i.task && <Link className="font-semibold text-link underline" data-testid={`blocked-task-${i.task.task_code}`} to={`/sites/${siteId}?task=${i.task.id}`}>{i.task.task_code} · {t(`taskState.${i.task.state}`, { defaultValue: i.task.state })}</Link>}
          </li>
        ))}
      </ol>
    </section>
  );
}
