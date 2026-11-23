import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api } from '@/api/client';
import { usePreviewInsert, type GateCondition, type WorkflowVersion } from '@/api/workflowEditor';
import { useToast } from '@/components/Toast';
import { ConditionsEditor } from '../wf/Conditions';
import { useErr } from '../wf/useErr';
import type { Ctx } from './studioCtx';
import { StudioCard } from './StudioForms';
import type { StudioSel } from './studioModel';
import { nextMilestone } from './studioModel';
import { AddColumn } from './StudioAddColumn';

export type AddTab = 'task' | 'milestone' | 'gate' | 'column';
const lbl = 'block text-sm font-semibold';
const field = 'input mt-1 min-h-11 font-normal';
const CODE = /^[A-Z][A-Z0-9_-]{0,19}$/;

const Step = ({ n, title, children, testid }: { n: number; title: string; children: ReactNode; testid: string }) => (
  <StudioCard title={`${n}. ${title}`} testid={testid}>{children}</StudioCard>
);

/** The add screen: three tabs (task, milestone, gate). Nothing is written until "Add to draft", which asks for the reason like every write. */
export function StudioAdd({ c, tab: first, milestone, task, onTab, onClose, onAdded }: { c: Ctx; tab: AddTab; milestone?: string; task?: string; onTab: (t: AddTab) => void; onClose: () => void; onAdded: (s: StudioSel) => void }) {
  const { t } = useTranslation();
  const tabs: AddTab[] = ['task', 'milestone', 'gate', 'column'];
  return (
    <div className="space-y-4" data-testid="studio-add">
      <header className="space-y-2">
        <h2 className="text-lg font-bold">{t('studio.add_title')}</h2>
        <div role="tablist" aria-label={t('studio.add_title')} className="flex flex-wrap gap-2">
          {tabs.map((k) => <button key={k} type="button" role="tab" aria-selected={first === k} className={`btn min-h-11 ${first === k ? 'btn-accent' : ''}`} data-testid={`studio-add-tab-${k}`} onClick={() => onTab(k)}>{t(`studio.new_${k}`)}</button>)}
        </div>
      </header>
      {first === 'task' && <AddTask c={c} milestone={milestone} onClose={onClose} onAdded={onAdded} />}
      {first === 'milestone' && <AddMilestone c={c} onClose={onClose} onAdded={onAdded} />}
      {first === 'column' && <AddColumn c={c} {...(task ? { presetTask: task } : {})} onClose={onClose} onAdded={onAdded} />}
      {first === 'gate' && <AddGate c={c} milestone={milestone} onClose={onClose} onAdded={onAdded} />}
    </div>
  );
}

function Footer({ onClose, onAdd, disabled, why }: { onClose: () => void; onAdd: () => void; disabled: boolean; why?: string | null }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <button type="button" className="btn min-h-11" data-testid="studio-add-cancel" onClick={onClose}>{t('common.cancel')}</button>
      <button type="button" className="btn btn-accent min-h-11" data-testid="studio-add-submit" disabled={disabled} title={disabled && why ? why : undefined} onClick={onAdd}>{t('studio.add_to_draft')}</button>
    </div>
  );
}
const NameFields = ({ code, setCode, en, setEn, ar, setAr, prefix }: { code: string; setCode: (v: string) => void; en: string; setEn: (v: string) => void; ar: string; setAr: (v: string) => void; prefix: string }) => {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className={lbl}>{t('wfe.code')}<input className={field} dir="ltr" data-testid={`${prefix}-code`} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} /></label>
      <span className="hidden sm:block" />
      <label className={lbl}>{t('wfe.name_en')}<input className={field} dir="ltr" data-testid={`${prefix}-en`} value={en} onChange={(e) => setEn(e.target.value)} /></label>
      <label className={lbl}>{t('wfe.name_ar')}<input className={field} dir="rtl" data-testid={`${prefix}-ar`} value={ar} onChange={(e) => setAr(e.target.value)} /></label>
    </div>
  );
};

