import { ExternalLink, X } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { StandardTable, type StdCol } from '@/components/StandardTable';
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

/** The Master tab of the site page: every Master column of the site with its value and its source, and a link to the source record (the table standard). */
export function SiteMasterSources({ siteId }: { siteId: string }) {
  const { t } = useTranslation();
  const q = useSiteMasterSiteSources(siteId);
  const cols: StdCol<SiteMasterCellSource>[] = useMemo(() => {
    const val = (c: SiteMasterCellSource) => (c.kind === 'not_tracked' ? t('siteMaster.not_tracked') : c.hidden ? t('siteMaster.src.hidden') : c.value ?? '');
    return [
      { id: 'column', label: t('siteMaster.src.column'), w: 260, pinned: true, text: (c) => `${c.letter} ${c.header}`, cell: (c) => <><span className="mono me-1 text-mute">{c.letter}</span>{c.header}</> },
      { id: 'value', label: t('siteMaster.src.value'), w: 220, text: (c) => String(val(c)), cell: (c) => c.kind === 'not_tracked'
        ? <span className="italic text-mute" title={t('siteMaster.not_tracked_hint')} data-testid={`site-master-not-tracked-${c.letter}`}>{t('siteMaster.not_tracked')}</span>
        : c.hidden ? <span className="text-mute">{t('siteMaster.src.hidden')}</span> : c.value ?? <span className="text-mute">-</span> },
      { id: 'source', label: t('siteMaster.src.source'), w: 420, multi: true, text: (c) => `${t(`siteMaster.src.kind.${c.kind}`)}${c.origin ? ` ${t(`siteMaster.src.origin.${c.origin}`)}` : ''}${c.task_code ? ` ${c.task_code}` : ''}`,
        cell: (c) => <SiteMasterSourceDetails siteId={siteId} cell={c} testid={`site-master-src-${c.letter}`} /> },
    ];
  }, [t, siteId]);
  if (q.isError) return <p className="text-lateInk" role="alert">{t('siteMaster.src.error')}</p>;
  const rows = (q.data?.cells ?? []).filter((c) => c.ord !== 1);
  return (
    <StandardTable screen="site-master-sources" testid="site-master-sources" cols={cols} rows={rows} rowId={(c) => String(c.ord)} rowTestId={(c) => `site-master-row-${c.letter}`}
      loading={q.isLoading} exportName="site-master-sources" noun="items" />
  );
}
