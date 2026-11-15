import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRegions, useSites, useStreams } from '@/api/sites';
import { LocksDialog } from '@/components/WorkflowLocks';
import { FormDialog } from '@/components/FormDialog';
import { ConditionsEditor } from './Conditions';
import { TaskPicker } from './Dialogs';
import { diffCount, findCycle, type Diff, type G, type M, type P } from './model';
import type { GateCondition } from '@/api/workflowEditor';

/** A question with a reason and nothing else (deactivate, closing task, move across milestones, parallel run...). */
export function ReasonDialog({ title, hint, onClose, onSubmit, busy, error, testid = 'wfe-reason-dialog', children }: { title: string; hint?: string; onClose: () => void; onSubmit: (reason: string) => void; busy: boolean; error: string | null; testid?: string; children?: React.ReactNode }) {
  return (
    <FormDialog open onClose={onClose} testid={testid} title={title} busy={busy} error={error} onSubmit={onSubmit}>
      {hint && <p className="text-sm text-mute">{hint}</p>}
      {children}
    </FormDialog>
  );
}

/** Add a milestone (code and names) or rename one (names only). */
export function MilestoneDialog({ initial, onClose, onSubmit, busy, error }: { initial?: M; onClose: () => void; busy: boolean; error: string | null; onSubmit: (f: { code: string; name_en: string; name_ar: string }, reason: string) => void }) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [en, setEn] = useState(initial?.name_en ?? '');
  const [ar, setAr] = useState(initial?.name_ar ?? '');
  return (
    <FormDialog open onClose={onClose} testid="wfe-ms-dialog" title={initial ? `${t('wfe.rename')}: ${initial.code}` : t('wfe.add_milestone')} busy={busy} error={error}
      disabled={!en.trim() || (!initial && !code.trim())} onSubmit={(r) => onSubmit({ code: code.trim().toUpperCase(), name_en: en.trim(), name_ar: ar.trim() }, r)}>
      {!initial && <label className="block text-sm font-semibold">{t('wfe.code')}<input className="input mt-1 font-normal" dir="ltr" data-testid="wfe-ms-code" value={code} onChange={(e) => setCode(e.target.value)} /></label>}
      <label className="block text-sm font-semibold">{t('wfe.name_en')}<input className="input mt-1 font-normal" dir="ltr" data-testid="wfe-ms-en" value={en} onChange={(e) => setEn(e.target.value)} /></label>
      <label className="block text-sm font-semibold">{t('wfe.name_ar')}<input className="input mt-1 font-normal" dir="rtl" data-testid="wfe-ms-ar" value={ar} onChange={(e) => setAr(e.target.value)} /></label>
    </FormDialog>
  );
}

