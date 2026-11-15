import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePreviewInsert } from '@/api/workflowEditor';
import { FormDialog } from '@/components/FormDialog';
import type { M, P } from './model';

export function TaskDialog({ title, onClose, onSubmit, busy, error, initial, withCode, withActive, stages }: {
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
export function TaskPicker({ all, exclude, sel, onChange, prefix }: { all: P[]; exclude?: string; sel: string[]; onChange: (v: string[]) => void; prefix: string }) {
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
            <span className="mono">{p.task_code}</span> {p.name_en} <span className="mono text-mute">({p.stage_code})</span>
          </label></li>
        ))}
      </ul>
    </div>
  );
}

/** Insert a task among the existing tasks of a milestone: the preview of the affected chain is fetched while the choices change, nothing is written until the reason is saved. */
export function InsertDialog({ version, stage, all, published, preset, onClose, onSubmit, busy, error }: {
  version: number; stage: string; all: P[]; published: boolean; preset?: { after?: string; preds?: string[]; succs?: string[] }; onClose: () => void; busy: boolean; error: string | null;
  onSubmit: (f: { code: string; name_en: string; name_ar: string; counts: boolean; after: string; preds: string[]; succs: string[]; remove: boolean; openSites: boolean; master: string }, reason: string) => void;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [en, setEn] = useState('');
  const [ar, setAr] = useState('');
  const [counts, setCounts] = useState(true);
  const [after, setAfter] = useState(preset?.after ?? '');
  const [preds, setPreds] = useState<string[]>(preset?.preds ?? []);
  const [succs, setSuccs] = useState<string[]>(preset?.succs ?? []);
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

/** Publishing needs the typed confirmation `v<version>` (CLAUDE.md), a reason and the step-up the client opens on 401. During the parallel run the Master impact is typed too. */
export function PublishDialog({ version, phrase, onClose, onSubmit, busy, error }: { version: number; phrase: string | null; onClose: () => void; busy: boolean; error: string | null; onSubmit: (confirm: string, reason: string, master: string | null) => void }) {
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
