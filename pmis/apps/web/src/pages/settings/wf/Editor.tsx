import type { DragEndEvent } from '@dnd-kit/core';
import { ArrowLeft, Eye, LayoutList, Lock, Table2, Trash2, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useBulkTaskPatch, useCreateTask, useDiscardDraft, useGateLight, useInsertTask, useMilestoneLight, usePublish, useRemoveItem, useReorderTasks, useReplaceStructure, useSetClosing, useSetPredecessors, useTaskSla, useUpdateTask, useWorkflowVersion, useWorkflowVersions,
  type StructureInput, type WorkflowVersion,
} from '@/api/workflowEditor';
import { FreezeCard, useFrozen } from '@/components/FreezePanel';
import { FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { MigrationDialog } from '../WorkflowStructure';
import { Board, GateColumn, MilestoneColumn, TaskColumn, type Can } from './Columns';
import { DetailPanel } from './Detail';
import { InsertDialog, PublishDialog, TaskDialog } from './Dialogs';
import { DuplicateDialog, GateDialog, MilestoneDialog, PredecessorDialog, PreviewDialog, ReasonDialog, SiteLocksShortcut, TableView } from './Forms';
import { diffVersions, findCycle, resolveDrop, type G, type M, type P, type Sel } from './model';
import { useErr } from './useErr';

type Dlg =
  | null | { k: 'ms-add' } | { k: 'ms-rename'; m: M } | { k: 'gate-add' } | { k: 'gate-edit'; g: G } | { k: 'insert'; after: string; next: string }
  | { k: 'rename'; p: P } | { k: 'dup'; p: P } | { k: 'preds'; p: P } | { k: 'remove'; what: 'task' | 'milestone' | 'gate'; code: string }
  | { k: 'discard' } | { k: 'preview' } | { k: 'publish' } | { k: 'migrate' } | { k: 'sitelocks' } | { k: 'lock' };
type Ask = { title: string; hint: string; run: (reason: string, cb: { onSuccess: () => void; onError: (e: unknown) => void }) => void };
const REASON_KEY = 'wfe.reorder_reason';

export function VersionLoader({ version, onGone }: { version: number; onGone: () => void }) {
  const q = useWorkflowVersion(version);
  const { t } = useTranslation();
  if (q.isError) return <p role="alert" className="text-lateInk">{t('errors.generic')}</p>;
  if (!q.data) return <p>{'…'}</p>;
  return <Editor v={q.data} onGone={onGone} key={q.data.version} />;
}

/** The three-column editor: milestones, the tasks of the selected milestone, the gate after it, and a detail panel. On a phone the columns are steps with a back button. */
export function Editor({ v, onGone }: { v: WorkflowVersion; onGone: () => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const err = useErr();
  const etag = v.version_etag ?? 0;
  const ar = i18n.language === 'ar';
  const { frozen, until } = useFrozen();
  const placements = v.placements as P[];
  const milestones = v.milestones as M[];
  const gates = v.gates as G[];
  const canEdit = v.can_edit === true;
  const isDraft = v.status === 'draft';
  const edit = canEdit && isDraft;
  const struct = edit && !frozen;
  const why = !canEdit ? t('wfe.readonly') : !isDraft ? t('wfe.draft_only_why') : frozen ? t('wfe.frozen_why', { date: until ?? '' }) : null;

  const [msSel, setMsSel] = useState('');
  const [sel, setSel] = useState<Sel>(null);
  const [dlg, setDlg] = useState<Dlg>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [askBusy, setAskBusy] = useState(false);
  const [askErr, setAskErr] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [table, setTable] = useState(false);

  const createTask = useCreateTask(v.version, etag), updateTask = useUpdateTask(v.version, etag), setPreds = useSetPredecessors(v.version, etag), setClosing = useSetClosing(v.version, etag);
  const insertTask = useInsertTask(v.version, etag), replace = useReplaceStructure(v.version, etag), reorder = useReorderTasks(v.version, etag);
  const msLight = useMilestoneLight(v.version, etag), gateLight = useGateLight(v.version, etag), publish = usePublish(v.version, etag);
  const removeItem = useRemoveItem(v.version, etag), discard = useDiscardDraft(v.version, etag), bulk = useBulkTaskPatch(v.version, etag);
  const allVersions = useWorkflowVersions().data?.items ?? [];
  const parent = useWorkflowVersion(isDraft ? v.parent_version ?? null : null).data;
  const sla = useTaskSla().data ?? new Map<string, { min: number; max: number }>();
  const busy = [createTask, updateTask, setPreds, setClosing, insertTask, replace, reorder, msLight, gateLight, publish, removeItem, discard, bulk].some((m) => m.isPending);
  const can: Can = { edit, struct, why, busy };

  const nm = (x: { name_en?: string; name_ar?: string | null }) => (ar && x.name_ar ? x.name_ar : x.name_en ?? '');
  const cur = milestones.find((m) => m.code === msSel) ?? milestones.find((m) => m.is_active !== false) ?? milestones[0];
  const rows = placements.filter((p) => p.stage_code === cur?.code);
  const myGates = gates.filter((g) => g.from_milestone === cur?.code);
  const nextMs = (() => { const i = milestones.findIndex((m) => m.code === cur?.code); return milestones.slice(i + 1).find((m) => m.is_active !== false); })();
  const done = (msg: string) => ({ onSuccess: () => { toast(msg); setDlg(null); }, onError: (e: unknown) => toast(err(e)) });
  const open = (d: Dlg, ...reset: { reset: () => void }[]) => { reset.forEach((r) => r.reset()); setDlg(d); };
  const askReason = (a: Ask) => { setAskErr(null); setAskBusy(false); setAsk(a); };
  const submitAsk = (reason: string) => {
    setAskBusy(true);
    ask?.run(reason, { onSuccess: () => { toast(t('wfe.saved')); setAsk(null); setAskBusy(false); }, onError: (e) => { setAskErr(err(e)); setAskBusy(false); } });
  };

  const structureOf = (patch: { milestones?: StructureInput['milestones']; gates?: StructureInput['gates'] }): Omit<StructureInput, 'reason'> => ({
    milestones: patch.milestones ?? milestones.map((m) => ({ code: m.code, is_active: m.is_active !== false })),
    gates: patch.gates ?? gates.map((g) => ({ code: g.code, is_active: g.is_active !== false })),
  });
  const moveMs = (i: number, d: -1 | 1) => {
    const list = milestones.map((m) => ({ code: m.code, is_active: m.is_active !== false }));
    [list[i], list[i + d]] = [list[i + d]!, list[i]!];
    replace.mutate({ ...structureOf({ milestones: list }), reason: t(REASON_KEY) }, { onError: (e) => toast(err(e)) });
  };
  const moveTask = (i: number, d: -1 | 1) => {
    const codes = rows.map((r) => r.task_code);
    [codes[i], codes[i + d]] = [codes[i + d]!, codes[i]!];
    reorder.mutate({ stage: cur!.code, task_codes: codes, reason: t(REASON_KEY) }, { onError: (e) => toast(err(e)) });
  };
  const toStage = (p: P, stage: string) => askReason({ title: t('wfe.move_task_title', { code: p.task_code, stage }), hint: t('wfe.move_task_hint'), run: (reason, cb) => updateTask.mutate({ code: p.task_code, stage_code: stage, reason }, cb) });
  const onDrop = (e: DragEndEvent) => {
    if (busy || !edit) return;
    const a = resolveDrop(String(e.active.id), e.over ? String(e.over.id) : null, milestones.map((m) => m.code), placements);
    if (!a) return;
    if (a.kind === 'reorder_milestones') { if (struct) replace.mutate({ ...structureOf({ milestones: a.codes.map((c) => ({ code: c, is_active: milestones.find((m) => m.code === c)?.is_active !== false })) }), reason: t(REASON_KEY) }, { onError: (x) => toast(err(x)) }); }
    else if (a.kind === 'reorder_tasks') reorder.mutate({ stage: a.stage, task_codes: a.codes, reason: t(REASON_KEY) }, { onError: (x) => toast(err(x)) });
    else if (struct) toStage(placements.find((p) => p.task_code === a.task)!, a.stage);
  };

  const cycle = useMemo(() => findCycle(placements), [placements]);
  const diff = useMemo(() => (parent ? diffVersions({ milestones: parent.milestones as M[], gates: parent.gates as G[], placements: parent.placements as P[] }, { milestones, gates, placements }) : null), [parent, milestones, gates, placements]);
  const phrase = v.validation?.master_impact?.confirmation_phrase ?? null;
  const select = (c: string) => { setSel({ kind: 'task', code: c }); setStep(2); };
  const pickMs = (c: string) => { setMsSel(c); setSel(null); setStep(1); };

  return (
    <div className="space-y-3 border-t border-line pt-3" data-testid="wfe-editor" data-status={v.status}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-bold">v{v.version} {'·'} {t(`wfe.status_${v.status}`)}</h3>
        <button type="button" className="btn" data-testid="wfe-table-toggle" aria-pressed={table} onClick={() => setTable((x) => !x)}>{table ? <LayoutList size={14} aria-hidden /> : <Table2 size={14} aria-hidden />} {table ? t('wfe.show_columns') : t('wfe.show_table')}</button>
        {(canEdit || v.can_publish) && <button type="button" className="btn" data-testid="wfe-sitelocks-btn" onClick={() => setDlg({ k: 'sitelocks' })}><Lock size={14} aria-hidden /> {t('wfe.sitelocks.title')}</button>}
        {isDraft && canEdit && <button type="button" className="btn" data-testid="wfe-discard" onClick={() => open({ k: 'discard' }, discard)}><Trash2 size={14} aria-hidden /> {t('wfe.discard_draft')}</button>}
        {!isDraft && v.can_publish && <button type="button" className="btn" data-testid="wfe-migrate" onClick={() => setDlg({ k: 'migrate' })}>{t('wfe.migrate_sites')}</button>}
        {isDraft && <button type="button" className="btn" data-testid="wfe-preview" onClick={() => setDlg({ k: 'preview' })}><Eye size={14} aria-hidden /> {t('wfe.preview_title')}</button>}
        {isDraft && v.can_publish && <button type="button" className="btn btn-accent" data-testid="wfe-publish" disabled={!v.validation?.valid || frozen} title={frozen ? why ?? '' : undefined} onClick={() => setDlg({ k: 'preview' })}><Upload size={14} aria-hidden /> {t('wfe.publish')}</button>}
      </div>
      <details className="rounded border border-line p-2" data-testid="wfe-lockpanel" open={frozen}><summary className="cursor-pointer text-sm font-semibold">{t('wfe.lock.panel')}</summary><FreezeCard compact /></details>
      {frozen && <p role="status" className="rounded border border-line bg-lockBg p-2 text-sm text-lockInk" data-testid="wfe-frozen-banner">{t('wfe.frozen_banner', { date: until ?? '' })}</p>}
      {!canEdit && <p className="text-sm text-mute" data-testid="wfe-readonly">{t('wfe.readonly')}</p>}
      {(v.validation?.problems?.length ?? 0) > 0 && <ul role="alert" className="list-disc ps-5 text-sm text-lateInk" data-testid="wfe-problems">{v.validation!.problems!.map((p) => <li key={p}>{p}</li>)}</ul>}
      {(v.validation?.warnings?.length ?? 0) > 0 && <ul className="list-disc ps-5 text-sm text-waitInk" data-testid="wfe-warnings">{v.validation!.warnings!.map((p) => <li key={p}>{p}</li>)}</ul>}
      {cycle && <p role="alert" className="text-sm text-lateInk" data-testid="wfe-cycle">{t('wfe.cycle_found', { path: cycle.join(' → ') })}</p>}

      {step > 0 && !table && <button type="button" className="btn md:hidden" data-testid="wfe-back" onClick={() => { if (step === 2) setSel(null); setStep(step - 1); }}><ArrowLeft size={14} aria-hidden className="rtl:rotate-180" /> {t('wfe.back')}</button>}

      {table ? (
        <TableView rows={placements} milestones={milestones} nm={nm} canEdit={edit} canMove={struct} why={why} onSelect={(c) => { setTable(false); const p = placements.find((x) => x.task_code === c); if (p) setMsSel(p.stage_code); select(c); }}
          onBulk={(codes, patch) => askReason({ title: t('wfe.table.bulk_title', { count: codes.length }), hint: t('wfe.table.bulk_hint'), run: (reason, cb) => bulk.mutate({ codes, patch, reason }, cb) })} />
      ) : (
        <Board onDrop={onDrop}>
          <div className="grid gap-3 md:grid-cols-3">
            <div className={`${step === 0 ? '' : 'hidden'} md:block`}>
              <MilestoneColumn milestones={milestones} selected={cur?.code ?? ''} nm={nm} can={can} taskCount={(c) => placements.filter((p) => p.stage_code === c && p.is_active !== false).length}
                onSelect={pickMs} onAdd={() => open({ k: 'ms-add' }, replace)} onRename={(m) => open({ k: 'ms-rename', m }, msLight)} onMove={moveMs} onRemove={(m) => open({ k: 'remove', what: 'milestone', code: m.code }, removeItem)}
                onToggle={(m) => askReason({ title: `${m.is_active === false ? t('wfe.activate') : t('wfe.deactivate')}: ${m.code}`, hint: t('wfe.toggle_ms_hint'),
                  run: (reason, cb) => replace.mutate({ ...structureOf({ milestones: milestones.map((x) => ({ code: x.code, is_active: x.code === m.code ? x.is_active === false : x.is_active !== false })) }), reason }, cb) })} />
            </div>
            <div className={`${step === 1 ? '' : 'hidden'} space-y-3 md:block md:col-span-2`}>
              <div className="grid gap-3 md:grid-cols-2">
                <TaskColumn rows={rows} sel={sel} nm={nm} can={can} milestoneName={cur ? nm(cur) : ''} onSelect={select} onMove={moveTask}
                  onInsert={(i) => open({ k: 'insert', after: rows[i - 1]?.task_code ?? '', next: rows[i]?.task_code ?? '' }, insertTask)} onRename={(p) => open({ k: 'rename', p }, updateTask)} onDuplicate={(p) => open({ k: 'dup', p }, createTask)}
                  onRemove={(p) => open({ k: 'remove', what: 'task', code: p.task_code }, removeItem)}
                  onToggle={(p) => askReason({ title: `${p.is_active === false ? t('wfe.activate') : t('wfe.deactivate')}: ${p.task_code}`, hint: t('wfe.toggle_task_hint'), run: (reason, cb) => updateTask.mutate({ code: p.task_code, is_active: p.is_active === false, reason }, cb) })} />
                <GateColumn gates={myGates} milestone={cur?.code ?? ''} sel={sel} nm={nm} can={can} canAdd={!!nextMs} onSelect={(c) => { setSel({ kind: 'gate', code: c }); setStep(2); }} onAdd={() => open({ k: 'gate-add' }, replace)}
                  onEdit={(g) => open({ k: 'gate-edit', g }, gateLight)} onRemove={(g) => open({ k: 'remove', what: 'gate', code: g.code }, removeItem)}
                  onToggle={(g) => askReason({ title: `${g.is_active === false ? t('wfe.activate') : t('wfe.deactivate')}: ${g.code}`, hint: t('wfe.toggle_gate_hint'),
                    run: (reason, cb) => replace.mutate({ ...structureOf({ gates: gates.map((x) => ({ code: x.code, is_active: x.code === g.code ? x.is_active === false : x.is_active !== false })) }), reason }, cb) })} />
              </div>
            </div>
            <div className={`${step === 2 ? '' : 'hidden'} md:col-span-3 md:block rounded border border-line p-3`}>
              <DetailPanel sel={sel} placements={placements} milestones={milestones} gates={gates} nm={nm} can={can} sla={sla}
                onPreds={(p) => open({ k: 'preds', p }, setPreds)} onGate={(g) => open({ k: 'gate-edit', g }, gateLight)} onMove={toStage}
                onParallel={(p, o) => askReason({ title: t('wfe.parallel_title', { code: p.task_code, other: o.task_code }), hint: t('wfe.parallel_hint'), run: (reason, cb) => setPreds.mutate({ code: p.task_code, predecessors: o.predecessors ?? [], reason }, cb) })}
                onClosing={(p, on) => askReason({ title: t(on ? 'wfe.closing_on' : 'wfe.closing_off', { code: p.task_code }), hint: t('wfe.closing_hint'), run: (reason, cb) => setClosing.mutate({ code: p.task_code, closing: on, reason }, cb) })}
                onCounts={(p, on) => askReason({ title: `${t('wfe.counts')}: ${p.task_code}`, hint: t('wfe.counts_hint'), run: (reason, cb) => updateTask.mutate({ code: p.task_code, counts_toward_milestone: on, reason }, cb) })} />
            </div>
          </div>
        </Board>
      )}

      {ask && <ReasonDialog title={ask.title} hint={ask.hint} onClose={() => setAsk(null)} onSubmit={submitAsk} busy={askBusy} error={askErr} />}
      {dlg?.k === 'ms-add' && <MilestoneDialog onClose={() => setDlg(null)} busy={replace.isPending} error={replace.isError ? err(replace.error) : null}
        onSubmit={(f, reason) => { const list = milestones.map((m) => ({ code: m.code, is_active: m.is_active !== false })); const at = milestones.findIndex((m) => m.code === cur?.code) + 1;
          list.splice(at, 0, { code: f.code, name_en: f.name_en, name_ar: f.name_ar || null, is_active: true } as (typeof list)[number]);
          replace.mutate({ ...structureOf({ milestones: list }), reason }, done(t('wfe.saved'))); }} />}
      {dlg?.k === 'ms-rename' && <MilestoneDialog initial={dlg.m} onClose={() => setDlg(null)} busy={msLight.isPending} error={msLight.isError ? err(msLight.error) : null}
        onSubmit={(f, reason) => msLight.mutate({ code: dlg.m.code, name_en: f.name_en, name_ar: f.name_ar, reason }, done(t('wfe.saved')))} />}
      {dlg?.k === 'gate-add' && cur && nextMs && <GateDialog from={cur.code} to={nextMs.code} all={placements} milestones={milestones} onClose={() => setDlg(null)} busy={replace.isPending} error={replace.isError ? err(replace.error) : null}
        onSubmit={(f, reason) => replace.mutate({ ...structureOf({ gates: [...gates.map((g) => ({ code: g.code, is_active: g.is_active !== false })), { code: f.code, name_en: f.name_en, name_ar: f.name_ar || null, from_milestone: cur.code, to_milestone: nextMs.code, is_active: true, conditions: f.conditions, ...(f.sla_min_wd !== undefined ? { sla_min_wd: f.sla_min_wd } : {}), ...(f.sla_max_wd !== undefined ? { sla_max_wd: f.sla_max_wd } : {}) }] }), reason }, done(t('wfe.saved')))} />}
      {dlg?.k === 'gate-edit' && <GateDialog initial={dlg.g} from={dlg.g.from_milestone} to={dlg.g.to_milestone} all={placements} milestones={milestones} onClose={() => setDlg(null)} busy={gateLight.isPending} error={gateLight.isError ? err(gateLight.error) : null}
        onSubmit={(f, reason) => gateLight.mutate({ code: dlg.g.code, name_en: f.name_en, name_ar: f.name_ar, ...(f.sla_min_wd !== undefined ? { sla_min_wd: f.sla_min_wd } : {}), ...(f.sla_max_wd !== undefined ? { sla_max_wd: f.sla_max_wd } : {}), conditions: f.conditions, reason }, done(t('wfe.saved')))} />}
      {dlg?.k === 'insert' && cur && <InsertDialog version={v.version} stage={cur.code} all={placements} published={v.status === 'published'} preset={{ after: dlg.after, preds: dlg.after ? [dlg.after] : [], succs: dlg.next ? [dlg.next] : [] }} onClose={() => setDlg(null)} busy={insertTask.isPending} error={insertTask.isError ? err(insertTask.error) : null}
        onSubmit={(f, reason) => insertTask.mutate({ stage_code: cur.code, code: f.code, name_en: f.name_en, name_ar: f.name_ar || null, counts_toward_milestone: f.counts, after_task_code: f.after || null, predecessors: f.preds, successors: f.succs, remove_direct_links: f.remove, add_to_open_sites: f.openSites, reason, ...(f.master ? { confirm_master_impact: f.master } : {}) }, done(t('wfe.saved')))} />}
      {dlg?.k === 'rename' && <TaskDialog title={t('wfe.rename')} initial={dlg.p} onClose={() => setDlg(null)} busy={updateTask.isPending} error={updateTask.isError ? err(updateTask.error) : null}
        onSubmit={(f, reason) => updateTask.mutate({ code: dlg.p.task_code, name_en: f.name_en, name_ar: f.name_ar || null, counts_toward_milestone: f.counts, reason }, done(t('wfe.saved')))} />}
      {dlg?.k === 'dup' && <DuplicateDialog source={dlg.p} onClose={() => setDlg(null)} busy={createTask.isPending} error={createTask.isError ? err(createTask.error) : null}
        onSubmit={(f, reason) => createTask.mutate({ stage_code: dlg.p.stage_code, code: f.code, name_en: f.name_en, name_ar: f.name_ar || null, counts_toward_milestone: dlg.p.counts_toward_milestone, after_task_code: dlg.p.task_code, predecessors: dlg.p.predecessors ?? [], reason }, done(t('wfe.saved')))} />}
      {dlg?.k === 'preds' && <PredecessorDialog task={dlg.p} all={placements} onClose={() => setDlg(null)} busy={setPreds.isPending} error={setPreds.isError ? err(setPreds.error) : null}
        onSubmit={(list, reason) => setPreds.mutate({ code: dlg.p.task_code, predecessors: list, reason }, done(t('wfe.saved')))} />}
      {dlg?.k === 'remove' && <FormDialog open onClose={() => setDlg(null)} testid="wfe-remove-dialog" title={t('wfe.remove_title', { kind: t(`wfe.kind_${dlg.what}`), code: dlg.code })} busy={removeItem.isPending} error={removeItem.isError ? err(removeItem.error) : null}
        onSubmit={(reason) => removeItem.mutate({ kind: dlg.what, code: dlg.code, reason }, { onSuccess: (r) => { toast(`${t(`wfe.removed_${r.outcome}`)} ${r.why.map((w) => t(`wfe.why_${w}`)).join(' ')}`); setDlg(null); } })}>
        <p className="text-sm text-mute">{t('wfe.remove_hint')}</p></FormDialog>}
      {dlg?.k === 'discard' && <FormDialog open onClose={() => setDlg(null)} testid="wfe-discard-dialog" title={t('wfe.discard_draft')} busy={discard.isPending} error={discard.isError ? err(discard.error) : null}
        onSubmit={(reason) => discard.mutate({ reason }, { onSuccess: () => { toast(t('wfe.discarded')); setDlg(null); onGone(); } })}><p className="text-sm text-mute">{t('wfe.discard_hint')}</p></FormDialog>}
      {dlg?.k === 'preview' && <PreviewDialog diff={diff} loading={isDraft && v.parent_version != null && !parent} problems={v.validation?.problems ?? []} warnings={v.validation?.warnings ?? []} cycle={cycle} canPublish={!!v.can_publish && !frozen && !!v.validation?.valid}
        onClose={() => setDlg(null)} onContinue={() => open({ k: 'publish' }, publish)} />}
      {dlg?.k === 'publish' && <PublishDialog version={v.version} phrase={phrase} onClose={() => setDlg(null)} busy={publish.isPending} error={publish.isError ? err(publish.error) : null}
        onSubmit={(confirm, reason, master) => publish.mutate({ reason, confirm_text: confirm, ...(master ? { confirm_master_impact: master } : {}) }, done(t('wfe.published')))} />}
      {dlg?.k === 'migrate' && <MigrationDialog version={v.version} versions={allVersions} phrase={phrase} onClose={() => setDlg(null)} />}
      {dlg?.k === 'sitelocks' && <SiteLocksShortcut onClose={() => setDlg(null)} />}
    </div>
  );
}
