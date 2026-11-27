import { useTranslation } from 'react-i18next';
import { useSiteTasks } from '@/api/sites';

/** States of a task that is finished or out of the flow: not offered as "the task that is blocked" or "the task a change affects". */
const CLOSED = new Set(['approved', 'na', 'skipped', 'retired']);

/**
 * A picker over the tasks of the record's site (Issue log "Blocked Gate / Task", Change Control "Affected Task"). It reads the site's task grid, so the
 * caller sees only what the Site Register already shows them. The stored value stays the task code (text), so the dashboard, exports and old records do not change;
 * a value that is not in the list (typed before this picker existed) stays visible and selectable.
 */
export function SiteTaskField({ id, siteId, value, onChange, disabled, invalid }: {
  id: string; siteId?: string | null; value: unknown; onChange: (v: string | null) => void; disabled?: boolean; invalid?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const q = useSiteTasks(siteId ?? '', null, !!siteId);
  const current = typeof value === 'string' ? value : '';
  const tasks = (q.data?.stages ?? []).flatMap((s) => s.tasks.map((k) => ({ code: k.task_code, name: (i18n.language === 'ar' && (k as { name_ar?: string | null }).name_ar) || k.name_en, state: k.state })))
    .filter((k) => !CLOSED.has(k.state));
  if (disabled) return <span data-testid={id}>{current || '—'}</span>;
  if (!siteId) return <p className="text-sm text-mute" data-testid={`${id}-nosite`}>{t('picker.choose_site_first', { defaultValue: 'Choose the site first.' })}</p>;
  const known = tasks.some((k) => k.code === current);
  return (
    <select id={id} data-testid={id} className="input" aria-invalid={invalid || undefined} value={current} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{t('picker.task_none', { defaultValue: 'None' })}</option>
      {current && !known && <option value={current}>{current}</option>}
      {tasks.map((k) => <option key={k.code} value={k.code}>{k.code} - {k.name}</option>)}
    </select>
  );
}
