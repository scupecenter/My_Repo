import { RotateCcw, Send } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMailOutbox, useMailStatus, useRetryMail, useSendTestMail, type MailOutboxItem, type MailStatus } from '@/api/logs';
import { errText, FormDialog } from '@/components/FormDialog';
import { stamp } from '@/components/logs/bits';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/States';
import { QuickFilter } from '@/components/TableKit';
import { useToast } from '@/components/Toast';

const STATE_TONE: Record<MailStatus['state'], string> = {
  disabled: 'bg-lockBg text-lockInk', unverified: 'bg-waitBg text-waitInk', verified: 'bg-doneBg text-doneInk', failing: 'bg-lateBg text-lateInk',
};
const ROW_TONE: Record<string, string> = {
  sent: 'bg-doneBg text-doneInk', dead: 'bg-lateBg text-lateInk', retrying: 'bg-waitBg text-waitInk', queued: 'bg-openBg text-openInk', sending: 'bg-openBg text-openInk',
  logged: 'bg-card2', suppressed: 'bg-lockBg text-lockInk',
};
const FILTERS = ['', 'queued', 'retrying', 'sent', 'dead', 'logged', 'suppressed'] as const;
const COUNTS = ['queued', 'retrying', 'dead_24h', 'sent_24h', 'logged_24h', 'suppressed_24h'] as const;

/**
 * Mail delivery (owner answer Q167, contract 0.12.3): the state of the channel, a test mail, and the outbox. The SMTP settings live in the server's
 * env file; the screen shows them without the password. The channel is called working only after a test mail went out with these settings.
 */
export function MailDelivery() {
  const { t } = useTranslation();
  const toast = useToast();
  const st = useMailStatus();
  const [filter, setFilter] = useState<string>('');
  const box = useMailOutbox(filter);
  const test = useSendTestMail(), retry = useRetryMail();
  const [target, setTarget] = useState<MailOutboxItem | null>(null);
  if (st.isError) return <ErrorState onRetry={() => void st.refetch()} />;
  const s = st.data;
  return (
    <div data-testid="page-mail" className="space-y-3">
      <PageHeader title={t('nav.logs.mail')} subtitle={t('mail.subtitle')} />
      {!s ? <LoadingSkeleton /> : (
        <section className="card space-y-2 p-4" aria-labelledby="mail-state-h" data-testid="mail-status">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="mail-state-h" className="font-bold">{t('mail.channel')}</h2>
            <span className={`chip ${STATE_TONE[s.state]}`} data-testid="mail-state" data-state={s.state}>{t(`mail.state_${s.state}`)}</span>
            <button className="btn btn-accent ms-auto" data-testid="mail-test" disabled={!s.enabled || test.isPending}
              onClick={() => test.mutate(undefined, {
                onSuccess: (r) => toast(r.outcome === 'sent' ? t('mail.test_sent', { to: r.to }) : t('mail.test_failed')),
              })}><Send size={14} />{t('mail.test')}</button>
          </div>
          <p className="text-sm text-mute" data-testid="mail-state-hint">{t(`mail.hint_${s.state}`)}</p>
          {test.isError && <p role="alert" className="text-sm text-lateInk" data-testid="mail-test-error">{errText(test.error, t)}</p>}
          {test.data?.outcome === 'failed' && <p role="alert" className="text-sm text-lateInk" data-testid="mail-test-failed" dir="ltr">{test.data.error}</p>}
          {s.settings && (
            <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]" data-testid="mail-settings">
              <dt className="text-mute">{t('mail.server')}</dt><dd className="mono" dir="ltr">{s.settings.host}:{s.settings.port} · {s.settings.tls}</dd>
              <dt className="text-mute">{t('mail.from')}</dt><dd className="mono" dir="ltr">{s.settings.from}</dd>
              <dt className="text-mute">{t('mail.auth')}</dt><dd>{s.settings.auth ? t('mail.auth_yes') : t('mail.auth_no')}</dd>
              <dt className="text-mute">{t('mail.verified_at')}</dt><dd className="mono" dir="ltr" data-testid="mail-verified-at">{s.verified_at ? stamp(s.verified_at) : '—'}</dd>
            </dl>
          )}
          <ul className="flex flex-wrap gap-3 text-sm" data-testid="mail-counts">
            {COUNTS.map((k) => <li key={k}><span className="text-mute">{t(`mail.c_${k}`)}</span> <b data-testid={`mail-count-${k}`}>{s.counts[k] ?? 0}</b></li>)}
          </ul>
          {s.last_error && <p className="text-xs text-lateInk" dir="ltr" data-testid="mail-last-error">{s.last_error}</p>}
        </section>
      )}
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('mail.filter')}>
        {FILTERS.map((f) => <QuickFilter key={f} on={filter === f} onClick={() => setFilter(f)} testid={`mail-filter-${f || 'all'}`}>{t(`mail.s_${f || 'all'}`)}</QuickFilter>)}
      </div>
      {box.isError ? <ErrorState onRetry={() => void box.refetch()} /> : box.isLoading ? <LoadingSkeleton /> : (
        <div className="card overflow-x-auto"><table className="w-full text-sm">
          <thead className="border-b border-line bg-card2 text-mute"><tr>{['at', 'kind', 'to', 'subject', 'status', 'attempts', 'error', ''].map((k) => <th key={k} className="p-2 text-start">{k ? t(`mail.h_${k}`) : ''}</th>)}</tr></thead>
          <tbody data-testid="mail-outbox">
            {box.items.map((m) => (
              <tr key={m.id} className="border-b border-line" data-testid={`mail-row-${m.id}`}>
                <td className="mono p-2 text-xs" dir="ltr">{stamp(m.created_at)}</td>
                <td className="mono p-2 text-xs" dir="ltr">{m.kind}</td>
                <td className="mono p-2 text-xs" dir="ltr">{m.to}</td>
                <td className="p-2" dir="auto">{m.sensitive ? <span className="text-mute">{t('mail.hidden')}</span> : m.subject}</td>
                <td className="p-2"><span className={`chip ${ROW_TONE[m.status] ?? 'bg-card2'}`} data-testid={`mail-status-${m.id}`}>{t(`mail.s_${m.status}`)}</span></td>
                <td className="mono p-2 text-xs">{m.attempts}</td>
                <td className="p-2 text-xs text-lateInk" dir="ltr">{m.last_error ?? ''}</td>
                <td className="p-2 text-end">{m.status === 'dead' && <button className="btn" data-testid={`mail-retry-${m.id}`} onClick={() => setTarget(m)}><RotateCcw size={14} />{t('mail.retry')}</button>}</td>
              </tr>))}
          </tbody>
        </table>{!box.items.length && <EmptyState title={t('logs.empty')} testid="mail-empty" />}</div>
      )}
      {box.hasNextPage && <div className="text-center"><button className="btn" data-testid="mail-more" onClick={() => void box.fetchNextPage()}>{t('logs.load_more')}</button></div>}
      {target && (
        <FormDialog open onClose={() => setTarget(null)} testid="mail-retry-dialog" title={t('mail.retry')} busy={retry.isPending} error={retry.isError ? errText(retry.error, t) : null}
          submitLabel={t('mail.retry')} onSubmit={(reason) => retry.mutate({ id: target.id, reason }, { onSuccess: () => { toast(t('mail.retried')); setTarget(null); } })}>
          <p className="mono text-sm" dir="ltr">{target.to}</p>
        </FormDialog>
      )}
    </div>
  );
}
