import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { Page, RegisterRecord } from '@/api/types';

/**
 * The open Change Control drafts of a site (name, Arabic name, coordinates, region, cluster, rule fields): what was proposed, in which state, and the
 * L2 note of a return. Read only: it lists the records of the existing `change_control` register for this site, no new endpoint. A returned draft
 * shows its note until a new draft or the approval replaces it.
 */
const OPEN = new Set(['entry', 'in_review', 'in_approval']);

export function usePendingSiteChanges(siteId: string) {
  return useQuery({
    queryKey: ['site-pending-changes', siteId],
    queryFn: () => api.get<Page<RegisterRecord>>('/registers/change_control/records', { query: { site_id: siteId, limit: 100 } }),
    select: (p) => {
      const seen = new Set<string>();
      const out: RegisterRecord[] = [];
      for (const r of p.items) {
        const item = String(r.data.field_item ?? '');
        if (!item || !OPEN.has(r.state) || r.is_current === false || seen.has(item)) continue;
        seen.add(item);
        out.push(r);
      }
      return out;
    },
  });
}

export function SitePendingChanges({ siteId }: { siteId: string }) {
  const { t } = useTranslation();
  const q = usePendingSiteChanges(siteId);
  const rows = q.data ?? [];
  if (!rows.length) return null;
  return (
    <ul className="my-2 space-y-1 text-sm" data-testid="site-pending-changes" aria-label={t('pendingChanges.title')}>
      {rows.map((r) => {
        const item = String(r.data.field_item);
        const returned = r.state === 'entry' && !!r.last_return_note;
        const label = returned ? t('pendingChanges.returned') : r.state === 'entry' ? t('pendingChanges.draft') : t('pendingChanges.waiting');
        return (
          <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-md bg-waitBg px-2 py-1 text-waitInk" data-testid={`site-pending-${item}`} data-state={r.state}>
            <span className="chip border border-line bg-card">{label}</span>
            <b>{t(`pendingChanges.item.${item.replace('site.', '')}`, { defaultValue: item })}</b>
            <span>{String(r.data.old_value ?? '')} → {String(r.data.new_value ?? '')}</span>
            {returned && <span data-testid={`site-pending-note-${item}`}>{t('pendingChanges.note', { note: r.last_return_note })}</span>}
          </li>
        );
      })}
    </ul>
  );
}
