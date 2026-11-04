import { CalendarRange, Check, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAddDelayPeriod, useDecideDelayPeriod, useDelayPeriods, useVoidDelayPeriod, type DelayParty, type DelayPeriod } from '@/api/dashboard';
import { errText } from './FormDialog';
import { ErrorState, LoadingSkeleton } from './States';
import { useToast } from './Toast';

const STATUS_TONE: Record<string, string> = { proposed: 'bg-waitBg text-waitInk', approved: 'bg-doneBg text-doneInk', rejected: 'bg-lateBg text-lateInk' };
const NEEDS_PARTY: DelayParty[] = ['contractor', 'external'];

/** The decision of one proposal (Q182, Q184): approve (naming the external party when the proposal has none) or reject with a note. */
function Decide({ taskId, p, parties }: { taskId: string; p: DelayPeriod; parties: { id: string; name: string }[] }) {
  const { t } = useTranslation();
  const toast = useToast();
  const decide = useDecideDelayPeriod(taskId);
  const [note, setNote] = useState('');
  const [ext, setExt] = useState('');
  const needsParty = NEEDS_PARTY.includes(p.party) && !p.external_party_id;
  const go = (decision: 'approve' | 'reject') => decide.mutate({ id: p.id, decision, note: note.trim() || null, external_party_id: ext || null }, {
    onSuccess: () => toast(t(decision === 'approve' ? 'delayp.approved_done' : 'delayp.rejected_done')),
  });
  return (
    <div className="mt-2 grid gap-2 rounded-md border border-line bg-card2 p-2 sm:grid-cols-2" data-testid={`delayp-decide-${p.id}`}>
      {needsParty && (
        <label className="sm:col-span-2">{t('delayp.external_party')}
          <select className="input" data-testid="delayp-decide-party" value={ext} onChange={(e) => setExt(e.target.value)}>
            <option value="" />
            {parties.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
          <span className="text-xs text-mute">{t('delayp.external_required')}</span>
        </label>
      )}
      <label className="sm:col-span-2">{t('delayp.note')}<input className="input" data-testid="delayp-decide-note" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} /></label>
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <button type="button" className="btn btn-primary" data-testid="delayp-approve" disabled={decide.isPending || (needsParty && !ext)} onClick={() => go('approve')}><Check size={14} />{t('delayp.approve')}</button>
        <button type="button" className="btn btn-danger" data-testid="delayp-reject" disabled={decide.isPending || note.trim().length < 3} title={t('delayp.note_required')} onClick={() => go('reject')}><X size={14} />{t('delayp.reject')}</button>
      </div>
      {decide.isError && <p role="alert" className="text-sm text-lateInk sm:col-span-2" data-testid="delayp-decide-error">{errText(decide.error, t)}</p>}
    </div>
  );
}

/**
 * Delay attribution periods of a task (owner answers Q122, Q182, Q184), in the task drawer. L1 or L2 proposes a period (from, to, the party, a reason,
 * optional evidence); it has no effect until L2, a System Admin or the delegate approves it, never the proposer. The server decides who may
 * (`can_propose`, `can_decide`); a period is voided with a reason, never deleted.
 */