function AddTask({ c, milestone, onClose, onAdded }: { c: Ctx; milestone?: string; onClose: () => void; onAdded: (s: StudioSel) => void }) {
  const { t } = useTranslation();
  const err = useErr();
  const toast = useToast();
  const active = c.milestones.filter((m) => m.is_active !== false);
  const [stage, setStage] = useState(milestone && active.some((m) => m.code === milestone) ? milestone : active[0]?.code ?? '');
  const rows = c.placements.filter((p) => p.stage_code === stage && p.is_active !== false).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const [after, setAfter] = useState(rows.length ? rows[rows.length - 1]!.task_code : '');
  const [before, setBefore] = useState('');
  const [rewire, setRewire] = useState(false);
  const [code, setCode] = useState(''), [en, setEn] = useState(''), [ar, setAr] = useState('');
  const [counts, setCounts] = useState(true);
  const [mn, setMn] = useState(''), [mx, setMx] = useState(''), [from, setFrom] = useState('PRED');
  const [wOn, setWOn] = useState(false), [wVal, setWVal] = useState(''), [wGroup, setWGroup] = useState('');
  const [master, setMaster] = useState('');
  const preds = after ? [after] : [], succs = before ? [before] : [];
  const preview = usePreviewInsert(c.v.version);
  const { mutate } = preview;
  useEffect(() => { if (preds.length || succs.length) mutate({ stage_code: stage, predecessors: after ? [after] : [], successors: before ? [before] : [], remove_direct_links: rewire, counts_toward_milestone: counts }); }, [mutate, stage, after, before, rewire, counts, preds.length, succs.length]);
  const pv = preds.length || succs.length ? preview.data ?? null : null;
  const cycle = pv?.errors?.find((e) => e.code === 'cycle');
  const phrase = pv?.master_confirmation_needed ? pv.confirmation_phrase ?? null : null;
  const slaBad = (mn !== '' || mx !== '') && (mn === '' || mx === '' || Number(mn) > Number(mx));
  const wBad = wOn && (!wGroup.trim() || wVal === '' || Number(wVal) < 0 || Number(wVal) > 100);
  const valid = CODE.test(code) && !!en.trim() && !!stage && !cycle && (!pv || pv.valid) && !slaBad && !wBad && (!phrase || master === phrase) && !c.placements.some((p) => p.task_code === code);
  const pickStage = (s: string) => { setStage(s); const r = c.placements.filter((p) => p.stage_code === s && p.is_active !== false).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)); setAfter(r.length ? r[r.length - 1]!.task_code : ''); setBefore(''); };
  const submit = () => c.askReason({
    title: `${t('studio.add_to_draft')}: ${code}`, hint: t('wfe.insert_hint'),
    run: (reason, cb) => c.W.insertTask.mutate({ stage_code: stage, code, name_en: en.trim(), name_ar: ar.trim() || null, counts_toward_milestone: counts, after_task_code: after || null, predecessors: preds, successors: succs, remove_direct_links: rewire, add_to_open_sites: false, reason, ...(master ? { confirm_master_impact: master } : {}) }, {
      onError: cb.onError,
      onSuccess: async (r) => {
        const path = `/workflow/versions/${c.v.version}/tasks/${code}`;
        let etag = r.version?.version_etag ?? c.etag;
        const refresh = async () => { etag = (await api.get<WorkflowVersion>(`/workflow/versions/${c.v.version}`)).version_etag ?? etag; };
        try {
          if (mn !== '' && mx !== '') { await api.put(`${path}/sla-rule`, { body: { min_working_days: Number(mn), max_working_days: Number(mx), start_event: from, unit: 'working', calendar_code: 'default', warning_pct: null, breach_owner_role: null, escalation_role: null, pause_on_client_wait: false, reason }, version: etag }); await refresh(); }
          if (wOn) await api.put(`${path}/weight`, { body: { counts_in_weight: true, weight_value: Number(wVal), weight_group: wGroup.trim().toUpperCase(), reason }, version: etag });
        } catch (e) { toast(err(e)); }
        cb.onSuccess();
        onAdded({ kind: 'task', code });
      },
    }),
  });
  return (
    <div className="space-y-4" data-testid="studio-add-task">
      <Step n={1} title={t('studio.step_where')} testid="studio-step-where">
        <div className="grid gap-3 sm:grid-cols-3">
          <label className={lbl}>{t('studio.milestone')}<select className={field} data-testid="studio-add-stage" value={stage} onChange={(e) => pickStage(e.target.value)}>{active.map((m) => <option key={m.code} value={m.code}>{m.code} {c.nm(m)}</option>)}</select></label>
          <label className={lbl}>{t('studio.comes_after')}<select className={field} data-testid="studio-add-after" value={after} onChange={(e) => setAfter(e.target.value)}><option value="">{t('studio.at_start')}</option>{rows.map((p) => <option key={p.task_code} value={p.task_code}>{p.task_code} {c.nm(p)}</option>)}</select></label>
          <label className={lbl}>{t('studio.comes_before')}<select className={field} data-testid="studio-add-before" value={before} onChange={(e) => setBefore(e.target.value)}><option value="">{t('studio.at_end')}</option>{rows.filter((p) => p.task_code !== after).map((p) => <option key={p.task_code} value={p.task_code}>{p.task_code} {c.nm(p)}</option>)}</select></label>
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" data-testid="studio-add-rewire" checked={rewire} onChange={(e) => setRewire(e.target.checked)} />{t('studio.rewire')}</label>
        <section aria-live="polite" className="rounded-lg border border-line bg-hover p-3 text-sm" data-testid="studio-add-chain">
          <h4 className="font-semibold">{t('wfe.chain')}</h4>
          {!pv && <p className="text-mute">{t('wfe.chain_empty')}</p>}
          {cycle && <p role="alert" className="text-lateInk" data-testid="studio-add-cycle">{t('wfe.err_cycle_insert')}</p>}
          {pv?.valid && (pv.rewiring.length === 0
            ? <p className="mono" dir="ltr" data-testid="studio-add-chain-line">{pv.predecessors.join(', ') || '-'} {'→'} <b>{code || '?'}</b></p>
            : <ul className="space-y-1">{pv.rewiring.map((r) => <li key={r.successor} className="mono" dir="ltr" data-testid={`studio-add-rewire-${r.successor}`}>{pv.predecessors.join(', ') || '-'} {'→'} <b>{code || '?'}</b> {'→'} {r.successor}{r.removed_links.length > 0 && <s className="ms-2 text-mute">{r.removed_links.join(', ')} {'→'} {r.successor}</s>}</li>)}</ul>)}
          {pv?.warnings?.includes('counting_task_may_move_milestone') && <p className="text-waitInk">{t('wfe.b8_warning')}</p>}
        </section>
        {phrase && <label className={lbl}>{t('wfe.type_to_confirm', { text: phrase })}<input className={field} dir="ltr" data-testid="studio-add-master" value={master} onChange={(e) => setMaster(e.target.value)} /></label>}
      </Step>
      <Step n={2} title={t('studio.step_what')} testid="studio-step-what">
        <NameFields code={code} setCode={setCode} en={en} setEn={setEn} ar={ar} setAr={setAr} prefix="studio-add" />
        <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" data-testid="studio-add-counts" checked={counts} onChange={(e) => setCounts(e.target.checked)} />{t('studio.counts_toward')}</label>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className={lbl}>{t('wfe.sla_section.min')}<input type="number" min={0} className={field} dir="ltr" data-testid="studio-add-sla-min" value={mn} onChange={(e) => setMn(e.target.value)} /></label>
          <label className={lbl}>{t('wfe.sla_section.max')}<input type="number" min={0} className={field} dir="ltr" data-testid="studio-add-sla-max" value={mx} onChange={(e) => setMx(e.target.value)} /></label>
          <label className={lbl}>{t('wfe.sla_section.start')}<select className={field} data-testid="studio-add-sla-from" value={from} onChange={(e) => setFrom(e.target.value)}><option value="PRED">{t('wfe.sla_section.start_pred')}</option><option value="OPEN">{t('wfe.sla_section.start_open')}</option></select></label>
        </div>
        {slaBad && <p role="alert" className="text-sm text-lateInk" data-testid="studio-add-sla-bad">{t('studio.sla_bad')}</p>}
      </Step>
      <Step n={3} title={t('studio.step_inputs')} testid="studio-step-inputs">
        <div className="rounded-lg border border-dashed border-line p-4 text-center text-sm text-mute" data-testid="studio-add-inputs">{t('studio.inputs_after')}</div>
      </Step>
      <Step n={4} title={t('studio.step_docs')} testid="studio-step-docs">
        <p className="text-sm text-mute">{t('studio.docs_approval_note')}</p>
        <Link className="inline-flex min-h-11 items-center text-sm text-link underline" to="/admin/matrix" data-testid="studio-add-matrix-link">{t('studio.open_matrix')}</Link>
        <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" data-testid="studio-add-weight-on" checked={wOn} onChange={(e) => setWOn(e.target.checked)} />{t('wfe.sla_section.counts')}</label>
        {wOn && <div className="grid gap-3 sm:grid-cols-2">
          <label className={lbl}>{t('wfe.sla_section.weight_value')}<input type="number" min={0} max={100} step={0.001} className={field} dir="ltr" data-testid="studio-add-weight" value={wVal} onChange={(e) => setWVal(e.target.value)} /></label>
          <label className={lbl}>{t('wfe.sla_section.weight_group')}<input className={field} dir="ltr" data-testid="studio-add-weight-group" value={wGroup} onChange={(e) => setWGroup(e.target.value.toUpperCase())} /></label>
        </div>}
      </Step>
      <Footer onClose={onClose} onAdd={submit} disabled={!valid || !c.can.edit} why={c.can.why} />
    </div>
  );
}

