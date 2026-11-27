import { useTranslation } from 'react-i18next';
import { useSite } from '@/api/sites';

/**
 * A picker over the gates of the record's site (Deliverables "Gate"). It reads the site page (the pipeline the Site Register already shows), so the caller sees
 * only what that page shows them. The stored value stays the gate code (text); a value that is not in the list (typed before this picker) stays visible.
 */
export function SiteGateField({ id, siteId, value, onChange, disabled, invalid }: {
  id: string; siteId?: string | null; value: unknown; onChange: (v: string | null) => void; disabled?: boolean; invalid?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const q = useSite(siteId ?? '');
  const current = typeof value === 'string' ? value : '';
  const gates = (q.data?.pipeline ?? []).filter((n) => n.kind === 'gate').map((g) => ({ code: g.code, name: (i18n.language === 'ar' && g.name_ar) || g.name_en }));
  if (disabled) return <span data-testid={id}>{current || '—'}</span>;
  if (!siteId) return <p className="text-sm text-mute" data-testid={`${id}-nosite`}>{t('picker.choose_site_first', { defaultValue: 'Choose the site first.' })}</p>;
  const known = gates.some((g) => g.code === current);
  return (
    <select id={id} data-testid={id} className="input" aria-invalid={invalid || undefined} value={current} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{t('picker.gate_none', { defaultValue: 'None' })}</option>
      {current && !known && <option value={current}>{current}</option>}
      {gates.map((g) => <option key={g.code} value={g.code}>{g.code} - {g.name}</option>)}
    </select>
  );
}
