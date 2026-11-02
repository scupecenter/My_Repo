import { useTranslation } from 'react-i18next';
import { useDeployments, useJobRuns } from '@/api/logs';
import { stamp } from '@/components/logs/bits';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/States';

const TONE = { ok: 'bg-doneBg text-doneInk', failed: 'bg-lateBg text-lateInk', running: 'bg-openBg text-openInk' } as const;
const secs = (a: string, b: string | null) => (b ? `${Math.round((Date.parse(b) - Date.parse(a)) / 1000)} s` : '—');

export function JobRuns() {
  const { t } = useTranslation();
  const q = useJobRuns();
  if (q.isError) return <ErrorState onRetry={() => void q.refetch()} />;
  return (
    <div data-testid="page-job-runs" className="space-y-3">
      <PageHeader title={t('nav.logs.job_runs')} subtitle={t('logs.jobs_subtitle')} />
      {q.isLoading ? <LoadingSkeleton /> : (
        <div className="card overflow-x-auto"><table className="w-full text-sm">
          <thead className="border-b border-line bg-card2 text-mute"><tr>{['name', 'started', 'duration', 'outcome', 'rows', 'error'].map((k) => <th key={k} className="p-2 text-start">{t(`logs.j_${k}`)}</th>)}</tr></thead>
          <tbody data-testid="jobs-list">
            {q.items.map((j) => (
              <tr key={j.id} className="border-b border-line" data-testid={`job-${j.id}`}>
                <td className="mono p-2 text-xs" dir="ltr">{j.name}</td><td className="mono p-2 text-xs" dir="ltr">{stamp(j.started_at)}</td><td className="mono p-2 text-xs">{secs(j.started_at, j.finished_at)}</td>
                <td className="p-2"><span className={`chip ${TONE[j.outcome]}`} data-testid={`job-outcome-${j.id}`}>{t(`logs.j_${j.outcome}`)}</span></td>
                <td className="mono p-2 text-xs">{j.rows ?? '—'}</td><td className="p-2 text-lateInk" dir="auto">{j.error ?? ''}</td>
              </tr>))}
          </tbody>
        </table>{!q.items.length && <EmptyState title={t('logs.empty')} testid="jobs-empty" />}</div>
      )}
      {q.hasNextPage && <div className="text-center"><button className="btn" data-testid="jobs-more" onClick={() => void q.fetchNextPage()}>{t('logs.load_more')}</button></div>}
    </div>
  );
}

export function Deployments() {
  const { t } = useTranslation();
  const q = useDeployments();
  if (q.isError) return <ErrorState onRetry={() => void q.refetch()} />;
  return (
    <div data-testid="page-deployments" className="space-y-3">
      <PageHeader title={t('nav.logs.deployments')} subtitle={t('logs.deps_subtitle')} />
      {q.isLoading ? <LoadingSkeleton /> : (
        <div className="card overflow-x-auto"><table className="w-full text-sm">
          <thead className="border-b border-line bg-card2 text-mute"><tr>{['at', 'version', 'sha', 'migrations', 'by'].map((k) => <th key={k} className="p-2 text-start">{t(`logs.dp_${k}`)}</th>)}</tr></thead>
          <tbody data-testid="deployments-list">
            {q.items.map((d) => (
              <tr key={d.id} className="border-b border-line align-top" data-testid={`deployment-${d.id}`}>
                <td className="mono p-2 text-xs" dir="ltr">{stamp(d.at)}</td><td className="mono p-2">{d.version}</td><td className="mono p-2 text-xs" dir="ltr">{d.git_sha.slice(0, 10)}</td>
                <td className="mono p-2 text-xs" dir="ltr">{d.migrations.length ? d.migrations.map((m) => <div key={m}>{m}</div>) : '—'}</td><td className="p-2">{d.by}</td>
              </tr>))}
          </tbody>
        </table>{!q.items.length && <EmptyState title={t('logs.empty')} testid="deployments-empty" />}</div>
      )}
      {q.hasNextPage && <div className="text-center"><button className="btn" data-testid="deployments-more" onClick={() => void q.fetchNextPage()}>{t('logs.load_more')}</button></div>}
    </div>
  );
}
