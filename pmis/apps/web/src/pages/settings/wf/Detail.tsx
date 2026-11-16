import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Act, type Can } from './Columns';
import { conditionLabel } from './Conditions';
import { findCycle, parallelGroups, successorsOf, type G, type M, type P, type Sel } from './model';
import { Flag, Link2, Pencil } from 'lucide-react';
import type { SlaWeightItem, WeightTotal } from '../../../api/workflowEditor';
import { SlaWeightSection } from './SlaWeightSection';

type Props = {
  sel: Sel; placements: P[]; milestones: M[]; gates: G[]; nm: (x: { name_en?: string; name_ar?: string | null }) => string; can: Can; sla: Map<string, { min: number; max: number }>;
  wf?: { version: number; etag: number; byCode: Map<string, SlaWeightItem>; totals: WeightTotal[] };
  onPreds: (p: P) => void; onParallel: (p: P, other: P) => void; onClosing: (p: P, on: boolean) => void; onCounts: (p: P, on: boolean) => void; onMove: (p: P, stage: string) => void; onGate: (g: G) => void;
};

/** The panel of the selected task or gate: what it waits for, what runs beside it, whether it closes its milestone or counts toward it, its SLA and its documents. */
export function DetailPanel(p: Props) {
  const { t } = useTranslation();
  const [other, setOther] = useState('');
  const [stage, setStage] = useState('');
  if (!p.sel) return <section className="text-sm text-mute" data-testid="wfe-detail-empty" aria-label={t('wfe.col.detail')}>{t('wfe.detail_empty')}</section>;
  if (p.sel.kind === 'gate') {
    const g = p.gates.find((x) => x.code === p.sel!.code);
    if (!g) return null;
    return (
      <section className="space-y-2" data-testid="wfe-detail-gate" aria-label={t('wfe.col.detail')}>
        <h4 className="font-semibold">{t('wfe.gate')} <span className="mono">{g.code}</span></h4>
        <p className="text-sm">{p.nm(g)} ({g.from_milestone} {'→'} {g.to_milestone})</p>
        <p className="text-sm text-mute">SLA {g.sla_min_wd ?? '-'}/{g.sla_max_wd ?? '-'} {t('wfe.working_days')}</p>
        <ul className="list-disc ps-5 text-sm">{(g.conditions ?? []).map((c, i) => <li key={i}>{conditionLabel(c, t)}</li>)}</ul>
        <Act testid="wfe-detail-gate-edit" label={t('wfe.edit_gate')} icon={<Pencil size={14} aria-hidden />} disabled={!p.can.edit} why={p.can.why} onClick={() => p.onGate(g)} />
      </section>
    );
  }
  const task = p.placements.find((x) => x.task_code === p.sel!.code);
  if (!task) return null;
  const rows = p.placements.filter((x) => x.stage_code === task.stage_code);
  const { index, groups } = parallelGroups(rows);
  const mine = groups[index[rows.findIndex((r) => r.task_code === task.task_code)] ?? -1] ?? [];
  const beside = mine.filter((c) => c !== task.task_code);
  const sla = p.sla.get(task.task_code);
  const nextPreds = (o: P) => p.placements.map((x) => (x.task_code === task.task_code ? { ...x, predecessors: o.predecessors ?? [] } : x));
  const target = p.placements.find((x) => x.task_code === other);
  const loop = target ? findCycle(nextPreds(target)) : null;
  return (
    <section className="space-y-3" data-testid="wfe-detail-task" aria-label={t('wfe.col.detail')}>
      <h4 className="font-semibold"><span className="mono">{task.task_code}</span> {p.nm(task)}</h4>
      <div>
        <p className="text-sm font-semibold">{t('wfe.predecessors')}</p>
        <p className="mono text-sm" data-testid="wfe-detail-preds">{(task.predecessors ?? []).map((c) => `${c} (${p.placements.find((x) => x.task_code === c)?.stage_code ?? '?'})`).join(', ') || '-'}</p>
        <p className="text-xs text-mute">{t('wfe.blocks')}: <span className="mono" data-testid="wfe-detail-succs">{successorsOf(p.placements, task.task_code).join(', ') || '-'}</span></p>
        <Act testid="wfe-detail-preds-edit" label={t('wfe.edit_links')} icon={<Link2 size={14} aria-hidden />} disabled={!p.can.edit} why={p.can.why} onClick={() => p.onPreds(task)} />
      </div>
      <div>
        <p className="text-sm font-semibold">{t('wfe.parallel_with')}</p>
        <p className="mono text-sm" data-testid="wfe-detail-parallel">{beside.join(', ') || t('wfe.none')}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <select className="input" aria-label={t('wfe.parallel_pick')} data-testid="wfe-detail-parallel-pick" value={other} onChange={(e) => setOther(e.target.value)}>
            <option value="">{t('wfe.parallel_pick')}</option>{rows.filter((r) => r.task_code !== task.task_code && r.is_active !== false).map((r) => <option key={r.task_code} value={r.task_code}>{r.task_code}</option>)}</select>
          <button type="button" className="btn" data-testid="wfe-detail-parallel-go" disabled={!p.can.edit || !target || !!loop} title={!p.can.edit ? p.can.why ?? '' : t('wfe.parallel_go')} onClick={() => target && p.onParallel(task, target)}>{t('wfe.parallel_go')}</button>
        </div>
        {loop && <p role="alert" className="text-xs text-lateInk" data-testid="wfe-detail-parallel-cycle">{t('wfe.cycle_found', { path: loop.join(' → ') })}</p>}
      </div>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" data-testid="wfe-detail-closing" checked={!!task.is_milestone_task} disabled={!p.can.struct} title={!p.can.struct ? p.can.why ?? '' : undefined} onChange={(e) => p.onClosing(task, e.target.checked)} />
        <span><Flag size={12} className="me-1 inline" aria-hidden />{t('wfe.closes_milestone')}{!p.can.struct && p.can.why ? <span className="block text-xs text-mute">{p.can.why}</span> : null}</span></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="wfe-detail-counts" checked={!!task.counts_toward_milestone} disabled={!p.can.edit} onChange={(e) => p.onCounts(task, e.target.checked)} />{t('wfe.counts_hint')}</label>
      {p.wf ? (() => {
        const it = p.wf.byCode.get(task.task_code);
        return <SlaWeightSection version={p.wf.version} etag={p.wf.etag} code={task.task_code} canEdit={p.can.edit} why={p.can.why} totals={p.wf.totals}
          sla={it?.sla ? { min: it.sla.min_working_days, max: it.sla.max_working_days, rule_id: it.sla.id, unit: it.sla.unit, start_event: it.sla.start_event, calendar_code: it.sla.calendar_code,
            warning_pct: it.sla.warning_pct, breach_owner_role: it.sla.breach_owner_role, escalation_role: it.sla.escalation_role, pause_on_client_wait: it.sla.pause_on_client_wait } : undefined}
          weight={{ counts: !!it?.counts_in_weight, value: Number(it?.weight_value ?? 0), group: it?.weight_group ?? null }} />;
      })() : <div className="text-sm"><span className="font-semibold">{t('wfe.sla')}: </span><span data-testid="wfe-detail-sla">{sla ? `${sla.min}/${sla.max} ${t('wfe.working_days')}` : t('wfe.none')}</span>
        <Link className="ms-2 underline" to="/settings?tab=sla" data-testid="wfe-detail-sla-link">{t('wfe.sla_edit')}</Link></div>}
      <p className="text-sm"><span className="font-semibold">{t('wfe.documents')}: </span><span data-testid="wfe-detail-docs">{task.has_documents ? t('common.yes') : t('common.no')}</span></p>
      <label className="block text-sm">{t('wfe.move_to')}
        <span className="ms-2 inline-flex gap-1"><select className="input" data-testid="wfe-detail-stage" value={stage} onChange={(e) => setStage(e.target.value)}><option value="">-</option>
          {p.milestones.filter((m) => m.is_active !== false && m.code !== task.stage_code).map((m) => <option key={m.code} value={m.code}>{m.code}</option>)}</select>
          <button type="button" className="btn" data-testid="wfe-detail-move" disabled={!p.can.struct || !stage} title={!p.can.struct ? p.can.why ?? '' : undefined} onClick={() => p.onMove(task, stage)}>{t('wfe.table.move')}</button></span></label>
    </section>
  );
}
