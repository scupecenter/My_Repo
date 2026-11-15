import { GitBranch } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCreateDraft, useWorkflowVersions } from '@/api/workflowEditor';
import { FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { MigrationLog } from './WorkflowStructure';
import { VersionLoader } from './wf/Editor';
import { useErr } from './wf/useErr';

/** Settings, Workflow (decision 4 of 2026-11-12, migration 0090): versions, the three-column editor of a draft (milestones, tasks, gate, detail), light edits of milestones and gates, publishing. */
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
      {open !== null && <VersionLoader version={open} onGone={() => setOpen(null)} />}
      <MigrationLog />
    </section>
  );
}
