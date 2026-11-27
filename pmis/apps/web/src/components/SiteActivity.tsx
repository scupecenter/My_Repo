import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { EMPTY_FILTER, useAuditLog } from '@/api/logs';
import { StandardTable, type StdCol } from '@/components/StandardTable';
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
  type Row = (typeof q.items)[number];
  const cols: StdCol<Row>[] = [
    { id: 'at', label: t('siteActivity.c_at'), w: 190, pinned: true, text: (r) => new Date(r.at).toLocaleString(), cell: (r) => <span className="tnum" dir="ltr">{new Date(r.at).toLocaleString()}</span> },
    { id: 'actor', label: t('siteActivity.c_actor'), w: 200, text: (r) => r.actor?.display_name ?? t('siteActivity.system'), cell: (r) => <b>{r.actor?.display_name ?? t('siteActivity.system')}</b> },
    { id: 'action', label: t('siteActivity.c_action'), w: 240, text: (r) => r.action, cell: (r) => <span className="chip border border-line">{r.action}</span> },
    { id: 'entity', label: t('siteActivity.c_entity'), w: 180, text: (r) => r.entity_type, cell: (r) => <span className="text-mute">{r.entity_type}</span> },
  ];
  return (
    <section data-testid="site-activity">
      <StandardTable screen="site-activity" testid="site-activity-table" cols={cols} rows={q.items} rowId={(r) => String(r.id)} rowTestId={() => 'site-activity-item'} exportName="site-activity"
        hasMore={q.hasNextPage} onMore={() => void q.fetchNextPage()} loadingMore={q.isFetchingNextPage} noun="items" />
    </section>
  );
}
