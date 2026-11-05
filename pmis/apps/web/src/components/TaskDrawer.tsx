import * as Dialog from '@radix-ui/react-dialog';
import { Check, Clock, ExternalLink, HandMetal, Play, Save, ShieldAlert, Undo2, UserMinus, UserX, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useTask } from '@/api/hooks';
import { taskErrorMessage } from '@/lib/taskErrors';
import { errText } from './FormDialog';
import { useAddComment, useComments, useDatePatch, useHistory, useTaskOp, type TaskOp } from '@/api/sites';
import type { TaskDetail, TaskRegisterField } from '@/api/types';
import { DocSlots } from './DocSlots';
import { DraftBar, useDraft } from './DraftBar';
import { DrawerFrame, DrawerTabs, panelProps, useReportDirty, type DrawerNav } from './DrawerFrame';
import { CommentsPanel } from './Comments';
import { DelayPeriodsPanel } from './DelayPeriods';
import { Holders } from './HolderChip';
import { BlockedByPanel, TimeInStatePanel } from './InsightPanels';
import { OverrideBadge } from './OverrideBadge';
import { TaskRegisterFields } from './TaskRegisterFields';
import { FieldHistory } from './logs/FieldHistory';
import { RejectDialog } from './RejectDialog';
import { useToast } from './Toast';

function Comments({ task }: { task: TaskDetail }) {
  const { t } = useTranslation();
  const c = useComments(task.id), add = useAddComment(task.id);
  return (
    <CommentsPanel items={c.data?.items} loaded={c.isSuccess} pending={add.isPending} error={add.isError ? errText(add.error, t) : null}
      onSend={(body, ids) => add.mutate({ body, ...(ids.length ? { mention_user_ids: ids } : {}) })} />
  );
}

function History({ task }: { task: TaskDetail }) {
  const { t } = useTranslation();
  const h = useHistory(task.id);
  return (
    <section aria-labelledby="dr-history">
      <h3 id="dr-history" className="mb-1 flex items-center gap-1 font-semibold"><Clock size={14} />{t('drawer.history')}</h3>
      <ol data-testid="history-list" className="space-y-1 text-sm">
        {h.data?.items.map((x) => <li key={x.id} data-previous-path={x.previous_path ? 'true' : undefined}>{t(`step.${x.action}`)} · L{x.level} · {x.acted_by?.display_name}{x.self_approval ? ` · ${t('drawer.self_approval')}` : ''}{x.note ? ` — ${x.note}` : ''}{x.previous_path && <span className="chip ms-2 bg-lockBg text-lockInk" data-testid="history-previous-path">{t('drawer.previous_path')}</span>}</li>)}
        {h.isSuccess && !h.data.items.length && <li className="text-mute">{t('drawer.no_history')}</li>}
      </ol>
    </section>
  );
}

