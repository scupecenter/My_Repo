import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { downloadExport, useExportParts, useExports } from '@/api/admin';
import { ApiError } from '@/api/client';
import { useRegions } from '@/api/sites';
import type { MasterExport } from '@/api/types';
import { EmptyState, ErrorState, LoadingSkeleton } from './States';
import { useToast } from './Toast';
import { fmtDateTime } from '@/lib/time';

const TONE: Record<string, string> = { queued: 'bg-lockBg text-lockInk', running: 'bg-openBg text-openInk', done: 'bg-doneBg text-doneInk', failed: 'bg-lateBg text-lateInk', expired: 'bg-lockBg text-lockInk' };

/**
 * The log of the caller's exports (Data entry proposal P7, contract 0.15.269): what was exported, with which scope, when, in which state, how many rows, until when the
 * file can be downloaded, and the download. It is the same list as the Export dialog and the Data hub (the same hook, labels and download), so nothing is kept twice;
 * the scheduled exports (Settings > Data > Scheduled export) land here like any export.
 */
export function ExportLog({ canSchedule }: { canSchedule: boolean }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const lang = i18n.language === 'ar' ? 'ar' : 'en';
  const list = useExports(true), parts = useExportParts(true), regions = useRegions();
  const rows: MasterExport[] = list.data ?? [];
  const partLabel = (k: string) => { const p = parts.data?.find((x) => x.key === k); return p ? (lang === 'ar' ? p.label_ar : p.label_en) : k; };
  const regionLabel = (id: number) => { const r = (regions.data ?? []).find((x) => x.id === id); return r ? ((lang === 'ar' && r.name_ar) || r.name_en) : String(id); };
  const when = (iso: string | null | undefined) => (iso ? fmtDateTime(iso, lang) || '—' : '—');
  const scope = (e: MasterExport) => (e.kind === 'partial' ? (e.parts ?? []).map(partLabel).join(', ') : e.kind === 'view' ? partLabel(e.view?.source ?? '') : t('exlog.whole'));
  const dl = (e: MasterExport) => downloadExport(e.id).catch((x) => toast(x instanceof ApiError && x.code === 'export_expired' ? t('errors.export_expired') : t('errors.generic'), 'err'));
  return (
    <section aria-labelledby="exlog-title" data-testid="export-log">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 id="exlog-title" className="text-lg font-bold">{t('exlog.title')}</h2>
        {canSchedule && <Link className="btn ms-auto px-2 py-1 text-xs" to="/admin/settings/data/export" data-testid="exlog-schedule-link">{t('exlog.schedule')}</Link>}
      </div>
      <p className="mb-2 text-sm text-mute">{t('exlog.hint')}</p>
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm" data-testid="exlog-table">
          <thead className="bg-card2 text-mute"><tr>{['what', 'scope', 'when', 'status', 'rows', 'expires', ''].map((c) => <th key={c || 'act'} className="p-2 text-start">{c ? t(`exlog.col_${c}`) : <span className="sr-only">{t('export.download')}</span>}</th>)}</tr></thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className="border-t border-line" data-testid={`exlog-row-${e.id}`} data-status={e.status}>
                <td className="p-2 font-semibold">{t(`export.kind_${e.kind}`)}</td>
                <td className="p-2 text-mute">
                  <span>{scope(e)}</span>
                  {!!e.regions?.length && <span className="ms-2 text-xs">· {e.regions.map(regionLabel).join(', ')}</span>}
                  {e.as_of && <span className="ms-2 text-xs">· {t('exlog.as_of')} <bdi>{e.as_of}</bdi></span>}
                </td>
                <td className="p-2 text-mute"><bdi>{when(e.created_at)}</bdi></td>
                <td className="p-2"><span className={`chip ${TONE[e.status]}`} title={e.status === 'failed' ? (e.error ?? undefined) : undefined}>{t(`export.status_${e.status}`)}</span>
                  {e.status === 'running' && typeof e.progress === 'number' && <span className="mono ms-2 text-xs text-mute">{Math.round(e.progress * 100)}%</span>}</td>
                <td className="p-2 text-mute">{e.row_count ?? '—'}</td>
                <td className="p-2 text-mute"><bdi>{e.status === 'done' ? when(e.expires_at) : '—'}</bdi></td>
                <td className="p-2 text-end">
                  {e.status === 'done' && <button className="btn" data-testid={`exlog-download-${e.id}`} aria-label={t('export.download')} title={t('export.download')} onClick={() => void dl(e)}><Download size={14} aria-hidden /></button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.isLoading && <LoadingSkeleton />}
        {list.isSuccess && !rows.length && <EmptyState testid="exlog-empty" title={t('export.none')} />}
        {list.isError && <ErrorState onRetry={() => void list.refetch()} />}
      </div>
    </section>
  );
}
