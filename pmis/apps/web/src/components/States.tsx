import { Lock, SearchX, Inbox, CircleAlert, PlugZap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { ApiError } from '@/api/client';
import { errText } from './FormDialog';

const box = 'flex flex-col items-center gap-2 p-8 text-center text-mute';

/** Shared page/list states (plan 2.14): loading, empty, no results, no permission, error with retry. */
export function LoadingSkeleton({ rows = 5, testid = 'state-loading' }: { rows?: number; testid?: string }) {
  const { t } = useTranslation();
  return (
    <div role="status" aria-busy="true" aria-label={t('common.loading')} data-testid={testid} className="space-y-2 p-4">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="h-8 motion-shimmer rounded-md bg-card2" />)}
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

/** 501 `not_available` (a route no controller serves yet, mocks/realApi.ts NOT_AVAILABLE): said plainly, nothing was read or saved. */
export function NotAvailable({ testid = 'state-not-available' }: { testid?: string }) {
  const { t } = useTranslation();
  return <div role="alert" data-testid={testid} className={box}><PlugZap size={20} strokeWidth={1.75} aria-hidden /><p className="font-semibold text-ink">{t('states.not_available')}</p><p className="text-sm">{t('states.not_available_hint')}</p></div>;
}

/** The standard state of a failed read: no permission (403), not available (501), or the error with a retry. Never a spinner. */
export function QueryError({ error, onRetry, testid = 'state-error' }: { error: unknown; onRetry?: () => void; testid?: string }) {
  const { t } = useTranslation();
  if (error instanceof ApiError && error.status === 403) return <NoPermission testid={`${testid}-forbidden`} />;
  if (error instanceof ApiError && (error.status === 501 || error.code === 'not_available')) return <NotAvailable testid={`${testid}-not-available`} />;
  return <ErrorState onRetry={onRetry} message={error instanceof ApiError ? errText(error, t) : t('states.load_failed')} testid={testid} />;
}

/** The part of a react-query result the fallback reads. */
export interface QueryLike { data?: unknown; isError: boolean; error: unknown; refetch: () => unknown }

/**
 * W4 of the 2026-11-23 plan: what a screen shows while one of its reads has no data yet. A failed read shows QueryError (403, 501, other); otherwise "Loading...".
 * Before, screens returned "Loading..." whenever data was missing, so a 403 or a 501 left them on "Loading..." for ever.
 */
export function QueryFallback({ queries, testid = 'state-loading' }: { queries: QueryLike[]; testid?: string }) {
  const { t } = useTranslation();
  const failed = queries.find((q) => q.isError);
  if (failed) return <QueryError error={failed.error} onRetry={() => { for (const q of queries) if (q.isError) void q.refetch(); }} testid={`${testid}-error`} />;
  return <p role="status" aria-busy="true" className="text-mute" data-testid={testid}>{t('common.loading')}</p>;
}
