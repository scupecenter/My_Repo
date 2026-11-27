import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/api/hooks';
import { ICONS } from '@/lib/icons';
import { canOpenScreenSettings, screenSettingsLabelKey, screenSettingsPath, type ScreenKey } from '@/lib/screenSettings';
import { Tip } from './Tip';

/** Two-line hint and aria-label: the title, then where the link lands (so the person knows before clicking). */
export function useScreenSettings(screen: ScreenKey) {
  const { t } = useTranslation();
  const me = useMe(true);
  const dest = t(screenSettingsLabelKey(screen));
  return { allowed: canOpenScreenSettings(me.data, screen), to: screenSettingsPath(screen), title: t('screenSettings.title'), dest, hint: `${t('screenSettings.title')}\n${dest}` };
}

/**
 * The settings gear: a link to the Settings page that owns this screen's configuration (no in-place editing). Placed in the header action row right before
 * the More menu; hidden for people who cannot open Settings. On narrow headers it is hidden and the same link is the last item of the More menu.
 */
export function ScreenSettingsLink({ screen, narrowHidden = false }: { screen: ScreenKey; narrowHidden?: boolean }) {
  const s = useScreenSettings(screen);
  if (!s.allowed) return null;
  const Icon = ICONS.settings;
  return (
    <Tip text={s.hint}>
      <Link to={s.to} className={`btn ${narrowHidden ? 'hidden sm:inline-flex' : ''}`} data-testid="screen-settings-link" data-screen={screen} aria-label={s.hint.replace('\n', ': ')}>
        <Icon size={16} aria-hidden />
      </Link>
    </Tip>
  );
}
