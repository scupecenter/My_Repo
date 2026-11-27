import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useSiteMasterRows, useSiteMasterSections } from '@/api/siteMaster';
import { CalendarGrid } from './CalendarGrid';
import { ErrorState, LoadingSkeleton } from './States';

/**
 * Decision V2: the Site list on a month calendar, read only. One item per site on the chosen Master date column (the same rows, filters and visibility as the
 * grid; a date changes only through its task). The field is chosen in the Layout panel (`calf` in the URL, kept with the saved views); the first date column is the default.
 */
export function SitesCalendar({ query }: { query: Record<string, string | undefined> }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [sp] = useSearchParams();
  const sections = useSiteMasterSections();
  const master = sections.data?.items.find((m) => m.key === 'master');
  const dateCols = useMemo(() => (master?.columns ?? []).filter((c) => c.value_type === 'date'), [master]);
  const field = useMemo(() => {
    const want = Number(sp.get('calf') ?? '');
    return dateCols.some((c) => c.ord === want) ? want : (dateCols[0]?.ord ?? null);
  }, [sp, dateCols]);
  const q = useSiteMasterRows(master ? 'master' : undefined, { ...Object.fromEntries(Object.entries(query).filter(([, v]) => v)), limit: 100 });
  const items = useMemo(() => (q.data?.rows ?? []).map((r) => {
    const v = field === null ? null : r.values[String(field)];
    return { id: r.site_id, label: r.site_code, date: (v ?? '').slice(0, 10), late: false };
  }), [q.data, field]);

  if (sections.isError || q.isError) return <ErrorState onRetry={() => { void sections.refetch(); void q.refetch(); }} testid="calendar-error" />;
  if (sections.isLoading || q.isLoading) return <LoadingSkeleton testid="calendar-loading" />;
  if (!dateCols.length) return <div className="card p-3 text-sm text-mute" data-testid="sites-calendar-empty">{t('calview.no_columns')}</div>;
  return (
    <div className="card p-3">
      <CalendarGrid testid="sites-calendar" items={items} onOpen={(id) => navigate(`/sites/${id}`)} />
    </div>
  );
}
