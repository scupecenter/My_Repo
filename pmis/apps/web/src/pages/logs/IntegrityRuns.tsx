import { ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useIntegrityRuns, useStartIntegrityRun, type LogIntegrityRun } from '@/api/logs';
import { errText } from '@/components/FormDialog';
import { stamp } from '@/components/logs/bits';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/States';
import { useToast } from '@/components/Toast';

const TONE: Record<LogIntegrityRun['status'], string> = { running: 'bg-openBg text-openInk', ok: 'bg-doneBg text-doneInk', broken: 'bg-lateBg text-lateInk', failed: 'bg-lateBg text-lateInk' };

/**
 * Integrity checks (owner answer Q171, contract 0.12.3): a whole chain is checked as a job with progress, nightly and on demand; the result stays,
 * with its range, its head and the check of the external anchor. A break raises the mandatory alert `audit_integrity_failure`.
 */
export function IntegrityRuns() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useIntegrityRuns(), start = useStartIntegrityRun();
  if (q.isError) return <ErrorState onRetry={() => void q.refetch()} />;
  const go = (log: 'audit' | 'security') => start.mutate(log, { onSuccess: () => toast(t('integ.started')) });
  return (
    <div data-testid="page-integrity" className="space-y-3">
      <PageHeader title={t('nav.logs.integrity')} subtitle={t('integ.subtitle')} />
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-accent" data-testid="integ-start-audit" disabled={start.isPending} onClick={() => go('audit')}><ShieldCheck size={14} />{t('integ.check_audit')}</button>
        <button className="btn" data-testid="integ-start-security" disabled={start.isPending} onClick={() => go('security')}><ShieldCheck size={14} />{t('integ.check_security')}</button>
      </div>
      {start.isError && <p role="alert" className="text-sm text-lateInk" data-testid="integ-error">{errText(start.error, t)}</p>}
      {q.isLoading ? <LoadingSkeleton /> : (
        <ul className="space-y-2" data-testid="integ-list">
          {(q.data ?? []).map((r) => (
            <li key={r.id} className="card space-y-1 p-3 text-sm" data-testid={`integ-run-${r.id}`} data-status={r.status}>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`chip ${TONE[r.status]}`} data-testid={`integ-status-${r.id}`}>{t(`integ.s_${r.status}`)}</span>
                <span className="font-semibold">{t(`integ.log_${r.log}`)}</span>
                <span className="text-mute">{t(`integ.t_${r.trigger}`)}</span>
                <span className="mono ms-auto text-xs text-mute" dir="ltr">{stamp(r.started_at)}</span>
              </div>
              <div className="h-2 overflow-hidden rounded bg-card2" role="progressbar" aria-label={t('integ.progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={r.progress}
                data-testid={`integ-progress-${r.id}`}><div className="h-full bg-accent" style={{ width: `${r.progress}%` }} /></div>
              <p className="text-xs text-mute">{t('integ.range', { from: r.from_seq, to: r.to_seq, rows: r.row_count })}</p>
              {r.head_hash && <p className="mono break-all text-xs text-mute" dir="ltr">{r.head_hash}</p>}
              {r.break_count > 0 && <p className="font-semibold text-lateInk" data-testid={`integ-breaks-${r.id}`}>{t('integ.breaks', { count: r.break_count })}</p>}
              {r.anchor_check && <p className="text-xs" data-testid={`integ-anchor-${r.id}`}>{r.anchor_check.ok === false ? t('integ.anchor_bad') : r.anchor_check.ok ? t('integ.anchor_ok') : t('integ.anchor_none')}</p>}
              {r.error && <p className="text-xs text-lateInk" dir="ltr">{r.error}</p>}
            </li>))}
        </ul>
      )}
      {q.isSuccess && !(q.data ?? []).length && <EmptyState title={t('integ.none')} testid="integ-empty" />}
    </div>
  );
}
