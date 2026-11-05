import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, ChevronRight, Download, FileText, Lock, Upload, UserX } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { downloadTemplate, useUploadBatch } from '@/api/registers';
import { useDatePatch } from '@/api/sites';
import type { SiteTasks, TaskSummary } from '@/api/types';
import { taskErrorMessage } from '@/lib/taskErrors';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { registerErrorMessage } from '@/lib/registerErrors';
import type { ColDef } from '@/lib/tablePrefs';
import { Holders } from './HolderChip';
import { OverrideBadge } from './OverrideBadge';
import { MoreMenu } from './PageHeader';
import { EmptyState, NoResults } from './States';
import { ActiveChips, BulkBar, ColumnMenu, Empty, HEADER_H, HeaderRow, NotApplicable, pin, QuickFilter, SelectBox, totalWidth, tracks, Trunc, useTablePrefs } from './TableKit';
import { useToast } from './Toast';
import { useVirtual } from './useVirtual';

const ROWS = { comfortable: 56, compact: 40 } as const;
const DATE_FIELD = { plan: 'planned_date', actual: 'actual_date' } as const;
type DateCol = keyof typeof DATE_FIELD;
// Column ids double as the saved-preference keys; `code` is the pinned identity column.
const DEFS: ColDef[] = [
  { id: 'code', w: 72, min: 56, pinned: true }, { id: 'task', w: 240, min: 120 }, { id: 'ball', w: 200, min: 100 }, { id: 'plan', w: 120, min: 100 }, { id: 'actual', w: 120, min: 100 },
  { id: 'sla', w: 140, min: 90 }, { id: 'status', w: 140, min: 90 }, { id: 'docs', w: 80, min: 64 }, { id: 'template', w: 100, min: 84 },
];
const LABEL: Record<string, string> = { code: 'grid.code', task: 'grid.task', ball: 'grid.ball', plan: 'grid.plan', actual: 'grid.actual', sla: 'grid.sla', status: 'grid.status', docs: 'grid.docs', template: 'grid.template' };
const QUICK = { late: (x: TaskSummary) => x.sla?.colour === 'red', docs: (x: TaskSummary) => !!x.slots_required && (x.slots_filled ?? 0) < x.slots_required } as const;
type Quick = keyof typeof QUICK;
const STATE_TONE: Record<string, string> = { approved: 'bg-doneBg text-doneInk', entry: 'bg-openBg text-openInk', open: 'bg-openBg text-openInk', in_review: 'bg-waitBg text-waitInk', in_approval: 'bg-waitBg text-waitInk', locked: 'bg-lockBg text-lockInk', na: 'bg-lockBg text-lockInk' };
const SLA_TONE: Record<string, string> = { green: 'bg-doneBg text-doneInk', amber: 'bg-waitBg text-waitInk', red: 'bg-lateBg text-lateInk', none: 'bg-lockBg text-lockInk' };
const editable = (t: TaskSummary) => t.state === 'entry' || t.state === 'open';
const isIso = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

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
  const nav = useNavigate();
  const file = useRef<HTMLInputElement>(null);
  const upload = useUploadBatch();
  const fail = (e: unknown) => toast(e instanceof ApiError && (e.code === 'template_rejected' || e.status === 413) ? registerErrorMessage(t, e) : t('errors.generic'), 'err');
  const down = () => downloadTemplate(task.template_id ?? '', { taskId: task.id }).then((n) => toast(t('grid.downloaded', { name: n })), fail);
  const up = (f?: File) => {
    if (!f) return;
    // the file is staged at once; a batch of a register opens its review (the Entry then L2 flow decides the rows)
    upload.mutate({ file: f, template_id: task.template_id ?? '', task_id: task.id }, {
      onSuccess: (b) => { toast(t('grid.uploaded')); if (b.register_key) nav(`/registers/${b.register_key}/batches/${b.id}`); },
      onError: fail,
    });
  };
  return (
    <span className="flex gap-1">
      <button type="button" className="btn px-2" disabled={!task.template_id} aria-label={t('grid.template_download', { code: task.task_code })} data-testid={`task-template-download-${task.id}`} onClick={() => void down()}><Download size={14} /></button>
      <button type="button" className="btn px-2" disabled={!task.template_id} aria-label={t('grid.template_upload', { code: task.task_code })} data-testid={`task-template-upload-${task.id}`} onClick={() => file.current?.click()}><Upload size={14} /></button>
      <input ref={file} type="file" accept=".xlsx" hidden data-testid={`task-template-file-${task.id}`} onChange={(e) => { up(e.target.files?.[0]); e.target.value = ''; }} />
    </span>
  );
}

