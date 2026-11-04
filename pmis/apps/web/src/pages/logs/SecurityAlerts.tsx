import { Check } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/api/hooks';
import { useAckAlert, useAlerts, type SecurityAlert } from '@/api/logs';
import { errText, FormDialog } from '@/components/FormDialog';
import { stamp } from '@/components/logs/bits';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/States';
import { QuickFilter } from '@/components/TableKit';
import { useToast } from '@/components/Toast';
import { AlertRules } from './AlertRules';

const SEV = { info: 'bg-card2 text-mute', low: 'bg-card2', medium: 'bg-waitBg text-waitInk', high: 'bg-lateBg text-lateInk', critical: 'bg-lateBg text-lateInk font-bold' } as const;

export function SecurityAlerts() {
  const { t } = useTranslation();
  const toast = useToast();
  const me = useMe(true);
  const [status, setStatus] = useState('open');
  const q = useAlerts(status), ack = useAckAlert();
  const [target, setTarget] = useState<SecurityAlert | null>(null);
  if (q.isError) return <ErrorState onRetry={() => void q.refetch()} />;
  return (
    <div data-testid="page-security-alerts" className="space-y-3">
      <PageHeader title={t('nav.logs.alerts')} subtitle={t('logs.alerts_subtitle')} />
      <AlertRules />
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('logs.a_status')}>
        {['open', 'acknowledged', ''].map((s) => <QuickFilter key={s} on={status === s} onClick={() => setStatus(s)} testid={`alerts-filter-${s || 'all'}`}>{t(`logs.a_${s || 'all'}`)}</QuickFilter>)}
      </div>
      {q.isLoading ? <LoadingSkeleton /> : (
        <ul className="space-y-2" data-testid="alerts-list">
          {q.items.map((a) => (
            <li key={a.id} data-testid={`alert-${a.id}`} data-status={a.status} className="card space-y-1 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`chip ${SEV[a.severity]}`}>{t(`logs.sev_${a.severity}`)}</span>
                <span className="mono text-xs" dir="ltr">{a.rule}</span>
                <span className="mono text-xs text-mute" dir="ltr">{stamp(a.at)}</span>
                <span className={`chip ms-auto ${a.status === 'open' ? 'bg-lateBg text-lateInk' : 'bg-doneBg text-doneInk'}`} data-testid={`alert-status-${a.id}`}>{t(`logs.a_${a.status}`)}</span>
              </div>
              <p className="font-semibold" dir="auto">{a.summary}</p>
              {a.detail && <p className="text-mute" dir="auto">{a.detail}</p>}
              {a.status === 'acknowledged'
                ? <p className="text-xs text-mute">{t('logs.a_ack_by', { name: a.ack_by ?? '—', at: stamp(a.ack_at) })}</p>
                : <button className="btn" data-testid={`alert-ack-${a.id}`} onClick={() => setTarget(a)}><Check size={14} />{t('logs.a_ack')}</button>}
            </li>))}
        </ul>
      )}
      {q.isSuccess && !q.items.length && <EmptyState title={t('logs.a_none')} testid="alerts-empty" />}
      {q.hasNextPage && <div className="text-center"><button className="btn" data-testid="alerts-more" onClick={() => void q.fetchNextPage()}>{t('logs.load_more')}</button></div>}
      {target && (
        <FormDialog open onClose={() => setTarget(null)} testid="ack-dialog" title={t('logs.a_ack')} busy={ack.isPending} error={ack.isError ? errText(ack.error, t) : null}
          submitLabel={t('logs.a_ack')} onSubmit={(note) => ack.mutate({ alert: target, note, by: me.data?.user.display_name ?? '' }, { onSuccess: () => { toast(t('logs.a_acked')); setTarget(null); } })}>
          <p className="text-sm" dir="auto">{target.summary}</p>
          <p className="text-xs text-mute">{t('logs.a_note_hint')}</p>
        </FormDialog>
      )}
    </div>
  );
}
