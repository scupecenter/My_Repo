import { LogOut } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/api/hooks';
import { ONLINE_POLL_MS, useAdminSessions, useEndSession, type AdminSession } from '@/api/logs';
import { errText, FormDialog } from '@/components/FormDialog';
import { DeviceIcon, deviceText, stamp, Who } from '@/components/logs/bits';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/States';
import { useToast } from '@/components/Toast';

/** Active sessions with device and sign-in method. Ending one needs a reason and the step-up dialog (opened by the API client on 401). */
export function OnlineSessions() {
  const { t } = useTranslation();
  const toast = useToast();
  const me = useMe(true);
  const q = useAdminSessions(), end = useEndSession();
  const [target, setTarget] = useState<AdminSession | null>(null);
  const items = q.data ?? [];
  const mine = me.data?.user.employee_id;
  if (q.isError) return <ErrorState onRetry={() => void q.refetch()} />;
  return (
    <div data-testid="page-online-sessions" className="space-y-3">
      <PageHeader title={t('nav.logs.online')} subtitle={t('logs.online_subtitle', { seconds: ONLINE_POLL_MS / 1000 })} />
      {q.isLoading ? <LoadingSkeleton /> : (
        <div className="card overflow-x-auto"><table className="w-full text-sm">
          <thead className="border-b border-line bg-card2 text-mute"><tr>{['user', 'started', 'last', 'screen', 'device', 'ip', 'auth'].map((k) => <th key={k} className="p-2 text-start">{t(`logs.o_${k}`)}</th>)}<th className="p-2" /></tr></thead>
          <tbody data-testid="sessions-list">
            {items.map((s) => (
              <tr key={s.session_id} className="border-b border-line" data-testid={`asession-${s.session_id}`}>
                <td className="p-2"><Who a={s.user} />{s.user.employee_id === mine && <span className="chip ms-2 bg-openBg text-openInk">{t('online.you')}</span>}</td>
                <td className="mono p-2 text-xs" dir="ltr">{stamp(s.started_at)}</td><td className="mono p-2 text-xs" dir="ltr">{stamp(s.last_activity_at).slice(11)}</td>
                <td className="mono p-2 text-xs" dir="ltr">{s.current_screen ?? '—'}</td>
                <td className="p-2"><span className="inline-flex items-center gap-1"><DeviceIcon device={s.device} /><span className="hidden lg:inline">{deviceText(s.device)}</span></span></td>
                <td className="mono p-2 text-xs" dir="ltr">{s.ip ?? '—'}</td>
                <td className="p-2">{t(`logs.auth_${s.auth_method}`)}{s.mfa && <span className="chip ms-1 bg-doneBg text-doneInk">MFA</span>}</td>
                <td className="p-2 text-end">{s.user.employee_id !== mine && <button className="btn" data-testid={`session-end-${s.session_id}`} onClick={() => setTarget(s)}><LogOut size={14} />{t('online.end_session')}</button>}</td>
              </tr>))}
          </tbody>
        </table>{!items.length && <EmptyState title={t('online.empty')} testid="sessions-empty" />}</div>
      )}
      {target && (
        <FormDialog open onClose={() => setTarget(null)} testid="end-session-dialog" title={t('online.end_session')} busy={end.isPending} error={end.isError ? errText(end.error, t) : null}
          onSubmit={(reason) => end.mutate({ session: target, reason }, { onSuccess: () => { toast(t('logs.session_ended')); setTarget(null); } })}>
          <p className="text-sm text-mute">{t('online.revoke_note')}</p>
          <p className="text-sm font-semibold"><Who a={target.user} /></p>
        </FormDialog>
      )}
    </div>
  );
}
