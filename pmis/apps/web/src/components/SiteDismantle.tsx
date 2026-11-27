import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useRegisterRecords } from '@/api/registers';
import { ApiError } from '@/api/client';

const NO_FILTER = { q: '', region_id: '', state: '', record_type: '' };
const str = (v: unknown): string => (v == null ? '' : String(v));

/**
 * The Dismantle tab of the Site page: the Dismantle register records of this site (the same list and the same rights as Registers > Dismantle, with the
 * `site_id` filter of GET /registers/dismantle/records). Each row opens the record in the register; nothing is edited here.
 */
export function SiteDismantle({ siteId }: { siteId: string }) {
  const { t } = useTranslation();
  const q = useRegisterRecords('dismantle', { ...NO_FILTER, site_id: siteId });
  const rows = (q.data?.pages ?? []).flatMap((p) => p.items);
  const denied = q.error instanceof ApiError && q.error.status === 403;
  return (
    <div className="space-y-3" data-testid="site-dismantle">
      <div className="flex items-center gap-2">
        <p className="me-auto text-sm text-mute" data-testid="site-dismantle-count">{t('site.dismantle_count', { count: rows.length })}</p>
        <Link className="btn" to="/registers/dismantle" data-testid="site-dismantle-open">{t('site.dismantle_open')}</Link>
      </div>
      {q.isLoading ? <p className="text-mute">{t('common.loading')}</p>
        : denied ? <p className="card p-6 text-mute" data-testid="site-dismantle-denied">{t('site.dismantle_denied')}</p>
        : q.isError ? <p role="alert" className="text-lateInk" data-testid="site-dismantle-error">{t('site.dismantle_failed')}</p>
        : rows.length === 0 ? <p className="card p-6 text-mute" data-testid="site-dismantle-empty">{t('site.dismantle_empty')}</p>
        : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-line bg-card2 text-mute">{['state', 'rfd', 'start', 'end', 'engineer'].map((c) => <th key={c} className="px-3 py-2 text-start font-semibold">{t(`site.dismantle_col_${c}`)}</th>)}</tr></thead>
              <tbody>{rows.map((r) => {
                const d = (r.data ?? {}) as Record<string, unknown>;
                return (
                  <tr key={r.id} className="border-b border-line last:border-0" data-testid="site-dismantle-row">
                    <td className="px-3 py-2"><Link className="text-accentText underline" to={`/registers/dismantle?record=${r.id}`}>{t(`regState.${r.state}`)}</Link></td>
                    <td className="px-3 py-2">{str(d.rfd_date)}</td>
                    <td className="px-3 py-2">{str(d.work_start_date)}</td>
                    <td className="px-3 py-2">{str(d.work_end_date)}</td>
                    <td className="px-3 py-2">{str(d.supervising_engineer)}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
    </div>
  );
}
