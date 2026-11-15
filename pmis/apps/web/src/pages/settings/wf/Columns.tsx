import { closestCenter, DndContext, KeyboardSensor, MouseSensor, pointerWithin, TouchSensor, useSensor, useSensors, type CollisionDetection, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, Ban, Copy, Flag, GripVertical, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { conditionLabel } from './Conditions';
import { bracketRole, parallelGroups, type G, type M, type P, type Sel } from './model';

/** The pointer decides first (a task dropped on a milestone row), the closest centre otherwise. */
const collide: CollisionDetection = (a) => { const hits = pointerWithin(a); return hits.length ? hits : closestCenter(a); };

/** What every column needs to know about what the admin may do now, and why not. */
export type Can = { edit: boolean; struct: boolean; why: string | null; busy: boolean };

/** A button that is off for a stated reason: the reason is its title and is read out with it. */
export function Act({ onClick, label, icon, testid, disabled, why, accent }: { onClick: () => void; label: string; icon: React.ReactNode; testid: string; disabled?: boolean; why?: string | null; accent?: boolean }) {
  return (
    <button type="button" className={`btn px-2 py-1 text-xs ${accent ? 'btn-accent' : ''}`} data-testid={testid} disabled={disabled} title={disabled && why ? why : label} aria-label={label} aria-describedby={undefined} onClick={onClick}>
      {icon}<span className="sr-only md:not-sr-only md:ms-1">{label}</span>
    </button>
  );
}

function Handle({ id, disabled, label, children, active, onClick, testid, className = '' }: { id: string; disabled?: boolean; label: string; children: React.ReactNode; active?: boolean; onClick: () => void; testid: string; className?: string }) {
  const s = useSortable({ id, disabled });
  return (
    <li ref={s.setNodeRef} style={{ transform: CSS.Transform.toString(s.transform), transition: s.transition, opacity: s.isDragging ? 0.5 : 1 }}
      className={`rounded border p-2 ${active ? 'border-link bg-card' : 'border-line'} ${s.isOver && !s.isDragging ? 'ring-2 ring-link' : ''} ${className}`} data-testid={testid} data-active={active ? 'true' : 'false'}>
      <div className="flex items-start gap-1">
        <button type="button" className="mt-0.5 cursor-grab touch-none text-mute disabled:cursor-not-allowed disabled:opacity-40" aria-label={label} disabled={disabled} {...s.attributes} {...s.listeners}><GripVertical size={16} aria-hidden /></button>
        <div className="min-w-0 flex-1" onClick={onClick}>{children}</div>
      </div>
    </li>
  );
}

export function Board({ onDrop, children }: { onDrop: (e: DragEndEvent) => void; children: React.ReactNode }) {
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  return <DndContext sensors={sensors} collisionDetection={collide} onDragEnd={onDrop}>{children}</DndContext>;
}

type MsP = {
  milestones: M[]; selected: string; nm: (x: { name_en?: string; name_ar?: string | null }) => string; can: Can; taskCount: (code: string) => number;
  onSelect: (c: string) => void; onAdd: () => void; onRename: (m: M) => void; onToggle: (m: M) => void; onRemove: (m: M) => void; onMove: (i: number, d: -1 | 1) => void;
};
/** Column 1: the milestones in order. Drag a row to reorder; drop a task on a row to move it there. */
export function MilestoneColumn(p: MsP) {
  const { t } = useTranslation();
  return (
    <section className="space-y-2" data-testid="wfe-col-milestones" aria-label={t('wfe.col.milestones')}>
      <div className="flex items-center justify-between"><h4 className="font-semibold">{t('wfe.col.milestones')}</h4>
        <Act testid="wfe-ms-add" label={t('wfe.add_milestone')} icon={<Plus size={14} aria-hidden />} disabled={!p.can.struct} why={p.can.why} onClick={p.onAdd} /></div>
      <SortableContext items={p.milestones.map((m) => `ms:${m.code}`)} strategy={verticalListSortingStrategy}>
        <ol className="space-y-1">
          {p.milestones.map((m, i) => (
            <Handle key={m.code} id={`ms:${m.code}`} disabled={!p.can.struct} label={t('wfe.drag_milestone', { code: m.code })} active={p.selected === m.code} onClick={() => p.onSelect(m.code)} testid={`wfe-stage-${m.code}`} className={m.is_active === false ? 'opacity-60' : ''}>
              <p className="text-sm font-semibold">{i + 1}. {p.nm(m)} <span className="mono text-mute">{m.code}</span>{m.is_active === false ? ` (${t('wfe.inactive')})` : ''}</p>
              <p className="text-xs text-mute">{t('wfe.n_tasks', { count: p.taskCount(m.code) })}</p>
              <div className="mt-1 flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
                <Act testid={`wfe-ms-${m.code}`} label={t('wfe.rename')} icon={<Pencil size={14} aria-hidden />} disabled={!p.can.edit} why={p.can.why} onClick={() => p.onRename(m)} />
                <Act testid={`wfe-ms-up-${m.code}`} label={t('wfe.up')} icon={<ArrowUp size={14} aria-hidden />} disabled={!p.can.struct || i === 0} why={p.can.why} onClick={() => p.onMove(i, -1)} />
                <Act testid={`wfe-ms-down-${m.code}`} label={t('wfe.down')} icon={<ArrowDown size={14} aria-hidden />} disabled={!p.can.struct || i === p.milestones.length - 1} why={p.can.why} onClick={() => p.onMove(i, 1)} />
                <Act testid={`wfe-ms-toggle-${m.code}`} label={m.is_active === false ? t('wfe.activate') : t('wfe.deactivate')} icon={m.is_active === false ? <RotateCcw size={14} aria-hidden /> : <Ban size={14} aria-hidden />} disabled={!p.can.struct} why={p.can.why} onClick={() => p.onToggle(m)} />
                <Act testid={`wfe-ms-del-${m.code}`} label={t('wfe.remove')} icon={<Trash2 size={14} aria-hidden />} disabled={!p.can.struct} why={p.can.why} onClick={() => p.onRemove(m)} />
              </div>
            </Handle>
          ))}
        </ol>
      </SortableContext>
    </section>
  );
}

type TaskP = {
  rows: P[]; sel: Sel; nm: (x: { name_en?: string; name_ar?: string | null }) => string; can: Can; milestoneName: string;
  onSelect: (c: string) => void; onInsert: (afterIndex: number) => void; onRename: (p: P) => void; onDuplicate: (p: P) => void; onToggle: (p: P) => void; onRemove: (p: P) => void; onMove: (i: number, d: -1 | 1) => void;
};
const BRACKET: Record<string, string> = { none: '', single: 'border-s-4 border-link', start: 'border-s-4 border-link rounded-be-none rounded-te-md', mid: 'border-s-4 border-link', end: 'border-s-4 border-link' };

/** Column 2: the tasks of the selected milestone in order, with a side bracket on tasks that run in parallel and a flag on the task that closes the milestone. */
export function TaskColumn(p: TaskP) {
  const { t } = useTranslation();
  const { index, groups } = parallelGroups(p.rows);
  const gap = (i: number) => (
    <li key={`gap-${i}`} className="flex justify-center"><button type="button" className="btn px-2 py-0 text-xs" data-testid={`wfe-gap-${i}`} disabled={!p.can.edit} title={!p.can.edit ? p.can.why ?? '' : t('wfe.insert_here')} aria-label={t('wfe.insert_here')} onClick={() => p.onInsert(i)}><Plus size={12} aria-hidden /></button></li>
  );
  return (
    <section className="space-y-2" data-testid="wfe-col-tasks" aria-label={t('wfe.col.tasks')}>
      <h4 className="font-semibold">{t('wfe.col.tasks')} <span className="text-mute">{p.milestoneName}</span></h4>
      {groups.length > 0 && <p className="text-xs text-mute" data-testid="wfe-parallel-note">{t('wfe.parallel_note', { count: groups.length })}</p>}
      <SortableContext items={p.rows.map((r) => `task:${r.task_code}`)} strategy={verticalListSortingStrategy}>
        <ol className="space-y-1">
          {gap(0)}
          {p.rows.flatMap((r, i) => [
            <Handle key={r.task_code} id={`task:${r.task_code}`} disabled={!p.can.edit} label={t('wfe.drag_task', { code: r.task_code })} active={p.sel?.kind === 'task' && p.sel.code === r.task_code} onClick={() => p.onSelect(r.task_code)}
              testid={`wfe-task-${r.task_code}`} className={`${BRACKET[bracketRole(index, i)]} ${r.is_active === false ? 'opacity-60' : ''}`}>
              <p className="text-sm"><span className="mono font-semibold">{r.task_code}</span> {p.nm(r)}{r.is_active === false ? ` (${t('wfe.inactive')})` : ''}
                {r.is_milestone_task && <span className="chip ms-1 bg-lockBg text-lockInk" data-testid={`wfe-closing-${r.task_code}`} title={t('wfe.closes_milestone')}><Flag size={12} className="me-1" aria-hidden />{t('wfe.closes_short')}</span>}
                {index[i]! >= 0 && <span className="chip ms-1 bg-waitBg text-waitInk" data-testid={`wfe-parallel-${r.task_code}`}>{t('wfe.parallel_chip', { n: index[i]! + 1 })}</span>}</p>
              <p className="mono text-xs text-mute" data-testid={`wfe-preds-${r.task_code}`}>{(r.predecessors ?? []).join(', ') || '-'}</p>
              <div className="mt-1 flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
                <Act testid={`wfe-up-${r.task_code}`} label={t('wfe.up')} icon={<ArrowUp size={14} aria-hidden />} disabled={!p.can.edit || i === 0} why={p.can.why} onClick={() => p.onMove(i, -1)} />
                <Act testid={`wfe-down-${r.task_code}`} label={t('wfe.down')} icon={<ArrowDown size={14} aria-hidden />} disabled={!p.can.edit || i === p.rows.length - 1} why={p.can.why} onClick={() => p.onMove(i, 1)} />
                <Act testid={`wfe-edit-${r.task_code}`} label={t('wfe.rename')} icon={<Pencil size={14} aria-hidden />} disabled={!p.can.edit} why={p.can.why} onClick={() => p.onRename(r)} />
                <Act testid={`wfe-dup-${r.task_code}`} label={t('wfe.duplicate')} icon={<Copy size={14} aria-hidden />} disabled={!p.can.edit} why={p.can.why} onClick={() => p.onDuplicate(r)} />
                <Act testid={`wfe-toggle-${r.task_code}`} label={r.is_active === false ? t('wfe.activate') : t('wfe.deactivate')} icon={r.is_active === false ? <RotateCcw size={14} aria-hidden /> : <Ban size={14} aria-hidden />} disabled={!p.can.edit} why={p.can.why} onClick={() => p.onToggle(r)} />
                <Act testid={`wfe-del-${r.task_code}`} label={t('wfe.remove')} icon={<Trash2 size={14} aria-hidden />} disabled={!p.can.edit} why={p.can.why} onClick={() => p.onRemove(r)} />
              </div>
            </Handle>,
            gap(i + 1),
          ])}
        </ol>
      </SortableContext>
      {p.rows.length === 0 && <p className="text-sm text-mute" data-testid="wfe-no-tasks">{t('wfe.no_tasks')}</p>}
    </section>
  );
}

type GateP = {
  gates: G[]; milestone: string; sel: Sel; nm: (x: { name_en?: string; name_ar?: string | null }) => string; can: Can; canAdd: boolean;
  onSelect: (c: string) => void; onAdd: () => void; onEdit: (g: G) => void; onToggle: (g: G) => void; onRemove: (g: G) => void;
};
/** Column 3: the gate after the selected milestone, with its SLA and conditions. */
export function GateColumn(p: GateP) {
  const { t } = useTranslation();
  return (
    <section className="space-y-2" data-testid="wfe-col-gate" aria-label={t('wfe.col.gate')}>
      <div className="flex items-center justify-between"><h4 className="font-semibold">{t('wfe.col.gate')}</h4>
        {p.gates.length === 0 && <Act testid="wfe-gate-add" label={t('wfe.add_gate')} icon={<Plus size={14} aria-hidden />} disabled={!p.can.struct || !p.canAdd} why={p.can.why ?? (p.canAdd ? null : t('wfe.no_next_milestone'))} onClick={p.onAdd} />}</div>
      {p.gates.length === 0 && <p className="text-sm text-mute" data-testid="wfe-no-gate">{t('wfe.no_gate')}</p>}
      {p.gates.map((g) => (
        <div key={g.code} className={`rounded border p-2 ${p.sel?.kind === 'gate' && p.sel.code === g.code ? 'border-link bg-card' : 'border-line'} ${g.is_active === false ? 'opacity-60' : ''}`} data-testid={`wfe-gate-${g.code}`}>
          <button type="button" className="block w-full text-start" onClick={() => p.onSelect(g.code)} data-testid={`wfe-gate-open-${g.code}`}>
            <p className="text-sm font-semibold"><span className="mono">{g.code}</span> {p.nm(g)}{g.is_active === false ? ` (${t('wfe.inactive')})` : ''}</p>
            <p className="text-xs text-mute">{g.from_milestone} → {g.to_milestone} · SLA {g.sla_min_wd ?? '-'}/{g.sla_max_wd ?? '-'}</p>
          </button>
          <ul className="mt-1 list-disc ps-5 text-xs" data-testid={`wfe-gate-conds-${g.code}`}>
            {(g.conditions ?? []).length === 0 ? <li className="list-none text-mute">{t('wfe.cond.none')}</li> : (g.conditions ?? []).map((c, i) => <li key={i}>{conditionLabel(c, t)}</li>)}
          </ul>
          <div className="mt-1 flex flex-wrap gap-1">
            <Act testid={`wfe-gate-edit-${g.code}`} label={t('wfe.edit_gate')} icon={<Pencil size={14} aria-hidden />} disabled={!p.can.edit} why={p.can.why} onClick={() => p.onEdit(g)} />
            <Act testid={`wfe-gate-toggle-${g.code}`} label={g.is_active === false ? t('wfe.activate') : t('wfe.deactivate')} icon={g.is_active === false ? <RotateCcw size={14} aria-hidden /> : <Ban size={14} aria-hidden />} disabled={!p.can.struct} why={p.can.why} onClick={() => p.onToggle(g)} />
            <Act testid={`wfe-gate-del-${g.code}`} label={t('wfe.remove')} icon={<Trash2 size={14} aria-hidden />} disabled={!p.can.struct} why={p.can.why} onClick={() => p.onRemove(g)} />
          </div>
        </div>
      ))}
    </section>
  );
}
