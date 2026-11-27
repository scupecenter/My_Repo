import { useTranslation } from 'react-i18next';
import { useLinkOptions, type LinkOption } from '@/api/registerLinks';

/**
 * The picker of ANY link field of the catalogue (migration 0431): the form needs no code per link. The candidates are the records of the target register the caller may see.
 * The stored value is the entity id; a value that is not in the list (typed before the catalogue) stays visible and selectable.
 */
export function RegisterLinkSelect({ registerKey, field, siteId, value, onChange, editable, invalid }: {
  registerKey: string; field: string; siteId: string | null | undefined; value: unknown; onChange: (v: string | null) => void; editable: boolean; invalid?: boolean;
}) {
  const { t } = useTranslation();
  const cur = typeof value === 'string' ? value : '';
  const q = useLinkOptions(registerKey, field, siteId, editable || !!cur);
  const items = q.data ?? [];
  const chosen = items.find((i) => i.entity_id === cur);
  const label = (i: LinkOption) => i.title ?? i.po_wo_no ?? i.pr_no ?? i.entity_id.slice(0, 8);
  return (
    <div data-testid="reg-link-select">
      {editable
        ? (
          <select id={`reg-field-${field}`} data-testid={`reg-field-${field}`} className="input" aria-invalid={invalid || undefined} value={cur} onChange={(e) => onChange(e.target.value || null)}>
            <option value="">{t('links.none')}</option>
            {items.map((i) => <option key={i.entity_id} value={i.entity_id}>{label(i)}{i.state ? ` · ${i.state}` : ''}</option>)}
            {cur && !chosen && <option value={cur}>{cur.slice(0, 8)}</option>}
          </select>
        )
        : <div className="font-semibold" data-testid={`reg-view-${field}`}>{chosen ? label(chosen) : cur ? cur.slice(0, 8) : '—'}</div>}
      {editable && <p className="text-sm text-mute">{t('links.hint')}</p>}
    </div>
  );
}
