import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, ChevronRight, Download, FileText, Lock, Upload, UserX } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError, downloadFile } from '@/api/client';
import { useDatePatch } from '@/api/sites';
import type { SiteTasks, TaskSummary } from '@/api/types';
import { taskErrorMessage } from '@/lib/taskErrors';
import { Holders } from './HolderChip';
import { useToast } from './Toast';
import { useVirtual } from './useVirtual';

const ROW = 56;
const COLS = ['open', 'planned_date', 'actual_date'] as const; // keyboard columns: row (opens the drawer), plan, actual
const FIELD = { planned_date: 'plan', actual_date: 'actual' } as const;
const STATE_TONE: Record<string, string> = { approved: 'bg-doneBg text-doneInk', entry: 'bg-openBg text-openInk', open: 'bg-openBg text-openInk', in_review: 'bg-waitBg text-waitInk', in_approval: 'bg-waitBg text-waitInk', locked: 'bg-lockBg text-lockInk', na: 'bg-lockBg text-lockInk' };
const SLA_TONE: Record<string, string> = { green: 'bg-doneBg text-doneInk', amber: 'bg-waitBg text-waitInk', red: 'bg-lateBg text-lateInk', none: 'bg-lockBg text-lockInk' };
const editable = (t: TaskSummary) => t.state === 'entry' || t.state === 'open';
const isIso = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const GRID = 'grid grid-cols-[64px_minmax(160px,1.5fr)_minmax(150px,1.3fr)_112px_112px_130px_120px_70px_92px] items-center gap-2 px-3';

type Row = { kind: 'stage'; code: string; name: string; done: number; total: number } | { kind: 'task'; task: TaskSummary };