const structure = (c: Ctx) => ({ milestones: c.milestones.map((m) => ({ code: m.code, is_active: m.is_active !== false })), gates: c.gates.map((g) => ({ code: g.code, is_active: g.is_active !== false })) });

function AddMilestone({ c, onClose, onAdded }: { c: Ctx; onClose: () => void; onAdded: (s: StudioSel) => void }) {
  const { t } = useTranslation();
  const list = c.milestones.filter((m) => m.is_active !== false);
  const [after, setAfter] = useState(list[list.length - 1]?.code ?? '');
  const [code, setCode] = useState(''), [en, setEn] = useState(''), [ar, setAr] = useState('');
  const valid = CODE.test(code) && !!en.trim() && !c.milestones.some((m) => m.code === code);
  const submit = () => c.askReason({
    title: `${t('studio.new_milestone')}: ${code}`,
    run: (reason, cb) => {
      const ms = structure(c).milestones as { code: string; is_active: boolean; name_en?: string; name_ar?: string | null }[];
      ms.splice(after ? c.milestones.findIndex((m) => m.code === after) + 1 : 0, 0, { code, name_en: en.trim(), name_ar: ar.trim() || null, is_active: true });
      c.W.replace.mutate({ ...structure(c), milestones: ms, reason }, { onError: cb.onError, onSuccess: () => { cb.onSuccess(); onAdded({ kind: 'milestone', code }); } });
    },
  });
  return (
    <div className="space-y-4" data-testid="studio-add-milestone">
      <Step n={1} title={t('studio.step_where')} testid="studio-step-where">
        <label className={lbl}>{t('studio.place_after')}<select className={field} data-testid="studio-add-ms-after" value={after} onChange={(e) => setAfter(e.target.value)}><option value="">{t('studio.at_start')}</option>{list.map((m) => <option key={m.code} value={m.code}>{m.code} {c.nm(m)}</option>)}</select></label>
      </Step>
      <Step n={2} title={t('studio.step_what')} testid="studio-step-what"><NameFields code={code} setCode={setCode} en={en} setEn={setEn} ar={ar} setAr={setAr} prefix="studio-add-ms" /></Step>
      <Footer onClose={onClose} onAdd={submit} disabled={!valid || !c.can.struct} why={c.can.why} />
    </div>
  );
}

