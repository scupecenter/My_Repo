import { Lock, SearchX, Inbox, CircleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';

const box = 'flex flex-col items-center gap-2 p-8 text-center text-mute';

/** Shared page/list states (plan 2.14): loading, empty, no results, no permission, error with retry. */
export function LoadingSkeleton({ rows = 5, testid = 'state-loading' }: { rows?: number; testid?: string }) {
  const { t } = useTranslation();
  return (
    <div role="status" aria-busy="true" aria-label={t('common.loading')} data-testid={testid} className="space-y-2 p-4">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="h-8 animate-pulse rounded-md bg-card2 motion-reduce:animate-none" />)}
    </div>
  );
}

export function EmptyState({ title, hint, action, testid = 'state-empty' }: { title: string; hint?: string; action?: ReactNode; testid?: string }) {
  return <div data-testid={testid} className={box}><Inbox size={20} strokeWidth={1.75} aria-hidden /><p className="font-semibold text-ink">{title}</p>{hint && <p className="text-sm">{hint}</p>}{action}</div>;
}

export function NoResults({ onClear, testid = 'state-no-results' }: { onClear: () => void; testid?: string }) {
  const { t } = useTranslation();
  return (
    <div data-testid={testid} className={box}>
      <SearchX size={20} strokeWidth={1.75} aria-hidden /><p className="font-semibold text-ink">{t('states.no_results')}</p>
      <button className="btn" data-testid={`${testid}-clear`} onClick={onClear}>{t('states.clear_filters')}</button>
    </div>
  );
}

export function NoPermission({ testid = 'state-no-permission' }: { testid?: string }) {
  const { t } = useTranslation();
  return <div role="alert" data-testid={testid} className={box}><Lock size={20} strokeWidth={1.75} aria-hidden /><p className="font-semibold text-ink">{t('states.no_permission')}</p><p className="text-sm">{t('states.no_permission_hint')}</p></div>;
}

export function ErrorState({ onRetry, message, testid = 'state-error' }: { onRetry?: () => void; message?: string; testid?: string }) {
  const { t } = useTranslation();
  return (
    <div role="alert" data-testid={testid} className={box}>
      <CircleAlert size={20} strokeWidth={1.75} aria-hidden className="text-lateInk" /><p className="font-semibold text-lateInk">{message ?? t('errors.generic')}</p>
      {onRetry && <button className="btn" data-testid={`${testid}-retry`} onClick={onRetry}>{t('states.retry')}</button>}
    </div>
  );
}
