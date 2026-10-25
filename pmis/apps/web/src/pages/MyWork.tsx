import { AlertTriangle, Check, Clock, Inbox, Pencil } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useMe, useMyTasks } from '@/api/hooks';
import type { TaskSummary } from '@/api/types';
import { PersonTag } from '@/components/PersonTag';

const SLA_CHIP: Record<string, string> = { green: 'bg-doneBg text-doneInk', amber: 'bg-waitBg text-waitInk', red: 'bg-lateBg text-lateInk', none: 'bg-lockBg text-lockInk' };

export function TaskCard({ task }: { task: TaskSummary }) {
  const { t, i18n } = useTranslation();
  const name = i18n.language === 'ar' && task.name_ar ? task.name_ar : task.name_en;
  const claimed = task.ball_in_court?.claimed_by;
  return (
    <li className="rounded-md border border-line bg-card p-3" data-testid={`task-card-${task.id}`}>
      <div><b className="mono">{task.site_code}</b> {task.task_code} · {name}</div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-mute">
        {task.sla?.colour && <span className={`chip ${SLA_CHIP[task.sla.colour]}`}>{t('approvals.sla')} {task.sla.elapsed_wd ?? '–'}/{task.sla.max_wd ?? '–'} {t('approvals.wd')}</span>}
        {claimed ? <PersonTag name={claimed.display_name} employeeId={claimed.employee_id} />
          : task.ball_in_court?.holders.map((h) => <span key={h.ref_id}>{h.label}</span>)}
      </div>
      {task.last_return_note && <div className="mt-1 text-sm text-lateInk">{t('approvals.returned_note', { note: task.last_return_note })}</div>}
    </li>
  );
}

function Bucket({ id, icon, title, tasks }: { id: string; icon: ReactNode; title: string; tasks: TaskSummary[] | undefined }) {
  const { t } = useTranslation();
  return (
    <section data-testid={`my-work-bucket-${id}`}>
      <h2 className="mb-2 flex items-center gap-2 font-bold">{icon}{title}<span className="chip border border-line" data-testid={`my-work-count-${id}`}>{tasks?.length ?? 0}</span></h2>
      <ul className="card space-y-2 p-2">
        {tasks?.length ? tasks.map((x) => <TaskCard key={x.id} task={x} />) : <li className="p-4 text-center text-mute">{t('myWork.nothing')}</li>}
      </ul>
    </section>
  );
}

export function MyWork() {
  const { t } = useTranslation();
  const me = useMe(true);
  const late = useMyTasks('late'), doNow = useMyTasks('do_now'), waiting = useMyTasks('waiting');
  const total = [late, doNow, waiting].reduce((n, q) => n + (q.data?.items.length ?? 0), 0);
  const loaded = [late, doNow, waiting].every((q) => q.isSuccess);
  return (
    <div className="space-y-4" data-testid="page-my-work">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('myWork.title')}</h1>
          <p className="text-mute">{t('myWork.hello', { name: me.data?.user.display_name.split(' ')[0] ?? '' })}</p>
        </div>
        <Link to="/approvals" data-testid="my-work-go-approvals" className="btn btn-accent"><Inbox size={16} />{t('myWork.go_approvals')}<span className="chip bg-card text-ink">{doNow.data?.items.length ?? 0}</span></Link>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Bucket id="late" icon={<AlertTriangle size={16} />} title={t('myWork.late')} tasks={late.data?.items} />
        <Bucket id="do_now" icon={<Pencil size={16} />} title={t('myWork.do_now')} tasks={doNow.data?.items} />
        <Bucket id="waiting" icon={<Clock size={16} />} title={t('myWork.waiting')} tasks={waiting.data?.items} />
      </div>
      {loaded && total === 0 && (
        <div className="card p-10 text-center" data-testid="my-work-empty"><Check className="mx-auto" /><h2 className="font-bold">{t('myWork.empty_title')}</h2><p className="text-mute">{t('myWork.empty_body')}</p></div>
      )}
    </div>
  );
}
