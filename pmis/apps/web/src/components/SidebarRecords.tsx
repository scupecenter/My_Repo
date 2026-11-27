import { useQueries } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api } from '@/api/client';
import type { SiteDetail } from '@/api/types';
import { clearRecentRecords, recordChanged, siteSignature, togglePinRecord, useRecordMemory, type RecRef } from '@/lib/recordMemory';

/**
 * Item 5: pinned and recent records in the sidebar. The dot means "changed since you last had it open". It reads the same site endpoint as the Site page,
 * so a site the person may not see is simply not shown as changed (the request fails and nothing is claimed). Refreshed at most every two minutes.
 */
export function SidebarRecords({ activePath, onNavigate }: { activePath: string; onNavigate?: () => void }) {
  const { t } = useTranslation();
  const m = useRecordMemory();
  const recent = m.recent.filter((r) => !m.pins.some((p) => p.id === r.id));
  const all = [...m.pins, ...recent];
  const live = useQueries({
    queries: all.map((r) => ({ queryKey: ['site', r.id], queryFn: () => api.get<SiteDetail>(`/sites/${r.id}`), staleTime: 120_000, retry: false })),
  });
  if (!all.length) return null;
  const changed = (r: RecRef, i: number) => {
    const d = live[i]?.data;
    return !!d && !activePath.startsWith(r.path) && recordChanged(m, r.id, siteSignature(d));
  };
  const item = (r: RecRef, i: number, pinned: boolean) => {
    const dot = changed(r, i);
    return (
      <div key={`${pinned ? 'p' : 'r'}-${r.id}`} className="group flex items-center" data-testid={`rec-${pinned ? 'pin' : 'recent'}-${r.code}`}>
        <Link to={r.path} onClick={onNavigate} aria-current={activePath.startsWith(r.path) ? 'page' : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink hover:bg-hover">
          <span className="mono shrink-0 text-xs text-mute">{r.code}</span>
          <span className="flex-1 truncate">{r.name}</span>
          {dot && <span data-testid={`rec-dot-${r.code}`} className="h-2 w-2 shrink-0 rounded-full bg-accent" role="img" aria-label={t('records.changed')} title={t('records.changed')} />}
        </Link>
        {pinned && (
          <button type="button" data-testid={`rec-unpin-${r.code}`} aria-label={`${t('records.unpin')}: ${r.code}`} onClick={() => togglePinRecord(r, '')}
            className="rounded-md p-1 text-faint hover:bg-hover hover:text-ink"><X size={14} aria-hidden /></button>
        )}
      </div>
    );
  };
  return (
    <>
      {!!m.pins.length && (
        <div className="mb-3" data-testid="nav-pinned-records">
          <div className="px-2 py-1 text-xs font-semibold text-mute">{t('records.pinned')}</div>
          {m.pins.map((r, i) => item(r, i, true))}
        </div>
      )}
      {!!recent.length && (
        <div className="mb-3" data-testid="nav-recent-records">
          <div className="flex items-center justify-between px-2 py-1 text-xs font-semibold text-mute">
            <span>{t('records.recent')}</span>
            <button type="button" data-testid="rec-clear" className="font-normal hover:text-ink" onClick={clearRecentRecords}>{t('records.clear')}</button>
          </div>
          {recent.map((r, i) => item(r, m.pins.length + i, false))}
        </div>
      )}
    </>
  );
}
