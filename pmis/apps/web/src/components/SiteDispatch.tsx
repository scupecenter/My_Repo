import { useTranslation } from 'react-i18next';
import type { SiteDispatch as Dispatch } from '@/api/types';
import { useSiteDispatch } from '@/api/warehouse';
import { StandardTable, type StdCol } from './StandardTable';

/** D6 (migration 0053): the two values are shown side by side and never merged. */
export const NEED_TONE: Record<string, string> = {
  complete: 'bg-doneBg text-doneInk',
  short: 'bg-lateBg text-lateInk',
  pending_configuration: 'bg-waitBg text-waitInk',
  not_applicable: 'bg-lockBg text-lockInk',
};

export function DispatchSummary({ d }: { d: Dispatch }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="dispatch-summary">
      <div className="card p-3">
        <p className="text-sm font-semibold">{t('wh.dispatch_date')}</p>
        <p className="mono text-lg" data-testid="dispatch-date">{d.te_dispatch_complete_date ?? '—'}</p>
        <p className="text-xs text-mute">{t('wh.dispatch_date_hint')}{d.latest_te_dn_no ? ` · ${t('wh.latest_dn')}: ${d.latest_te_dn_no}` : ''}</p>
      </div>
      <div className="card p-3">
        <p className="text-sm font-semibold">{t('wh.need_status')}</p>
        <p><span className={`chip ${NEED_TONE[d.need_status]}`} data-testid="dispatch-need-status" data-status={d.need_status}>{t(`wh.ns_${d.need_status}`)}</span>
          {d.router_only && <span className="chip ms-2 bg-lockBg text-lockInk">{t('wh.router_only')}</span>}</p>
        <p className="text-xs text-mute">{t('wh.need_status_hint')}</p>
      </div>
    </div>
  );
}

/** The Warehouse section of the site page: the TE dispatch date (Q65) and the need status with its lines. */
export function SiteDispatchPanel({ siteId }: { siteId: string }) {
  const { t, i18n } = useTranslation();
  const q = useSiteDispatch(siteId);
  if (q.isLoading) return <p className="text-mute">{t('common.loading')}</p>;
  if (q.isError || !q.data) return <p role="alert" className="text-lateInk">{t('errors.generic')}</p>;
  const d = q.data;
  const num = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toLocaleString(i18n.language));
  type Line = NonNullable<Dispatch['lines']>[number];
  const cols: StdCol<Line>[] = [
    { id: 'need_unit', label: t('wh.need_unit'), w: 160, pinned: true, text: (l) => l.need_unit, cell: (l) => l.need_unit },
    { id: 'items', label: t('wh.items'), w: 220, text: (l) => l.items.map((x) => x.item_code).join(' / '), cell: (l) => <span className="mono">{l.items.map((x) => x.item_code).join(' / ')}</span> },
    { id: 'need', label: t('wh.need'), w: 100, text: (l) => num(l.need), cell: (l) => num(l.need) },
    { id: 'delivered', label: t('wh.delivered'), w: 110, text: (l) => num(l.delivered), cell: (l) => num(l.delivered) },
    { id: 'short', label: t('wh.short'), w: 100, text: (l) => num(l.short), cell: (l) => num(l.short) },
    { id: 'status', label: t('wh.status'), w: 240, multi: true, text: (l) => t(`wh.ns_${l.line_status}`) + (l.missing ? ` ${t(`wh.miss_${l.missing}`)}` : ''),
      cell: (l) => <><span className={`chip ${NEED_TONE[l.line_status]}`}>{t(`wh.ns_${l.line_status}`)}</span>{l.missing && <span className="ms-2 text-xs text-mute" data-testid={`dispatch-missing-${l.need_group}`}>{t(`wh.miss_${l.missing}`)}</span>}</> },
  ];
  return (
    <div data-testid="site-dispatch">
      <DispatchSummary d={d} />
      {!d.te_applies ? <p className="card mt-3 p-6 text-mute" data-testid="dispatch-no-te">{t('wh.no_te')}</p> : (
        <div className="mt-3"><StandardTable screen="site-dispatch" testid="site-dispatch-table" cols={cols} rows={d.lines ?? []} rowId={(l) => `${l.need_unit}|${l.need_group}`}
          rowTestId={(l) => `dispatch-line-${l.need_group}`} rowAttrs={(l) => ({ 'data-status': l.line_status })} exportName="site-dispatch-lines" noun="items" /></div>
      )}
    </div>
  );
}
