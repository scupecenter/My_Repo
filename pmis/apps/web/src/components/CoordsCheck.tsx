import { MapPinOff, MapPin } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useSiteMap } from '@/api/dashboard';

const LIST_MAX = 15;

/**
 * Setup check of the site map: how many live sites have valid coordinates (inside the country bounds, the same rule as the map) and which do not.
 * Read only; the figures come from the map's own endpoint (region scope of the caller), so nothing new is computed. Each site links to its page.
 */
export function CoordsCheck() {
  const { t, i18n } = useTranslation();
  const q = useSiteMap(true);
  const ar = i18n.language === 'ar';
  if (q.isError) return <p role="alert" className="text-sm text-lateInk" data-testid="coords-check-error">{t('maps.coords_error')}</p>;
  if (!q.data) return <p className="text-sm text-mute">{t('common.loading')}</p>;
  const { with_coordinates: ok, without_coordinates: missing } = q.data.counts;
  const total = ok + missing;
  const missingSites = q.data.items.filter((s) => !s.has_coordinates && s.overall_status !== 'cancelled');
  return (
    <section className="card space-y-2 p-4" data-testid="coords-check">
      <h2 className="font-bold">{t('maps.coords_title')}</h2>
      <p className="text-sm text-mute">{t('maps.coords_note')}</p>
      <div className="flex flex-wrap gap-2">
        <span className="chip" title={t('maps.coords_ok_hint')} data-testid="coords-ok"><MapPin size={14} aria-hidden /> {t('maps.coords_ok', { ok, total })}</span>
        <span className={`chip ${missing ? 'bg-lateBg text-lateInk' : ''}`} title={t('maps.coords_missing_hint')} data-testid="coords-missing"><MapPinOff size={14} aria-hidden /> {t('maps.coords_missing', { count: missing })}</span>
      </div>
      {missing === 0 ? <p className="text-sm" data-testid="coords-all-good">{t('maps.coords_all_good')}</p> : (
        <ul className="grid gap-1 text-sm sm:grid-cols-2" data-testid="coords-missing-list">
          {missingSites.slice(0, LIST_MAX).map((s) => (
            <li key={s.id}><Link className="text-link underline" to={`/sites/${s.id}`}><span className="mono">{s.site_code}</span> {(ar && s.name_ar) || s.name}</Link></li>
          ))}
          {missingSites.length > LIST_MAX && <li className="text-mute">{t('maps.coords_more', { count: missingSites.length - LIST_MAX })}</li>}
        </ul>
      )}
    </section>
  );
}
