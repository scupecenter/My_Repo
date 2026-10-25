import * as Dialog from '@radix-ui/react-dialog';
import { Check, Clock, FileUp, MessageSquare, Undo2, UserX, X } from 'lucide-react';
import { useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { useTask } from '@/api/hooks';
import { useAddComment, useComments, useDatePatch, useHistory, useTaskOp, useUpload, type TaskOp } from '@/api/sites';
import type { DocumentSlot, TaskDetail } from '@/api/types';
import { Holders } from './HolderChip';
import { RejectDialog } from './RejectDialog';
import { useToast } from './Toast';

const SLOT_TONE: Record<string, string> = { approved: 'bg-doneBg text-doneInk', uploaded: 'bg-openBg text-openInk', in_review: 'bg-waitBg text-waitInk', rejected: 'bg-lateBg text-lateInk', missing: 'bg-lockBg text-lockInk', not_required: 'bg-lockBg text-lockInk' };

function Slot({ slot, canUpload, onFile }: { slot: DocumentSlot; canUpload: boolean; onFile: (f: File) => void }) {
  const { t, i18n } = useTranslation();
  const [over, setOver] = useState(false);
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f && canUpload) onFile(f); };
  const name = (i18n.language === 'ar' && slot.name_ar) || slot.name_en;
  return (
    <li data-testid={`slot-${slot.id}`} data-status={slot.status} className="rounded-md border border-line p-3">
      <div className="flex items-center gap-2">
        <b>{name}</b>{slot.mandatory && <span className="text-lateInk" title={t('drawer.mandatory')}>*</span>}
        <span className={`chip ms-auto ${SLOT_TONE[slot.status]}`} data-testid={`slot-status-${slot.id}`}>{t(`slotStatus.${slot.status}`)}</span>
      </div>
      {slot.status === 'rejected' && slot.reject_reason && <p className="mt-1 text-sm text-lateInk">{slot.reject_reason}</p>}
      <ul className="mt-1 text-sm text-mute">{slot.files.map((f) => <li key={f.id} className="mono truncate">{f.original_name} <span>v{f.version}</span></li>)}</ul>
      {canUpload && (
        <label data-testid={`slot-drop-${slot.id}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}
          className={`mt-2 flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed p-2 text-sm ${over ? 'border-accent bg-accentSoft' : 'border-line text-mute hover:bg-hover'}`}>
          <FileUp size={14} />{t('drawer.drop')}
          <input type="file" className="sr-only" data-testid={`slot-input-${slot.id}`} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
        </label>
      )}
    </li>
  );
}

function Thread({ task }: { task: TaskDetail }) {
  const { t } = useTranslation();
  const c = useComments(task.id), h = useHistory(task.id), add = useAddComment(task.id);
  const [text, setText] = useState('');
  return (
    <>
      <section aria-labelledby="dr-comments">
        <h3 id="dr-comments" className="mb-1 flex items-center gap-1 font-semibold"><MessageSquare size={14} />{t('drawer.comments')}</h3>
        <ul data-testid="comment-list" className="space-y-1 text-sm">
          {c.data?.items.map((x) => <li key={x.id} className={`rounded-md p-2 ${x.is_rejection_note ? 'bg-lateBg text-lateInk' : 'bg-card2'}`}><b>{x.author.display_name}</b> · {x.body}</li>)}
          {c.isSuccess && !c.data.items.length && <li className="text-mute">{t('drawer.no_comments')}</li>}
        </ul>
        <div className="mt-2 flex gap-2">
          <input className="input" data-testid="comment-input" aria-label={t('drawer.comment_label')} value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn" data-testid="comment-send" disabled={!text.trim() || add.isPending} onClick={() => add.mutate(text, { onSuccess: () => setText('') })}>{t('drawer.send')}</button>
        </div>
      </section>
      <section aria-labelledby="dr-history">
        <h3 id="dr-history" className="mb-1 flex items-center gap-1 font-semibold"><Clock size={14} />{t('drawer.history')}</h3>
        <ol data-testid="history-list" className="space-y-1 text-sm">
          {h.data?.items.map((x) => <li key={x.id}>{t(`step.${x.action}`)} · L{x.level} · {x.acted_by?.display_name}{x.self_approval ? ` · ${t('drawer.self_approval')}` : ''}{x.note ? ` — ${x.note}` : ''}</li>)}
          {h.isSuccess && !h.data.items.length && <li className="text-mute">{t('drawer.no_history')}</li>}
        </ol>
      </section>
    </>
  );
}

function Body({ task }: { task: TaskDetail }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const op = useTaskOp(task.site_id), date = useDatePatch(task.site_id), up = useUpload(task);
  const [rejecting, setRejecting] = useState(false);
  const act = (a: string) => task.allowed_actions.find((x) => x.action === a);
  const edit = !!act('edit'), submit = act('submit');
  const missing = task.slots.some((s) => s.mandatory && (s.status === 'missing' || s.status === 'rejected'));
  const run = (o: TaskOp, note?: string) => op.mutate({ task, op: o, note }, {
    onSuccess: () => { toast(t('approvals.done')); setRejecting(false); },
    onError: (e) => toast(e instanceof ApiError && e.code === 'mandatory_slots_missing' ? t('drawer.slots_missing') : e instanceof ApiError && e.code === 'precondition_failed' ? t('errors.precondition_failed') : e instanceof ApiError && e.status === 403 ? t('errors.forbidden') : e instanceof ApiError && e.code === 'step_up_required' ? '' : t('errors.generic'), 'err'),
  });
  const save = (field: 'planned_date' | 'actual_date', v: string) => { if ((v || null) !== (task[field] ?? null)) date.mutate({ task, patch: { [field]: v || null } }, { onError: () => toast(t('errors.generic'), 'err') }); };
  const name = (i18n.language === 'ar' && task.name_ar) || task.name_en;
  const final = (a?: { final?: boolean }) => !!a?.final;
  const review = act('review'), approve = act('approve');

  return (
    <div className="flex h-full flex-col" data-testid="task-drawer-body" data-state={task.state}>
      <header className="flex items-start gap-2 border-b border-line p-4">
        <div className="flex-1">
          <Dialog.Title className="font-bold"><span className="mono">{task.site_code}</span> · {task.task_code} {name}</Dialog.Title>
          <Dialog.Description className="mt-1 flex flex-wrap items-center gap-2 text-sm text-mute"><span className="chip bg-card2" data-testid="drawer-state">{t(`taskState.${task.state}`)}</span>{t('drawer.level', { level: task.current_level ?? 1, total: task.levels_required ?? 3 })}</Dialog.Description>
        </div>
        <Dialog.Close asChild><button className="btn px-2" aria-label={t('common.close')} data-testid="drawer-close"><X size={16} /></button></Dialog.Close>
      </header>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {task.lock_reasons?.length ? <div className="rounded-md bg-lockBg p-3 text-sm text-lockInk" data-testid="drawer-locks">{task.lock_reasons.map((r, i) => <p key={i}>{r.message}</p>)}</div> : null}
        {task.last_return_note && task.state === 'entry' && <div className="rounded-md bg-lateBg p-3 text-sm text-lateInk" data-testid="drawer-return-note">{t('approvals.returned_note', { note: task.last_return_note })}</div>}
        {task.holder_absent && <div className="flex gap-2 rounded-md bg-waitBg p-3 text-sm text-waitInk" data-testid="drawer-absent"><UserX size={16} />{t('drawer.absent')}</div>}

        <section aria-label={t('grid.ball')}>
          <div className="mb-1 text-sm text-mute">{t('grid.ball')}</div>
          <Holders holders={task.ball_in_court?.holders ?? []} />
          <ol className="mt-2 flex flex-wrap gap-2 text-sm" data-testid="approval-path">
            {task.approval_path.map((l) => <li key={l.level} data-status={l.status} className={`chip ${l.status === 'current' ? 'bg-openBg text-openInk' : l.status === 'done' ? 'bg-doneBg text-doneInk' : 'bg-lockBg text-lockInk'}`}>{l.level}. {t(`level.${l.kind}`)}{l.will_skip ? ` · ${t('drawer.will_skip')}` : ''}</li>)}
          </ol>
        </section>

        <section className="grid grid-cols-2 gap-3 text-sm" aria-label={t('drawer.dates')}>
          {(['planned_date', 'actual_date'] as const).map((f) => (
            <label key={f} className="block"><span className="text-mute">{t(f === 'planned_date' ? 'grid.plan' : 'grid.actual')}</span>
              <input type="date" className="input mono" data-testid={`drawer-${f === 'planned_date' ? 'plan' : 'actual'}-date`} disabled={!edit} defaultValue={task[f] ?? ''} key={`${f}-${task[f]}`} onBlur={(e) => save(f, e.target.value)} />
            </label>
          ))}
          <div><span className="text-mute">{t('grid.sla')}</span><div className="font-semibold">{task.sla?.min_wd ?? '–'}–{task.sla?.max_wd ?? '–'} {t('approvals.wd')} <span className={`chip ${task.sla?.colour === 'red' ? 'bg-lateBg text-lateInk' : 'bg-doneBg text-doneInk'}`}>{task.sla?.elapsed_wd ?? 0}</span></div></div>
        </section>

        <section aria-label={t('grid.docs')}>
          <h3 className="mb-1 font-semibold">{t('approvals.documents', { count: task.slots.length })}</h3>
          <ul className="space-y-2" data-testid="slot-list">
            {task.slots.map((s) => <Slot key={s.id} slot={s} canUpload={edit && s.status !== 'approved'} onFile={(file) => up.mutate({ slotId: s.id, file }, { onError: () => toast(t('drawer.upload_failed'), 'err') })} />)}
            {!task.slots.length && <li className="text-mute">{t('drawer.no_slots')}</li>}
          </ul>
        </section>
        <Thread task={task} />
      </div>
      <footer className="space-y-2 border-t border-line p-4">
        {submit && (final(submit) || submit.will_skip_to) && <p className="text-sm text-waitInk" data-testid="drawer-skip-note">{final(submit) ? t('drawer.self_approval_note') : t('drawer.skip_note', { level: submit.will_skip_to })}</p>}
        {submit && missing && <p className="text-sm text-mute" data-testid="drawer-missing">{t('drawer.slots_missing')}</p>}
        <div className="flex gap-2">
          {(act('reject')) && <button className="btn btn-danger" data-testid="drawer-reject" disabled={op.isPending} onClick={() => setRejecting(true)}><Undo2 size={16} />{t('approvals.reject')}</button>}
          {submit && <button className="btn btn-primary ms-auto" data-testid="drawer-submit" disabled={missing || !!submit.disabled_reason || op.isPending} onClick={() => run('submit')}><Check size={16} />{final(submit) ? t('drawer.submit_final') : t('drawer.submit')}</button>}
          {review && <button className="btn btn-primary ms-auto" data-testid="drawer-review" disabled={op.isPending} onClick={() => run('review')}><Check size={16} />{t('approvals.pass')}</button>}
          {approve && <button className="btn btn-primary ms-auto" data-testid="drawer-approve" disabled={op.isPending} onClick={() => run('approve')}><Check size={16} />{t('approvals.approve')}</button>}
        </div>
      </footer>
      <RejectDialog open={rejecting} title={t('approvals.reject_title', { site: task.site_code })} onClose={() => setRejecting(false)} onSend={(note) => run('reject', note)} />
    </div>
  );
}

export function TaskDrawer({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useTask(taskId);
  return (
    <Dialog.Root open={!!taskId} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-scrim/50" />
        <Dialog.Content data-testid="task-drawer" aria-describedby={undefined} className="fixed inset-y-0 end-0 z-[60] w-[min(560px,100vw)] border-s border-line bg-card shadow-lg">
          {q.data ? <Body key={q.data.id} task={q.data} /> : <div className="p-4"><Dialog.Title className="font-bold">{t('common.loading')}</Dialog.Title></div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
