import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { useMigrateSites, usePreviewMigration, type SlaWeightItem, type WorkflowVersion } from '@/api/workflowEditor';
import { useSlaTasks } from '@/api/settings';
import { useToast } from '@/components/Toast';
import { findCycle } from '../wf/model';
import { Code, Flow, ltr, Name, useArrow } from '../wf/rtl';
import { useErr } from '../wf/useErr';
import { impactCounts, pendingChanges, type Change, type Struct } from './studioModel';
import { StudioCard } from './StudioForms';
import type { Ctx } from './studioCtx';

export type OpenSites = 'new_only' | 'migrate_all' | 'later';
const structOf = (v: WorkflowVersion | undefined): Struct | null => (v ? { milestones: v.milestones as Struct['milestones'], gates: v.gates as Struct['gates'], placements: v.placements as Struct['placements'] } : null);

export const Badge = ({ kind }: { kind: Change['kind'] }) => {
  const { t } = useTranslation();
  return <span className={`chip ${kind === 'structural' ? 'bg-waitBg text-waitInk' : 'bg-hover text-mute'}`} data-testid={`studio-badge-${kind}`}>{t(`studio.${kind}`)}</span>;
};

/** Review and publish: the changes (Light or Structural), the impact on open sites, the options, the reason, the typed confirmation `v<N>`. */
export function StudioReview({ c, parent, parentSw, draftSw, frozen, onBack, onPublished }: { c: Ctx; parent: WorkflowVersion | undefined; parentSw: SlaWeightItem[]; draftSw: SlaWeightItem[]; frozen: boolean; onBack: () => void; onPublished: () => void }) {
  const { t } = useTranslation();
  const err = useErr();
  const toast = useToast();
  const [opt, setOpt] = useState<OpenSites>('new_only');
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [master, setMaster] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const draftS = structOf(c.v)!;
  const parentS = structOf(parent);
  const changes = parentS ? pendingChanges(parentS, draftS, parentSw, draftSw) : [];
  const cycle = useMemo(() => findCycle(c.placements), [c.placements]);
  const preview = usePreviewMigration(c.v.version);
  const migrate = useMigrateSites(c.v.version);
  const { mutate } = preview;
  const parentNo = c.v.parent_version ?? undefined;
  useEffect(() => { mutate(parentNo ? { filter: { from_version: parentNo } } : { filter: {} }); }, [mutate, parentNo]);
  const pv = preview.data;
  const phrase = c.v.validation?.master_impact?.confirmation_phrase ?? null;
  const problems = c.v.validation?.problems ?? [], warnings = c.v.validation?.warnings ?? [];
  // 0.15.85: a warning only (never a block): tasks of this draft whose SLA is not decided yet.
  const slaTasks = useSlaTasks();
  const undecidedHere = (slaTasks.data?.items ?? []).filter((i) => i.in_draft && i.workflow_version === c.v.version && i.mode === 'undecided').map((i) => i.task_code);
  // D53: a warning only (never a block): an active milestone with tasks but no closing task is done only when all its tasks are.
  const noClosing = c.milestones.filter((m) => m.is_active !== false && c.placements.some((p) => p.stage_code === m.code && p.is_active !== false) && !c.placements.some((p) => p.stage_code === m.code && p.is_active !== false && p.is_milestone_task)).map((m) => m.code);
  const blocked = !c.v.can_publish || frozen || problems.length > 0 || !!cycle || c.v.validation?.valid === false;
  const ready = !blocked && reason.trim().length >= 3 && typed === `v${c.v.version}` && (!phrase || master === phrase) && !busy;
  const n = pv ? impactCounts(pv) : null;
  const arrow = useArrow();
  const refused = preview.error instanceof ApiError ? preview.error : null;

  const publish = () => {
    setError(null); setBusy(true);
    c.W.publish.mutate({ reason: reason.trim(), confirm_text: typed, ...(phrase ? { confirm_master_impact: master } : {}) }, {
      onError: (e) => { setError(err(e)); setBusy(false); },
      onSuccess: async () => {
        toast(t('wfe.published'));
        if (opt === 'migrate_all') {
          try {
            const sel = parentNo ? { filter: { from_version: parentNo } } : { filter: {} };
            const p = await preview.mutateAsync(sel);
            const r = await migrate.mutateAsync({ preview_hash: p.preview_hash, selection: sel, reason: reason.trim(), ...(phrase ? { confirm_master_impact: master } : {}) });
            toast(t('wfe.migrated', { count: r.sites_migrated }));
          } catch (e) { toast(`${t('studio.migrate_failed')} ${err(e)}`); }
        }
        setBusy(false);
        onPublished();
      },
    });
  };
  return (
    <div className="space-y-4" data-testid="studio-review">
      <header><h2 className="text-lg font-bold">{t('studio.review_title')}</h2><p className="text-sm text-mute">{t('studio.review_sub', { from: c.v.parent_version ?? '-', to: c.v.version })}</p></header>
      {blocked && <p role="alert" className="rounded-lg border border-line bg-lockBg p-3 text-sm text-lockInk" data-testid="studio-review-blocked">{frozen ? t('wfe.frozen_why', { date: '' }) : !c.v.can_publish ? t('wfe.readonly') : cycle ? t('wfe.cycle_found', { path: cycle.join(arrow) }) : problems.join('; ')}</p>}
      {undecidedHere.length > 0 && <p role="status" className="text-sm text-waitInk" data-testid="studio-review-sla-undecided">{t('studio.sla_undecided_warning', { codes: undecidedHere.join(', ') })}</p>}
      {noClosing.length > 0 && <p role="status" className="text-sm text-waitInk" data-testid="studio-review-no-closing">{t('studio.no_closing_warning', { codes: noClosing.join(', ') })}</p>}
      {warnings.length > 0 && <ul className="list-disc ps-5 text-sm text-waitInk" data-testid="studio-review-warnings">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>}

      <StudioCard title={t('studio.changes_title', { count: changes.length })} testid="studio-review-changes">
        {!parentS && <p className="text-sm text-mute">{t('wfe.loading')}</p>}
        {parentS && changes.length === 0 && <p className="text-sm text-mute" data-testid="studio-review-none">{t('wfe.prev.none')}</p>}
        <ul className="divide-y divide-line">
          {changes.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-2 py-2 text-sm" data-testid={`studio-change-${x.id}`}>
              <Badge kind={x.kind} /><span>{t(`studio.change_${x.key}`)}</span>{x.code !== '*' && <Code>{x.code}</Code>}
              {x.from !== undefined && x.to !== undefined ? <span className="text-mute"><Flow from={x.from} to={x.to} ltr={!!x.ltr} /></span> : x.detail && <span className="text-mute"><Name>{x.detail}</Name></span>}
            </li>))}
        </ul>
      </StudioCard>

      <StudioCard title={t('studio.impact_title')} testid="studio-review-impact">
        {preview.isPending && <p className="text-sm text-mute" data-testid="studio-impact-loading">{t('wfe.loading')}</p>}
        {preview.isError && (
          <div className="space-y-2" data-testid="studio-impact-refused" data-status={refused?.status ?? ''}>
            <p className="text-sm text-waitInk" role="status">{refused?.status === 403 ? t('studioPanel.impact_forbidden') : t('studioPanel.impact_refused', { status: refused?.status ?? '-' })}</p>
            <button type="button" className="btn min-h-11" data-testid="studio-impact-retry" onClick={() => mutate(parentNo ? { filter: { from_version: parentNo } } : { filter: {} })}>{t('studioPanel.impact_retry')}</button>
          </div>
        )}
        {n && (
          <>
            <p className="text-sm" data-testid="studio-impact">{t('studio.impact_sites', { count: n.sites, ok: n.movable })}</p>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="studio-impact-counts">
              {([['sites', n.sites], ['added', n.added], ['moved', n.moved], ['dates', n.dates]] as const).map(([k, v]) => (
                <div key={k} className="rounded-lg border border-line p-3"><dt className="text-xs text-mute">{t(`studioPanel.impact_${k}`)}</dt><dd className="text-xl font-bold" data-testid={`studio-impact-${k}`}><Code className="">{v}</Code></dd></div>))}
            </dl>
            {n.blocked > 0 && <p className="text-sm text-waitInk" data-testid="studio-impact-blocked">{t('studio.impact_blocked', { count: n.blocked })}</p>}
          </>
        )}
      </StudioCard>

      <StudioCard title={t('studio.options_title')} testid="studio-review-options">
        <label className="flex min-h-11 items-start gap-2 text-sm opacity-60"><input type="checkbox" className="mt-1 h-5 w-5" disabled data-testid="studio-opt-sla" /><span>{t('studio.opt_sla')}<span className="block text-xs text-mute">{t('studio.opt_sla_note')}</span></span></label>
        <fieldset className="space-y-1"><legend className="text-sm font-semibold">{t('studio.open_sites')}</legend>
          {(['new_only', 'migrate_all', 'later'] as const).map((k) => (
            <label key={k} className="flex min-h-11 items-center gap-2 text-sm"><input type="radio" name="studio-open-sites" className="h-5 w-5" data-testid={`studio-opt-${k}`} checked={opt === k} onChange={() => setOpt(k)} />{t(`studio.open_${k}`)}</label>))}
        </fieldset>
      </StudioCard>

      <StudioCard title={t('studio.confirm_title')} testid="studio-review-confirm">
        <label className="block text-sm font-semibold">{t('common.reason')}<textarea className="input mt-1 min-h-16 font-normal" data-testid="studio-publish-reason" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <label className="block text-sm font-semibold">{t('wfe.type_to_confirm', { text: ltr(`v${c.v.version}`) })}<input className="input mt-1 min-h-11 font-normal" dir="ltr" data-testid="studio-publish-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
        {phrase && <label className="block text-sm font-semibold">{t('wfe.type_to_confirm', { text: ltr(phrase) })}<input className="input mt-1 min-h-11 font-normal" dir="ltr" data-testid="studio-publish-master" value={master} onChange={(e) => setMaster(e.target.value)} /></label>}
        <p className="text-xs text-mute" data-testid="studio-stepup-note">{t('studio.stepup_note')}</p>
        {error && <p role="alert" className="text-sm text-lateInk" data-testid="studio-publish-error">{error}</p>}
      </StudioCard>

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="btn min-h-11" data-testid="studio-review-back" onClick={onBack}>{t('wfe.back')}</button>
        <button type="button" className="btn btn-accent min-h-11" data-testid="studio-publish" disabled={!ready} onClick={publish}>{t('wfe.publish')}</button>
      </div>
    </div>
  );
}
