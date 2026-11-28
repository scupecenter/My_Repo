import { useTranslation } from 'react-i18next';
import type { MatrixCoverage } from '@/api/types';

/** L8 (contract 0.15.562): a badge for the modules that have registers and no permission grant in any profile. Read only; renders nothing when every module is granted. */
export function NoGrantsBadge({ modules }: { modules: MatrixCoverage['modules_without_grants'] | undefined }) {
  const { t, i18n } = useTranslation();
  if (!modules || modules.length === 0) return null;
  const ar = i18n.language.startsWith('ar');
  return (
    <p className="rounded-md bg-waitBg p-2 text-sm text-waitInk" role="status" data-testid="no-grants-badge">
      <b>{t('noGrants.title', { count: modules.length })}</b> {modules.map((m) => `${m.module_key} (${m.registers.map((r) => (ar && r.name_ar ? r.name_ar : r.name_en)).join(', ')})`).join('; ')}. {t('noGrants.hint')}
    </p>
  );
}
