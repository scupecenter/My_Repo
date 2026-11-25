import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { useMigrateSites, usePreviewMigration, useRevertMigration, useSiteMigrations, type WorkflowVersionSummary } from '@/api/workflowEditor';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';

/** Decisions 2026-11-13 (maximum flexibility): the structure of a draft (milestones, gates, their conditions), the migration of open sites and its revert. */

export function useStructureErr() {
  const { t } = useTranslation();
  return (e: unknown) => {
    if (e instanceof ApiError) {
      if (e.code === 'stale_preview') return t('wfe.err.stale_preview');
      const first = Object.values(fieldErrors(e))[0];
      if (first && t(`wfe.err.${first}`) !== `wfe.err.${first}`) return t(`wfe.err.${first}`);
    }
    return errText(e, t);
  };
}

/** Migrate the open sites that are on another version to this published one: preview first (what stays, moves, is added or retired), then confirm. */
export function MigrationDialog({ version, versions, phrase, onClose }: { version: number; versions: WorkflowVersionSummary[]; phrase: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const err = useStructureErr();
  const [from, setFrom] = useState('');
  const [typed, setTyped] = useState('');
  const [master, setMaster] = useState('');
  const preview = usePreviewMigration(version);
  const migrate = useMigrateSites(version);
  const selection = from ? { filter: { from_version: Number(from) } } : { filter: {} };
  const pv = preview.data;
  const n = pv?.sites.length ?? 0;
  return (
    <FormDialog inline open wide onClose={onClose} testid="wfe-migrate-dialog" title={t('wfe.migrate_title', { version })} busy={migrate.isPending} error={migrate.isError ? err(migrate.error) : preview.isError ? err(preview.error) : null}
      disabled={!pv || n === 0 || typed !== `v${version}` || (!!phrase && master !== phrase)} submitLabel={t('wfe.migrate')}
      onSubmit={(reason) => migrate.mutate({ preview_hash: pv!.preview_hash, selection, reason, ...(phrase ? { confirm_master_impact: master } : {}) }, { onSuccess: (r) => { toast(t('wfe.migrated', { count: r.sites_migrated })); onClose(); } })}>
      <p className="text-sm text-mute">{t('wfe.migrate_hint')}</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm font-semibold">{t('wfe.from_version')}
          <select className="input mt-1 font-normal" data-testid="wfe-mig-from" value={from} onChange={(e) => { setFrom(e.target.value); preview.reset(); }}>
            <option value="">{t('wfe.any_version')}</option>
            {versions.filter((x) => x.version !== version && x.status === 'published').map((x) => <option key={x.version} value={x.version}>v{x.version}</option>)}
          </select></label>
        <button type="button" className="btn" data-testid="wfe-mig-preview" disabled={preview.isPending} onClick={() => preview.mutate(selection)}>{t('wfe.preview')}</button>
      </div>
      {pv && (n === 0 ? <p data-testid="wfe-mig-empty" className="text-sm text-mute">{t('wfe.migrate_none')}</p> : (
        <table className="w-full text-sm" data-testid="wfe-mig-table">
          <thead><tr className="text-mute"><th className="text-start">{t('wfe.site')}</th><th className="text-start">v</th><th className="text-start">{t('wfe.kept')}</th><th className="text-start">{t('wfe.moved')}</th><th className="text-start">{t('wfe.added')}</th><th className="text-start">{t('wfe.retired')}</th></tr></thead>
          <tbody>{pv.sites.map((s) => (
            <tr key={s.site_id} data-testid={`wfe-mig-site-${s.site_code}`}>
              <td className="mono">{s.site_code}</td><td>{s.from_version}</td><td>{s.tasks_kept?.length ?? 0}</td><td>{s.tasks_moved?.length ?? 0}</td><td>{s.tasks_added?.length ?? 0}</td><td>{s.tasks_retired?.length ?? 0}</td>
            </tr>))}</tbody>
        </table>
      ))}
      <label className="block text-sm font-semibold">{t('wfe.type_to_confirm', { text: `v${version}` })}<input className="input mt-1 font-normal" dir="ltr" data-testid="wfe-mig-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
      {phrase && <label className="block text-sm font-semibold">{t('wfe.type_to_confirm', { text: phrase })}<input className="input mt-1 font-normal" dir="ltr" value={master} onChange={(e) => setMaster(e.target.value)} /></label>}
    </FormDialog>
  );
}

/** The log of site migrations with the revert of each one that still can be reverted. */
export function MigrationLog() {
  const { t } = useTranslation();
  const toast = useToast();
  const err = useStructureErr();
  const q = useSiteMigrations(true);
  const revert = useRevertMigration();
  const [target, setTarget] = useState<string | null>(null);
  const items = q.data?.items ?? [];
  if (q.isError || items.length === 0) return null;
  return (
    <section className="space-y-2 border-t border-line pt-3" data-testid="wfe-migrations">
      <h3 className="font-bold">{t('wfe.migration_log')}</h3>
      <table className="w-full text-sm">
        <thead><tr className="text-mute"><th className="text-start">{t('wfe.site')}</th><th className="text-start">{t('wfe.from_version')}</th><th className="text-start">{t('wfe.to_version')}</th><th className="text-start">{t('common.reason')}</th><th /></tr></thead>
        <tbody>{items.map((m) => (
          <tr key={m.id} data-testid={`wfe-migration-${m.id}`}>
            <td className="mono">{m.site_code}</td><td>v{m.from_version}</td><td>v{m.to_version}</td><td>{m.reason}</td>
            <td>{m.reverted_at ? t('wfe.reverted') : m.revertible && <button className="btn" data-testid={`wfe-revert-${m.id}`} onClick={() => { revert.reset(); setTarget(m.id); }}>{t('wfe.revert')}</button>}</td>
          </tr>))}</tbody>
      </table>
      {target && <FormDialog inline open onClose={() => setTarget(null)} testid="wfe-revert-dialog" title={t('wfe.revert')} busy={revert.isPending} error={revert.isError ? err(revert.error) : null}
        onSubmit={(reason) => revert.mutate({ id: target, reason }, { onSuccess: () => { toast(t('wfe.reverted')); setTarget(null); } })}>
        <p className="text-sm text-mute">{t('wfe.revert_hint')}</p>
      </FormDialog>}
    </section>
  );
}
