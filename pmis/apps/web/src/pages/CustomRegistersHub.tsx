import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useRegisterDefs } from '@/api/registers';
import { isCustomKey } from '@/lib/registerForms';

/**
 * Migration 0531: the one side-menu entry of the custom registers. It lists the enabled custom registers the caller may view (the register list of the API already
 * leaves out a hidden or disabled register and one without the view right); each opens the ordinary register page. The permission grid, the matrix and the
 * exports work on the register key as for every other register.
 */
export function CustomRegistersHub() {
  const { t, i18n } = useTranslation();
  const defs = useRegisterDefs();
  const items = (defs.data ?? []).filter((d) => isCustomKey(d.register_key));
  const ar = i18n.language.startsWith('ar');
  return (
    <section className="card space-y-3 p-4" data-testid="page-custom-registers-hub">
      <h1 className="text-2xl font-bold">{t('custreg.hub_title')}</h1>
      <p className="text-sm text-mute">{t('custreg.hub_note')}</p>
      {defs.isLoading ? <p className="text-mute">{t('common.loading')}</p> : items.length === 0 ? (
        <p className="text-sm text-mute" data-testid="custreg-hub-empty">{t('custreg.hub_empty')}</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2" data-testid="custreg-hub-list">
          {items.map((d) => (
            <li key={d.register_key}>
              <Link className="card block p-3 hover:bg-hover" data-testid={`custreg-hub-${d.register_key}`} to={`/registers/${d.register_key}`}>
                <span className="font-semibold">{ar && d.name_ar ? d.name_ar : d.name_en}</span>
                {typeof d.record_count === 'number' && <span className="ms-2 chip">{d.record_count}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
