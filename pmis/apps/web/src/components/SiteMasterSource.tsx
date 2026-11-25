import { ExternalLink, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { siteMasterSourceHref, useSiteMasterSiteSources, type SiteMasterCellSource } from '@/api/siteMaster';

/** Chips and details of one cell's source (contract 0.15.35): kind, origin, the record or task, the rule, and a link that opens the source. */
export function SiteMasterSourceDetails({ siteId, cell, testid = 'site-master-source' }: { siteId: string; cell: SiteMasterCellSource; testid?: string }) {
  const { t, i18n } = useTranslation();
  const href = siteMasterSourceHref(siteId, cell);
  const taskName = i18n.language === 'ar' && cell.task_name_ar ? cell.task_name_ar : cell.task_name_en ?? '';
  return (
    <div className="flex flex-col gap-1 text-xs" data-testid={`${testid}-details`} data-kind={cell.kind}>
      <div className="flex flex-wrap items-center gap-1">
        <span className="chip bg-sideOn text-accentText" data-testid={`${testid}-kind`}>{t(`siteMaster.src.kind.${cell.kind}`)}</span>
        {cell.origin && <span className="chip bg-hover text-mute" data-testid={`${testid}-origin`}>{t(`siteMaster.src.origin.${cell.origin}`)}</span>}
      </div>
      {cell.hidden ? (
        <p className="text-mute" data-testid={`${testid}-hidden`}>{t('siteMaster.src.hidden')}</p>
      ) : (
        <>
          {cell.kind !== 'not_tracked' && cell.value === null && <p className="text-mute">{t('siteMaster.src.no_value')}</p>}
          {cell.record_id && cell.register_key && <p>{t('siteMaster.src.record', { key: cell.register_key, version: cell.record_version ?? 1 })}</p>}
          {cell.task_code && <p>{t('siteMaster.src.task', { code: cell.task_code, name: taskName })}</p>}
          {cell.baseline_version !== undefined && <p>{t('siteMaster.src.baseline', { version: cell.baseline_version })}</p>}
          {cell.fed_by && <p>{t('siteMaster.src.fed_by', { key: cell.fed_by.register_key })}</p>}
          {cell.field && <p className="text-mute">{t('siteMaster.src.field')}: <span className="mono" dir="ltr">{cell.field}</span></p>}
        </>
      )}
      {cell.note && <p className="text-mute">{t('siteMaster.src.rule')}: <span dir="ltr">{cell.note}</span></p>}
      {href && (
        <Link to={href} className="inline-flex items-center gap-1 text-link underline" data-testid={`${testid}-open`}>
          <ExternalLink size={12} />{t('siteMaster.src.open')}
        </Link>
      )}
    </div>
  );
}

/** The source panel of the grid: the cell opened in the Site Master grid, read from the per-site sources (one request per site, cached). */
export function SiteMasterSourcePanel({ siteId, siteCode, ord, onClose }: { siteId: string; siteCode: string; ord: number; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useSiteMasterSiteSources(siteId);
  const cell = q.data?.cells.find((c) => c.ord === ord);
  return (
    <section className="card mt-2 p-3" aria-label={t('siteMaster.src.title')} data-testid="site-master-source-panel" data-ord={ord}>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="me-auto text-sm font-semibold">
          {t('siteMaster.src.title')}: <span className="mono">{siteCode}</span>{cell ? <> · <span className="mono">{cell.letter}</span> {cell.header}</> : null}
        </h3>
        <button type="button" className="text-mute hover:text-ink" aria-label={t('siteMaster.src.close')} onClick={onClose} data-testid="site-master-source-close"><X size={14} /></button>
      </div>
      {q.isLoading ? <p className="text-xs text-mute">{t('siteMaster.src.loading')}</p>
        : q.isError || !cell ? <p className="text-xs text-lateInk" role="alert">{t('siteMaster.src.error')}</p>
        : (
          <>
            {cell.value !== null && !cell.hidden && <p className="mb-1 text-sm font-semibold" data-testid="site-master-source-value">{cell.value}</p>}
            <SiteMasterSourceDetails siteId={siteId} cell={cell} />
          </>
        )}
    </section>
  );
}

/** The Master tab of the site page: every Master column of the site with its value and its source, and a link to the source record. */
export function SiteMasterSources({ siteId }: { siteId: string }) {
  const { t } = useTranslation();
  const q = useSiteMasterSiteSources(siteId);
  if (q.isLoading) return <p className="text-mute">{t('siteMaster.src.loading')}</p>;
  if (q.isError || !q.data) return <p className="text-lateInk" role="alert">{t('siteMaster.src.error')}</p>;
  return (
    <div className="card overflow-auto" data-testid="site-master-sources">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-line text-start">
            <th className="px-2 py-1 text-start">{t('siteMaster.src.column')}</th>
            <th className="px-2 py-1 text-start">{t('siteMaster.src.value')}</th>
            <th className="px-2 py-1 text-start">{t('siteMaster.src.source')}</th>
          </tr>
        </thead>
        <tbody>
          {q.data.cells.filter((c) => c.ord !== 1).map((c) => (
            <tr key={c.ord} className="border-b border-line align-top" data-testid={`site-master-row-${c.letter}`}>
              <td className="px-2 py-1"><span className="mono me-1 text-mute">{c.letter}</span>{c.header}</td>
              <td className="px-2 py-1">
                {c.kind === 'not_tracked'
                  ? <span className="italic text-mute" title={t('siteMaster.not_tracked_hint')} data-testid={`site-master-not-tracked-${c.letter}`}>{t('siteMaster.not_tracked')}</span>
                  : c.hidden ? <span className="text-mute">{t('siteMaster.src.hidden')}</span>
                  : c.value ?? <span className="text-mute">-</span>}
              </td>
              <td className="px-2 py-1"><SiteMasterSourceDetails siteId={siteId} cell={c} testid={`site-master-src-${c.letter}`} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
