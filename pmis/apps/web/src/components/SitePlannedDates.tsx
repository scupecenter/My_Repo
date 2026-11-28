import { CalendarClock } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApplyPlannedDates, usePlannedDates } from '@/api/planDates';
import { errText, FormDialog } from './FormDialog';
import { Tip } from './Tip';
import { useToast } from './Toast';

/**
 * Site page (A4, contract 0.15.463): the planned dates the predecessors and the work calendars propose for the tasks of this site. Shown only when at least one
 * proposal differs from the planned date. The engineer ticks the tasks and confirms; only then does `planned_date` change (audited per task).
 */
export function SitePlannedDates({ siteId }: { siteId: string }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = usePlannedDates(siteId);
  const apply = useApplyPlannedDates(siteId);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const rows = (q.data?.items ?? []).filter((x) => x.proposed_date && x.proposed_date !== x.planned_date);
  if (!rows.length) return null;
  const sel = picked ?? new Set(rows.map((x) => x.task_id));
  const toggle = (id: string) => { const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); setPicked(n); };
  const label = t('planned.open');
  return (
    <div className="my-2" data-testid="site-planned-dates">
      <Tip text={t('planned.hint')}>
        <button className="btn gap-1" data-testid="site-planned-open" aria-label={label} onClick={() => { setPicked(null); setOpen(true); }}>
          <CalendarClock size={14} aria-hidden /> {label} <span className="chip">{rows.length}</span>
        </button>
      </Tip>
      {open && (
        <FormDialog open wide onClose={() => setOpen(false)} testid="site-planned-dialog" title={t('planned.title')} withReason={false} busy={apply.isPending}
          submitLabel={t('planned.confirm', { count: sel.size })} disabled={sel.size === 0}
          error={apply.isError ? errText(apply.error, t) : null}
          onSubmit={() => apply.mutate([...sel], { onSuccess: (r) => { toast(t('planned.done', { count: r.applied })); setOpen(false); } })}>
          <p className="mb-2 text-xs text-mute">{t('planned.note', { basis: t(`planRules.basis_${q.data?.rules.basis ?? 'max'}`) })}</p>
          <table className="w-full text-sm">
            <thead><tr className="text-start text-mute"><th /><th className="text-start">{t('planned.task')}</th><th className="text-start">{t('planned.current')}</th><th className="text-start">{t('planned.proposed')}</th><th className="text-start">{t('planned.basis')}</th></tr></thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.task_id} data-testid={`planned-row-${x.task_code}`}>
                  <td><input type="checkbox" aria-label={t('planned.pick', { code: x.task_code })} checked={sel.has(x.task_id)} onChange={() => toggle(x.task_id)} /></td>
                  <td><span className="mono">{x.task_code}</span> <bdi>{(i18n.language === 'ar' && x.name_ar) || x.name_en}</bdi></td>
                  <td className="mono"><bdi>{x.planned_date ?? t('planned.none')}</bdi></td>
                  <td className="mono font-semibold"><bdi>{x.proposed_date}</bdi>{x.slip_days ? <span className={x.slip_days > 0 ? 'ms-1 text-lateInk' : 'ms-1 text-mute'}> ({x.slip_days > 0 ? '+' : ''}{x.slip_days})</span> : null}</td>
                  <td className="text-xs text-mute"><bdi>{x.basis_task_code}</bdi> {x.basis_kind ? t(`planned.kind_${x.basis_kind}`) : ''} + {x.working_days} {t('planned.wd')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </FormDialog>
      )}
    </div>
  );
}
