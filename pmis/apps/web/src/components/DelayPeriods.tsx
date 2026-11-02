import { CalendarRange, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAddDelayPeriod, useDelayPeriods, useVoidDelayPeriod, type DelayParty } from '@/api/dashboard';
import { errText } from './FormDialog';
import { ErrorState, LoadingSkeleton } from './States';
import { useToast } from './Toast';

/**
 * Delay attribution periods of a task (owner answer Q122), in the task drawer: from, to, the responsible party and a reason. The reviewer of the
 * task records them (the server decides who may: `can_edit`); a period is voided with a reason, never deleted.
 */
export function DelayPeriodsPanel({ taskId }: { taskId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useDelayPeriods(taskId);
  const add = useAddDelayPeriod(taskId);
  const voidP = useVoidDelayPeriod(taskId);
  const [form, setForm] = useState<{ from_date: string; to_date: string; party: DelayParty | ''; reason: string }>({ from_date: '', to_date: '', party: '', reason: '' });
  const [voiding, setVoiding] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');
  if (q.isLoading) return <LoadingSkeleton rows={3} testid="delayp-loading" />;
  if (q.isError || !q.data) return <ErrorState onRetry={() => void q.refetch()} message={q.isError ? errText(q.error, t) : undefined} testid="delayp-error" />;
  const d = q.data;
  const ok = !!form.from_date && !!form.to_date && form.from_date <= form.to_date && !!form.party && form.reason.trim().length >= 3;
  const submit = () => {
    if (!ok || !form.party) return;
    add.mutate({ from_date: form.from_date, to_date: form.to_date, party: form.party, reason: form.reason.trim() }, {
      onSuccess: () => { toast(t('delayp.added')); setForm({ from_date: '', to_date: '', party: '', reason: '' }); },
    });
  };
  const doVoid = (id: string) => voidP.mutate({ id, reason: voidReason.trim() }, {
    onSuccess: () => { toast(t('delayp.voided_done')); setVoiding(null); setVoidReason(''); },
  });

  return (
    <section aria-labelledby="dr-delayp" data-testid="delay-periods">
      <h3 id="dr-delayp" className="mb-1 flex items-center gap-1 font-semibold"><CalendarRange size={14} aria-hidden />{t('delayp.title')}</h3>
      <p className="mb-2 text-sm text-mute">{t('delayp.hint')}</p>
      <p className="mb-2 text-sm" data-testid="delayp-due">{d.due_date ? t('delayp.due', { date: d.due_date }) : t('delayp.no_due')}</p>
      {d.items.length === 0 ? <p className="text-sm text-mute" data-testid="delayp-none">{t('delayp.none')}</p> : (
        <ul className="space-y-2 text-sm" data-testid="delayp-list">
          {d.items.map((p) => (
            <li key={p.id} className={`rounded-md border border-line p-2 ${p.voided ? 'opacity-70' : ''}`} data-testid={`delayp-${p.id}`} data-voided={p.voided}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="mono">{p.from_date} → {p.to_date}</span>
                <span className="chip bg-openBg text-openInk">{p.external_party_name ?? t(`delayp.parties.${p.party}`)}</span>
                {p.voided && <span className="chip bg-lockBg text-lockInk">{t('delayp.voided')}</span>}
                {d.can_edit && !p.voided && voiding !== p.id && <button className="btn ms-auto px-2 py-1 text-xs" data-testid={`delayp-void-${p.id}`} onClick={() => { setVoiding(p.id); setVoidReason(''); }}>{t('delayp.void')}</button>}
              </div>
              <div className="text-mute">{p.reason} · {t('delayp.by', { name: p.created_by.display_name })}</div>
              {p.voided && p.void_reason && <div className="text-mute">{t('delayp.void_reason')}: {p.void_reason}</div>}
              {voiding === p.id && (
                <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (voidReason.trim().length >= 3) doVoid(p.id); }}>
                  <label className="min-w-0 flex-1">{t('delayp.void_reason')}
                    <input className="input" data-testid="delayp-void-reason" value={voidReason} minLength={3} onChange={(e) => setVoidReason(e.target.value)} required />
                  </label>
                  <button type="submit" className="btn btn-danger" data-testid="delayp-void-confirm" disabled={voidReason.trim().length < 3 || voidP.isPending}>{t('delayp.void_confirm')}</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {voidP.isError && <p role="alert" className="mt-1 text-sm text-lateInk">{errText(voidP.error, t)}</p>}
      {d.can_edit ? (
        <form className="mt-3 grid grid-cols-2 gap-2 text-sm" data-testid="delayp-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <label>{t('delayp.from')}<input type="date" className="input mono" data-testid="delayp-from" value={form.from_date} onChange={(e) => setForm((f) => ({ ...f, from_date: e.target.value }))} required /></label>
          <label>{t('delayp.to')}<input type="date" className="input mono" data-testid="delayp-to" min={form.from_date || undefined} value={form.to_date} onChange={(e) => setForm((f) => ({ ...f, to_date: e.target.value }))} required /></label>
          <label className="col-span-2">{t('delayp.party')}
            <select className="input" data-testid="delayp-party" value={form.party} onChange={(e) => setForm((f) => ({ ...f, party: e.target.value as DelayParty }))} required>
              <option value="" />
              {d.parties.map((p) => <option key={p} value={p}>{t(`delayp.parties.${p}`)}</option>)}
            </select>
          </label>
          <label className="col-span-2">{t('delayp.reason')}<input className="input" data-testid="delayp-reason" value={form.reason} minLength={3} maxLength={1000} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} required /></label>
          <div className="col-span-2"><button type="submit" className="btn btn-primary" data-testid="delayp-add" disabled={!ok || add.isPending}><Plus size={16} />{t('delayp.add')}</button></div>
          {add.isError && <p role="alert" className="col-span-2 text-lateInk" data-testid="delayp-add-error">{errText(add.error, t)}</p>}
        </form>
      ) : <p className="mt-2 text-sm text-mute" data-testid="delayp-readonly">{t('delayp.readonly')}</p>}
    </section>
  );
}
