import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMigrateSites, usePreviewMigration, type SlaWeightItem, type WorkflowVersion } from '@/api/workflowEditor';
import { useToast } from '@/components/Toast';
import { findCycle } from '../wf/model';
import { useErr } from '../wf/useErr';
import { pendingChanges, type Change, type Struct } from './studioModel';
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
  const blocked = !c.v.can_publish || frozen || problems.length > 0 || !!cycle || c.v.validation?.valid === false;
  const ready = !blocked && reason.trim().length >= 3 && typed === `v${c.v.version}` && (!phrase || master === phrase) && !busy;
  const migratable = pv?.sites.filter((s) => s.migratable).length ?? 0;

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
      {blocked && <p role="alert" className="rounded-lg border border-line bg-lockBg p-3 text-sm text-lockInk" data-testid="studio-review-blocked">{frozen ? t('wfe.frozen_why', { date: '' }) : !c.v.can_publish ? t('wfe.readonly') : cycle ? t('wfe.cycle_found', { path: cycle.join(' → ') }) : problems.join('; ')}</p>}
      {warnings.length > 0 && <ul className="list-disc ps-5 text-sm text-waitInk" data-testid="studio-review-warnings">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>}

      <StudioCard title={t('studio.changes_title', { count: changes.length })} testid="studio-review-changes">
        {!parentS && <p className="text-sm text-mute">{t('wfe.loading')}</p>}
        {parentS && changes.length === 0 && <p className="text-sm text-mute" data-testid="studio-review-none">{t('wfe.prev.none')}</p>}
        <ul className="divide-y divide-line">
          {changes.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-2 py-2 text-sm" data-testid={`studio-change-${x.id}`}>
              <Badge kind={x.kind} /><span>{t(`studio.change_${x.key}`)}</span>{x.code !== '*' && <span className="mono" dir="ltr">{x.code}</span>}{x.detail && <span className="text-mute">{x.detail}</span>}
            </li>))}
        </ul>
      </StudioCard>

      <StudioCard title={t('studio.impact_title')} testid="studio-review-impact">
        {preview.isPending && <p className="text-sm text-mute">{t('wfe.loading')}</p>}
        {preview.isError && <p className="text-sm text-mute" data-testid="studio-impact-na">{t('studio.impact_na')}</p>}
        {pv && <p className="text-sm" data-testid="studio-impact">{t('studio.impact_sites', { count: pv.sites.length, ok: migratable })}</p>}
        {pv && pv.sites.some((s) => !s.migratable) && <p className="text-sm text-waitInk">{t('studio.impact_blocked', { count: pv.sites.length - migratable })}</p>}
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
        <label className="block text-sm font-semibold">{t('wfe.type_to_confirm', { text: `v${c.v.version}` })}<input className="input mt-1 min-h-11 font-normal" dir="ltr" data-testid="studio-publish-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
        {phrase && <label className="block text-sm font-semibold">{t('wfe.type_to_confirm', { text: phrase })}<input className="input mt-1 min-h-11 font-normal" dir="ltr" data-testid="studio-publish-master" value={master} onChange={(e) => setMaster(e.target.value)} /></label>}
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
