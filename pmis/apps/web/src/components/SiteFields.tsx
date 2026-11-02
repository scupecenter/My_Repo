import { useTranslation } from 'react-i18next';
import { useUpdateSite, type SiteCustomField } from '@/api/qc';
import type { SiteDetail } from '@/api/types';
import { taskErrorMessage } from '@/lib/taskErrors';
import { useToast } from './Toast';

/**
 * The site's custom fields (owner answer Q130: the yes/no field near_airport). A yes/no field the caller may edit is a switch; the others are shown as
 * values. A change goes through PATCH /sites/{id} with the site's version, and the conditional documents that read the field follow by themselves.
 */
export function SiteFields({ site }: { site: SiteDetail }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const save = useUpdateSite(site.id);
  const fields = (site.custom_fields ?? []) as SiteCustomField[];
  if (!fields.length) return null;
  const values = (site.custom ?? {}) as Record<string, unknown>;
  const label = (f: SiteCustomField) => (i18n.language === 'ar' && f.label_ar) || f.label_en;
  const show = (v: unknown) => (v === true ? t('common.yes') : v === false ? t('common.no') : v === undefined || v === null || v === '' ? '—' : String(v));
  return (
    <section className="mt-3 flex flex-wrap items-center gap-4 rounded-md border border-line p-3 text-sm" aria-label={t('siteFields.title')} data-testid="site-fields">
      <span className="font-semibold">{t('siteFields.title')}</span>
      {fields.map((f) => {
        const v = values[f.code];
        if (f.type === 'bool' && f.can_edit) {
          return (
            <label key={f.code} className="inline-flex items-center gap-2" data-testid={`site-field-${f.code}`}>
              <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" data-testid={`site-field-input-${f.code}`} checked={v === true} disabled={save.isPending}
                onChange={(e) => save.mutate({ version: site.version, custom: { [f.code]: e.target.checked } }, {
                  onSuccess: () => toast(t('siteFields.saved')),
                  onError: (err) => toast(taskErrorMessage(t as never, err) || t('siteFields.failed'), 'err'),
                })} />
              {label(f)}
            </label>
          );
        }
        return <span key={f.code} data-testid={`site-field-${f.code}`}><span className="text-mute">{label(f)}:</span> <b>{show(v)}</b></span>;
      })}
    </section>
  );
}
