import { ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * The "Admin override" badge of a task accepted without its mandatory documents under the historical-load waiver (Q462, contract 0.14.3:
 * `historical_no_documents`). It is cleared by itself when the documents are uploaded. The title says why and what clears it.
 */
export function OverrideBadge({ taskId, className = '', bypass, direct, admin }: {
  taskId: string; className?: string; /** 0.15.4: the lock the task bypassed on an open site */ bypass?: string | null;
  /** 0.15.11: approved directly by the historical load of the Master (no L2) */ direct?: boolean;
  /** 0.15.7: a date set by a System Admin (reversible) */ admin?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <span className={`chip shrink-0 bg-waitBg text-waitInk ${className}`} data-testid={`override-${taskId}`} data-kind={direct ? 'historical_direct' : admin ? 'admin_edit' : bypass ? 'lock_bypass' : 'historical'}
      title={direct ? t('override.direct_title') : admin ? t('override.admin_title') : bypass ? t('override.bypass_title', { why: bypass.replace(/^predecessor_open:/, '').replace(/^gate_closed:/, '') }) : t('override.historical_title')}>
      <ShieldAlert size={12} className="me-1" aria-hidden />{t('override.badge')}
    </span>
  );
}
