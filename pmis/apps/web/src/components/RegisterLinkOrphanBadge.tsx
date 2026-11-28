import { useTranslation } from 'react-i18next';
import { useRegisterLinkOrphans } from '@/api/p4c';

/**
 * D60 follow-up: the orphan count of one declared link, shown next to the link in the Settings links editor (System Admin). Green when no row holds an id that is not a
 * current record of the target, red with the count otherwise; its title says how many rows use the link. The counts come from GET /registers/links/orphans (one call for the
 * whole editor, cached). Shows nothing for a user who may not read the report or while it loads.
 */
export function RegisterLinkOrphanBadge({ register, field }: { register: string; field: string }) {
  const { t } = useTranslation();
  const q = useRegisterLinkOrphans();
  const row = q.data?.find((o) => o.register_key === register && o.field_code === field);
  if (!row) return null;
  const n = Number(row.orphan_rows);
  const total = Number(row.rows_with_value);
  const title = total === 0 ? t('linkOrphans.badge_none') : t('linkOrphans.badge_title', { n, total, target: row.target_register });
  return (
    <span data-testid={`link-orphans-${register}-${field}`} title={title} className={`ms-2 rounded px-1 text-xs ${n > 0 ? 'bg-danger/10 text-danger' : 'bg-surface-2 text-mute'}`}>
      {n > 0 ? t('linkOrphans.badge_orphans', { n }) : t('linkOrphans.badge_clean')}
    </span>
  );
}