function Body({ task, regFields }: { task: TaskDetail; regFields: TaskRegisterField[] }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const op = useTaskOp(task.site_id), date = useDatePatch(task.site_id);
  const [rejecting, setRejecting] = useState(false);
  const [tab, setTab] = useState('data');
  const act = (a: string) => task.allowed_actions.find((x) => x.action === a);
  const edit = !!act('edit'), submit = act('submit');
  const missing = task.slots.some((s) => s.mandatory && (s.status === 'missing' || s.status === 'rejected'));
  const DONE: Partial<Record<TaskOp, string>> = { start: 'drawer.started', claim: 'drawer.claimed', release: 'drawer.released' };
  // The 422/409/403 codes of the engine are shown in plain words (lib/taskErrors.ts); a cancelled step-up shows nothing.
  const fail = (e: unknown) => { const m = taskErrorMessage(t, e); if (m) toast(m, 'err'); };
  const run = (o: TaskOp, note?: string) => op.mutate({ task, op: o, note }, {
    onSuccess: () => { toast(t(DONE[o] ?? 'approvals.done')); setRejecting(false); },
    onError: (e) => { if (o === 'reject') setRejecting(false); fail(e); },
  });
  const [draft, setDraft] = useState({ planned_date: task.planned_date ?? '', actual_start: task.actual_start ?? '', actual_date: task.actual_date ?? '' });
  const dirty = (['planned_date', 'actual_start', 'actual_date'] as const).filter((k) => (draft[k] || null) !== (task[k] ?? null));
  const layout0 = typeof task.values?.layout_submitted_date === 'string' ? task.values.layout_submitted_date : '';
  const [layout, setLayout] = useState(layout0);
  const layoutDirty = task.task_code === 'B6' && layout !== layout0;
  useReportDirty(dirty.length > 0 || layoutDirty);
  // Q115: unsaved dates are kept as a server-side draft of this user (never a save of the task), with a last-saved time and an optional restore
  const dr = useDraft(`task.${task.id}`, draft, dirty.length > 0, edit);
  const save = () => date.mutate({ task, patch: { ...Object.fromEntries(dirty.map((k) => [k, draft[k] || null])), ...(layoutDirty ? { values: { layout_submitted_date: layout || null } } : {}) } }, { onSuccess: () => { dr.clear(); toast(t('drawer.saved')); }, onError: fail });
  const name = (i18n.language === 'ar' && task.name_ar) || task.name_en;
  const final = (a?: { final?: boolean }) => !!a?.final;
  const review = act('review'), approve = act('approve'), start = act('start'), claim = act('claim'), release = act('release');
  const claimedBy = task.ball_in_court?.claimed_by;

  return (
    <div className="flex h-full flex-col" data-testid="task-drawer-body" data-state={task.state}>
      <header className="flex items-start gap-2 border-b border-line p-4">
        <div className="flex-1">
          <Dialog.Title className="font-bold"><span className="mono">{task.site_code}</span> · {task.task_code} {name}</Dialog.Title>
          <Dialog.Description className="mt-1 flex flex-wrap items-center gap-2 text-sm text-mute"><span className="chip bg-card2" data-testid="drawer-state">{t(`taskState.${task.state}`)}</span>{task.historical_no_documents && <OverrideBadge taskId={task.id} />}{t('drawer.level', { level: task.current_level ?? 1, total: task.levels_required ?? 3 })}</Dialog.Description>
        </div>
        <Link className="btn px-2 py-1 text-xs" data-testid="drawer-open-site" to={`/sites/${task.site_id}`}><ExternalLink size={12} />{t('drawer.open_site')}</Link>
        <Dialog.Close asChild><button className="btn px-2" aria-label={t('common.close')} data-testid="drawer-close"><X size={16} /></button></Dialog.Close>
      </header>
      <DrawerTabs value={tab} onChange={setTab} tabs={[{ id: 'data', label: t('drawer.tab_data') }, { id: 'documents', label: `${t('drawer.tab_documents')} (${task.slots.length})` }, { id: 'comments', label: t('drawer.comments') }, { id: 'history', label: t('drawer.history') }, { id: 'time', label: t('tis.tab') }, { id: 'delay', label: t('delayp.tab') }]} />
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {task.lock_reasons?.length ? <div className="rounded-md bg-lockBg p-3 text-sm text-lockInk" data-testid="drawer-locks">{task.lock_reasons.map((r, i) => <p key={i}>{r.message}</p>)}</div> : null}
        {task.lock_reasons?.length ? <BlockedByPanel taskId={task.id} siteId={task.site_id} /> : null}
        {task.last_return_note && task.state === 'entry' && <div className="rounded-md bg-lateBg p-3 text-sm text-lateInk" data-testid="drawer-return-note">{t('approvals.returned_note', { note: task.last_return_note })}</div>}
        {task.historical_no_documents && (
          <div className="flex gap-2 rounded-md bg-waitBg p-3 text-sm text-waitInk" data-testid="drawer-historical">
            <ShieldAlert size={16} className="shrink-0" />
            <span>{t('override.historical_note', { docs: (task.historical_load?.missing_documents ?? []).join(', '), cutoff: task.historical_load?.cutoff_date ?? '' })}{task.historical_load?.reason ? ` — ${task.historical_load.reason}` : ''}</span>
          </div>
        )}
        {task.holder_absent && <div className="flex gap-2 rounded-md bg-waitBg p-3 text-sm text-waitInk" data-testid="drawer-absent"><UserX size={16} />{t('drawer.absent')}</div>}

        <div {...panelProps('data', tab)} className="space-y-4">
        <section aria-label={t('grid.ball')}>
          <div className="mb-1 text-sm text-mute">{t('grid.ball')}</div>
          <Holders holders={task.ball_in_court?.holders ?? []} />
          {claimedBy && <p className="mt-1 text-sm text-openInk" data-testid="drawer-claimed-by">{t('drawer.claimed_by', { name: claimedBy.display_name })}</p>}
          <ol className="mt-2 flex flex-wrap gap-2 text-sm" data-testid="approval-path">
            {task.approval_path.map((l) => <li key={l.level} data-status={l.status} className={`chip ${l.status === 'current' ? 'bg-openBg text-openInk' : l.status === 'done' ? 'bg-doneBg text-doneInk' : 'bg-lockBg text-lockInk'}`}>{l.level}. {t(`level.${l.kind}`)}{l.will_skip ? ` · ${t('drawer.will_skip')}` : ''}</li>)}
          </ol>
        </section>

        <section className="grid grid-cols-2 gap-3 text-sm" aria-label={t('drawer.dates')}>
          {([['planned_date', 'plan', 'grid.plan'], ['actual_start', 'start', 'drawer.actual_start'], ['actual_date', 'actual', 'grid.actual']] as const).map(([f, id, label]) => (
            <div key={f}>
              <label className="block"><span className="text-mute">{t(label)}</span>
                <input type="date" className="input mono" data-testid={`drawer-${id}-date`} disabled={!edit} value={draft[f]} onChange={(e) => setDraft((d) => ({ ...d, [f]: e.target.value }))} />
              </label>
              <FieldHistory entityType="task" entityId={task.id} field={f} label={t(label)} />
            </div>
          ))}
          <div><span className="text-mute">{t('grid.sla')}</span>{task.sla?.measured === false
            ? <div className="font-semibold" data-testid="drawer-sla-not-measured">{t('sla.not_measured')}</div>
            : <div className="font-semibold">{task.sla?.min_wd ?? '–'}–{task.sla?.max_wd ?? '–'} {t('approvals.wd')} <span className={`chip ${task.sla?.colour === 'red' ? 'bg-lateBg text-lateInk' : 'bg-doneBg text-doneInk'}`}>{task.sla?.elapsed_wd ?? 0}</span>
              {task.sla?.pending_confirmation && <span className="chip ms-1 bg-waitBg text-waitInk" data-testid="drawer-sla-pending">{t('sla.pending_confirmation')}</span>}</div>}</div>
          {task.sla?.due_date && <div><span className="text-mute">{t('sla.due_date')}</span><div className="mono font-semibold" data-testid="drawer-due-date">{task.sla.due_date}
            {task.sla.due_date_tentative && <span className="chip ms-1 bg-waitBg text-waitInk" data-testid="drawer-due-tentative" title={t('sla.tentative_title', { dates: (task.sla.tentative_holidays ?? []).join(', ') })}>{t('sla.tentative_date')}</span>}</div></div>}
          {task.task_code === 'B6' && (
            /* 0.12.0 (Q13): the Layout Submitted Date, its own field (never taken from another date) */
            <div>
              <label className="block"><span className="text-mute">{t('drawer.layout_submitted')}</span>
                <input type="date" className="input mono" data-testid="drawer-layout-date" disabled={!edit} value={layout} onChange={(e) => setLayout(e.target.value)} />
              </label>
            </div>
          )}
          {edit && <div className="col-span-2"><DraftBar draft={dr} onRestore={(v) => setDraft((d) => ({ ...d, ...v }))} /></div>}
          {edit && <div className="col-span-2"><button className="btn" data-testid="drawer-save" disabled={(!dirty.length && !layoutDirty) || date.isPending} onClick={save}><Save size={16} />{t('drawer.save')}</button></div>}
        </section>

        <TaskRegisterFields fields={regFields} siteId={task.site_id} />
        </div>

        <section aria-label={t('grid.docs')} {...panelProps('documents', tab)}>
          <h3 className="mb-1 font-semibold">{t('approvals.documents', { count: task.slots.length })}</h3>
          <DocSlots task={task} edit={edit} />
        </section>
        <div {...panelProps('comments', tab)}><Comments task={task} /></div>
        <div {...panelProps('history', tab)}><History task={task} /></div>
        <div {...panelProps('time', tab)}>{tab === 'time' && <TimeInStatePanel taskId={task.id} />}</div>
        <div {...panelProps('delay', tab)}>{tab === 'delay' && <DelayPeriodsPanel taskId={task.id} />}</div>
      </div>
      <footer className="space-y-2 border-t border-line p-4">
        {submit && (final(submit) || submit.will_skip_to) && <p className="text-sm text-waitInk" data-testid="drawer-skip-note">{final(submit) ? t('drawer.self_approval_note') : t('drawer.skip_note', { level: submit.will_skip_to })}</p>}
        {submit && (missing || !!task.missing_for_submit?.length) && <p className="text-sm text-mute" data-testid="drawer-missing">{missing ? t('drawer.slots_missing') : t('taskErrors.mandatory_fields_missing_list', { list: task.missing_for_submit?.join(', ') })}</p>}
        <div className="flex gap-2">
          {start && <button className="btn" data-testid="drawer-start" disabled={op.isPending} onClick={() => run('start')}><Play size={16} />{t('drawer.start')}</button>}
          {claim && <button className="btn" data-testid="drawer-claim" disabled={op.isPending} onClick={() => run('claim')}><HandMetal size={16} />{t('drawer.claim')}</button>}
          {release && <button className="btn" data-testid="drawer-release" disabled={op.isPending} onClick={() => run('release')}><UserMinus size={16} />{t('drawer.release')}</button>}
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

/** `registerFields` come from the Site Register grid (contract 0.4.9: only the grid carries them). `nav` = the ids of the list the drawer was opened from, for next/previous. */
export function TaskDrawer({ taskId, onClose, registerFields = [], nav }: { taskId: string | null; onClose: () => void; registerFields?: TaskRegisterField[]; nav?: Pick<DrawerNav, 'ids' | 'onGo'> }) {
  const { t } = useTranslation();
  const q = useTask(taskId);
  return (
    <DrawerFrame name="task" testid="task-drawer" open={!!taskId} onClose={onClose} nav={nav && { ...nav, current: taskId }}>
      {q.data ? <Body key={q.data.id} task={q.data} regFields={registerFields} /> : <div className="p-4"><Dialog.Title className="font-bold">{t('common.loading')}</Dialog.Title></div>}
    </DrawerFrame>
  );
}
