import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useRegisterRecords } from '@/api/registers';
import { ApiError } from '@/api/client';
import { StandardTable, type StdCol } from './StandardTable';

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
  type Rec = (typeof rows)[number];
  const d = (r: Rec) => (r.data ?? {}) as Record<string, unknown>;
  const cols: StdCol<Rec>[] = [
    { id: 'state', label: t('site.dismantle_col_state'), w: 160, pinned: true, text: (r) => t(`regState.${r.state}`), cell: (r) => <Link className="text-accentText underline" to={`/registers/dismantle?record=${r.id}`}>{t(`regState.${r.state}`)}</Link> },
    { id: 'rfd', label: t('site.dismantle_col_rfd'), w: 140, text: (r) => str(d(r).rfd_date), cell: (r) => str(d(r).rfd_date) },
    { id: 'start', label: t('site.dismantle_col_start'), w: 140, text: (r) => str(d(r).work_start_date), cell: (r) => str(d(r).work_start_date) },
    { id: 'end', label: t('site.dismantle_col_end'), w: 140, text: (r) => str(d(r).work_end_date), cell: (r) => str(d(r).work_end_date) },
    { id: 'engineer', label: t('site.dismantle_col_engineer'), w: 200, text: (r) => str(d(r).supervising_engineer), cell: (r) => str(d(r).supervising_engineer) },
  ];
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
        : <StandardTable screen="site-dismantle" testid="site-dismantle-table" cols={cols} rows={rows} rowId={(r) => r.id} rowTestId={() => 'site-dismantle-row'} exportName="site-dismantle" noun="records" />}
    </div>
  );
}