export type GateForm = { code: string; name_en: string; name_ar: string; sla_min_wd?: number; sla_max_wd?: number; conditions: GateCondition[] };
/** Add the gate after a milestone, or edit one: names, SLA and conditions (tasks, milestones, permits, dates with a working-day offset). */
export function GateDialog({ initial, from, to, all, milestones, permits, onClose, onSubmit, busy, error }: {
  initial?: G; from: string; to: string; all: P[]; milestones: M[]; permits?: string[]; onClose: () => void; busy: boolean; error: string | null; onSubmit: (f: GateForm, reason: string) => void;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [en, setEn] = useState(initial?.name_en ?? '');
  const [ar, setAr] = useState(initial?.name_ar ?? '');
  const [mn, setMn] = useState(String(initial?.sla_min_wd ?? ''));
  const [mx, setMx] = useState(String(initial?.sla_max_wd ?? ''));
  const [conds, setConds] = useState<GateCondition[]>(initial?.conditions ?? []);
  return (
    <FormDialog open wide onClose={onClose} testid="wfe-gate-dialog" title={initial ? `${t('wfe.edit_gate')}: ${initial.code}` : `${t('wfe.add_gate')}: ${from} → ${to}`} busy={busy} error={error} disabled={!en.trim() || (!initial && !code.trim())}
      onSubmit={(r) => onSubmit({ code: code.trim().toUpperCase(), name_en: en.trim(), name_ar: ar.trim(), ...(mn !== '' ? { sla_min_wd: Number(mn) } : {}), ...(mx !== '' ? { sla_max_wd: Number(mx) } : {}),
        conditions: conds.filter((c) => c.type === 'stop_work_blocks' || (c.ref ?? '').trim()) }, r)}>
      {!initial && <label className="block text-sm font-semibold">{t('wfe.code')}<input className="input mt-1 font-normal" dir="ltr" data-testid="wfe-gate-code" value={code} onChange={(e) => setCode(e.target.value)} /></label>}
      <label className="block text-sm font-semibold">{t('wfe.name_en')}<input className="input mt-1 font-normal" dir="ltr" data-testid="wfe-gate-en" value={en} onChange={(e) => setEn(e.target.value)} /></label>
      <label className="block text-sm font-semibold">{t('wfe.name_ar')}<input className="input mt-1 font-normal" dir="rtl" data-testid="wfe-gate-ar" value={ar} onChange={(e) => setAr(e.target.value)} /></label>
      <div className="flex gap-3">
        <label className="text-sm font-semibold">{t('wfe.sla_min')}<input type="number" min={0} className="input mt-1 font-normal" dir="ltr" data-testid="wfe-gate-sla-min" value={mn} onChange={(e) => setMn(e.target.value)} /></label>
        <label className="text-sm font-semibold">{t('wfe.sla_max')}<input type="number" min={0} className="input mt-1 font-normal" dir="ltr" data-testid="wfe-gate-sla-max" value={mx} onChange={(e) => setMx(e.target.value)} /></label>
      </div>
      <ConditionsEditor value={conds} onChange={setConds} prefix="wfe-gate-cond" tasks={all} milestones={milestones} permits={permits ?? []} />
    </FormDialog>
  );
}

/** The predecessors of one task, taken from every milestone. A loop is found before anything is sent; the server refuses it too. */
export function PredecessorDialog({ task, all, onClose, onSubmit, busy, error }: { task: P; all: P[]; onClose: () => void; busy: boolean; error: string | null; onSubmit: (list: string[], reason: string) => void }) {
  const { t } = useTranslation();
  const [sel, setSel] = useState<string[]>(task.predecessors ?? []);
  const loop = useMemo(() => findCycle(all.map((p) => (p.task_code === task.task_code ? { ...p, predecessors: sel } : p))), [all, task.task_code, sel]);
  return (
    <FormDialog open wide onClose={onClose} testid="wfe-pred-dialog" title={`${t('wfe.predecessors')}: ${task.task_code}`} busy={busy} error={error} disabled={!!loop} onSubmit={(r) => onSubmit(sel, r)}>
      <p className="text-sm text-mute">{t('wfe.pred_hint')}</p>
      <TaskPicker all={all} exclude={task.task_code} sel={sel} onChange={setSel} prefix="wfe-pred" />
      {loop && <p role="alert" className="text-sm text-lateInk" data-testid="wfe-pred-cycle">{t('wfe.cycle_found', { path: loop.join(' → ') })}</p>}
    </FormDialog>
  );
}

/** Duplicate a task: the copy sits right after it, with the same predecessors; only the code and the names are asked. */
export function DuplicateDialog({ source, onClose, onSubmit, busy, error }: { source: P; onClose: () => void; busy: boolean; error: string | null; onSubmit: (f: { code: string; name_en: string; name_ar: string }, reason: string) => void }) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [en, setEn] = useState(`${source.name_en ?? source.task_code} (${t('wfe.copy')})`);
  const [ar, setAr] = useState(source.name_ar ?? '');
  return (
    <FormDialog open onClose={onClose} testid="wfe-dup-dialog" title={`${t('wfe.duplicate')}: ${source.task_code}`} busy={busy} error={error} disabled={!code.trim() || !en.trim()} onSubmit={(r) => onSubmit({ code: code.trim().toUpperCase(), name_en: en.trim(), name_ar: ar.trim() }, r)}>
      <label className="block text-sm font-semibold">{t('wfe.code')}<input className="input mt-1 font-normal" dir="ltr" data-testid="wfe-dup-code" value={code} onChange={(e) => setCode(e.target.value)} /></label>
      <label className="block text-sm font-semibold">{t('wfe.name_en')}<input className="input mt-1 font-normal" dir="ltr" data-testid="wfe-dup-en" value={en} onChange={(e) => setEn(e.target.value)} /></label>
      <label className="block text-sm font-semibold">{t('wfe.name_ar')}<input className="input mt-1 font-normal" dir="rtl" data-testid="wfe-dup-ar" value={ar} onChange={(e) => setAr(e.target.value)} /></label>
    </FormDialog>
  );
}

