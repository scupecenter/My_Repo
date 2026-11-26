import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { EMPTY_FILTER, useAuditLog } from '@/api/logs';
import { EmptyState, ErrorState, LoadingSkeleton, NoPermission } from '@/components/States';

/**
 * Site Master activity stream: the Audit Log rows of this one site, newest first. It reads the existing Audit Log endpoint, so the server's own
 * scope rules decide what the person sees (a person without Audit Log rights gets the no-permission notice). Nothing new is read or stored.
 */
export function SiteActivity({ siteId, siteCode }: { siteId: string; siteCode: string }) {
  const { t } = useTranslation();
  const q = useAuditLog({ ...EMPTY_FILTER, site: { id: siteId, code: siteCode } });
  if (q.isLoading) return <LoadingSkeleton testid="site-activity-loading" />;
  if (q.error instanceof ApiError && q.error.status === 403) return <NoPermission testid="site-activity-forbidden" />;
  if (q.isError) return <ErrorState onRetry={() => void q.refetch()} testid="site-activity-error" />;
  if (!q.items.length) return <EmptyState testid="site-activity-empty" title={t('siteActivity.empty')} />;
  return (
    <section data-testid="site-activity">
      <ul className="card divide-y divide-line text-sm">
        {q.items.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 p-2" data-testid="site-activity-item">
            <span className="tnum text-mute" dir="ltr">{new Date(r.at).toLocaleString()}</span>
            <b>{r.actor?.display_name ?? t('siteActivity.system')}</b>
            <span className="chip border border-line">{r.action}</span>
            <span className="text-mute">{r.entity_type}</span>
          </li>
        ))}
      </ul>
      {q.hasNextPage && <button className="btn mt-2" data-testid="site-activity-more" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{t('siteActivity.more')}</button>}
    </section>
  );
}
