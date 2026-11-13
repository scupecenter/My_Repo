import { ArrowDown, ArrowUp, GitBranch, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import {
  useCreateDraft, useCreateTask, useGateLight, useMilestoneLight, usePublish, useReorderTasks, useSetPredecessors, useUpdateTask, useWorkflowVersion, useWorkflowVersions,
  type TaskPlacement, type WorkflowVersion,
} from '@/api/workflowEditor';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';

type P = TaskPlacement & { name_en?: string; name_ar?: string | null; is_active?: boolean };
type M = { code: string; name_en: string; name_ar?: string | null; is_active?: boolean; counts_in_project_status?: boolean };
type G = { code: string; name_en: string; name_ar?: string | null; from_milestone: string; to_milestone: string; sla_min_wd?: number | null; sla_max_wd?: number | null };

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
      {open !== null && <Editor version={open} />}
    </section>
  );
}

function Editor({ version }: { version: number }) {
  const q = useWorkflowVersion(version);
  const { t } = useTranslation();
  if (q.isError) return <p role="alert" className="text-lateInk">{t('errors.generic')}</p>;
  if (!q.data) return <p>…</p>;
  return <VersionEditor v={q.data} key={`${q.data.version}-${q.data.version_etag}`} />;
}

type Dlg = null | { kind: 'create'; stage: string } | { kind: 'edit'; task: P } | { kind: 'preds'; task: P } | { kind: 'milestone'; m: M } | { kind: 'gate'; g: G } | { kind: 'publish' };

function VersionEditor({ v }: { v: WorkflowVersion }) {
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
  const reorder = useReorderTasks(v.version, etag);
  const msLight = useMilestoneLight(v.version, etag);
  const gateLight = useGateLight(v.version, etag);
  const publish = usePublish(v.version, etag);
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
                        <button className="btn" data-testid={`wfe-pred-${p.task_code}`} onClick={() => { setPreds.reset(); setDlg({ kind: 'preds', task: p }); }}>{t('wfe.predecessors')}</button>
                      </>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {gate && (
              <p className="mt-2 text-sm text-mute" data-testid={`wfe-gate-${gate.code}`}>
                {t('wfe.gate')} {gate.code}: {nm(gate)} · SLA {gate.sla_min_wd ?? '-'}/{gate.sla_max_wd ?? '-'}
                {canEdit && <button className="btn ms-2" data-testid={`wfe-gate-edit-${gate.code}`} onClick={() => { gateLight.reset(); setDlg({ kind: 'gate', g: gate }); }}>{t('wfe.edit_names')}</button>}
              </p>
            )}
          </section>
        );
      })}

      {dlg?.kind === 'create' && <TaskDialog title={t('wfe.add_task')} onClose={() => setDlg(null)} busy={createTask.isPending} error={createTask.isError ? err(createTask.error) : null} withCode
        onSubmit={(f, reason) => createTask.mutate({ stage_code: dlg.stage, code: f.code, name_en: f.name_en, name_ar: f.name_ar || null, counts_toward_milestone: f.counts, reason }, done(t('wfe.saved')))} />}
      {dlg?.kind === 'edit' && <TaskDialog title={t('wfe.edit_task')} onClose={() => setDlg(null)} busy={updateTask.isPending} error={updateTask.isError ? err(updateTask.error) : null} initial={dlg.task} withActive
        onSubmit={(f, reason) => updateTask.mutate({ code: dlg.task.task_code, name_en: f.name_en, name_ar: f.name_ar || null, counts_toward_milestone: f.counts, is_active: f.active, reason }, done(t('wfe.saved')))} />}
      {dlg?.kind === 'preds' && <PredecessorDialog task={dlg.task} all={placements} onClose={() => setDlg(null)} busy={setPreds.isPending} error={setPreds.isError ? err(setPreds.error) : null}
        onSubmit={(list, reason) => setPreds.mutate({ code: dlg.task.task_code, predecessors: list, reason }, done(t('wfe.saved')))} />}
      {dlg?.kind === 'milestone' && <LightDialog title={t('wfe.edit_names')} item={dlg.m} onClose={() => setDlg(null)} busy={msLight.isPending} error={msLight.isError ? err(msLight.error) : null}
        onSubmit={(f, reason) => msLight.mutate({ code: dlg.m.code, ...f, reason }, done(t('wfe.saved')))} />}
      {dlg?.kind === 'gate' && <LightDialog title={t('wfe.edit_names')} item={dlg.g} gate onClose={() => setDlg(null)} busy={gateLight.isPending} error={gateLight.isError ? err(gateLight.error) : null}
        onSubmit={(f, reason) => gateLight.mutate({ code: dlg.g.code, ...f, reason }, done(t('wfe.saved')))} />}
      {dlg?.kind === 'publish' && <PublishDialog version={v.version} onClose={() => setDlg(null)} busy={publish.isPending} error={publish.isError ? err(publish.error) : null}
        phrase={v.validation?.master_impact?.confirmation_phrase ?? null}
        onSubmit={(confirm, reason, master) => publish.mutate({ reason, confirm_text: confirm, ...(master ? { confirm_master_impact: master } : {}) }, done(t('wfe.published')))} />}
    </div>
  );
}