function WhyLocked({ task }: { task: TaskSummary }) {
  const { t } = useTranslation();
  return (
    <Popover.Root>
      <Popover.Trigger asChild><button type="button" className="btn px-2 py-0.5 text-xs" data-testid={`why-locked-${task.id}`}><Lock size={12} />{t('grid.why_locked')}</button></Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={6} className="card z-50 w-72 p-3 text-sm" data-testid="why-locked-card">
          <b>{t('grid.locked_title')}</b>
          {task.lock_reasons?.length ? <ul className="mt-1 list-disc ps-4">{task.lock_reasons.map((r, i) => <li key={i}>{r.message}</li>)}</ul> : <p className="text-mute">{t('grid.locked_none')}</p>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function TemplateButtons({ task }: { task: TaskSummary }) {
  const { t } = useTranslation();
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const fail = (e: unknown) => toast(e instanceof ApiError && e.code === 'template_rejected' ? t('grid.template_rejected') : t('errors.generic'), 'err');
  const down = () => downloadFile(`/templates/${task.template_id}/download`, { task_id: task.id }).then((n) => toast(t('grid.downloaded', { name: n })), fail);
  const up = (f?: File) => {
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f); fd.append('template_id', task.template_id ?? ''); fd.append('task_id', task.id);
    api.post('/import-batches', { body: fd, idempotencyKey: crypto.randomUUID() }).then(() => toast(t('grid.uploaded')), fail);
  };
  return (
    <span className="flex gap-1">
      <button type="button" className="btn px-2" disabled={!task.template_id} aria-label={t('grid.template_download', { code: task.task_code })} data-testid={`task-template-download-${task.id}`} onClick={() => void down()}><Download size={14} /></button>
      <button type="button" className="btn px-2" disabled={!task.template_id} aria-label={t('grid.template_upload', { code: task.task_code })} data-testid={`task-template-upload-${task.id}`} onClick={() => file.current?.click()}><Upload size={14} /></button>
      <input ref={file} type="file" accept=".xlsx" hidden data-testid={`task-template-file-${task.id}`} onChange={(e) => { up(e.target.files?.[0]); e.target.value = ''; }} />
    </span>
  );
}

export function TaskGrid({ siteId, stages, onOpen }: { siteId: string; stages: SiteTasks['stages']; onOpen: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const patch = useDatePatch(siteId);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [active, setActive] = useState({ row: 0, col: 0 });
  const [edit, setEdit] = useState<{ id: string; col: 1 | 2 } | null>(null);
  const [draft, setDraft] = useState('');
  const [bad, setBad] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const cancelled = useRef(false); // Esc unmounts the input; its blur must not save
  const ar = i18n.language === 'ar';

  const rows = useMemo<Row[]>(() => stages.flatMap((s) => {
    const done = s.tasks.filter((x) => x.state === 'approved').length;
    const head: Row = { kind: 'stage', code: s.code, name: (ar && s.name_ar) || s.name_en, done, total: s.tasks.length };
    return collapsed.has(s.code) ? [head] : [head, ...s.tasks.map((task): Row => ({ kind: 'task', task }))];
  }), [stages, collapsed, ar]);
  const viewport = Math.max(360, (typeof window === 'undefined' ? 800 : window.innerHeight) - 260);
  const v = useVirtual(rows.length, ROW, viewport);

  useEffect(() => { // keep the active row inside the window when moving by keyboard
    const el = box.current;
    if (!el) return;
    const top = active.row * ROW;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW > el.scrollTop + viewport) el.scrollTop = top + ROW - viewport;
  }, [active.row, viewport]);

  const startEdit = (task: TaskSummary, col: 1 | 2) => { cancelled.current = false; setDraft(task[COLS[col]] ?? ''); setBad(false); setEdit({ id: task.id, col }); };
  const stop = () => { setEdit(null); box.current?.focus(); };
  const commit = (task: TaskSummary) => {
    if (!edit || cancelled.current) return;
    const field = COLS[edit.col] as 'planned_date' | 'actual_date', val = draft.trim();
    if (val && !isIso(val)) { setBad(true); return; }
    if ((val || null) !== (task[field] ?? null)) {
      patch.mutate({ task, patch: { [field]: val || null } }, { onError: (e) => { const m = taskErrorMessage(t, e); if (m) toast(m, 'err'); } });
    }
    stop();
  };

  const onKey = (e: KeyboardEvent) => {
    if (edit) return;
    const step = (dr: number, dc: number) => { e.preventDefault(); setActive((a) => ({ row: Math.min(rows.length - 1, Math.max(0, a.row + dr)), col: Math.min(2, Math.max(0, a.col + dc)) })); };
    const flip = document.documentElement.dir === 'rtl' ? -1 : 1;
    if (e.key === 'ArrowDown') step(1, 0);
    else if (e.key === 'ArrowUp') step(-1, 0);
    else if (e.key === 'ArrowRight') step(0, flip);
    else if (e.key === 'ArrowLeft') step(0, -flip);
    else if (e.key === 'Enter') {
      const r = rows[active.row];
      if (!r) return;
      e.preventDefault();
      if (r.kind === 'stage') setCollapsed((c) => { const n = new Set(c); if (n.has(r.code)) n.delete(r.code); else n.add(r.code); return n; });
      else if (active.col > 0 && editable(r.task)) startEdit(r.task, active.col as 1 | 2);
      else onOpen(r.task.id);
    }
  };

  const dateCell = (task: TaskSummary, col: 1 | 2, rowIx: number) => {
    const key = COLS[col] as 'planned_date' | 'actual_date', name = FIELD[key];
    const isActive = active.row === rowIx && active.col === col;
    if (edit?.id === task.id && edit.col === col) {
      return (
        <input autoFocus className={`input mono px-1 py-1 ${bad ? 'border-late' : ''}`} dir="ltr" inputMode="numeric" placeholder="YYYY-MM-DD" aria-label={t(`grid.${name}`)} aria-invalid={bad} data-testid={`grid-input-${task.id}-${name}`}
          value={draft} onChange={(e) => { setDraft(e.target.value); setBad(false); }} onBlur={() => commit(task)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(task); } else if (e.key === 'Escape') { e.stopPropagation(); cancelled.current = true; stop(); } }} />
      );
    }
    return (
      <button type="button" tabIndex={-1} data-testid={`grid-cell-${task.id}-${name}`} dir="ltr"
        className={`mono rounded px-1 py-1 text-start text-sm ${editable(task) ? 'hover:bg-hover' : ''} ${isActive ? 'outline outline-2 outline-accent' : ''}`}
        onClick={() => { setActive({ row: rowIx, col }); if (editable(task)) startEdit(task, col); }}>
        {task[key] ?? '—'}
      </button>
    );
  };

  return (
    <div className="card overflow-hidden" data-testid="task-grid">
      <div className={`${GRID} border-b border-line bg-card2 py-2 text-sm font-semibold text-mute`} role="row">
        <span>{t('grid.code')}</span><span>{t('grid.task')}</span><span>{t('grid.ball')}</span><span>{t('grid.plan')}</span><span>{t('grid.actual')}</span><span>{t('grid.sla')}</span><span>{t('grid.status')}</span><span>{t('grid.docs')}</span><span>{t('grid.template')}</span>
      </div>
      <div ref={box} role="grid" tabIndex={0} aria-label={t('grid.title')} aria-rowcount={rows.length} data-testid="task-grid-body" className="relative overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-accent" style={{ height: viewport }} onScroll={v.onScroll} onKeyDown={onKey}>
        <div style={{ height: v.total }}>
          {rows.slice(v.start, v.end).map((r, k) => {
            const ix = v.start + k, pos = { insetBlockStart: ix * ROW, height: ROW };
            if (r.kind === 'stage') {
              const open = !collapsed.has(r.code);
              return (
                <div key={r.code} role="row" aria-rowindex={ix + 1} data-testid={`grid-stage-${r.code}`} className={`absolute inset-x-0 flex items-center gap-2 border-b border-line bg-card2 px-3 font-semibold ${active.row === ix ? 'outline outline-2 -outline-offset-2 outline-accent' : ''}`} style={pos}>
                  <button type="button" tabIndex={-1} aria-expanded={open} aria-label={r.name} onClick={() => setCollapsed((c) => { const n = new Set(c); if (open) n.add(r.code); else n.delete(r.code); return n; })}>{open ? <ChevronDown size={16} className="rtl:rotate-90" /> : <ChevronRight size={16} className="rtl:rotate-180" />}</button>
                  {r.name} <span className="mono text-mute">{r.done}/{r.total}</span>
                </div>
              );
            }
            const task = r.task, name = (ar && task.name_ar) || task.name_en;
            return (
              <div key={task.id} role="row" aria-rowindex={ix + 1} data-testid={`grid-row-${task.id}`} data-task={task.task_code} data-state={task.state} className={`${GRID} absolute inset-x-0 border-b border-line text-sm ${active.row === ix ? 'bg-hover' : ''}`} style={pos}>
                <button type="button" tabIndex={-1} className={`mono text-start font-bold ${active.row === ix && active.col === 0 ? 'outline outline-2 outline-accent' : ''}`} data-testid={`grid-open-${task.id}`} onClick={() => { setActive({ row: ix, col: 0 }); onOpen(task.id); }}>{task.task_code}</button>
                <button type="button" tabIndex={-1} className="truncate text-start" onClick={() => onOpen(task.id)}>{name}{task.return_count ? <span className="chip ms-1 bg-lateBg text-lateInk">{t('grid.returned')}</span> : null}</button>
                <span className="flex flex-wrap items-center gap-1">{task.state === 'approved' || task.state === 'na' ? <span className="text-mute">—</span> : <Holders holders={task.ball_in_court?.holders ?? []} />}{task.holder_absent && <span className="chip bg-waitBg text-waitInk" data-testid={`absent-${task.id}`}><UserX size={12} className="me-1" />{t('grid.absent')}</span>}</span>
                {dateCell(task, 1, ix)}
                {dateCell(task, 2, ix)}
                <span>{task.sla?.max_wd != null ? <span data-testid={`sla-${task.id}`} data-colour={task.sla.colour} className={`chip ${SLA_TONE[task.sla.colour ?? 'none']}`}>{task.sla.min_wd}–{task.sla.max_wd} {t('approvals.wd')}{task.sla.colour === 'red' ? ` · ${t('grid.late')}` : ''}</span> : <span className="text-mute">—</span>}</span>
                <span className="flex flex-col items-start gap-0.5"><span className={`chip ${STATE_TONE[task.state]}`}>{t(`taskState.${task.state}`)}</span>{task.state === 'locked' && <WhyLocked task={task} />}</span>
                <span className={`chip ${task.slots_required && task.slots_filled === task.slots_required ? 'bg-doneBg text-doneInk' : 'bg-lockBg text-lockInk'}`} data-testid={`slots-${task.id}`}><FileText size={12} className="me-1" />{task.slots_filled ?? 0}/{task.slots_required ?? 0}</span>
                <TemplateButtons task={task} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
