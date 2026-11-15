import { useTranslation } from 'react-i18next';

/** Settings > Site360. The column-to-menu mapping is part of F15; until that screen is on main this tab is a placeholder. */
export function Site360() {
  const { t } = useTranslation();
  return (
    <section data-testid="settings-site360" className="card p-4">
      <h2 className="text-lg font-bold">{t('settings.site360_title')}</h2>
      <p className="text-mute">{t('settings.site360_pending')}</p>
    </section>
  );
}
