import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * A warning (never a block) under an Arabic name field that was left empty while the English name is filled: Arabic users then see the English text
 * (Settings review gap 2). Shown for weight activities and items and for goals.
 */
export function MissingArabicHint({ en, ar, testid }: { en: string | null | undefined; ar: string | null | undefined; testid: string }) {
  const { t } = useTranslation();
  if (!(en ?? '').trim() || (ar ?? '').trim()) return null;
  return (
    <p className="mt-1 flex items-center gap-1 text-xs text-warn" role="status" data-testid={testid}>
      <TriangleAlert size={12} aria-hidden className="shrink-0" />{t('common.name_ar_missing')}
    </p>
  );
}
