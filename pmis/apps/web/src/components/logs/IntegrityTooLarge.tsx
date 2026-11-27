import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { useStartIntegrityRun } from '@/api/logs';
import { errText } from '@/components/FormDialog';

/**
 * L5: the Verify button checks the chain in one request. When the chain is longer than the limit the server answers 422 integrity_too_large; instead of only
 * an error toast this offers to start the same check as a job (POST /admin/log-integrity/runs, with progress) and opens the Integrity checks screen.
 */
export const isTooLarge = (e: unknown): e is ApiError => e instanceof ApiError && e.code === 'integrity_too_large';

export function IntegrityTooLarge({ log, onClose }: { log: 'audit' | 'security'; onClose: () => void }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const start = useStartIntegrityRun();
  return (
    <div className="card space-y-2 p-3 text-sm" role="alert" data-testid={`integrity-too-large-${log}`}>
      <p>{t('errors.integrity_too_large')}</p>
      {start.isError && <p className="text-lateInk" data-testid="integrity-job-error">{errText(start.error, t)}</p>}
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-accent" data-testid={`integrity-start-job-${log}`} disabled={start.isPending} onClick={() => start.mutate(log, { onSuccess: () => nav('/admin/logs/integrity') })}>{t('logs.integrity_start_job')}</button>
        <Link className="btn" to="/admin/logs/integrity" data-testid="integrity-open-runs">{t('logs.integrity_open_runs')}</Link>
        <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
      </div>
    </div>
  );
}
