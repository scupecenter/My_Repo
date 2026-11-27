import { Copy, Diamond, Link2, MoveRight, Power, PowerOff } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { GateCondition, SlaWeightItem } from '@/api/workflowEditor';
import { FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { ConditionsEditor } from '../wf/Conditions';
import { TaskPicker } from '../wf/Dialogs';
import { DuplicateDialog, PredecessorDialog } from '../wf/Forms';
import { findCycle, parallelGroups, successorsOf, type P } from '../wf/model';
import { SlaWeightSection } from '../wf/SlaWeightSection';
import { Chev, Code, ltr, Name, useArrow } from '../wf/rtl';
import { useErr } from '../wf/useErr';
import { masterCol, nextMilestone } from './studioModel';
import { ClosingToggle } from './StudioClosing';
import type { Ctx } from './studioCtx';
import { TaskColumnsCard } from './StudioColumns';

/** A calm card: white, 12px radius, 1px border, 16 to 18px padding. */
export function StudioCard({ title, children, testid, aside }: { title: string; children: ReactNode; testid: string; aside?: ReactNode }) {
  return (
    <section className="card space-y-3 rounded-xl p-4 sm:p-[18px]" data-testid={testid} aria-label={title}>
      <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-bold">{title}</h3>{aside}</div>
      {children}
    </section>
  );
}
const lbl = 'block text-sm font-semibold';
const field = 'input mt-1 min-h-11 font-normal';

function Chip({ code, name, onClick, testid }: { code: string; name?: string; onClick?: () => void; testid: string }) {
  return <button type="button" className="inline-flex min-h-11 items-center gap-1 rounded-full border border-line bg-card px-3 text-xs hover:bg-hover" onClick={onClick} data-testid={testid}><span className="mono" dir="ltr">{code}</span>{name && <span className="text-mute">{name}</span>}</button>;
}

/** Pick the tasks that come after this one (its successors). */
function SuccessorDialog({ task, all, onClose, onSubmit, busy, error }: { task: P; all: P[]; onClose: () => void; busy: boolean; error: string | null; onSubmit: (list: string[], reason: string) => void }) {
  const { t } = useTranslation();
  const arrow = useArrow();
  const [sel, setSel] = useState<string[]>(successorsOf(all, task.task_code));
  const loop = findCycle(all.map((p) => (sel.includes(p.task_code) ? { ...p, predecessors: [...(p.predecessors ?? []).filter((c) => c !== task.task_code), task.task_code] } : { ...p, predecessors: (p.predecessors ?? []).filter((c) => c !== task.task_code) })));
  return (
    <FormDialog open wide onClose={onClose} testid="studio-succ-dialog" title={`${t('studio.comes_before')}: ${task.task_code}`} busy={busy} error={error} disabled={!!loop} onSubmit={(r) => onSubmit(sel, r)}>
      <TaskPicker all={all} exclude={task.task_code} sel={sel} onChange={setSel} prefix="studio-succ" />
      {loop && <p role="alert" className="text-sm text-lateInk" data-testid="studio-succ-cycle">{t('wfe.cycle_found', { path: loop.join(arrow) })}</p>}
    </FormDialog>
  );
}

export function slaProps(it: SlaWeightItem | undefined) {
  return {
    sla: it?.sla ? { min: it.sla.min_working_days, max: it.sla.max_working_days, rule_id: it.sla.id, unit: it.sla.unit, start_event: it.sla.start_event, calendar_code: it.sla.calendar_code, warning_pct: it.sla.warning_pct,
      breach_owner_role: it.sla.breach_owner_role, escalation_role: it.sla.escalation_role, pause_on_client_wait: it.sla.pause_on_client_wait } : undefined,
    weight: { counts: !!it?.counts_in_weight, value: Number(it?.weight_value ?? 0), group: it?.weight_group ?? null },
    estimate: { man_days: it?.est_man_days != null ? Number(it.est_man_days) : null, duration: it?.planned_duration_days ?? null, suggested: it?.suggested_weight != null ? Number(it.suggested_weight) : null },
  };
}
export function baseOf(it: SlaWeightItem | undefined) {
  return it ? { min: it.sla?.min_working_days, max: it.sla?.max_working_days, start_event: it.sla?.start_event, weight: it.counts_in_weight ? Number(it.weight_value) : undefined } : null;
}

const Header = ({ crumbs, children }: { crumbs: ReactNode; children?: ReactNode }) => (
  <header className="flex flex-wrap items-center justify-between gap-2">
    <h2 className="text-lg font-bold" data-testid="studio-form-title">{crumbs}</h2><div className="flex flex-wrap gap-2">{children}</div>
  </header>
);
const Act = ({ id, icon, label, onClick, disabled, why }: { id: string; icon: ReactNode; label: string; onClick: () => void; disabled?: boolean; why?: string | null }) => (
  <button type="button" className="btn min-h-11" data-testid={id} disabled={disabled} title={disabled && why ? why : label} onClick={onClick}>{icon}{label}</button>
);

/** The task form: general, order and dependencies, SLA and weight, documents, Site Master columns. */
export function TaskForm({ c, code }: { c: Ctx; code: string }) {
  const { t } = useTranslation();
  const arrow = useArrow();
  const toast = useToast();
  const err = useErr();
  const task = c.placements.find((x) => x.task_code === code);
  const [en, setEn] = useState(task?.name_en ?? '');
  const [ar, setAr] = useState(task?.name_ar ?? '');
  const [counts, setCounts] = useState(task?.counts_toward_milestone ?? true);
  const [stage, setStage] = useState(task?.stage_code ?? '');
  const [dlg, setDlg] = useState<null | 'dup' | 'preds' | 'succs'>(null);
  const [other, setOther] = useState('');
  const stageRef = useRef<HTMLSelectElement>(null);
  if (!task) return null;
  const ms = c.milestones.find((m) => m.code === task.stage_code);
  const dis = !c.can.edit;
  const why = c.can.why;
  const rows = c.placements.filter((x) => x.stage_code === task.stage_code);
  const { index, groups } = parallelGroups(rows);
  const beside = (groups[index[rows.findIndex((r) => r.task_code === code)] ?? -1] ?? []).filter((x) => x !== code);
  const target = c.placements.find((x) => x.task_code === other);
  const loop = target ? findCycle(c.placements.map((x) => (x.task_code === code ? { ...x, predecessors: target.predecessors ?? [] } : x))) : null;
  const dirty = en.trim() !== (task.name_en ?? '') || ar.trim() !== (task.name_ar ?? '') || counts !== (task.counts_toward_milestone ?? true) || stage !== task.stage_code;
  const done = { onSuccess: () => { toast(t('wfe.saved')); setDlg(null); }, onError: (e: unknown) => toast(err(e)) };
  const it = c.sw.get(code);
  const act = task.is_active === false;
  return (
    <div className="space-y-4" data-testid="studio-task-form" data-code={code}>
      <Header crumbs={<><button type="button" className="text-mute hover:underline" data-testid="studio-crumb-ms" onClick={() => ms && c.select({ kind: 'milestone', code: ms.code })}>{ms ? c.nm(ms) : task.stage_code}</button><Chev className="mx-2 inline text-mute" size={14} /><Code>{code}</Code> <Name>{c.nm(task)}</Name></>}>
        <Act id="studio-duplicate" icon={<Copy size={14} aria-hidden />} label={t('wfe.duplicate')} disabled={dis} why={why} onClick={() => setDlg('dup')} />
        <Act id="studio-move" icon={<MoveRight size={14} aria-hidden className="rtl:rotate-180" />} label={t('studio.move_to_ms')} disabled={!c.can.struct} why={why} onClick={() => stageRef.current?.focus()} />
        <Act id="studio-toggle-active" icon={act ? <Power size={14} aria-hidden /> : <PowerOff size={14} aria-hidden />} label={t(act ? 'wfe.activate' : 'wfe.deactivate')} disabled={dis} why={why}
          onClick={() => c.askReason({ title: `${act ? t('wfe.activate') : t('wfe.deactivate')}: ${code}`, hint: t('wfe.toggle_task_hint'), run: (reason, cb) => c.W.updateTask.mutate({ code, is_active: act, reason }, cb) })} />
      </Header>

      <StudioCard title={t('studio.general')} testid="studio-card-general">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={lbl}>{t('wfe.name_en')}<input className={field} dir="ltr" data-testid="studio-name-en" disabled={dis} value={en} onChange={(e) => setEn(e.target.value)} /></label>
          <label className={lbl}>{t('wfe.name_ar')}<input className={field} dir="rtl" data-testid="studio-name-ar" disabled={dis} value={ar} onChange={(e) => setAr(e.target.value)} /></label>
          <label className={lbl}>{t('studio.milestone')}
            <select ref={stageRef} className={field} data-testid="studio-stage" disabled={!c.can.struct} title={!c.can.struct ? why ?? undefined : undefined} value={stage} onChange={(e) => setStage(e.target.value)}>
              {c.milestones.filter((m) => m.is_active !== false || m.code === task.stage_code).map((m) => <option key={m.code} value={m.code}>{m.code} {c.nm(m)}</option>)}</select></label>
          <label className="flex min-h-11 items-center gap-2 self-end text-sm"><input type="checkbox" className="h-5 w-5" data-testid="studio-counts" disabled={dis} checked={counts} onChange={(e) => setCounts(e.target.checked)} />{t('studio.counts_toward')}</label>
          <ClosingToggle c={c} task={task} />
        </div>
        <div className="flex justify-end"><button type="button" className="btn btn-accent min-h-11" data-testid="studio-general-save" disabled={dis || !dirty || !en.trim()} title={dis ? why ?? undefined : undefined}
          onClick={() => c.askReason({ title: `${t('studio.save_general')}: ${code}`, hint: stage !== task.stage_code ? t('wfe.move_task_hint') : undefined,
            run: (reason, cb) => c.W.updateTask.mutate({ code, name_en: en.trim(), name_ar: ar.trim() || null, counts_toward_milestone: counts, ...(stage !== task.stage_code ? { stage_code: stage } : {}), reason }, cb) })}>{t('studio.save_general')}</button></div>
      </StudioCard>

      <StudioCard title={t('studio.order_deps')} testid="studio-card-order">
        <div>
          <p className="text-sm font-semibold">{t('studio.comes_after')}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2" data-testid="studio-after">
            {(task.predecessors ?? []).length === 0 && <span className="text-sm text-mute">{t('wfe.none')}</span>}
            {(task.predecessors ?? []).map((x) => <Chip key={x} code={x} name={c.nm(c.placements.find((k) => k.task_code === x) ?? {})} testid={`studio-after-${x}`} onClick={() => c.select({ kind: 'task', code: x })} />)}
            <Act id="studio-edit-after" icon={<Link2 size={14} aria-hidden />} label={t('wfe.edit_links')} disabled={dis} why={why} onClick={() => setDlg('preds')} />
          </div>
        </div>
        <div>
          <p className="text-sm font-semibold">{t('studio.comes_before')}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2" data-testid="studio-before">
            {successorsOf(c.placements, code).length === 0 && <span className="text-sm text-mute">{t('wfe.none')}</span>}
            {successorsOf(c.placements, code).map((x) => <Chip key={x} code={x} name={c.nm(c.placements.find((k) => k.task_code === x) ?? {})} testid={`studio-before-${x}`} onClick={() => c.select({ kind: 'task', code: x })} />)}
            <Act id="studio-edit-before" icon={<Link2 size={14} aria-hidden />} label={t('wfe.edit_links')} disabled={dis} why={why} onClick={() => setDlg('succs')} />
          </div>
        </div>
        <div>
          <p className="text-sm font-semibold">{t('wfe.parallel_with')}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span data-testid="studio-parallel" className="text-sm">{beside.length ? beside.map((x) => <Chip key={x} code={x} testid={`studio-parallel-${x}`} onClick={() => c.select({ kind: 'task', code: x })} />) : <span className="text-mute">{t('wfe.none')}</span>}</span>
            <select className="input min-h-11 w-auto" aria-label={t('wfe.parallel_pick')} data-testid="studio-parallel-pick" disabled={dis} value={other} onChange={(e) => setOther(e.target.value)}>
              <option value="">{t('wfe.parallel_pick')}</option>{rows.filter((r) => r.task_code !== code && r.is_active !== false).map((r) => <option key={r.task_code} value={r.task_code}>{r.task_code}</option>)}</select>
            <button type="button" className="btn min-h-11" data-testid="studio-parallel-go" disabled={dis || !target || !!loop}
              onClick={() => target && c.askReason({ title: t('wfe.parallel_title', { code, other: target.task_code }), hint: t('wfe.parallel_hint'), run: (reason, cb) => c.W.setPreds.mutate({ code, predecessors: target.predecessors ?? [], reason }, cb) })}>{t('wfe.parallel_go')}</button>
          </div>
          {loop && <p role="alert" className="text-xs text-lateInk">{t('wfe.cycle_found', { path: loop.join(arrow) })}</p>}
        </div>
      </StudioCard>

      <StudioCard title={t('wfe.sla_section.title')} testid="studio-card-sla">
        <SlaWeightSection key={`${code}-${c.etag}-${it?.sla?.id ?? ''}`} version={c.v.version} etag={c.etag} code={code} canEdit={c.can.edit} why={why} totals={c.totals} {...slaProps(it)} base={c.isDraft ? baseOf(c.baseSw?.get(code)) : null} />
      </StudioCard>

      <StudioCard title={t('wfe.documents')} testid="studio-card-docs">
        <p className="text-sm">{t('studio.has_documents')}: <b data-testid="studio-has-docs">{task.has_documents ? t('common.yes') : t('common.no')}</b></p>
        <Link className="inline-flex min-h-11 items-center text-sm text-link underline" to="/admin/settings/documents/types" data-testid="studio-docs-link">{t('studio.open_library')}</Link>
      </StudioCard>

      <TaskColumnsCard c={c} code={code} />

      {dlg === 'dup' && <DuplicateDialog source={task} onClose={() => setDlg(null)} busy={c.W.createTask.isPending} error={c.W.createTask.isError ? err(c.W.createTask.error) : null}
        onSubmit={(f, reason) => c.W.createTask.mutate({ stage_code: task.stage_code, code: f.code, name_en: f.name_en, name_ar: f.name_ar || null, counts_toward_milestone: task.counts_toward_milestone, after_task_code: code, predecessors: task.predecessors ?? [], reason }, { ...done, onSuccess: () => { done.onSuccess(); c.select({ kind: 'task', code: f.code }); } })} />}
      {dlg === 'preds' && <PredecessorDialog task={task} all={c.placements} onClose={() => setDlg(null)} busy={c.W.setPreds.isPending} error={c.W.setPreds.isError ? err(c.W.setPreds.error) : null}
        onSubmit={(list, reason) => c.W.setPreds.mutate({ code, predecessors: list, reason }, done)} />}
      {dlg === 'succs' && <SuccessorDialog task={task} all={c.placements} onClose={() => setDlg(null)} busy={c.W.setSuccs.isPending} error={c.W.setSuccs.isError ? err(c.W.setSuccs.error) : null}
        onSubmit={(list, reason) => c.W.setSuccs.mutate({ code, successors: list, reason }, done)} />}
    </div>
  );
}

/** Names edited in two inputs, shared by the gate and the milestone form. */
function Names({ en, ar, setEn, setAr, dis, prefix }: { en: string; ar: string; setEn: (v: string) => void; setAr: (v: string) => void; dis: boolean; prefix: string }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className={lbl}>{t('wfe.name_en')}<input className={field} dir="ltr" data-testid={`${prefix}-name-en`} disabled={dis} value={en} onChange={(e) => setEn(e.target.value)} /></label>
      <label className={lbl}>{t('wfe.name_ar')}<input className={field} dir="rtl" data-testid={`${prefix}-name-ar`} disabled={dis} value={ar} onChange={(e) => setAr(e.target.value)} /></label>
    </div>
  );
}
const MasterLine = ({ col, testid }: { col: string | null; testid: string }) => {
  const { t } = useTranslation();
  return <p className="text-sm text-mute" data-testid={testid}>{col ? t('studio.master_col_is', { col: ltr(col) }) : t('studio.master_col_none')}</p>;
};

