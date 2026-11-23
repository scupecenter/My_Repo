import { AlertTriangle, Check, Clock, Columns3, Inbox, List, Pencil } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { useMe, useMyTasks } from '@/api/hooks';
import type { TaskSummary } from '@/api/types';
import { Holders } from '@/components/HolderChip';
import { PersonTag } from '@/components/PersonTag';
import { TaskDrawer } from '@/components/TaskDrawer';
import { BallSince, ExternalParty, SlaOverrun, StaleBadge } from '@/components/TaskTiming';
import { TasksBoard } from '@/components/TasksBoard';
import { SavedViews } from '@/components/SavedViews';
import { UnifiedFilter } from '@/components/UnifiedFilter';
import { decodeFilter, encodeFilter, type FilterTree } from '@/api/views';

const SLA_CHIP: Record<string, string> = { green: 'bg-doneBg text-doneInk', amber: 'bg-waitBg text-waitInk', red: 'bg-lateBg text-lateInk', none: 'bg-lockBg text-lockInk' };

/** The card is a button: Enter or click opens the task drawer straight away (plan E1); the drawer returns focus to the card. */
export function TaskCard({ task, onOpen }: { task: TaskSummary; onOpen?: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const name = i18n.language === 'ar' && task.name_ar ? task.name_ar : task.name_en;
  const claimed = task.ball_in_court?.claimed_by;
  return (
    <li className="cursor-pointer rounded-md border border-line bg-card p-3 hover:bg-hover" data-testid={`task-card-${task.id}`} onClick={(e) => { if (!(e.target as HTMLElement).closest('button,a')) onOpen?.(task.id); }}>
      <div><button type="button" className="sr-only" data-testid={`task-card-open-${task.id}`} onClick={() => onOpen?.(task.id)}>{task.site_code} {task.task_code}</button><b className="mono">{task.site_code}</b> {task.task_code} · {name}</div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-mute">
        {task.sla?.colour && <span className={`chip ${SLA_CHIP[task.sla.colour]}`}>{t('approvals.sla')} {task.sla.elapsed_wd ?? '–'}/{task.sla.max_wd ?? '–'} {t('approvals.wd')}</span>}
        <SlaOverrun task={task} />
        {claimed ? <PersonTag name={claimed.display_name} employeeId={claimed.employee_id} />
          : <Holders holders={task.ball_in_court?.holders ?? []} />}
        <ExternalParty task={task} /><BallSince task={task} /><StaleBadge task={task} />
      </div>
      {task.last_return_note && <div className="mt-1 text-sm text-lateInk">{t('approvals.returned_note', { note: task.last_return_note })}</div>}
    </li>
  );
}

function Bucket({ id, icon, title, tasks, onOpen }: { id: string; icon: ReactNode; title: string; tasks: TaskSummary[] | undefined; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  return (
    <section data-testid={`my-work-bucket-${id}`}>
      <h2 className="mb-2 flex items-center gap-2 font-bold">{icon}{title}<span className="chip border border-line" data-testid={`my-work-count-${id}`}>{tasks?.length ?? 0}</span></h2>
      <ul className="card space-y-2 p-2">
        {tasks?.length ? tasks.map((x) => <TaskCard key={x.id} task={x} onOpen={onOpen} />) : <li className="p-4 text-center text-mute">{t('myWork.nothing')}</li>}
      </ul>
    </section>
  );
}

const BOARD_EMPTY = { mine: '' };

export function MyWork() {
  const { t } = useTranslation();
  const me = useMe(true);
  const [open, setOpen] = useState<string | null>(null);
  // F5 (0.15.32): List (the three buckets) or Board (the tasks board by approval state); the layout, the "mine" switch and the F3 tree live in the URL
  const [sp, setSp] = useSearchParams();
  const board = sp.get('layout') === 'board';
  const mine = sp.get('mine') === 'true';
  const adv = sp.get('adv') ?? '';
  const advTree = decodeFilter(adv);
  const setParams = (kv: Record<string, string>) => setSp((prev) => { const n = new URLSearchParams(prev); for (const [k, v] of Object.entries(kv)) { if (v) n.set(k, v); else n.delete(k); } return n; }, { replace: true });
  const late = useMyTasks('late'), doNow = useMyTasks('do_now'), waiting = useMyTasks('waiting');
  const total = [late, doNow, waiting].reduce((n, q) => n + (q.data?.items.length ?? 0), 0);
  const loaded = [late, doNow, waiting].every((q) => q.isSuccess);
  return (
    <div className="space-y-4" data-testid="page-my-work">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">{t('myWork.title')}</h1>
          <p className="text-mute">{t('myWork.hello', { name: me.data?.user.display_name.split(' ')[0] ?? '' })}</p>
        </div>
        <span className="ms-auto inline-flex gap-1" role="group" aria-label={t('board.layout')} data-testid="my-work-layout">
          <button type="button" aria-pressed={!board} data-testid="my-work-layout-list" onClick={() => setParams({ layout: '' })} className={`btn px-2 py-1 text-xs ${!board ? 'btn-primary' : ''}`}><List size={14} aria-hidden />{t('board.list')}</button>
          <button type="button" aria-pressed={board} data-testid="my-work-layout-board" onClick={() => setParams({ layout: 'board' })} className={`btn px-2 py-1 text-xs ${board ? 'btn-primary' : ''}`}><Columns3 size={14} aria-hidden />{t('board.board')}</button>
        </span>
        <Link to="/approvals" data-testid="my-work-go-approvals" className="btn btn-accent"><Inbox size={16} />{t('myWork.go_approvals')}<span className="chip bg-card text-ink">{doNow.data?.items.length ?? 0}</span></Link>
      </div>
      {board ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2" data-testid="tasks-board-toolbar">
            <SavedViews screen="tasks-board" value={{ mine: mine ? 'true' : '', ...(advTree ? { advanced: advTree } : {}) }} empty={BOARD_EMPTY}
              onApply={(v) => setParams({ mine: String((v as Record<string, unknown>).mine ?? ''), adv: encodeFilter((v as { advanced?: FilterTree }).advanced) })} />
            <UnifiedFilter screen="tasks-board" value={advTree} onChange={(tree) => setParams({ adv: encodeFilter(tree) })} onClearAll={() => setParams({ adv: '', mine: '' })}
              extras={[{ key: 'mine', label: t('board.mine'), group: 'work', kind: 'bool', value: mine ? '1' : '', set: (v) => setParams({ mine: v ? 'true' : '' }) }]} />
          </div>
          <TasksBoard query={{ filter: adv || undefined, mine: mine || undefined }} />
        </div>
      ) : (<>
      <div className="grid gap-4 md:grid-cols-3">
        <Bucket id="late" icon={<AlertTriangle size={16} />} title={t('myWork.late')} tasks={late.data?.items} onOpen={setOpen} />
        <Bucket id="do_now" icon={<Pencil size={16} />} title={t('myWork.do_now')} tasks={doNow.data?.items} onOpen={setOpen} />
        <Bucket id="waiting" icon={<Clock size={16} />} title={t('myWork.waiting')} tasks={waiting.data?.items} onOpen={setOpen} />
      </div>
      <TaskDrawer taskId={open} onClose={() => setOpen(null)} />
      {loaded && total === 0 && (
        <div className="card p-10 text-center" data-testid="my-work-empty"><Check className="mx-auto" /><h2 className="font-bold">{t('myWork.empty_title')}</h2><p className="text-mute">{t('myWork.empty_body')}</p></div>
      )}
      </>)}
    </div>
  );
}
