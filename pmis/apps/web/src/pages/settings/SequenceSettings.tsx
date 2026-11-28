import { Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useWorkflowVersions } from '@/api/workflowEditor';
import { QueryFallback } from '@/components/States';

/**
 * Settings, Workflow, Sequence (D49, contract 0.15.321). The one place that explains and lists the sequence locks: the mode of every workflow version
 * (Strict by default, Open), where it is changed (the draft's Review and publish screen), and where the audited per-site switch and the historical load are.
 * Read only here: the mode is edited in the editor with its reason and step-up; the per-site switch stays the override.
 */
export function SequenceSettings() {
  const { t } = useTranslation();
  const q = useWorkflowVersions();
  const items = q.data?.items ?? [];
  if (!q.data) return <section className="card p-4" data-testid="page-sequence"><QueryFallback queries={[q]} testid="seq-loading" /></section>;
  const mode = (m: string | undefined) => (m === 'open' ? t('studio.lock_open') : t('studio.lock_strict'));
  return (
    <section className="card space-y-3 p-4" data-testid="page-sequence">
      <h2 className="flex items-center gap-2 font-bold"><Lock size={18} aria-hidden />{t('studio.seq_title')}</h2>
      <p className="text-sm text-mute">{t('studio.seq_note')}</p>
      <table className="w-full text-sm" data-testid="seq-versions">
        <thead><tr className="text-start text-mute"><th className="text-start">{t('studio.seq_version')}</th><th className="text-start">{t('studio.seq_status')}</th><th className="text-start">{t('studio.lock_mode')}</th></tr></thead>
        <tbody>
          {items.map((v) => (
            <tr key={v.version} data-testid={`seq-row-${v.version}`} className="border-t border-line">
              <td className="mono py-2" dir="ltr">v{v.version}{v.is_current ? ` · ${t('studio.seq_live')}` : ''}</td>
              <td>{v.status}</td>
              <td data-testid={`seq-mode-${v.version}`} data-mode={(v as { lock_mode?: string }).lock_mode ?? 'strict'}>{mode((v as { lock_mode?: string }).lock_mode)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="space-y-1 text-sm">
        <li><Link className="underline" to="/admin/settings/workflow/editor" data-testid="seq-link-editor">{t('studio.seq_edit')}</Link></li>
        <li><Link className="underline" to="/admin/settings/data/historical" data-testid="seq-link-historical">{t('studio.seq_historical')}</Link></li>
      </ul>
      <p className="text-sm text-mute">{t('studio.seq_site_note')}</p>
    </section>
  );
}