function AddGate({ c, milestone, onClose, onAdded }: { c: Ctx; milestone?: string; onClose: () => void; onAdded: (s: StudioSel) => void }) {
  const { t } = useTranslation();
  const free = c.milestones.filter((m) => m.is_active !== false && !c.gates.some((g) => g.from_milestone === m.code && g.is_active !== false) && nextMilestone(c.milestones, m.code));
  const [from, setFrom] = useState(free.some((m) => m.code === milestone) ? milestone! : free[0]?.code ?? '');
  const [code, setCode] = useState(''), [en, setEn] = useState(''), [ar, setAr] = useState('');
  const [mn, setMn] = useState(''), [mx, setMx] = useState('');
  const [conds, setConds] = useState<GateCondition[]>([]);
  const to = nextMilestone(c.milestones, from);
  const valid = CODE.test(code) && !!en.trim() && !!from && !!to && !c.gates.some((g) => g.code === code) && !((mn !== '' || mx !== '') && (mn === '' || mx === '' || Number(mn) > Number(mx)));
  const submit = () => c.askReason({
    title: `${t('studio.new_gate')}: ${code}`,
    run: (reason, cb) => c.W.replace.mutate({ ...structure(c), gates: [...structure(c).gates, { code, name_en: en.trim(), name_ar: ar.trim() || null, from_milestone: from, to_milestone: to!.code, is_active: true,
      conditions: conds.filter((x) => x.type === 'stop_work_blocks' || (x.ref ?? '').trim()), ...(mn !== '' ? { sla_min_wd: Number(mn) } : {}), ...(mx !== '' ? { sla_max_wd: Number(mx) } : {}) }], reason }, { onError: cb.onError, onSuccess: () => { cb.onSuccess(); onAdded({ kind: 'gate', code }); } }),
  });
  return (
    <div className="space-y-4" data-testid="studio-add-gate">
      <Step n={1} title={t('studio.step_where')} testid="studio-step-where">
        {free.length === 0 ? <p className="text-sm text-mute" data-testid="studio-add-gate-none">{t('studio.no_free_gate')}</p>
          : <label className={lbl}>{t('studio.gate_after')}<select className={field} data-testid="studio-add-gate-from" value={from} onChange={(e) => setFrom(e.target.value)}>{free.map((m) => <option key={m.code} value={m.code}>{m.code} {c.nm(m)}</option>)}</select></label>}
      </Step>
      <Step n={2} title={t('studio.step_what')} testid="studio-step-what">
        <NameFields code={code} setCode={setCode} en={en} setEn={setEn} ar={ar} setAr={setAr} prefix="studio-add-gate" />
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={lbl}>{t('wfe.sla_min')}<input type="number" min={0} className={field} dir="ltr" data-testid="studio-add-gate-sla-min" value={mn} onChange={(e) => setMn(e.target.value)} /></label>
          <label className={lbl}>{t('wfe.sla_max')}<input type="number" min={0} className={field} dir="ltr" data-testid="studio-add-gate-sla-max" value={mx} onChange={(e) => setMx(e.target.value)} /></label>
        </div>
        <ConditionsEditor value={conds} onChange={setConds} prefix="studio-add-gate-cond" tasks={c.placements} milestones={c.milestones} permits={[]} quickAdd />
      </Step>
      <Footer onClose={onClose} onAdd={submit} disabled={!valid || !c.can.struct} why={c.can.why} />
    </div>
  );
}
