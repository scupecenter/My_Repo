import * as Popover from '@radix-ui/react-popover';
import { ArrowLeft, Eye, Plus, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useCreateDraft, useSlaWeight, useWeightTotals, useWorkflowVersion, useWorkflowVersions, type WorkflowVersion } from '@/api/workflowEditor';
import { FormDialog } from '@/components/FormDialog';
import { useFrozen } from '@/components/FreezePanel';
import { useToast } from '@/components/Toast';
import type { Can } from '../wf/Columns';
import { PreviewDialog } from '../wf/Forms';
import { diffVersions, findCycle, type G, type M, type P } from '../wf/model';
import { useErr } from '../wf/useErr';
import { StudioAdd, type AddTab } from './StudioAdd';
import { GateForm, MilestoneForm, TaskForm } from './StudioForms';
import { StudioReview } from './StudioReview';
import { StudioTree } from './StudioTree';
import { useAsk, useWrites, type Ctx } from './studioCtx';
import { editedCodes, pendingChanges, type StudioSel, type Struct } from './studioModel';

type View = 'form' | 'add' | 'review';

/** Settings, Workflow, "Workflow Studio" (S1): one tree, one form at a time, a reviewed publish. It reads and writes through the same API and rules as the classic editor. */
export function Studio() {
  const { t } = useTranslation();
  const q = useWorkflowVersions();
  const items = q.data?.items ?? [];
  const live = items.find((v) => v.is_current);
  const draft = items.find((v) => v.status === 'draft');
  const shown = draft?.version ?? live?.version ?? null;
  const one = useWorkflowVersion(shown);
  if (q.isError || one.isError) return <p role="alert" className="text-lateInk" data-testid="studio-error">{t('errors.generic')}</p>;
  if (!one.data) return <p data-testid="studio-loading">{'…'}</p>;
  return <StudioBody key={one.data.version} v={one.data} liveNo={live?.version ?? null} />;
}