export function TaskGrid({ siteId, stages, onOpen, selected, onVisible }: { siteId: string; stages: SiteTasks['stages']; onOpen: (id: string) => void; selected?: string | null; onVisible?: (ids: string[]) => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const patch = useDatePatch(siteId);
  const [sp, setSp] = useSearchParams();
  const api2 = useTablePrefs('task-grid', DEFS);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [active, setActive] = useState({ row: 0, col: 0 });
  const [edit, setEdit] = useState<{ id: string; field: DateCol } | null>(null);
  const [draft, setDraft] = useState('');
  const [bad, setBad] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const box = useRef<HTMLDivElement>(null);
  const cancelled = useRef(false); // Esc unmounts the input; its blur must not save
  const ar = i18n.language === 'ar';
  const ROW = ROWS[api2.density];
  const hasSel = true;

  // Quick filters work on the loaded tasks of this site (the grid loads them all); the URL keeps them (plan F9).
  const qkey = sp.get('tf') ?? '';
  const quick = qkey.split(',').filter((x): x is Quick => x in QUICK);
  const setQuick = (next: Quick[]) => setSp((p) => { const n = new URLSearchParams(p); if (next.length) n.set('tf', next.join(',')); else n.delete('tf'); return n; }, { replace: true });
  const toggleQuick = (q: Quick) => setQuick(quick.includes(q) ? quick.filter((x) => x !== q) : [...quick, q]);
  const shown = useMemo(() => stages.map((st) => ({ ...st, shown: st.tasks.filter((x) => quick.every((q) => QUICK[q](x))) })), [stages, qkey]); // eslint-disable-line react-hooks/exhaustive-deps
  const totalTasks = stages.reduce((n, st) => n + st.tasks.length, 0);
  const shownTasks = shown.flatMap((st) => st.shown);
  const listKey = shownTasks.map((x) => x.id).join(',');
  useEffect(() => { onVisible?.(listKey ? listKey.split(',') : []); }, [listKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo<Row[]>(() => shown.flatMap((s) => {
    if (quick.length && !s.shown.length) return [];
    const done = s.tasks.filter((x) => x.state === 'approved').length;
    const head: Row = { kind: 'stage', code: s.code, name: (ar && s.name_ar) || s.name_en, done, total: s.tasks.length };
    return collapsed.has(s.code) ? [head] : [head, ...s.shown.map((task): Row => ({ kind: 'task', task }))];
  }), [shown, collapsed, ar, quick.length]);
  const viewport = Math.max(360, (typeof window === 'undefined' ? 800 : window.innerHeight) - 300);
  const v = useVirtual(rows.length, ROW, viewport);
  const cols = api2.cols, W = totalWidth(cols, hasSel);
  const label = (id: string) => t(LABEL[id]);
  const kcols = ['code', ...cols.map((c) => c.id).filter((c): c is DateCol => c in DATE_FIELD)]; // keyboard columns: the row (opens the drawer), then the visible date columns

  useLayoutEffect(() => { // scroll position is restored when coming back to the site (plan F9)
    const el = box.current, y = Number(sessionStorage.getItem(`pmis.scroll.grid.${siteId}`) ?? 0);
    if (el && y) el.scrollTop = y;
  }, [siteId]);
  useEffect(() => { // keep the active row inside the window when moving by keyboard
    const el = box.current;
    if (!el) return;
    const top = active.row * ROW + HEADER_H;
    if (top - HEADER_H < el.scrollTop) el.scrollTop = top - HEADER_H;
    else if (top + ROW > el.scrollTop + viewport) el.scrollTop = top + ROW - viewport;
  }, [active.row, viewport, ROW]);

  const startEdit = (task: TaskSummary, field: DateCol) => { cancelled.current = false; setDraft(task[DATE_FIELD[field]] ?? ''); setBad(false); setEdit({ id: task.id, field }); };
  const stop = () => { setEdit(null); box.current?.focus(); };
  const commit = (task: TaskSummary) => {
    if (!edit || cancelled.current) return;
    const field = DATE_FIELD[edit.field], val = draft.trim();
    if (val && !isIso(val)) { setBad(true); return; }
    if ((val || null) !== (task[field] ?? null)) {
      patch.mutate({ task, patch: { [field]: val || null } }, { onError: (e) => { const m = taskErrorMessage(t, e); if (m) toast(m, 'err'); } });
    }
    stop();
  };
  const flipPick = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allIds = shownTasks.map((x) => x.id);
  const allPicked = allIds.length > 0 && allIds.every((id) => picked.has(id));
  const pickedTasks = shownTasks.filter((x) => picked.has(x.id));

  const onKey = (e: KeyboardEvent) => {
    if (edit) return;
    const step = (dr: number, dc: number) => { e.preventDefault(); setActive((a) => ({ row: Math.min(rows.length - 1, Math.max(0, a.row + dr)), col: Math.min(kcols.length - 1, Math.max(0, a.col + dc)) })); };
    const flip = document.documentElement.dir === 'rtl' ? -1 : 1;
    if (e.key === 'ArrowDown') step(1, 0);
    else if (e.key === 'ArrowUp') step(-1, 0);
    else if (e.key === 'ArrowRight') step(0, flip);
    else if (e.key === 'ArrowLeft') step(0, -flip);
    else if (e.key === ' ') { const r = rows[active.row]; if (r?.kind === 'task') { e.preventDefault(); flipPick(r.task.id); } }
    else if (e.key === 'Enter') {
      const r = rows[active.row];
      if (!r) return;
      e.preventDefault();
      if (r.kind === 'stage') setCollapsed((c) => { const n = new Set(c); if (n.has(r.code)) n.delete(r.code); else n.add(r.code); return n; });
      else if (active.col > 0 && editable(r.task)) startEdit(r.task, kcols[active.col] as DateCol);
      else onOpen(r.task.id);
    }
  };

  const dateCell = (task: TaskSummary, field: DateCol, rowIx: number) => {
    const name = field, key = DATE_FIELD[field];
    const isActive = active.row === rowIx && kcols[active.col] === field;
    if (edit?.id === task.id && edit.field === field) {
      return (
        <input autoFocus className={`input mono px-1 py-1 ${bad ? 'border-late' : ''}`} dir="ltr" inputMode="numeric" placeholder="YYYY-MM-DD" aria-label={t(`grid.${name}`)} aria-invalid={bad} data-testid={`grid-input-${task.id}-${name}`}
          value={draft} onChange={(e) => { setDraft(e.target.value); setBad(false); }} onBlur={() => commit(task)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(task); } else if (e.key === 'Escape') { e.stopPropagation(); cancelled.current = true; stop(); } }} />
      );
    }
    return (
      <button type="button" tabIndex={-1} data-testid={`grid-cell-${task.id}-${name}`} dir="ltr"
        className={`mono rounded px-1 py-1 text-start text-sm ${editable(task) ? 'hover:bg-hover' : ''} ${isActive ? 'outline outline-2 outline-accent' : ''}`}
        onClick={() => { setActive({ row: rowIx, col: Math.max(0, kcols.indexOf(field)) }); if (editable(task)) startEdit(task, field); }}>
        {task[key] ?? (task.state === 'na' ? <NotApplicable /> : <Empty />)}
      </button>
    );
  };

  const cell = (id: string, task: TaskSummary, ix: number, name: string) => {
    switch (id) {
      case 'code': return <button type="button" tabIndex={-1} className={`mono text-start font-bold ${active.row === ix && active.col === 0 ? 'outline outline-2 outline-accent' : ''}`} data-testid={`grid-open-${task.id}`} onClick={() => { setActive({ row: ix, col: 0 }); onOpen(task.id); }}>{task.task_code}</button>;
      case 'task': return <button type="button" tabIndex={-1} className="flex w-full min-w-0 items-center gap-1 text-start" onClick={() => onOpen(task.id)}><Trunc text={name} />{task.return_count ? <span className="chip shrink-0 bg-lateBg text-lateInk">{t('grid.returned')}</span> : null}</button>;
      case 'ball': return <span className="flex flex-wrap items-center gap-1">{task.state === 'approved' || task.state === 'na' ? (task.state === 'na' ? <NotApplicable /> : <Empty />) : <Holders holders={task.ball_in_court?.holders ?? []} />}{task.holder_absent && <span className="chip bg-waitBg text-waitInk" data-testid={`absent-${task.id}`}><UserX size={12} className="me-1" />{t('grid.absent')}</span>}</span>;
      case 'plan': case 'actual': return dateCell(task, id, ix);
      case 'sla': return task.sla?.measured === false ? <span className="chip bg-lockBg text-lockInk" data-testid={`sla-not-measured-${task.id}`}>{t('sla.not_measured')}</span>
        : task.sla?.max_wd != null ? <span className="inline-flex flex-wrap items-center gap-1"><span data-testid={`sla-${task.id}`} data-colour={task.sla.colour} className={`chip ${SLA_TONE[task.sla.colour ?? 'none']}`}>{task.sla.min_wd}–{task.sla.max_wd} {t('approvals.wd')}{task.sla.colour === 'red' ? ` · ${t('grid.late')}` : ''}</span>
          {/* 0.12.0 (D4b): a tentative holiday inside the period; Q135: Pending SLA Confirmation */}
          {task.sla.due_date_tentative && <span className="chip bg-waitBg text-waitInk" data-testid={`sla-tentative-${task.id}`} title={t('sla.tentative_title', { dates: (task.sla.tentative_holidays ?? []).join(', ') })}>{t('sla.tentative_date')}</span>}
          {task.sla.pending_confirmation && <span className="chip bg-waitBg text-waitInk" data-testid={`sla-pending-${task.id}`}>{t('sla.pending_confirmation')}</span>}</span> : <Empty />;
      case 'status': return <span className="flex flex-wrap items-center gap-1"><span className={`chip ${STATE_TONE[task.state]}`}>{t(`taskState.${task.state}`)}</span>{task.state === 'locked' && <WhyLocked task={task} />}{task.historical_no_documents && <OverrideBadge taskId={task.id} />}</span>;
      case 'docs': return <span className={`chip ${task.slots_required && task.slots_filled === task.slots_required ? 'bg-doneBg text-doneInk' : 'bg-lockBg text-lockInk'}`} data-testid={`slots-${task.id}`}><FileText size={12} className="me-1" />{task.slots_filled ?? 0}/{task.slots_required ?? 0}</span>;
      default: return <TemplateButtons task={task} />;
    }
  };

  const chips = quick.map((q) => ({ key: `tf-${q}`, label: `${t(`table.${q === 'docs' ? 'missing_docs' : 'late'}`)} ${t('table.loaded_only')}`, onRemove: () => setQuick(quick.filter((x) => x !== q)) }));
  const copy = () => { void navigator.clipboard?.writeText(pickedTasks.map((x) => x.task_code).join('\n')); toast(t('table.copied', { count: pickedTasks.length })); };
  const downloads = pickedTasks.filter((x) => x.template_id);
  const downAll = async () => { let n = 0; for (const x of downloads) { try { await downloadTemplate(x.template_id ?? '', { taskId: x.id }); n += 1; } catch { toast(t('errors.generic'), 'err'); break; } } if (n) toast(t('table.tpl_done', { count: n })); };

  return (
    <div data-testid="task-grid-wrap">
      <div role="toolbar" aria-label={t('table.quick')} className="mb-2 flex flex-wrap items-center gap-2" data-testid="task-grid-tools">
        <QuickFilter testid="tf-late" on={quick.includes('late')} onClick={() => toggleQuick('late')}>{t('table.late')} {t('table.loaded_only')}</QuickFilter>
        <QuickFilter testid="tf-docs" on={quick.includes('docs')} onClick={() => toggleQuick('docs')}>{t('table.missing_docs')} {t('table.loaded_only')}</QuickFilter>
        <span className="ms-auto flex gap-2">
          <ColumnMenu api={api2} label={label} />
          <MoreMenu items={[{ id: 'reset', label: t('table.reset'), testid: 'more-reset-cols', onSelect: api2.reset }]} />
        </span>
      </div>
      <ActiveChips chips={chips} onClear={() => setQuick([])} />
      <div className="card overflow-hidden" data-testid="task-grid" data-density={api2.density}>
        <div ref={box} role="grid" tabIndex={0} aria-label={t('grid.title')} aria-rowcount={rows.length} aria-multiselectable data-testid="task-grid-body" className="relative overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-accent" style={{ height: viewport }}
          onScroll={(e) => { v.onScroll(e); sessionStorage.setItem(`pmis.scroll.grid.${siteId}`, String(e.currentTarget.scrollTop)); }} onKeyDown={onKey}>
          <HeaderRow api={api2} label={label} testid="task-grid-head" select={{ checked: allPicked, indeterminate: picked.size > 0, onChange: () => setPicked(allPicked ? new Set() : new Set(allIds)), label: t('table.select_all'), testid: 'grid-select-all' }} />
          <div className="relative" style={{ height: v.total, minWidth: W }}>
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
              const task = r.task, name = (ar && task.name_ar) || task.name_en, on = picked.has(task.id), cur = selected === task.id;
              return (
                <div key={task.id} role="row" aria-rowindex={ix + 1} aria-selected={on || cur} data-testid={`grid-row-${task.id}`} data-task={task.task_code} data-state={task.state} data-current={cur || undefined}
                  className={`absolute inset-x-0 grid items-center border-b border-line text-sm ${on ? 'bg-accentSoft' : active.row === ix ? 'bg-hover' : 'bg-card'} ${cur ? 'ring-2 ring-inset ring-accent' : ''}`} style={{ ...pos, gridTemplateColumns: tracks(cols, hasSel) }}>
                  <div className="sticky start-0 z-10 flex justify-center bg-inherit"><SelectBox checked={on} onChange={() => flipPick(task.id)} label={t('table.select_row', { code: task.task_code })} testid={`grid-select-${task.id}`} /></div>
                  {cols.map((c) => { const p = pin(c, hasSel); return <div key={c.id} data-col={c.id} className={`min-w-0 px-2 ${p.className}`} style={p.style}>{cell(c.id, task, ix, name)}</div>; })}
                </div>
              );
            })}
          </div>
        </div>
        {!rows.length && (totalTasks ? <NoResults testid="grid-empty" onClear={() => setQuick([])} /> : <EmptyState testid="grid-empty" title={t('table.no_data')} />)}
      </div>
      <BulkBar testid="grid-bulk" count={picked.size} loaded={totalTasks} total={totalTasks} onClear={() => setPicked(new Set())}>
        {picked.size === 1 && <button type="button" className="btn" data-testid="grid-bulk-open" onClick={() => onOpen(pickedTasks[0].id)}>{t('table.open_selected')}</button>}
        <button type="button" className="btn" data-testid="grid-bulk-copy" onClick={copy}>{t('table.copy_codes')}</button>
        <button type="button" className="btn" data-testid="grid-bulk-templates" disabled={!downloads.length} onClick={() => void downAll()}><Download size={14} />{t('table.download_templates')}</button>
      </BulkBar>
    </div>
  );
}
