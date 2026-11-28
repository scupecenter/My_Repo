import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePicker } from '@/api/admin';
import { useSaveSubTask, useSubTasks, type SubTaskKind, type SubTaskRow } from '@/api/x';
import { DateInput } from '@/components/DateInput';
import { errText } from './FormDialog';
import { ErrorState, LoadingSkeleton } from './States';

const TONE: Record<string, string> = { open: 'bg-card2 text-mute', doing: 'bg-waitBg text-waitInk', done: 'bg-doneBg text-doneInk' };

/** One row: the status and progress of a sub-task. Whoever owns it may change both; the entry level may change everything and remove it. */
function Row({ kind, parentId, s, canEdit }: { kind: SubTaskKind; parentId: string; s: SubTaskRow; canEdit: boolean }) {
  const { t } = useTranslation();
  const save = useSaveSubTask(kind, parentId);
  const mayMove = canEdit || s.mine;
  const patch = (p: { state?: 'open' | 'doing' | 'done'; progress?: number; removed?: boolean }) => save.mutate({ id: s.id, version: s.version, patch: p });
  return (
    <li className="rounded-md border border-line bg-card p-2" data-testid={`subtask-${s.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <input type="checkbox" aria-label={t('subtasks.done_toggle')} title={t('subtasks.done_toggle')} checked={s.state === 'done'} disabled={!mayMove || save.isPending}
          data-testid={`subtask-check-${s.id}`} onChange={(e) => patch({ state: e.target.checked ? 'done' : 'open' })} />
        <span className={`min-w-0 flex-1 break-words ${s.state === 'done' ? 'text-mute line-through' : ''}`}>{s.title}</span>
        <span className={`rounded px-2 py-0.5 text-xs ${TONE[s.state]}`}>{t(`subtasks.state_${s.state}`)}</span>
        {canEdit && (
          <button type="button" className="btn btn-ghost" aria-label={t('subtasks.remove')} title={t('subtasks.remove_tip')} data-testid={`subtask-remove-${s.id}`} disabled={save.isPending} onClick={() => patch({ removed: true })}><Trash2 size={14} /></button>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-mute">
        <span title={t('subtasks.owner_tip')}>{s.owner_name ?? t('subtasks.no_owner')}</span>
        {s.due_date && <span title={t('subtasks.due_tip')}>{s.due_date}</span>}
        <label className="flex items-center gap-1" title={t('subtasks.progress_tip')}>
          <input type="range" min={0} max={100} step={5} value={s.progress} disabled={!mayMove || save.isPending} aria-label={t('subtasks.progress')}
            data-testid={`subtask-progress-${s.id}`} onChange={(e) => patch({ progress: Number(e.target.value) })} />
          <span className="tabular-nums">{s.progress}%</span>
        </label>
      </div>
      {save.isError && <p role="alert" className="mt-1 text-sm text-lateInk" data-testid={`subtask-error-${s.id}`}>{errText(save.error, t)}</p>}
    </li>
  );
}

/** The add form: a title, an optional owner (searched among the people the server offers) and an optional due date. */
function AddForm({ kind, parentId }: { kind: SubTaskKind; parentId: string }) {
  const { t } = useTranslation();
  const save = useSaveSubTask(kind, parentId);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [q, setQ] = useState('');
  const [owner, setOwner] = useState('');
  const people = usePicker(q);
  const add = () => save.mutate({ patch: { title: title.trim(), owner_id: owner || null, due_date: due || null } }, {
    onSuccess: () => { setTitle(''); setDue(''); setQ(''); setOwner(''); },
  });
  return (
    <div className="grid gap-2 rounded-md border border-dashed border-line p-2 sm:grid-cols-2" data-testid="subtask-add">
      <label className="sm:col-span-2">{t('subtasks.title')}
        <input className="input" data-testid="subtask-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label title={t('subtasks.owner_tip')}>{t('subtasks.owner')}
        <input className="input" data-testid="subtask-owner-search" value={q} placeholder={t('subtasks.owner_search')} onChange={(e) => { setQ(e.target.value); setOwner(''); }} />
        {(people.data?.length ?? 0) > 0 && !owner && (
          <select className="input mt-1" data-testid="subtask-owner" aria-label={t('subtasks.owner')} value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="" />
            {people.data?.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
          </select>
        )}
      </label>
      <label title={t('subtasks.due_tip')}>{t('subtasks.due')}<DateInput value={due} onChange={(e) => setDue(e.target.value)} /></label>
      <div className="sm:col-span-2">
        <button type="button" className="btn btn-primary" data-testid="subtask-add-btn" disabled={save.isPending || title.trim().length === 0} onClick={add}><Plus size={14} />{t('subtasks.add')}</button>
      </div>
      {save.isError && <p role="alert" className="text-sm text-lateInk sm:col-span-2" data-testid="subtask-add-error">{errText(save.error, t)}</p>}
    </div>
  );
}

/**
 * Sub-tasks of a task or a register record (0.15.474): a small list with an owner, a status and a progress per line, and the roll-up on top.
 * The roll-up is information only; it never moves the parent. The server judges every right (`can_edit`, the owner's own lines).
 */
export function SubTasks({ kind, parentId, enabled = true }: { kind: SubTaskKind; parentId: string; enabled?: boolean }) {
  const { t } = useTranslation();
  const q = useSubTasks(kind, parentId, enabled);
  if (!enabled) return <p className="text-mute" data-testid="subtasks-global">{t('subtasks.global')}</p>;
  if (q.isLoading) return <LoadingSkeleton rows={2} testid="subtasks-loading" />;
  if (q.isError || !q.data) return <ErrorState onRetry={() => void q.refetch()} />;
  const { items, rollup, can_edit } = q.data;
  return (
    <section className="grid gap-2" data-testid="subtasks" aria-label={t('subtasks.heading')}>
      <header className="flex flex-wrap items-center gap-3">
        <h3 className="font-semibold">{t('subtasks.heading')}</h3>
        {rollup.total > 0 && (
          <span className="flex items-center gap-2 text-sm text-mute" title={t('subtasks.rollup_tip')} data-testid="subtasks-rollup">
            <progress className="h-2 w-24" max={100} value={rollup.progress} aria-label={t('subtasks.progress')} />
            {t('subtasks.rollup', { done: rollup.done, total: rollup.total, pct: rollup.progress })}
          </span>
        )}
      </header>
      {items.length === 0 ? <p className="text-mute" data-testid="subtasks-empty">{t('subtasks.empty')}</p> : (
        <ul className="grid gap-2">{items.map((s) => <Row key={s.id} kind={kind} parentId={parentId} s={s} canEdit={can_edit} />)}</ul>
      )}
      {can_edit ? <AddForm kind={kind} parentId={parentId} /> : <p className="text-xs text-mute" data-testid="subtasks-readonly">{t('subtasks.readonly')}</p>}
    </section>
  );
}