export function DelayPeriodsPanel({ taskId }: { taskId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useDelayPeriods(taskId);
  const add = useAddDelayPeriod(taskId);
  const voidP = useVoidDelayPeriod(taskId);
  const [form, setForm] = useState<{ from_date: string; to_date: string; party: DelayParty | ''; reason: string; evidence: string }>({ from_date: '', to_date: '', party: '', reason: '', evidence: '' });
  const [voiding, setVoiding] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');
  if (q.isLoading) return <LoadingSkeleton rows={3} testid="delayp-loading" />;
  if (q.isError || !q.data) return <ErrorState onRetry={() => void q.refetch()} message={q.isError ? errText(q.error, t) : undefined} testid="delayp-error" />;
  const d = q.data;
  const canPropose = d.can_propose ?? d.can_edit;
  const canDecide = d.can_decide ?? d.can_edit;
  const ok = !!form.from_date && !!form.to_date && form.from_date <= form.to_date && !!form.party && form.reason.trim().length >= 3;
  const submit = () => {
    if (!ok || !form.party) return;
    add.mutate({ from_date: form.from_date, to_date: form.to_date, party: form.party, reason: form.reason.trim(), evidence: form.evidence.trim() || null }, {
      onSuccess: () => { toast(t('delayp.added')); setForm({ from_date: '', to_date: '', party: '', reason: '', evidence: '' }); },
    });
  };
  const doVoid = (id: string) => voidP.mutate({ id, reason: voidReason.trim() }, {
    onSuccess: () => { toast(t('delayp.voided_done')); setVoiding(null); setVoidReason(''); },
  });
  const mine = (p: DelayPeriod) => !!d.me && p.created_by.id === d.me;

  return (
    <section aria-labelledby="dr-delayp" data-testid="delay-periods">
      <h3 id="dr-delayp" className="mb-1 flex items-center gap-1 font-semibold"><CalendarRange size={14} aria-hidden />{t('delayp.title')}</h3>
      <p className="mb-2 text-sm text-mute">{t('delayp.hint')}</p>
      <p className="mb-2 text-sm" data-testid="delayp-due">{d.due_date ? t('delayp.due', { date: d.due_date }) : t('delayp.no_due')}</p>
      {d.items.length === 0 ? <p className="text-sm text-mute" data-testid="delayp-none">{t('delayp.none')}</p> : (
        <ul className="space-y-2 text-sm" data-testid="delayp-list">
          {d.items.map((p) => {
            const status = p.status ?? 'approved';
            const canVoid = !p.voided && status !== 'rejected' && (canDecide || (status === 'proposed' && mine(p)));
            return (
              <li key={p.id} className={`rounded-md border border-line p-2 ${p.voided || status === 'rejected' ? 'opacity-70' : ''}`} data-testid={`delayp-${p.id}`} data-voided={p.voided} data-status={status}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mono">{p.from_date} → {p.to_date}</span>
                  <span className="chip bg-openBg text-openInk">{p.external_party_name ?? t(`delayp.parties.${p.party}`)}</span>
                  {!p.voided && <span className={`chip ${STATUS_TONE[status]}`} data-testid={`delayp-status-${p.id}`}>{t(`delayp.status.${status}`)}</span>}
                  {p.voided && <span className="chip bg-lockBg text-lockInk">{t('delayp.voided')}</span>}
                  {canVoid && voiding !== p.id && <button className="btn ms-auto px-2 py-1 text-xs" data-testid={`delayp-void-${p.id}`} onClick={() => { setVoiding(p.id); setVoidReason(''); }}>{t('delayp.void')}</button>}
                </div>
                <div className="text-mute">{p.reason} · {t('delayp.proposed_by', { name: p.created_by.display_name })}{p.decided_by && <> · {t('delayp.decided_by', { name: p.decided_by.display_name })}</>}</div>
                {p.evidence && <div className="text-mute">{t('delayp.evidence')}: {p.evidence}</div>}
                {p.decision_note && <div className="text-mute">{t('delayp.note')}: {p.decision_note}</div>}
                {status === 'approved' && !p.voided && p.counts === false && <div className="text-waitInk" data-testid={`delayp-not-counting-${p.id}`}>{t('delayp.not_counting')}</div>}
                {p.voided && p.void_reason && <div className="text-mute">{t('delayp.void_reason')}: {p.void_reason}</div>}
                {status === 'proposed' && !p.voided && canDecide && (mine(p) ? <p className="mt-1 text-xs text-mute" data-testid={`delayp-own-${p.id}`}>{t('delayp.own')}</p>
                  : <Decide taskId={taskId} p={p} parties={d.external_parties ?? []} />)}
                {voiding === p.id && (
                  <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (voidReason.trim().length >= 3) doVoid(p.id); }}>
                    <label className="min-w-0 flex-1">{t('delayp.void_reason')}
                      <input className="input" data-testid="delayp-void-reason" value={voidReason} minLength={3} onChange={(e) => setVoidReason(e.target.value)} required />
                    </label>
                    <button type="submit" className="btn btn-danger" data-testid="delayp-void-confirm" disabled={voidReason.trim().length < 3 || voidP.isPending}>{t('delayp.void_confirm')}</button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {voidP.isError && <p role="alert" className="mt-1 text-sm text-lateInk">{errText(voidP.error, t)}</p>}
      {canPropose ? (
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
          <label className="col-span-2">{t('delayp.evidence')}<input className="input" data-testid="delayp-evidence" value={form.evidence} maxLength={2000} onChange={(e) => setForm((f) => ({ ...f, evidence: e.target.value }))} /></label>
          <div className="col-span-2"><button type="submit" className="btn btn-primary" data-testid="delayp-add" disabled={!ok || add.isPending}><Plus size={16} />{t('delayp.add')}</button></div>
          {add.isError && <p role="alert" className="col-span-2 text-lateInk" data-testid="delayp-add-error">{errText(add.error, t)}</p>}
        </form>
      ) : <p className="mt-2 text-sm text-mute" data-testid="delayp-readonly">{t('delayp.readonly')}</p>}
    </section>
  );
}