/** The gate form: names, gate SLA, the Master column it writes, its conditions and what it opens. */
export function GateForm({ c, code }: { c: Ctx; code: string }) {
  const { t } = useTranslation();
  const g = c.gates.find((x) => x.code === code);
  const [en, setEn] = useState(g?.name_en ?? '');
  const [ar, setAr] = useState(g?.name_ar ?? '');
  const [mn, setMn] = useState(String(g?.sla_min_wd ?? ''));
  const [mx, setMx] = useState(String(g?.sla_max_wd ?? ''));
  const [conds, setConds] = useState<GateCondition[]>(g?.conditions ?? []);
  if (!g) return null;
  const dis = !c.can.edit;
  const next = c.milestones.find((m) => m.code === g.to_milestone) ?? nextMilestone(c.milestones, g.from_milestone);
  const from = c.milestones.find((m) => m.code === g.from_milestone);
  const opens = c.placements.filter((p) => p.stage_code === next?.code && p.is_active !== false && !(p.predecessors ?? []).some((x) => c.placements.find((k) => k.task_code === x)?.stage_code === next?.code));
  const clean = conds.filter((x) => x.type === 'stop_work_blocks' || (x.ref ?? '').trim());
  return (
    <div className="space-y-4" data-testid="studio-gate-form" data-code={code}>
      <Header crumbs={<><Diamond size={16} aria-hidden className="me-2 inline text-mute" />{c.nm(g)}</>} />
      <StudioCard title={t('studio.general')} testid="studio-card-gate">
        <Names en={en} ar={ar} setEn={setEn} setAr={setAr} dis={dis} prefix="studio-gate" />
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={lbl}>{t('wfe.sla_min')}<input type="number" min={0} className={field} dir="ltr" data-testid="studio-gate-sla-min" disabled={dis} value={mn} onChange={(e) => setMn(e.target.value)} /></label>
          <label className={lbl}>{t('wfe.sla_max')}<input type="number" min={0} className={field} dir="ltr" data-testid="studio-gate-sla-max" disabled={dis} value={mx} onChange={(e) => setMx(e.target.value)} /></label>
        </div>
        <MasterLine col={masterCol(g)} testid="studio-gate-master" />
      </StudioCard>
      <StudioCard title={t('wfe.conditions')} testid="studio-card-conditions">
        <fieldset disabled={dis} className="min-w-0">
          <ConditionsEditor value={conds} onChange={setConds} prefix="studio-gate-cond" tasks={c.placements} milestones={c.milestones} permits={[]} quickAdd />
        </fieldset>
      </StudioCard>
      <StudioCard title={t('studio.gate_opens')} testid="studio-card-opens">
        <p className="text-sm text-mute">{from && next ? t('studio.gate_between', { from: c.nm(from), to: c.nm(next) }) : ''}</p>
        <div className="flex flex-wrap gap-2" data-testid="studio-gate-opens">
          {opens.length === 0 && <span className="text-sm text-mute">{t('wfe.none')}</span>}
          {opens.map((p) => <Chip key={p.task_code} code={p.task_code} name={c.nm(p)} testid={`studio-opens-${p.task_code}`} onClick={() => c.select({ kind: 'task', code: p.task_code })} />)}
        </div>
      </StudioCard>
      <div className="flex justify-end"><button type="button" className="btn btn-accent min-h-11" data-testid="studio-gate-save" disabled={dis || !en.trim()} title={dis ? c.can.why ?? undefined : undefined}
        onClick={() => c.askReason({ title: `${t('wfe.edit_gate')}: ${code}`, run: (reason, cb) => c.W.gateLight.mutate({ code, name_en: en.trim(), name_ar: ar.trim(), ...(mn !== '' ? { sla_min_wd: Number(mn) } : {}), ...(mx !== '' ? { sla_max_wd: Number(mx) } : {}), conditions: clean, reason }, cb) })}>{t('common.save')}</button></div>
    </div>
  );
}

