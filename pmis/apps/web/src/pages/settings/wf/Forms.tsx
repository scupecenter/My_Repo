import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRegions, useSites, useStreams } from '@/api/sites';
import { LocksDialog } from '@/components/WorkflowLocks';
import { FormDialog } from '@/components/FormDialog';
import { TaskPicker } from './Dialogs';
import { diffCount, findCycle, type Diff, type P } from './model';
import { Code, useArrow } from './rtl';

/** A question with a reason and nothing else (deactivate, closing task, move across milestones, parallel run...). */
export function ReasonDialog({ title, hint, onClose, onSubmit, busy, error, testid = 'wfe-reason-dialog', children }: { title: string; hint?: string; onClose: () => void; onSubmit: (reason: string) => void; busy: boolean; error: string | null; testid?: string; children?: React.ReactNode }) {
  return (
    <FormDialog open onClose={onClose} testid={testid} title={title} busy={busy} error={error} onSubmit={onSubmit}>
      {hint && <p className="text-sm text-mute">{hint}</p>}
      {children}
    </FormDialog>
  );
}

/** The predecessors of one task, taken from every milestone. A loop is found before anything is sent; the server refuses it too. */
export function PredecessorDialog({ task, all, onClose, onSubmit, busy, error }: { task: P; all: P[]; onClose: () => void; busy: boolean; error: string | null; onSubmit: (list: string[], reason: string) => void }) {
  const { t } = useTranslation();
  const arrow = useArrow();
  const [sel, setSel] = useState<string[]>(task.predecessors ?? []);
  const loop = useMemo(() => findCycle(all.map((p) => (p.task_code === task.task_code ? { ...p, predecessors: sel } : p))), [all, task.task_code, sel]);
  return (
    <FormDialog open wide onClose={onClose} testid="wfe-pred-dialog" title={`${t('wfe.predecessors')}: ${task.task_code}`} busy={busy} error={error} disabled={!!loop} onSubmit={(r) => onSubmit(sel, r)}>
      <p className="text-sm text-mute">{t('wfe.pred_hint')}</p>
      <TaskPicker all={all} exclude={task.task_code} sel={sel} onChange={setSel} prefix="wfe-pred" />
      {loop && <p role="alert" className="text-sm text-lateInk" data-testid="wfe-pred-cycle">{t('wfe.cycle_found', { path: loop.join(arrow) })}</p>}
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
  const arrow = useArrow();
  const line = (label: string, items: string[]) => items.length > 0 && <li key={label} data-testid={`wfe-prev-${label}`}>{t(`wfe.prev.${label}`)}: <Code>{items.join(', ')}</Code></li>;
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
      <p className={`text-sm ${cycle ? 'text-lateInk' : 'text-doneInk'}`} role={cycle ? 'alert' : undefined} data-testid="wfe-prev-cycle">{cycle ? t('wfe.cycle_found', { path: cycle.join(arrow) }) : t('wfe.no_cycle')}</p>
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
