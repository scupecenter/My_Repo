import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { useLibraryForms } from '@/api/library';

/** The three pages of the Library: Forms (generate and print), Templates (create, edit and approve; only for who may configure) and Archive. */
export function LibraryTabs() {
  const { t } = useTranslation();
  const forms = useLibraryForms();
  const tabs = [
    { to: '/library/forms', key: 'forms', show: true },
    { to: '/library/templates', key: 'templates', show: !!forms.data?.can_configure },
    { to: '/library/archive', key: 'archive', show: true },
    { to: '/library/media', key: 'media', show: true },
  ].filter((x) => x.show);
  return (
    <nav className="mb-3 flex flex-wrap gap-1 border-b border-line" aria-label={t('lib.tabs')} data-testid="lib-tabs">
      {tabs.map((x) => (
        <NavLink key={x.key} to={x.to} data-testid={`lib-tab-${x.key}`}
          className={({ isActive }) => `rounded-t px-3 py-2 text-sm font-semibold ${isActive ? 'border-b-2 border-accent text-accentText' : 'text-mute hover:text-ink'}`}>{t(`lib.tab_${x.key}`)}</NavLink>
      ))}
    </nav>
  );
}