function StudioBody({ v, liveNo }: { v: WorkflowVersion; liveNo: number | null }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const err = useErr();
  const { frozen, until } = useFrozen();
  const ar = i18n.language === 'ar';
  const etag = v.version_etag ?? 0;
  const isDraft = v.status === 'draft';
  const canEdit = v.can_edit === true;
  const edit = canEdit && isDraft;
  const struct = edit && !frozen;
  const why = !canEdit ? t('wfe.readonly') : !isDraft ? t('wfe.draft_only_why') : frozen ? t('wfe.frozen_why', { date: until ?? '' }) : null;
  const W = useWrites(v.version, etag);
  const { askReason, node } = useAsk();
  const parent = useWorkflowVersion(isDraft ? v.parent_version ?? null : null).data;
  const sw = useSlaWeight(v.version).data?.items ?? [];
  const baseSw = useSlaWeight(isDraft ? v.parent_version ?? null : null).data?.items;
  const totals = useWeightTotals(v.version).data?.items ?? [];
  const create = useCreateDraft();
  const busy = Object.values(W).some((m) => m.isPending);
  const can: Can = { edit, struct, why, busy };

  const [sel, setSel] = useState<StudioSel>(null);
  const [view, setView] = useState<View>('form');
  const [tab, setTab] = useState<AddTab>('task');
  const [addMs, setAddMs] = useState<string | undefined>();
  const [addTask, setAddTask] = useState<string | undefined>();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [step, setStep] = useState<'tree' | 'detail'>('tree');
  const [menu, setMenu] = useState(false);
  const [dlg, setDlg] = useState<null | 'draft' | 'preview'>(null);

  const placements = v.placements as P[], milestones = v.milestones as M[], gates = v.gates as G[];
  const struc: Struct = { milestones, gates, placements };
  const pStruct: Struct | null = parent ? { milestones: parent.milestones as M[], gates: parent.gates as G[], placements: parent.placements as P[] } : null;
  const changes = pStruct ? pendingChanges(pStruct, struc, baseSw ?? [], sw) : [];
  const edited = editedCodes(changes);
  const diff = pStruct ? diffVersions(pStruct, struc) : null;
  const cycle = useMemo(() => findCycle(placements), [placements]);
  const nm = (x: { name_en?: string; name_ar?: string | null }) => (ar && x.name_ar ? x.name_ar : x.name_en ?? '');
  const msOf = (s: NonNullable<StudioSel>) => (s.kind === 'task' ? placements.find((p) => p.task_code === s.code)?.stage_code : s.kind === 'gate' ? gates.find((g) => g.code === s.code)?.from_milestone : s.code);
  const select = (s: StudioSel) => { setSel(s); setView('form'); setStep('detail'); const m = s && msOf(s); if (m) setOpen((o) => new Set(o).add(m)); };
  const toggle = (code: string) => setOpen((o) => { const n = new Set(o); if (n.has(code)) n.delete(code); else n.add(code); return n; });
  const startAdd = (k: AddTab, ms?: string, taskCode?: string) => { setTab(k); setAddMs(ms ?? (sel ? msOf(sel) : undefined)); setAddTask(taskCode ?? (k === 'column' && sel?.kind === 'task' ? sel.code : undefined)); setView('add'); setStep('detail'); setMenu(false); };

  const c: Ctx = { v, etag, placements, milestones, gates, can, W, askReason, nm, sw: new Map(sw.map((x) => [x.task_code, x])), baseSw: baseSw ? new Map(baseSw.map((x) => [x.task_code, x])) : null, totals, edited, select, isDraft, canCols: canEdit, addColumn: (code) => startAdd('column', undefined, code) };
  const menuItem = 'flex min-h-11 w-full items-center rounded-md px-3 text-start text-sm hover:bg-hover disabled:opacity-50 disabled:pointer-events-none';

  return (
    <div className="space-y-3" data-testid="studio" data-status={v.status}>
      <header className="space-y-2">
        <nav aria-label={t('studio.breadcrumb')} className="text-xs text-mute" data-testid="studio-breadcrumb">{t('studio.crumb_settings')} {'>'} {t('settings.tab_workflow')}</nav>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="me-2 text-xl font-bold">{t('studio.title')}</h2>
          <span className="chip bg-accentSoft text-accentText" data-testid="studio-chip-live">{t('studio.live', { version: liveNo ?? v.version })}</span>
          {isDraft
            ? <span className="chip bg-waitBg text-waitInk" data-testid="studio-chip-draft">{t('studio.draft', { version: v.version })}</span>
            : <button type="button" className="btn btn-accent min-h-11" data-testid="studio-create-draft" disabled={!canEdit} title={!canEdit ? t('wfe.readonly') : undefined} onClick={() => { create.reset(); setDlg('draft'); }}>{t('studio.create_draft', { version: v.version + 1 })}</button>}
          <Link className="ms-auto inline-flex min-h-11 items-center text-sm text-link underline" to="/admin/settings/workflow/classic" data-testid="studio-classic-link">{t('studio.classic')}</Link>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="min-w-48 flex-1 sm:max-w-sm"><span className="sr-only">{t('studio.search')}</span>
            <input type="search" className="input min-h-11" placeholder={t('studio.search')} data-testid="studio-search" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
          <Popover.Root open={menu} onOpenChange={setMenu}>
            <Popover.Trigger asChild><button type="button" className="btn min-h-11" data-testid="studio-add-menu" aria-haspopup="menu" disabled={!isDraft && !canEdit}><Plus size={14} aria-hidden />{t('studio.add_new')}</button></Popover.Trigger>
            <Popover.Portal>
              <Popover.Content align="start" sideOffset={6} role="menu" aria-label={t('studio.add_new')} className="card z-[60] w-64 p-1 shadow-lg" data-testid="studio-add-menu-list">
                <button type="button" role="menuitem" className={menuItem} data-testid="studio-menu-task" disabled={!struct} title={!struct ? why ?? undefined : undefined} onClick={() => startAdd('task')}>{t('studio.menu_task')}</button>
                <button type="button" role="menuitem" className={menuItem} data-testid="studio-menu-milestone" disabled={!struct} title={!struct ? why ?? undefined : undefined} onClick={() => startAdd('milestone')}>{t('studio.new_milestone')}</button>
                <button type="button" role="menuitem" className={menuItem} data-testid="studio-menu-gate" disabled={!struct} title={!struct ? why ?? undefined : undefined} onClick={() => startAdd('gate')}>{t('studio.new_gate')}</button>
                <button type="button" role="menuitem" className={menuItem} data-testid="studio-menu-column" disabled={!canEdit} title={!canEdit ? t('studio.columns.readonly') : undefined} onClick={() => startAdd('column')}>{t('studio.menu_column')}</button>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          {isDraft && <>
            <span className="chip bg-hover text-ink" data-testid="studio-pending" aria-live="polite">{t('studio.pending', { count: changes.length })}</span>
            <button type="button" className="btn min-h-11" data-testid="studio-preview" onClick={() => setDlg('preview')}><Eye size={14} aria-hidden />{t('studio.preview_impact')}</button>
            <button type="button" className="btn btn-accent min-h-11" data-testid="studio-review-btn" disabled={!v.can_publish} title={!v.can_publish ? t('wfe.readonly') : undefined} onClick={() => { setView('review'); setStep('detail'); }}><Upload size={14} aria-hidden />{t('studio.review_publish')}</button>
          </>}
        </div>
      </header>
      {frozen && <p role="status" className="rounded-lg border border-line bg-lockBg p-3 text-sm text-lockInk" data-testid="studio-frozen-banner">{t('wfe.frozen_banner', { date: until ?? '' })}</p>}
      {!canEdit && <p className="text-sm text-mute" data-testid="studio-readonly">{t('wfe.readonly')}</p>}
      {!isDraft && canEdit && <p className="text-sm text-mute" data-testid="studio-live-note">{t('studio.live_note')}</p>}

      <div className="grid gap-4 md:grid-cols-[minmax(340px,380px)_minmax(0,1fr)]">
        <div className={`${step === 'tree' ? '' : 'hidden'} md:block`}>
          <StudioTree s={struc} version={v.version} isDraft={isDraft} query={query} expanded={open} onToggle={toggle} sel={sel} edited={edited} nm={nm} onSelect={select} onAddTask={(m) => startAdd('task', m)} canAdd={struct} why={why} />
        </div>
        <main className={`${step === 'detail' ? '' : 'hidden'} min-w-0 space-y-3 md:block`} aria-label={t('studio.title')} data-testid="studio-centre">
          <button type="button" className="btn min-h-11 md:hidden" data-testid="studio-back" onClick={() => setStep('tree')}><ArrowLeft size={14} aria-hidden className="rtl:rotate-180" />{t('wfe.back')}</button>
          {view === 'add' && <StudioAdd c={c} tab={tab} {...(addMs ? { milestone: addMs } : {})} {...(addTask ? { task: addTask } : {})} onTab={setTab} onClose={() => setView('form')} onAdded={(s) => { select(s); }} />}
          {view === 'review' && <StudioReview c={c} parent={parent} parentSw={baseSw ?? []} draftSw={sw} frozen={frozen} onBack={() => setView('form')} onPublished={() => { setView('form'); setSel(null); setStep('tree'); }} />}
          {view === 'form' && (!sel
            ? <div className="card rounded-xl p-6 text-center text-sm text-mute" data-testid="studio-empty">{t('studio.empty')}</div>
            : sel.kind === 'task' ? <TaskForm key={`${sel.code}-${v.version_etag}`} c={c} code={sel.code} />
              : sel.kind === 'gate' ? <GateForm key={`${sel.code}-${v.version_etag}`} c={c} code={sel.code} /> : <MilestoneForm key={`${sel.code}-${v.version_etag}`} c={c} code={sel.code} />)}
        </main>
      </div>

      {node}
      {dlg === 'draft' && (
        <FormDialog open onClose={() => setDlg(null)} testid="studio-draft-dialog" title={t('wfe.new_draft', { version: v.version })} busy={create.isPending} error={create.isError ? err(create.error) : null}
          onSubmit={(reason) => create.mutate({ parent_version: v.version, reason }, { onSuccess: () => { toast(t('wfe.draft_created')); setDlg(null); } })}>
          <p className="text-sm text-mute">{t('wfe.new_draft_hint')}</p>
        </FormDialog>
      )}
      {dlg === 'preview' && <PreviewDialog diff={diff} loading={!!v.parent_version && !parent} problems={v.validation?.problems ?? []} warnings={v.validation?.warnings ?? []} cycle={cycle} canPublish={!!v.can_publish && !frozen && !!v.validation?.valid}
        onClose={() => setDlg(null)} onContinue={() => { setDlg(null); setView('review'); setStep('detail'); }} />}
    </div>
  );
}
