import { ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useHistoricalWaiver, useSetHistoricalWaiver } from '@/api/historicalWaiver';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';

/**
 * Settings, historical load (contract 0.14.3, decision on owner question Q462). The one-time waiver that lets a System Admin accept the historical tasks of the
 * owner's Master without their documents. Closed by default. Only a System Admin opens it (never a delegate), with a cutoff date that is not in the future, a
 * reason and a step-up; it closes itself after 30 days, or by hand. Every change is audited.
 */
export function HistoricalWaiver() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useHistoricalWaiver();
  const set = useSetHistoricalWaiver();
  const [dialog, setDialog] = useState<'open' | 'close' | null>(null);
  const [cutoff, setCutoff] = useState('');
  const w = q.data;
  const errs = fieldErrors(set.error);
  const today = new Date().toISOString().slice(0, 10);
  const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(i18n.language === 'ar' ? 'ar' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const done = (msg: string) => ({ onSuccess: () => { toast(msg); setDialog(null); setCutoff(''); } });
  if (q.isError) return <section className="card p-4" data-testid="page-historical-waiver"><p role="alert" className="text-lateInk">{t('errors.generic')}</p></section>;
  if (!w) return <section className="card p-4" data-testid="page-historical-waiver">…</section>;

  return (
    <section className="card space-y-3 p-4" data-testid="page-historical-waiver" data-open={w.open ? 'true' : 'false'}>
      <h2 className="flex items-center gap-2 font-bold"><ShieldAlert size={18} aria-hidden />{t('hw.title')}</h2>
      <p className="text-sm text-mute">{t('hw.note')}</p>
      <ul className="list-disc space-y-1 ps-5 text-sm text-mute">
        <li>{t('hw.rule_scope')}</li>
        <li>{t('hw.rule_checks')}</li>
        <li>{t('hw.rule_flag')}</li>
        <li>{t('hw.rule_reverse')}</li>
        <li>{t('hw.rule_time')}</li>
      </ul>
      <div className={`rounded-md p-3 text-sm ${w.open ? 'bg-waitBg text-waitInk' : 'bg-card2'}`} data-testid="hw-state">
        <p className="font-semibold" data-testid="hw-status">{w.open ? t('hw.state_open') : t('hw.state_closed')}</p>
        {w.open ? (
          <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
            <dt>{t('hw.cutoff')}</dt><dd className="mono" data-testid="hw-cutoff">{w.cutoff_date}</dd>
            <dt>{t('hw.opened_at')}</dt><dd>{when(w.opened_at)}</dd>
            <dt>{t('hw.expires_at')}</dt><dd data-testid="hw-expires">{when(w.expires_at)} · {t('hw.days_left', { count: w.days_left ?? 0 })}</dd>
            {w.reason && <><dt>{t('common.reason')}</dt><dd data-testid="hw-reason">{w.reason}</dd></>}
          </dl>
        ) : w.closed_at ? (
          <p className="mt-1 text-mute" data-testid="hw-last-closed">{t(w.closed_how === 'expired' ? 'hw.closed_expired' : 'hw.closed_manual', { when: when(w.closed_at) })}</p>
        ) : null}
      </div>
      {w.can_manage ? (
        w.open
          ? <button className="btn btn-danger" data-testid="hw-close" onClick={() => { set.reset(); setDialog('close'); }}>{t('hw.close')}</button>
          : <button className="btn btn-accent" data-testid="hw-open" onClick={() => { set.reset(); setDialog('open'); }}>{t('hw.open')}</button>
      ) : <p className="text-sm text-mute" data-testid="hw-admin-only">{t('hw.admin_only')}</p>}
      {dialog === 'open' && (
        <FormDialog open onClose={() => setDialog(null)} testid="hw-open-dialog" title={t('hw.open_title')} busy={set.isPending} disabled={!cutoff}
          error={set.isError ? (errs['/cutoff_date'] ? t(`fieldError.${errs['/cutoff_date']}`) : errText(set.error, t)) : null}
          onSubmit={(reason) => set.mutate({ open: true, cutoff_date: cutoff, reason }, done(t('hw.opened_toast')))}>
          <p className="text-sm text-mute">{t('hw.open_hint')}</p>
          <label className="block text-sm font-semibold">{t('hw.cutoff_label')}
            <input type="date" className="input mt-1 font-normal" dir="ltr" data-testid="hw-cutoff-input" max={today} value={cutoff} onChange={(e) => setCutoff(e.target.value)} />
          </label>
        </FormDialog>
      )}
      {dialog === 'close' && (
        <FormDialog open onClose={() => setDialog(null)} testid="hw-close-dialog" title={t('hw.close_title')} busy={set.isPending} error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ open: false, reason }, done(t('hw.closed_toast')))}>
          <p className="text-sm text-mute">{t('hw.close_hint')}</p>
        </FormDialog>
      )}
    </section>
  );
}
