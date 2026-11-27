import { useTranslation } from 'react-i18next';
import { useUiFeatures } from '@/api/uiFeatures';
import { NEW_FEATURES, isNew, type NewFeatureKey } from '@/lib/newFeatures';
import { tripoliToday } from '@/lib/today';

/** A small "New" badge beside a feature that now sits next to the old way (item 14). Shows for the days set in Settings > Screens > Interface, then disappears. */
export function NewBadge({ feature, className = '' }: { feature: NewFeatureKey; className?: string }) {
  const { t } = useTranslation();
  const cfg = useUiFeatures().new_badge;
  if (!isNew(NEW_FEATURES[feature], tripoliToday(), cfg)) return null;
  return <span data-testid={`new-badge-${feature}`} title={t('ui.new_hint')} className={`chip ms-1 bg-accentSoft px-1.5 py-0 text-[10px] uppercase tracking-wide text-accentText ${className}`}>{t('ui.new')}</span>;
}
