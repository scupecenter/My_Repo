import { ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * The "Admin override" badge of a task accepted without its mandatory documents under the historical-load waiver (Q462, contract 0.14.3:
 * `historical_no_documents`). It is cleared by itself when the documents are uploaded. The title says why and what clears it.
 */
export function OverrideBadge({ taskId, className = '' }: { taskId: string; className?: string }) {
  const { t } = useTranslation();
  return (
    <span className={`chip shrink-0 bg-waitBg text-waitInk ${className}`} data-testid={`override-${taskId}`} title={t('override.historical_title')}>
      <ShieldAlert size={12} className="me-1" aria-hidden />{t('override.badge')}
    </span>
  );
}
