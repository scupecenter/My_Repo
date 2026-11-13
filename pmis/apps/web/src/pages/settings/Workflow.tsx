import { ArrowDown, ArrowUp, GitBranch, Pencil, Plus, Split } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import {
  useCreateDraft, useRemoveItem, useDiscardDraft, useCreateTask, useGateLight, useInsertTask, useReplaceStructure, type GateCondition, useMilestoneLight, usePreviewInsert, usePublish, useReorderTasks, useSetPredecessors, useSetSuccessors, useUpdateTask, useWorkflowVersion, useWorkflowVersions,
  type TaskPlacement, type WorkflowVersion,
} from '@/api/workflowEditor';
import { errText, FormDialog } from '@/components/FormDialog';
import { ConditionsEditor, MigrationDialog, MigrationLog, StructureDialog } from './WorkflowStructure';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';

type P = TaskPlacement & { name_en?: string; name_ar?: string | null; is_active?: boolean };
type M = { code: string; name_en: string; name_ar?: string | null; is_active?: boolean; counts_in_project_status?: boolean };
type G = { code: string; name_en: string; name_ar?: string | null; from_milestone: string; to_milestone: string; sla_min_wd?: number | null; sla_max_wd?: number | null; conditions?: GateCondition[] };

/** The text of a failed write: a field error of the workflow editor first (cycle, self, unknown...), then the generic texts. */
function useErr() {
  const { t } = useTranslation();
  return (e: unknown) => {
    if (e instanceof ApiError) {
      if (e.code === 'master_impact_unconfirmed') return t('wfe.err.master_impact_unconfirmed');
      if (e.code === 'workflow_invalid') return `${t('wfe.err.workflow_invalid')} ${((e.problem as { problems?: string[] }).problems ?? []).join('; ')}`;
      const first = Object.values(fieldErrors(e))[0];
      if (first && t(`wfe.err.${first}`) !== `wfe.err.${first}`) return t(`wfe.err.${first}`);
    }
    return errText(e, t);
  };
}

