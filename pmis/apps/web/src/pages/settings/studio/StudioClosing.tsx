import { useTranslation } from 'react-i18next';
import type { P } from '../wf/model';
import type { Ctx } from './studioCtx';

/** "This task closes the milestone": the task whose approval decides when its milestone counts as done (one per milestone; choosing another replaces it). Closing tasks are structure, so the structural lock blocks it. */
export function ClosingToggle({ c, task }: { c: Ctx; task: P }) {
  const { t } = useTranslation();
  const on = task.is_milestone_task === true;
  const dis = !c.can.struct;
  return (
    <div className="self-end">
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" data-testid="studio-closing" disabled={dis || c.can.busy} title={dis ? c.can.why ?? undefined : undefined} checked={on}
        onChange={(e) => {
          const closing = e.target.checked;
          c.askReason({ title: t(closing ? 'wfe.closing_on' : 'wfe.closing_off', { code: task.task_code }), hint: t('wfe.closing_hint'), run: (reason, cb) => c.W.setClosing.mutate({ code: task.task_code, closing, reason }, cb) });
        }} />{t('studioPanel.closing')}</label>
      {on && <span className="chip bg-accentSoft text-accentText" data-testid={`studio-closing-chip-${task.task_code}`}>{t('studioPanel.closing_chip')}</span>}
    </div>
  );
}
