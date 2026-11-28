import { useQueryClient } from '@tanstack/react-query';
import { useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { useTasksBoard, type TaskBoardColumn, type TasksBoard as Board } from '@/api/boards';
import type { TaskDetail, TaskSummary } from '@/api/types';
import { Holders } from './HolderChip';
import { DragGrip } from './TextSelection';
import { BallSince, SlaOverrun, StaleBadge } from './TaskTiming';
import { TaskDrawer, type DrawerIntent } from './TaskDrawer';
import { useToast } from './Toast';

/**
 * F5 (contract 0.15.32): the tasks board by approval state. A card dropped on a column, or moved with its "Open action" menu (keyboard),
 * never changes the task: it only opens the task's existing action in the task drawer (submit, review, approve, or the reject dialog with
 * its mandatory note), and only when the server lists that action in `allowed_actions` of the task; otherwise the drop is refused with a
 * message. The action then runs only when the person confirms it with the usual button, through the usual endpoint.
 */
export const BOARD_COLUMNS: readonly TaskBoardColumn[] = ['entry', 'review', 'rejected', 'approved'];

/** The existing actions a drop on a column may open, in order of preference (a final review approves, so it may open on Approved). */
export function intentFor(target: TaskBoardColumn, allowed: TaskDetail['allowed_actions']): DrawerIntent | null {
  const has = (a: string) => allowed.find((x) => x.action === a);
  if (target === 'review') return has('submit') ? 'submit' : null;
  if (target === 'approved') return has('approve') ? 'approve' : has('review')?.final ? 'review' : has('submit')?.final ? 'submit' : null;
  if (target === 'rejected') return has('reject') ? 'reject' : null;
  return null; // nothing moves a task back to Data Entry except a rejection
}

function Card({ task, column, onMove, onOpen }: { task: TaskSummary; column: TaskBoardColumn; onMove: (t: TaskSummary, to: TaskBoardColumn) => void; onOpen: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const name = (i18n.language === 'ar' && task.name_ar) || task.name_en;
  return (
    <li draggable data-testid={`board-task-${task.id}`} data-column={column}
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', task.id); e.dataTransfer.effectAllowed = 'move'; }}
      className="rounded-md border border-line bg-card p-2 text-sm">
      <DragGrip className="float-end" />
      <button type="button" className="block w-full text-start" data-testid={`board-task-open-${task.id}`} onClick={() => onOpen(task.id)}>
        <b className="mono" dir="ltr">{task.site_code}</b> {task.task_code} · {name}
      </button>
      <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
        <SlaOverrun task={task} /><BallSince task={task} /><StaleBadge task={task} />
      </div>
      {task.ball_in_court?.holders?.length ? <div className="mt-1 text-xs"><Holders holders={task.ball_in_court.holders} /></div> : null}
      {column === 'rejected' && task.last_return_note && <p className="mt-1 text-xs text-lateInk">{t('approvals.returned_note', { note: task.last_return_note })}</p>}
      <label className="mt-1 flex items-center gap-1 text-xs text-mute">
        <span>{t('board.open_action')}</span>
        <select className="input w-auto py-0 text-xs" data-testid={`board-task-move-${task.id}`} value="" aria-label={t('board.open_action_for', { code: `${task.site_code} ${task.task_code}` })}
          onChange={(e) => { if (e.target.value) onMove(task, e.target.value as TaskBoardColumn); }}>
          <option value="">—</option>
          {BOARD_COLUMNS.filter((c) => c !== column).map((c) => <option key={c} value={c}>{t(`board.col_${c}`)}</option>)}
        </select>
      </label>
    </li>
  );
}

export function TasksBoard({ query }: { query: Record<string, string | boolean | undefined> }) {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useTasksBoard(query);
  const b: Board | undefined = q.data;
  const [open, setOpen] = useState<{ id: string; intent?: DrawerIntent } | null>(null);
  const [over, setOver] = useState<TaskBoardColumn | null>(null);

  const colOf = (id: string) => b?.columns.find((c) => c.items.some((x) => x.id === id))?.key;
  const move = async (task: TaskSummary, to: TaskBoardColumn) => {
    if (colOf(task.id) === to) return;
    try {
      // the server decides what the caller may do now (the same list as the drawer's buttons)
      const d = await qc.fetchQuery({ queryKey: ['task', task.id], queryFn: () => api.get<TaskDetail>(`/tasks/${task.id}`), staleTime: 0 });
      const intent = intentFor(to, d.allowed_actions);
      if (!intent) { toast(t('board.drop_refused', { column: t(`board.col_${to}`) }), 'err'); return; }
      setOpen({ id: task.id, intent });
    } catch {
      toast(t('common.error'), 'err');
    }
  };
  const onDrop = (to: TaskBoardColumn) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData('text/plain');
    const task = b?.columns.flatMap((c) => c.items).find((x) => x.id === id);
    if (task) void move(task, to);
  };

  return (
    <section className="space-y-2" data-testid="tasks-board" aria-label={t('board.tasks_title')}>
      <p className="text-xs text-mute" data-testid="tasks-board-note">{t('board.drop_note')}</p>
      {q.isError && <p role="alert" className="text-sm text-lateInk">{t('common.error')}</p>}
      {b && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {b.columns.map((c) => (
            <section key={c.key} data-testid={`board-tcol-${c.key}`} aria-labelledby={`board-tcol-h-${c.key}`} data-drop-target={over === c.key || undefined}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(c.key); }} onDragLeave={() => setOver(null)} onDrop={onDrop(c.key)}
              className={`card p-2 ${over === c.key ? 'outline outline-2 outline-accent' : ''}`}>
              <h3 id={`board-tcol-h-${c.key}`} className="mb-2 flex items-center gap-2 font-bold">{t(`board.col_${c.key}`)}<span className="chip ms-auto border border-line" data-testid={`board-tcol-count-${c.key}`}>{c.count}</span></h3>
              <ul className="space-y-2">
                {c.items.map((x) => <Card key={x.id} task={x} column={c.key} onMove={(task, to) => void move(task, to)} onOpen={(id) => setOpen({ id })} />)}
                {!c.items.length && <li className="p-3 text-center text-sm text-mute">{t('myWork.nothing')}</li>}
              </ul>
              {c.more && <p className="mt-1 text-xs text-mute" data-testid={`board-tcol-more-${c.key}`}>{t('board.more', { count: c.count - c.items.length })}</p>}
            </section>
          ))}
        </div>
      )}
      {/* after the drawer closes the board is read again (an action may have run through its usual endpoint) */}
      <TaskDrawer taskId={open?.id ?? null} intent={open?.intent} onClose={() => { setOpen(null); void qc.invalidateQueries({ queryKey: ['boards', 'tasks'] }); }} />
    </section>
  );
}