/** Settings, Workflow (decision 4 of 2026-11-12, migration 0090): versions, the task editor of a draft, light edits of milestones and gates, publishing. */
export function Workflow() {
  const { t } = useTranslation();
  const toast = useToast();
  const err = useErr();
  const versions = useWorkflowVersions();
  const [open, setOpen] = useState<number | null>(null);
  const [dialog, setDialog] = useState(false);
  const create = useCreateDraft();
  const items = versions.data?.items ?? [];
  const current = items.find((v) => v.is_current);
  const hasDraft = items.some((v) => v.status === 'draft');

  return (
    <section className="card space-y-3 p-4" data-testid="page-workflow">
      <h2 className="flex items-center gap-2 font-bold"><GitBranch size={18} aria-hidden />{t('wfe.title')}</h2>
      <p className="text-sm text-mute">{t('wfe.note')}</p>
      <table className="w-full text-sm" data-testid="wfe-versions">
        <thead><tr className="text-start text-mute"><th className="text-start">{t('wfe.version')}</th><th className="text-start">{t('wfe.status')}</th><th className="text-start">{t('wfe.sites')}</th><th className="text-start">{t('common.reason')}</th><th /></tr></thead>
        <tbody>
          {items.map((v) => (
            <tr key={v.version} data-testid={`wfe-version-${v.version}`}>
              <td className="mono">v{v.version}{v.is_current ? ` (${t('wfe.current')})` : ''}</td>
              <td>{t(`wfe.status_${v.status}`)}</td>
              <td>{v.site_count ?? 0}</td>
              <td>{v.reason ?? ''}</td>
              <td><button className="btn" data-testid={`wfe-open-${v.version}`} onClick={() => setOpen(v.version)}>{v.status === 'draft' ? t('wfe.edit') : t('wfe.view')}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {current && !hasDraft && <button className="btn btn-accent" data-testid="wfe-new-draft" onClick={() => { create.reset(); setDialog(true); }}>{t('wfe.new_draft', { version: current.version })}</button>}
      {dialog && current && (
        <FormDialog open onClose={() => setDialog(false)} testid="wfe-draft-dialog" title={t('wfe.new_draft', { version: current.version })} busy={create.isPending} error={create.isError ? err(create.error) : null}
          onSubmit={(reason) => create.mutate({ parent_version: current.version, reason }, { onSuccess: (v) => { toast(t('wfe.draft_created')); setDialog(false); setOpen(v.version); } })}>
          <p className="text-sm text-mute">{t('wfe.new_draft_hint')}</p>
        </FormDialog>
      )}
      {open !== null && <Editor version={open} onGone={() => setOpen(null)} />}
      <MigrationLog />
    </section>
  );
}

function Editor({ version, onGone }: { version: number; onGone: () => void }) {
  const q = useWorkflowVersion(version);
  const { t } = useTranslation();
  if (q.isError) return <p role="alert" className="text-lateInk">{t('errors.generic')}</p>;
  if (!q.data) return <p>…</p>;
  return <VersionEditor v={q.data} onGone={onGone} key={`${q.data.version}-${q.data.version_etag}`} />;
}

type Dlg = null | { kind: 'remove'; what: 'task' | 'milestone' | 'gate'; code: string } | { kind: 'discard' } | { kind: 'create'; stage: string } | { kind: 'edit'; task: P } | { kind: 'preds'; task: P } | { kind: 'succs'; task: P } | { kind: 'insert'; stage: string } | { kind: 'milestone'; m: M } | { kind: 'gate'; g: G } | { kind: 'publish' } | { kind: 'structure' } | { kind: 'migrate' };

function VersionEditor({ v, onGone }: { v: WorkflowVersion; onGone: () => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const err = useErr();
  const etag = v.version_etag ?? 0;
  const [dlg, setDlg] = useState<Dlg>(null);
  const ar = i18n.language === 'ar';
  const placements = v.placements as P[];
  const milestones = v.milestones as M[];
  const gates = v.gates as G[];
  const canEdit = v.can_edit === true;
  const isDraft = v.status === 'draft';
  const createTask = useCreateTask(v.version, etag);
  const updateTask = useUpdateTask(v.version, etag);
  const setPreds = useSetPredecessors(v.version, etag);
  const setSuccs = useSetSuccessors(v.version, etag);
  const insertTask = useInsertTask(v.version, etag);
  const replace = useReplaceStructure(v.version, etag);
  const allVersions = useWorkflowVersions().data?.items ?? [];
  const reorder = useReorderTasks(v.version, etag);
  const msLight = useMilestoneLight(v.version, etag);
  const gateLight = useGateLight(v.version, etag);
  const publish = usePublish(v.version, etag);
  const removeItem = useRemoveItem(v.version, etag);
  const discard = useDiscardDraft(v.version, etag);
  const done = (msg: string) => ({ onSuccess: () => { toast(msg); setDlg(null); } });
  const nm = (x: { name_en?: string; name_ar?: string | null }) => (ar && x.name_ar ? x.name_ar : x.name_en ?? '');

  const move = (stage: string, codes: string[], i: number, d: -1 | 1) => {
    const next = [...codes]; [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    reorder.mutate({ stage, task_codes: next, reason: t('wfe.reorder_reason') }, { onError: (e) => toast(err(e)) });
  };

  return (
    <div className="space-y-3 border-t border-line pt-3" data-testid={`wfe-editor`} data-status={v.status}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-bold">v{v.version} · {t(`wfe.status_${v.status}`)}</h3>
        {isDraft && canEdit && <button className="btn" data-testid="wfe-structure" onClick={() => { replace.reset(); setDlg({ kind: 'structure' }); }}>{t('wfe.edit_structure')}</button>}
        {isDraft && canEdit && <button className="btn" data-testid="wfe-discard" onClick={() => { discard.reset(); setDlg({ kind: 'discard' }); }}>{t('wfe.discard_draft')}</button>}
        {!isDraft && v.can_publish && <button className="btn" data-testid="wfe-migrate" onClick={() => setDlg({ kind: 'migrate' })}>{t('wfe.migrate_sites')}</button>}
        {isDraft && v.can_publish && <button className="btn btn-accent" data-testid="wfe-publish" disabled={!v.validation?.valid} onClick={() => { publish.reset(); setDlg({ kind: 'publish' }); }}>{t('wfe.publish')}</button>}
      </div>
      {(v.validation?.problems?.length ?? 0) > 0 && <ul role="alert" className="list-disc ps-5 text-sm text-lateInk" data-testid="wfe-problems">{v.validation!.problems!.map((p) => <li key={p}>{p}</li>)}</ul>}
      {(v.validation?.warnings?.length ?? 0) > 0 && <ul className="list-disc ps-5 text-sm text-waitInk" data-testid="wfe-warnings">{v.validation!.warnings!.map((p) => <li key={p}>{p}</li>)}</ul>}
      {!canEdit && <p className="text-sm text-mute" data-testid="wfe-readonly">{t('wfe.readonly')}</p>}

      {milestones.map((m, mi) => {
        const rows = placements.filter((p) => p.stage_code === m.code);
        const codes = rows.map((p) => p.task_code);
        const gate = gates.find((g) => g.from_milestone === m.code);
        return (
          <section key={m.code} className="rounded-md border border-line p-3" data-testid={`wfe-stage-${m.code}`}>
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="font-semibold">{mi + 1}. {nm(m)} <span className="mono text-mute">{m.code}</span></h4>
              {canEdit && <button className="btn" data-testid={`wfe-ms-${m.code}`} onClick={() => { msLight.reset(); setDlg({ kind: 'milestone', m }); }}><Pencil size={14} aria-hidden /> {t('wfe.edit_names')}</button>}
              {canEdit && <button className="btn" data-testid={`wfe-ms-del-${m.code}`} onClick={() => { removeItem.reset(); setDlg({ kind: 'remove', what: 'milestone', code: m.code }); }}>{t('wfe.remove')}</button>}
              {canEdit && <button className="btn" data-testid={`wfe-insert-${m.code}`} onClick={() => { insertTask.reset(); setDlg({ kind: 'insert', stage: m.code }); }}><Split size={14} aria-hidden /> {t('wfe.insert_task')}</button>}
              {canEdit && <button className="btn" data-testid={`wfe-add-${m.code}`} onClick={() => { createTask.reset(); setDlg({ kind: 'create', stage: m.code }); }}><Plus size={14} aria-hidden /> {t('wfe.add_task')}</button>}
            </div>
            <table className="mt-2 w-full text-sm">
              <thead><tr className="text-mute"><th className="text-start">{t('wfe.code')}</th><th className="text-start">{t('wfe.task_name')}</th><th className="text-start">{t('wfe.predecessors')}</th><th className="text-start">{t('wfe.counts')}</th><th /></tr></thead>
              <tbody>
                {rows.map((p, i) => (
                  <tr key={p.task_code} data-testid={`wfe-task-${p.task_code}`} className={p.is_active === false ? 'opacity-60' : ''}>
                    <td className="mono">{p.task_code}</td>
                    <td>{nm(p)}{p.is_active === false ? ` (${t('wfe.inactive')})` : ''}</td>
                    <td className="mono" data-testid={`wfe-preds-${p.task_code}`}>{(p.predecessors ?? []).join(', ') || '-'}</td>
                    <td>{p.counts_toward_milestone ? t('common.yes') : t('common.no')}</td>
                    <td className="whitespace-nowrap">
                      {canEdit && <>
                        <button className="btn" aria-label={t('wfe.up')} disabled={i === 0 || reorder.isPending} onClick={() => move(m.code, codes, i, -1)}><ArrowUp size={14} aria-hidden /></button>
                        <button className="btn" aria-label={t('wfe.down')} disabled={i === rows.length - 1 || reorder.isPending} onClick={() => move(m.code, codes, i, 1)}><ArrowDown size={14} aria-hidden /></button>
                        <button className="btn" data-testid={`wfe-edit-${p.task_code}`} onClick={() => { updateTask.reset(); setDlg({ kind: 'edit', task: p }); }}>{t('wfe.edit_task')}</button>
                        <button className="btn" data-testid={`wfe-del-${p.task_code}`} onClick={() => { removeItem.reset(); setDlg({ kind: 'remove', what: 'task', code: p.task_code }); }}>{t('wfe.remove')}</button>
                        <button className="btn" data-testid={`wfe-pred-${p.task_code}`} onClick={() => { setPreds.reset(); setDlg({ kind: 'preds', task: p }); }}>{t('wfe.predecessors')}</button>
                      </>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <DependencyView stage={m.code} rows={rows} all={placements} nm={nm} canEdit={canEdit}
              onPreds={(task) => { setPreds.reset(); setDlg({ kind: 'preds', task }); }} onSuccs={(task) => { setSuccs.reset(); setDlg({ kind: 'succs', task }); }} />
            {gate && (
              <p className="mt-2 text-sm text-mute" data-testid={`wfe-gate-${gate.code}`}>
                {t('wfe.gate')} {gate.code}: {nm(gate)} · SLA {gate.sla_min_wd ?? '-'}/{gate.sla_max_wd ?? '-'}
                {canEdit && <button className="btn ms-2" data-testid={`wfe-gate-edit-${gate.code}`} onClick={() => { gateLight.reset(); setDlg({ kind: 'gate', g: gate }); }}>{t('wfe.edit_names')}</button>}
                {canEdit && <button className="btn ms-2" data-testid={`wfe-gate-del-${gate.code}`} onClick={() => { removeItem.reset(); setDlg({ kind: 'remove', what: 'gate', code: gate.code }); }}>{t('wfe.remove')}</button>}
              </p>
            )}
          </section>
        );
      })}

      {dlg?.kind === 'create' && <TaskDialog title={t('wfe.add_task')} onClose={() => setDlg(null)} busy={createTask.isPending} error={createTask.isError ? err(createTask.error) : null} withCode
        onSubmit={(f, reason) => createTask.mutate({ stage_code: dlg.stage, code: f.code, name_en: f.name_en, name_ar: f.name_ar || null, counts_toward_milestone: f.counts, reason }, done(t('wfe.saved')))} />}
      {dlg?.kind === 'edit' && <TaskDialog title={t('wfe.edit_task')} onClose={() => setDlg(null)} busy={updateTask.isPending} error={updateTask.isError ? err(updateTask.error) : null} initial={dlg.task} withActive
        stages={isDraft ? milestones.filter((m) => m.is_active !== false) : undefined}
        onSubmit={(f, reason) => updateTask.mutate({ code: dlg.task.task_code, name_en: f.name_en, name_ar: f.name_ar || null, counts_toward_milestone: f.counts, is_active: f.active, ...(f.stage && f.stage !== dlg.task.stage_code ? { stage_code: f.stage } : {}), reason }, done(t('wfe.saved')))} />}
      {dlg?.kind === 'preds' && <PredecessorDialog task={dlg.task} all={placements} onClose={() => setDlg(null)} busy={setPreds.isPending} error={setPreds.isError ? err(setPreds.error) : null}
        onSubmit={(list, reason) => setPreds.mutate({ code: dlg.task.task_code, predecessors: list, reason }, done(t('wfe.saved')))} />}
      {dlg?.kind === 'succs' && <PredecessorDialog task={dlg.task} all={placements} succ onClose={() => setDlg(null)} busy={setSuccs.isPending} error={setSuccs.isError ? err(setSuccs.error) : null}
        onSubmit={(list, reason) => setSuccs.mutate({ code: dlg.task.task_code, successors: list, reason }, done(t('wfe.saved')))} />}
      {dlg?.kind === 'insert' && <InsertDialog version={v.version} stage={dlg.stage} all={placements} published={v.status === 'published'} onClose={() => setDlg(null)} busy={insertTask.isPending} error={insertTask.isError ? err(insertTask.error) : null}
        onSubmit={(f, reason) => insertTask.mutate({ stage_code: dlg.stage, code: f.code, name_en: f.name_en, name_ar: f.name_ar || null, counts_toward_milestone: f.counts, after_task_code: f.after || null,
          predecessors: f.preds, successors: f.succs, remove_direct_links: f.remove, add_to_open_sites: f.openSites, reason, ...(f.master ? { confirm_master_impact: f.master } : {}) }, done(t('wfe.saved')))} />}
      {dlg?.kind === 'structure' && <StructureDialog v={v} onClose={() => setDlg(null)} busy={replace.isPending} error={replace.isError ? err(replace.error) : null}
        onSubmit={(st, reason) => replace.mutate({ ...st, reason }, done(t('wfe.saved')))} />}
      {dlg?.kind === 'migrate' && <MigrationDialog version={v.version} versions={allVersions} phrase={v.validation?.master_impact?.confirmation_phrase ?? null} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'milestone' && <LightDialog title={t('wfe.edit_names')} item={dlg.m} onClose={() => setDlg(null)} busy={msLight.isPending} error={msLight.isError ? err(msLight.error) : null}
        onSubmit={(f, reason) => msLight.mutate({ code: dlg.m.code, ...f, reason }, done(t('wfe.saved')))} />}
      {dlg?.kind === 'gate' && <LightDialog title={t('wfe.edit_names')} item={dlg.g} gate onClose={() => setDlg(null)} busy={gateLight.isPending} error={gateLight.isError ? err(gateLight.error) : null}
        onSubmit={(f, reason) => gateLight.mutate({ code: dlg.g.code, ...f, reason }, done(t('wfe.saved')))} />}
      {dlg?.kind === 'remove' && <FormDialog open onClose={() => setDlg(null)} testid="wfe-remove-dialog" title={t('wfe.remove_title', { kind: t(`wfe.kind_${dlg.what}`), code: dlg.code })} busy={removeItem.isPending} error={removeItem.isError ? err(removeItem.error) : null}
        onSubmit={(reason) => removeItem.mutate({ kind: dlg.what, code: dlg.code, reason }, { onSuccess: (r) => { toast(`${t(`wfe.removed_${r.outcome}`)} ${r.why.map((w) => t(`wfe.why_${w}`)).join(' ')}`); setDlg(null); } })}>
        <p className="text-sm text-mute">{t('wfe.remove_hint')}</p>
      </FormDialog>}
      {dlg?.kind === 'discard' && <FormDialog open onClose={() => setDlg(null)} testid="wfe-discard-dialog" title={t('wfe.discard_draft')} busy={discard.isPending} error={discard.isError ? err(discard.error) : null}
        onSubmit={(reason) => discard.mutate({ reason }, { onSuccess: () => { toast(t('wfe.discarded')); setDlg(null); onGone(); } })}>
        <p className="text-sm text-mute">{t('wfe.discard_hint')}</p>
      </FormDialog>}
      {dlg?.kind === 'publish' && <PublishDialog version={v.version} onClose={() => setDlg(null)} busy={publish.isPending} error={publish.isError ? err(publish.error) : null}
        phrase={v.validation?.master_impact?.confirmation_phrase ?? null}
        onSubmit={(confirm, reason, master) => publish.mutate({ reason, confirm_text: confirm, ...(master ? { confirm_master_impact: master } : {}) }, done(t('wfe.published')))} />}
    </div>
  );
}

function TaskDialog({ title, onClose, onSubmit, busy, error, initial, withCode, withActive, stages }: {
  title: string; onClose: () => void; busy: boolean; error: string | null; initial?: P; withCode?: boolean; withActive?: boolean; stages?: M[];
  onSubmit: (f: { code: string; name_en: string; name_ar: string; counts: boolean; active: boolean; stage: string }, reason: string) => void;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [en, setEn] = useState(initial?.name_en ?? '');
  const [ar, setAr] = useState(initial?.name_ar ?? '');
  const [counts, setCounts] = useState(initial?.counts_toward_milestone ?? true);
  const [active, setActive] = useState(initial?.is_active ?? true);
  const [stage, setStage] = useState(initial?.stage_code ?? '');
  return (
    <FormDialog open onClose={onClose} testid="wfe-task-dialog" title={title} busy={busy} error={error} disabled={!en.trim() || (withCode && !code.trim())} onSubmit={(r) => onSubmit({ code: code.trim().toUpperCase(), name_en: en.trim(), name_ar: ar.trim(), counts, active, stage }, r)}>
      {withCode && <label className="block text-sm font-semibold">{t('wfe.code')}<input className="input mt-1 font-normal" dir="ltr" data-testid="wfe-code" value={code} onChange={(e) => setCode(e.target.value)} /></label>}
      <label className="block text-sm font-semibold">{t('wfe.name_en')}<input className="input mt-1 font-normal" dir="ltr" data-testid="wfe-name-en" value={en} onChange={(e) => setEn(e.target.value)} /></label>
      <label className="block text-sm font-semibold">{t('wfe.name_ar')}<input className="input mt-1 font-normal" dir="rtl" data-testid="wfe-name-ar" value={ar} onChange={(e) => setAr(e.target.value)} /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={counts} onChange={(e) => setCounts(e.target.checked)} data-testid="wfe-counts" />{t('wfe.counts_hint')}</label>
      {stages && <label className="block text-sm font-semibold">{t('wfe.move_to')}<select className="input mt-1 font-normal" data-testid="wfe-task-stage" value={stage} onChange={(e) => setStage(e.target.value)}>{stages.map((m) => <option key={m.code} value={m.code}>{m.code} {m.name_en}</option>)}</select></label>}
      {withActive && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} data-testid="wfe-active" />{t('wfe.active')}</label>}
    </FormDialog>
  );
}

/** A filtered checklist of the active tasks of the version (the predecessor, successor and insert pickers). */
function TaskPicker({ all, exclude, sel, onChange, prefix }: { all: P[]; exclude?: string; sel: string[]; onChange: (v: string[]) => void; prefix: string }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const options = all.filter((p) => p.task_code !== exclude && p.is_active !== false && `${p.task_code} ${p.name_en ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div>
      <input className="input" dir="ltr" placeholder={t('common.search')} aria-label={t('common.search')} value={filter} onChange={(e) => setFilter(e.target.value)} />
      <ul className="max-h-48 overflow-y-auto text-sm" data-testid={`${prefix}-list`}>
        {options.map((p) => (
          <li key={p.task_code}><label className="flex items-center gap-2 py-0.5">
            <input type="checkbox" data-testid={`${prefix}-opt-${p.task_code}`} checked={sel.includes(p.task_code)} onChange={(e) => onChange(e.target.checked ? [...sel, p.task_code] : sel.filter((c) => c !== p.task_code))} />
            <span className="mono">{p.task_code}</span> {p.name_en}
          </label></li>
        ))}
      </ul>
    </div>
  );
}

const successorsOf = (all: P[], code: string) => all.filter((x) => (x.predecessors ?? []).includes(code)).map((x) => x.task_code);

/** The predecessor (or, with `succ`, the successor) multi-select of one task. A cycle comes back as a field error and is shown here. */
function PredecessorDialog({ task, all, succ, onClose, onSubmit, busy, error }: { task: P; all: P[]; succ?: boolean; onClose: () => void; busy: boolean; error: string | null; onSubmit: (list: string[], reason: string) => void }) {
  const { t } = useTranslation();
  const [sel, setSel] = useState<string[]>(succ ? successorsOf(all, task.task_code) : task.predecessors ?? []);
  return (
    <FormDialog open wide onClose={onClose} testid={succ ? 'wfe-succ-dialog' : 'wfe-pred-dialog'} title={succ ? t('wfe.successors_of', { task: task.task_code }) : `${t('wfe.predecessors')}: ${task.task_code}`} busy={busy} error={error} onSubmit={(r) => onSubmit(sel, r)}>
      <TaskPicker all={all} exclude={task.task_code} sel={sel} onChange={setSel} prefix={succ ? 'wfe-succ' : 'wfe-pred'} />
    </FormDialog>
  );
}

/** The waterfall of one milestone: each task indented by its depth in the chain, with what it waits for and what waits for it. A code opens its predecessors. */
function DependencyView({ stage, rows, all, nm, canEdit, onPreds, onSuccs }: { stage: string; rows: P[]; all: P[]; nm: (x: P) => string; canEdit: boolean; onPreds: (p: P) => void; onSuccs: (p: P) => void }) {
  const { t } = useTranslation();
  const depth = useMemo(() => {
    const memo = new Map<string, number>();
    const d = (c: string, seen: string[]): number => {
      if (memo.has(c)) return memo.get(c)!;
      if (seen.includes(c)) return 0;
      const preds = (all.find((x) => x.task_code === c)?.predecessors ?? []).filter((x) => rows.some((r) => r.task_code === x));
      const n = preds.length ? 1 + Math.max(...preds.map((x) => d(x, [...seen, c]))) : 0;
      memo.set(c, n);
      return n;
    };
    return (c: string) => d(c, []);
  }, [all, rows]);
  const chip = (code: string) => {
    const p = all.find((x) => x.task_code === code);
    return canEdit && p ? <button key={code} className="mono underline" data-testid={`wfe-dep-link-${code}`} onClick={() => onPreds(p)}>{code}</button> : <span key={code} className="mono">{code}</span>;
  };
  const list = (codes: string[]) => (codes.length ? codes.flatMap((c, i) => (i ? [', ', chip(c)] : [chip(c)])) : t('wfe.none'));
  return (
    <details className="mt-2" data-testid={`wfe-deps-${stage}`}>
      <summary className="cursor-pointer text-sm font-semibold">{t('wfe.dep_view')}</summary>
      <p className="text-xs text-mute">{t('wfe.dep_hint')}</p>
      <ol className="mt-1 space-y-1 text-sm">
        {rows.filter((p) => p.is_active !== false).map((p) => (
          <li key={p.task_code} style={{ paddingInlineStart: `${depth(p.task_code) * 20}px` }} className="rounded border border-line px-2 py-1" data-testid={`wfe-dep-${p.task_code}`}>
            <span className="mono font-semibold">{p.task_code}</span> {nm(p)}
            <span className="block text-mute">{t('wfe.waits_for')}: {list(p.predecessors ?? [])} · {t('wfe.blocks')}: {list(successorsOf(all, p.task_code))}
              {canEdit && <button className="btn ms-2" data-testid={`wfe-dep-succ-${p.task_code}`} onClick={() => onSuccs(p)}>{t('wfe.edit_links')}</button>}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Insert a task among the existing tasks of a milestone: the preview of the affected chain is fetched while the choices change, nothing is written until the reason is saved. */
function InsertDialog({ version, stage, all, published, onClose, onSubmit, busy, error }: {
  version: number; stage: string; all: P[]; published: boolean; onClose: () => void; busy: boolean; error: string | null;
  onSubmit: (f: { code: string; name_en: string; name_ar: string; counts: boolean; after: string; preds: string[]; succs: string[]; remove: boolean; openSites: boolean; master: string }, reason: string) => void;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [en, setEn] = useState('');
  const [ar, setAr] = useState('');
  const [counts, setCounts] = useState(true);
  const [after, setAfter] = useState('');
  const [preds, setPreds] = useState<string[]>([]);
  const [succs, setSuccs] = useState<string[]>([]);
  const [remove, setRemove] = useState(false);
  const [openSites, setOpenSites] = useState(false);
  const [master, setMaster] = useState('');
  const preview = usePreviewInsert(version);
  const { mutate } = preview;
  useEffect(() => {
    if (preds.length === 0 && succs.length === 0) return;
    mutate({ stage_code: stage, predecessors: preds, successors: succs, remove_direct_links: remove, counts_toward_milestone: counts });
  }, [mutate, stage, preds, succs, remove, counts]);
  const pv = preds.length === 0 && succs.length === 0 ? null : preview.data ?? null;
  const cycle = pv?.errors?.find((e) => e.code === 'cycle');
  const phrase = pv?.master_confirmation_needed ? pv.confirmation_phrase ?? null : null;
  const stageRows = all.filter((p) => p.stage_code === stage);
  return (
    <FormDialog open wide onClose={onClose} testid="wfe-insert-dialog" title={`${t('wfe.insert_task')}: ${stage}`} busy={busy} error={error}
      disabled={!en.trim() || !code.trim() || !!cycle || (pv ? !pv.valid : false) || (!!phrase && master !== phrase)}
      onSubmit={(r) => onSubmit({ code: code.trim().toUpperCase(), name_en: en.trim(), name_ar: ar.trim(), counts, after, preds, succs, remove, openSites, master }, r)}>
      <p className="text-sm text-mute">{t('wfe.insert_hint')}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-sm font-semibold">{t('wfe.code')}<input className="input mt-1 font-normal" dir="ltr" data-testid="wfe-ins-code" value={code} onChange={(e) => setCode(e.target.value)} /></label>
        <label className="block text-sm font-semibold">{t('wfe.after_task')}
          <select className="input mt-1 font-normal" data-testid="wfe-ins-after" value={after} onChange={(e) => setAfter(e.target.value)}>
            <option value="">{t('wfe.last')}</option>
            {stageRows.map((p) => <option key={p.task_code} value={p.task_code}>{p.task_code}</option>)}
          </select></label>
        <label className="block text-sm font-semibold">{t('wfe.name_en')}<input className="input mt-1 font-normal" dir="ltr" data-testid="wfe-ins-en" value={en} onChange={(e) => setEn(e.target.value)} /></label>
        <label className="block text-sm font-semibold">{t('wfe.name_ar')}<input className="input mt-1 font-normal" dir="rtl" data-testid="wfe-ins-ar" value={ar} onChange={(e) => setAr(e.target.value)} /></label>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={counts} onChange={(e) => setCounts(e.target.checked)} data-testid="wfe-ins-counts" />{t('wfe.counts_hint')}</label>
      <div className="grid gap-3 sm:grid-cols-2">
        <div><p className="text-sm font-semibold">{t('wfe.predecessors')}</p><TaskPicker all={all} sel={preds} onChange={setPreds} prefix="wfe-ins-pred" /></div>
        <div><p className="text-sm font-semibold">{t('wfe.successors')}</p><TaskPicker all={all} sel={succs} onChange={setSuccs} prefix="wfe-ins-succ" /></div>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} data-testid="wfe-ins-remove" />{t('wfe.remove_direct')}</label>
      <section aria-live="polite" className="rounded border border-line p-2 text-sm" data-testid="wfe-ins-chain">
        <h5 className="font-semibold">{t('wfe.chain')}</h5>
        {!pv && <p className="text-mute">{t('wfe.chain_empty')}</p>}
        {cycle && <p role="alert" className="text-lateInk" data-testid="wfe-ins-cycle">{t('wfe.err_cycle_insert')}</p>}
        {pv?.valid && (pv.rewiring.length === 0
          ? <p className="mono" dir="ltr">{pv.predecessors.join(', ') || '-'} {'\u2192'} <b>{code.trim().toUpperCase() || '?'}</b> ({t('wfe.new_task')})</p>
          : <ul className="space-y-1">{pv.rewiring.map((r) => (
            <li key={r.successor} data-testid={`wfe-ins-rewire-${r.successor}`}>
              <span className="mono" dir="ltr">{pv.predecessors.join(', ') || '-'} {'\u2192'} <b>{code.trim().toUpperCase() || '?'}</b> {'\u2192'} {r.successor}</span>
              {r.removed_links.length > 0 && <span className="ms-2 text-mute"><s className="mono">{r.removed_links.join(', ')} {'\u2192'} {r.successor}</s> ({t('wfe.link_removed')})</span>}
            </li>))}</ul>)}
        {pv?.warnings?.includes('counting_task_may_move_milestone') && <p className="text-waitInk" data-testid="wfe-ins-b8">{t('wfe.b8_warning')}</p>}
      </section>
      {published && (
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={openSites} onChange={(e) => setOpenSites(e.target.checked)} data-testid="wfe-ins-open" />
          {pv && pv.open_sites > 0 ? t('wfe.add_open_sites', { count: pv.open_sites }) : t('wfe.new_sites_only')}</label>
      )}
      {phrase && <label className="block text-sm font-semibold">{t('wfe.type_to_confirm', { text: phrase })}<input className="input mt-1 font-normal" dir="ltr" data-testid="wfe-ins-master" value={master} onChange={(e) => setMaster(e.target.value)} /></label>}
    </FormDialog>
  );
}

function LightDialog({ title, item, gate, onClose, onSubmit, busy, error }: {
  title: string; item: M | G; gate?: boolean; onClose: () => void; busy: boolean; error: string | null;
  onSubmit: (f: { name_en: string; name_ar: string; sla_min_wd?: number; sla_max_wd?: number; conditions?: GateCondition[] }, reason: string) => void;
}) {
  const { t } = useTranslation();
  const [en, setEn] = useState(item.name_en);
  const [ar, setAr] = useState(item.name_ar ?? '');
  const g = item as G;
  const [mn, setMn] = useState(String(g.sla_min_wd ?? ''));
  const [mx, setMx] = useState(String(g.sla_max_wd ?? ''));
  const [conds, setConds] = useState<GateCondition[]>(g.conditions ?? []);
  return (
    <FormDialog open onClose={onClose} testid="wfe-light-dialog" title={`${title}: ${item.code}`} busy={busy} error={error} disabled={!en.trim()}
      onSubmit={(r) => onSubmit({ name_en: en.trim(), name_ar: ar.trim(), ...(gate && mn !== '' ? { sla_min_wd: Number(mn) } : {}), ...(gate && mx !== '' ? { sla_max_wd: Number(mx) } : {}), ...(gate ? { conditions: conds.filter((c) => c.type === 'stop_work_blocks' || (c.ref ?? '').trim()) } : {}) }, r)}>
      <p className="text-sm text-mute">{t('wfe.light_hint')}</p>
      <label className="block text-sm font-semibold">{t('wfe.name_en')}<input className="input mt-1 font-normal" dir="ltr" data-testid="wfe-light-en" value={en} onChange={(e) => setEn(e.target.value)} /></label>
      <label className="block text-sm font-semibold">{t('wfe.name_ar')}<input className="input mt-1 font-normal" dir="rtl" data-testid="wfe-light-ar" value={ar} onChange={(e) => setAr(e.target.value)} /></label>
      {gate && <div className="flex gap-3">
        <label className="text-sm font-semibold">SLA min<input type="number" min={0} className="input mt-1 font-normal" dir="ltr" value={mn} onChange={(e) => setMn(e.target.value)} /></label>
        <label className="text-sm font-semibold">SLA max<input type="number" min={0} className="input mt-1 font-normal" dir="ltr" value={mx} onChange={(e) => setMx(e.target.value)} /></label>
      </div>}
      {gate && <ConditionsEditor value={conds} onChange={setConds} prefix="wfe-light-gate" />}
    </FormDialog>
  );
}

/** Publishing needs the typed confirmation `v<version>` (CLAUDE.md), a reason and the step-up the client opens on 401. During the parallel run the Master impact is typed too. */
function PublishDialog({ version, phrase, onClose, onSubmit, busy, error }: { version: number; phrase: string | null; onClose: () => void; busy: boolean; error: string | null; onSubmit: (confirm: string, reason: string, master: string | null) => void }) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  const [master, setMaster] = useState('');
  return (
    <FormDialog open onClose={onClose} testid="wfe-publish-dialog" title={t('wfe.publish')} busy={busy} error={error} disabled={typed !== `v${version}` || (!!phrase && master !== phrase)}
      onSubmit={(r) => onSubmit(typed, r, phrase ? master : null)}>
      <p className="text-sm text-mute">{t('wfe.publish_hint')}</p>
      <label className="block text-sm font-semibold">{t('wfe.type_to_confirm', { text: `v${version}` })}<input className="input mt-1 font-normal" dir="ltr" data-testid="wfe-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
      {phrase && <label className="block text-sm font-semibold">{t('wfe.type_to_confirm', { text: phrase })}<input className="input mt-1 font-normal" dir="ltr" data-testid="wfe-confirm-master" value={master} onChange={(e) => setMaster(e.target.value)} /></label>}
    </FormDialog>
  );
}
