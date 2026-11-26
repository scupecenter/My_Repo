import { useTranslation } from 'react-i18next';
import type { components } from '@/api/schema';
import { summarizePipeline } from '@/lib/siteSummary';

type SiteDetail = components['schemas']['SiteDetail'];

/** Site Master summary header: where the site stands at a glance. Reads only what the site endpoint already returned for this user. */
export function SiteSummaryStrip({ site }: { site: SiteDetail }) {
  const { t, i18n } = useTranslation();
  const sum = summarizePipeline(site.pipeline);
  if (!sum.total) return null;
  const nm = (n: { name_en: string; name_ar?: string | null }) => (i18n.language === 'ar' && n.name_ar) || n.name_en;
  const c = site.counts ?? {};
  return (
    <section className="my-3 flex flex-wrap gap-2 text-sm" data-testid="site-summary" aria-label={t('siteSummary.title')}>
      <span className="chip border border-line" data-testid="site-summary-progress">{t('siteSummary.progress', { done: sum.done, total: sum.total })}</span>
      {sum.current && <span className="chip border border-line" data-testid="site-summary-current">{t('siteSummary.current')}: {nm(sum.current)}</span>}
      {sum.late.length > 0 && <span className="chip bg-lateBg text-lateInk" data-testid="site-summary-late">{t('siteSummary.late', { n: sum.late.length })}</span>}
      {sum.nextPlanned && <span className="chip border border-line" data-testid="site-summary-next">{t('siteSummary.next')}: {nm(sum.nextPlanned.node)} · <span className="tnum" dir="ltr">{sum.nextPlanned.date}</span></span>}
      {(c.open_snags ?? 0) > 0 && <span className="chip bg-waitBg text-waitInk" data-testid="site-summary-snags">{t('siteSummary.snags', { n: c.open_snags })}</span>}
      {(c.open_issues ?? 0) > 0 && <span className="chip bg-waitBg text-waitInk" data-testid="site-summary-issues">{t('siteSummary.issues', { n: c.open_issues })}</span>}
      {(c.documents_missing ?? 0) > 0 && <span className="chip bg-waitBg text-waitInk" data-testid="site-summary-docs">{t('siteSummary.docs', { n: c.documents_missing })}</span>}
    </section>
  );
}