/** The milestone form: names, the Master column, counting in Project Status, its tasks in order and its gate. */
export function MilestoneForm({ c, code }: { c: Ctx; code: string }) {
  const { t } = useTranslation();
  const m = c.milestones.find((x) => x.code === code);
  const [en, setEn] = useState(m?.name_en ?? '');
  const [ar, setAr] = useState(m?.name_ar ?? '');
  const [cps, setCps] = useState(m?.counts_in_project_status !== false);
  if (!m) return null;
  const dis = !c.can.edit;
  const tasks = c.placements.filter((p) => p.stage_code === code).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const gate = c.gates.find((g) => g.from_milestone === code && g.is_active !== false);
  return (
    <div className="space-y-4" data-testid="studio-ms-form" data-code={code}>
      <Header crumbs={<>{c.nm(m)}</>} />
      <StudioCard title={t('studio.general')} testid="studio-card-ms">
        <Names en={en} ar={ar} setEn={setEn} setAr={setAr} dis={dis} prefix="studio-ms" />
        <MasterLine col={masterCol(m)} testid="studio-ms-master" />
        <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" data-testid="studio-ms-cps" disabled={dis} checked={cps} onChange={(e) => setCps(e.target.checked)} />{t('studio.counts_in_status')}</label>
        <div className="flex justify-end"><button type="button" className="btn btn-accent min-h-11" data-testid="studio-ms-save" disabled={dis || !en.trim()} title={dis ? c.can.why ?? undefined : undefined}
          onClick={() => c.askReason({ title: `${t('wfe.rename')}: ${code}`, run: (reason, cb) => c.W.msLight.mutate({ code, name_en: en.trim(), name_ar: ar.trim(), counts_in_project_status: cps, reason }, cb) })}>{t('common.save')}</button></div>
      </StudioCard>
      <StudioCard title={t('studio.ms_tasks')} testid="studio-card-ms-tasks">
        <ol className="space-y-1" data-testid="studio-ms-tasks">
          {tasks.map((p) => <li key={p.task_code}><button type="button" className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-line px-3 text-start text-sm hover:bg-hover" data-testid={`studio-ms-task-${p.task_code}`} onClick={() => c.select({ kind: 'task', code: p.task_code })}>
            <span className="mono text-xs text-mute" dir="ltr">{p.task_code}</span>{c.nm(p)}</button></li>)}
          {tasks.length === 0 && <li className="text-sm text-mute">{t('wfe.none')}</li>}
        </ol>
      </StudioCard>
      <StudioCard title={t('wfe.gate')} testid="studio-card-ms-gate">
        {gate ? <button type="button" className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line px-3 text-sm hover:bg-hover" data-testid="studio-ms-gate" onClick={() => c.select({ kind: 'gate', code: gate.code })}><Diamond size={14} aria-hidden />{c.nm(gate)}</button> : <p className="text-sm text-mute">{t('wfe.none')}</p>}
      </StudioCard>
    </div>
  );
}