/** The impact of the draft against its parent before publishing: what changed, the cycle check, the problems and warnings the server found. */
export function PreviewDialog({ diff, problems, warnings, cycle, loading, canPublish, onClose, onContinue }: { diff: Diff | null; problems: string[]; warnings: string[]; cycle: string[] | null; loading: boolean; canPublish: boolean; onClose: () => void; onContinue: () => void }) {
  const { t } = useTranslation();
  const line = (label: string, items: string[]) => items.length > 0 && <li key={label} data-testid={`wfe-prev-${label}`}>{t(`wfe.prev.${label}`)}: <span className="mono">{items.join(', ')}</span></li>;
  const blocked = !!cycle || problems.length > 0 || !canPublish;
  return (
    <FormDialog open wide onClose={onClose} testid="wfe-preview-dialog" title={t('wfe.preview_title')} withReason={false} onSubmit={() => onContinue()} submitLabel={t('wfe.continue_publish')} disabled={blocked || loading} busy={false} error={null}>
      {loading && <p className="text-sm text-mute">{t('wfe.loading')}</p>}
      {diff && <p className="text-sm font-semibold" data-testid="wfe-prev-count">{diffCount(diff) === 0 ? t('wfe.prev.none') : t('wfe.prev.count', { count: diffCount(diff) })}</p>}
      {diff && <ul className="list-disc ps-5 text-sm">
        {line('ms_added', diff.milestones.added)}{line('ms_removed', diff.milestones.removed)}{line('ms_renamed', diff.milestones.renamed)}{diff.milestones.reordered && <li data-testid="wfe-prev-ms_reordered">{t('wfe.prev.ms_reordered')}</li>}
        {line('g_added', diff.gates.added)}{line('g_removed', diff.gates.removed)}{line('g_changed', diff.gates.changed)}
        {line('t_added', diff.tasks.added)}{line('t_deactivated', diff.tasks.deactivated)}{line('t_moved', diff.tasks.moved)}{line('t_renamed', diff.tasks.renamed)}{line('t_relinked', diff.tasks.relinked)}{line('t_closing', diff.tasks.closing)}
      </ul>}
      <p className={`text-sm ${cycle ? 'text-lateInk' : 'text-doneInk'}`} role={cycle ? 'alert' : undefined} data-testid="wfe-prev-cycle">{cycle ? t('wfe.cycle_found', { path: cycle.join(' → ') }) : t('wfe.no_cycle')}</p>
      {problems.length > 0 && <ul role="alert" className="list-disc ps-5 text-sm text-lateInk" data-testid="wfe-prev-problems">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      {warnings.length > 0 && <ul className="list-disc ps-5 text-sm text-waitInk" data-testid="wfe-prev-warnings">{warnings.map((p) => <li key={p}>{p}</li>)}</ul>}
    </FormDialog>
  );
}

/** The shortcut to the site locks (0.15.4) from the workflow editor: the sites of a region and/or a stream, switched together through the same door as the Site Register. */
export function SiteLocksShortcut({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const regions = useRegions().data ?? [];
  const streams = useStreams().data ?? [];
  const [region, setRegion] = useState('');
  const [stream, setStream] = useState('');
  const [locked, setLocked] = useState(false);
  const [go, setGo] = useState(false);
  const ar = i18n.language === 'ar';
  const q = useSites({ q: '', region_id: region, scenario: '', overall_status: '', stage_code: '', ...(stream ? { stream } : {}) }, go);
  const ids = (q.data?.pages.flatMap((p) => p.items) ?? []).map((s) => s.id).slice(0, 500);
  if (go && q.data && !q.hasNextPage && ids.length > 0) {
    return <LocksDialog target={{ site_ids: ids }} locked={locked} count={ids.length} testid="wfe-locks-dialog" onClose={onClose} />;
  }
  if (go && q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  return (
    <FormDialog open onClose={onClose} testid="wfe-sitelocks" title={t('wfe.sitelocks.title')} withReason={false} submitLabel={t('wfe.sitelocks.find')} busy={go && (q.isFetching || q.hasNextPage)} disabled={go && q.isFetching}
      error={go && q.data && ids.length === 0 ? t('wfe.sitelocks.none') : null} onSubmit={() => setGo(true)}>
      <p className="text-sm text-mute">{t('wfe.sitelocks.hint')}</p>
      <label className="block text-sm font-semibold">{t('wfe.sitelocks.region')}
        <select className="input mt-1 font-normal" data-testid="wfe-sitelocks-region" value={region} onChange={(e) => { setRegion(e.target.value); setGo(false); }}>
          <option value="">{t('wfe.sitelocks.all')}</option>{regions.map((r) => <option key={r.id} value={String(r.id)}>{ar && r.name_ar ? r.name_ar : r.name_en}</option>)}</select></label>
      <label className="block text-sm font-semibold">{t('wfe.sitelocks.stream')}
        <select className="input mt-1 font-normal" data-testid="wfe-sitelocks-stream" value={stream} onChange={(e) => { setStream(e.target.value); setGo(false); }}>
          <option value="">{t('wfe.sitelocks.all')}</option>{streams.map((s) => <option key={s.code} value={s.code}>{ar && s.name_ar ? s.name_ar : s.name_en}</option>)}</select></label>
      <fieldset className="text-sm"><legend className="font-semibold">{t('wfe.sitelocks.action')}</legend>
        <label className="me-4"><input type="radio" name="wfe-sl" checked={!locked} onChange={() => setLocked(false)} data-testid="wfe-sitelocks-open" /> {t('locks.open')}</label>
        <label><input type="radio" name="wfe-sl" checked={locked} onChange={() => setLocked(true)} data-testid="wfe-sitelocks-lock" /> {t('locks.lock')}</label></fieldset>
    </FormDialog>
  );
}

/** Every task of the draft in one table, for bulk edits: pick rows, then activate, deactivate, change the counting flag or move them to a milestone. */
export function TableView({ rows, milestones, nm, canEdit, canMove, why, onBulk, onSelect }: {
  rows: P[]; milestones: M[]; nm: (x: { name_en?: string; name_ar?: string | null }) => string; canEdit: boolean; canMove: boolean; why: string | null;
  onBulk: (codes: string[], patch: { is_active?: boolean; counts_toward_milestone?: boolean; stage_code?: string }) => void; onSelect: (code: string) => void;
}) {
  const { t } = useTranslation();
  const [pick, setPick] = useState<string[]>([]);
  const [stage, setStage] = useState('');
  const toggle = (c: string, on: boolean) => setPick((p) => (on ? [...p, c] : p.filter((x) => x !== c)));
  const dis = !canEdit || pick.length === 0;
  const btn = (id: string, label: string, patch: { is_active?: boolean; counts_toward_milestone?: boolean }) => <button type="button" className="btn" data-testid={id} disabled={dis} title={!canEdit && why ? why : label} onClick={() => onBulk(pick, patch)}>{label}</button>;
  return (
    <section className="space-y-2" data-testid="wfe-table">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-mute" data-testid="wfe-table-picked">{t('wfe.table.picked', { count: pick.length })}</span>
        {btn('wfe-bulk-activate', t('wfe.activate'), { is_active: true })}{btn('wfe-bulk-deactivate', t('wfe.deactivate'), { is_active: false })}
        {btn('wfe-bulk-counts-on', t('wfe.table.counts_on'), { counts_toward_milestone: true })}{btn('wfe-bulk-counts-off', t('wfe.table.counts_off'), { counts_toward_milestone: false })}
        <select className="input" aria-label={t('wfe.move_to')} data-testid="wfe-bulk-stage" value={stage} onChange={(e) => setStage(e.target.value)}><option value="">{t('wfe.move_to')}</option>{milestones.filter((m) => m.is_active !== false).map((m) => <option key={m.code} value={m.code}>{m.code}</option>)}</select>
        <button type="button" className="btn" data-testid="wfe-bulk-move" disabled={dis || !canMove || !stage} title={!canMove && why ? why : t('wfe.move_to')} onClick={() => onBulk(pick, { stage_code: stage })}>{t('wfe.table.move')}</button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-mute"><th><input type="checkbox" aria-label={t('wfe.table.all')} data-testid="wfe-table-all" checked={pick.length === rows.length && rows.length > 0} onChange={(e) => setPick(e.target.checked ? rows.map((r) => r.task_code) : [])} /></th>
            <th className="text-start">{t('wfe.code')}</th><th className="text-start">{t('wfe.task_name')}</th><th className="text-start">{t('wfe.col.milestones')}</th><th className="text-start">{t('wfe.predecessors')}</th><th className="text-start">{t('wfe.counts')}</th><th className="text-start">{t('wfe.closes_short')}</th><th className="text-start">{t('wfe.active')}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.task_code} data-testid={`wfe-row-${r.task_code}`} className={r.is_active === false ? 'opacity-60' : ''}>
                <td><input type="checkbox" aria-label={r.task_code} data-testid={`wfe-pick-${r.task_code}`} checked={pick.includes(r.task_code)} onChange={(e) => toggle(r.task_code, e.target.checked)} /></td>
                <td className="mono"><button type="button" className="underline" onClick={() => onSelect(r.task_code)}>{r.task_code}</button></td>
                <td>{nm(r)}</td><td className="mono">{r.stage_code}</td><td className="mono">{(r.predecessors ?? []).join(', ') || '-'}</td>
                <td>{r.counts_toward_milestone ? t('common.yes') : t('common.no')}</td><td>{r.is_milestone_task ? t('common.yes') : t('common.no')}</td><td>{r.is_active === false ? t('common.no') : t('common.yes')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