function TaskDialog({ title, onClose, onSubmit, busy, error, initial, withCode, withActive }: {
  title: string; onClose: () => void; busy: boolean; error: string | null; initial?: P; withCode?: boolean; withActive?: boolean;
  onSubmit: (f: { code: string; name_en: string; name_ar: string; counts: boolean; active: boolean }, reason: string) => void;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [en, setEn] = useState(initial?.name_en ?? '');
  const [ar, setAr] = useState(initial?.name_ar ?? '');
  const [counts, setCounts] = useState(initial?.counts_toward_milestone ?? true);
  const [active, setActive] = useState(initial?.is_active ?? true);
  return (
    <FormDialog open onClose={onClose} testid="wfe-task-dialog" title={title} busy={busy} error={error} disabled={!en.trim() || (withCode && !code.trim())} onSubmit={(r) => onSubmit({ code: code.trim().toUpperCase(), name_en: en.trim(), name_ar: ar.trim(), counts, active }, r)}>
      {withCode && <label className="block text-sm font-semibold">{t('wfe.code')}<input className="input mt-1 font-normal" dir="ltr" data-testid="wfe-code" value={code} onChange={(e) => setCode(e.target.value)} /></label>}
      <label className="block text-sm font-semibold">{t('wfe.name_en')}<input className="input mt-1 font-normal" dir="ltr" data-testid="wfe-name-en" value={en} onChange={(e) => setEn(e.target.value)} /></label>
      <label className="block text-sm font-semibold">{t('wfe.name_ar')}<input className="input mt-1 font-normal" dir="rtl" data-testid="wfe-name-ar" value={ar} onChange={(e) => setAr(e.target.value)} /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={counts} onChange={(e) => setCounts(e.target.checked)} data-testid="wfe-counts" />{t('wfe.counts_hint')}</label>
      {withActive && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} data-testid="wfe-active" />{t('wfe.active')}</label>}
    </FormDialog>
  );
}

/** The predecessor multi-select: every other task of the version, checked when the task waits for it. A cycle comes back as a field error and is shown here. */
function PredecessorDialog({ task, all, onClose, onSubmit, busy, error }: { task: P; all: P[]; onClose: () => void; busy: boolean; error: string | null; onSubmit: (list: string[], reason: string) => void }) {
  const { t } = useTranslation();
  const [sel, setSel] = useState<string[]>(task.predecessors ?? []);
  const [filter, setFilter] = useState('');
  const options = all.filter((p) => p.task_code !== task.task_code && p.is_active !== false && `${p.task_code} ${p.name_en ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <FormDialog open wide onClose={onClose} testid="wfe-pred-dialog" title={`${t('wfe.predecessors')}: ${task.task_code}`} busy={busy} error={error} onSubmit={(r) => onSubmit(sel, r)}>
      <input className="input" dir="ltr" placeholder={t('common.search')} aria-label={t('common.search')} value={filter} onChange={(e) => setFilter(e.target.value)} />
      <ul className="max-h-64 overflow-y-auto text-sm" data-testid="wfe-pred-list">
        {options.map((p) => (
          <li key={p.task_code}><label className="flex items-center gap-2 py-0.5">
            <input type="checkbox" data-testid={`wfe-pred-opt-${p.task_code}`} checked={sel.includes(p.task_code)} onChange={(e) => setSel(e.target.checked ? [...sel, p.task_code] : sel.filter((c) => c !== p.task_code))} />
            <span className="mono">{p.task_code}</span> {p.name_en}
          </label></li>
        ))}
      </ul>
    </FormDialog>
  );
}

function LightDialog({ title, item, gate, onClose, onSubmit, busy, error }: {
  title: string; item: M | G; gate?: boolean; onClose: () => void; busy: boolean; error: string | null;
  onSubmit: (f: { name_en: string; name_ar: string; sla_min_wd?: number; sla_max_wd?: number }, reason: string) => void;
}) {
  const { t } = useTranslation();
  const [en, setEn] = useState(item.name_en);
  const [ar, setAr] = useState(item.name_ar ?? '');
  const g = item as G;
  const [mn, setMn] = useState(String(g.sla_min_wd ?? ''));
  const [mx, setMx] = useState(String(g.sla_max_wd ?? ''));
  return (
    <FormDialog open onClose={onClose} testid="wfe-light-dialog" title={`${title}: ${item.code}`} busy={busy} error={error} disabled={!en.trim()}
      onSubmit={(r) => onSubmit({ name_en: en.trim(), name_ar: ar.trim(), ...(gate && mn !== '' ? { sla_min_wd: Number(mn) } : {}), ...(gate && mx !== '' ? { sla_max_wd: Number(mx) } : {}) }, r)}>
      <p className="text-sm text-mute">{t('wfe.light_hint')}</p>
      <label className="block text-sm font-semibold">{t('wfe.name_en')}<input className="input mt-1 font-normal" dir="ltr" data-testid="wfe-light-en" value={en} onChange={(e) => setEn(e.target.value)} /></label>
      <label className="block text-sm font-semibold">{t('wfe.name_ar')}<input className="input mt-1 font-normal" dir="rtl" data-testid="wfe-light-ar" value={ar} onChange={(e) => setAr(e.target.value)} /></label>
      {gate && <div className="flex gap-3">
        <label className="text-sm font-semibold">SLA min<input type="number" min={0} className="input mt-1 font-normal" dir="ltr" value={mn} onChange={(e) => setMn(e.target.value)} /></label>
        <label className="text-sm font-semibold">SLA max<input type="number" min={0} className="input mt-1 font-normal" dir="ltr" value={mx} onChange={(e) => setMx(e.target.value)} /></label>
      </div>}
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
