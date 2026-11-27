import { Lock, LockOpen } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFreeze, useLiftFreeze, useSetFreeze } from '@/api/settings';
import { fieldErrors } from '@/lib/fields';
import { errText, FormDialog } from './FormDialog';
import { useToast } from './Toast';
import { DateInput } from '@/components/DateInput';

export const FREEZE_CONFIRM = 'structural-freeze';
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Whether the structural freeze is on: the editor disables its structural actions and says why (decision B9, contract 0.15.16). */
export function useFrozen(): { frozen: boolean; until: string | null } {
  const f = useFreeze().data;
  return { frozen: f?.active === true, until: f?.ends_on ?? null };
}

/**
 * The structural freeze (B9) as one component, shared by Settings > Rules and the workflow editor: its status, "Lock" (PUT /settings/structural-freeze: a window, a reason,
 * a step-up; after a lift it locks again) and "Unlock" (POST .../lift: a System Admin, the typed confirmation `structural-freeze`, a reason, a step-up). The server decides who may.
 */
export function FreezeCard({ compact, canLock = true }: { compact?: boolean; canLock?: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useFreeze(), lift = useLiftFreeze(), lock = useSetFreeze();
  const [dlg, setDlg] = useState<null | 'lock' | 'lift'>(null);
  const [typed, setTyped] = useState('');
  const [from, setFrom] = useState(() => iso(new Date()));
  const [to, setTo] = useState(() => iso(new Date(new Date().getTime() + 30 * 86400000)));
  const f = q.data;
  const liftErrs = fieldErrors(lift.error);
  const lockErrs = fieldErrors(lock.error);
  const canLift = !!f && !!f.starts_on && !f.lifted;
  const status = f?.lifted ? t('rules.freeze_lifted') : f?.active ? t('rules.freeze_active') : t('rules.freeze_inactive');
  return (
    <section className={compact ? 'space-y-2' : 'card space-y-3 p-4'} data-testid="page-freeze" data-active={f?.active ? 'true' : 'false'}>
      {compact
        ? <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">{f?.active ? <Lock size={16} aria-hidden /> : <LockOpen size={16} aria-hidden />}{t('rules.freeze')}<span className={`chip ${f?.active ? 'bg-lockBg text-lockInk' : 'bg-waitBg text-waitInk'}`} data-testid="freeze-chip">{f?.active ? t('wfe.lock.on') : t('wfe.lock.off')}</span></p>
        : <h2 className="flex items-center gap-2 font-bold">{f?.active ? <Lock size={16} aria-hidden /> : <LockOpen size={16} aria-hidden />}{t('rules.freeze')}</h2>}
      <p data-testid="freeze-status" className="text-sm">{status}</p>
      {f?.starts_on && <p className="mono text-xs text-mute">{f.starts_on} → {f.ends_on}</p>}
      {f?.lifted && <p className="text-sm text-mute">{t('rules.lift_reason', { reason: f.lift_reason })}</p>}
      {!compact && <p className="text-xs text-mute">{t('rules.freeze_note')}</p>}
      <div className="flex flex-wrap gap-2">
        {f && canLock && !f.active && <button className="btn btn-accent" data-testid="freeze-lock" onClick={() => { lock.reset(); setDlg('lock'); }}><Lock size={14} aria-hidden /> {t(f.lifted ? 'wfe.lock.relock' : 'wfe.lock.lock')}</button>}
        {canLift && <button className="btn btn-accent" data-testid="freeze-lift" onClick={() => { lift.reset(); setTyped(''); setDlg('lift'); }}><LockOpen size={14} aria-hidden /> {t('rules.lift')}</button>}
      </div>
      {dlg === 'lift' && f && (
        <FormDialog open onClose={() => setDlg(null)} testid="freeze-dialog" title={t('rules.lift')} disabled={typed !== FREEZE_CONFIRM} busy={lift.isPending} error={lift.isError && !liftErrs['/confirm_text'] ? errText(lift.error, t) : null}
          onSubmit={(reason) => lift.mutate({ version: f.version, reason, confirm_text: typed }, { onSuccess: () => { toast(t('settings.audited')); setDlg(null); } })}>
          <label className="block text-sm font-semibold">{t('rules.type_to_confirm', { text: FREEZE_CONFIRM })}
            <input className="input mono mt-1 font-normal" dir="ltr" data-testid="freeze-confirm" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
          {liftErrs['/confirm_text'] && <p role="alert" className="text-sm text-lateInk">{t('errors.confirmation_mismatch')}</p>}
        </FormDialog>
      )}
      {dlg === 'lock' && f && (
        <FormDialog open onClose={() => setDlg(null)} testid="freeze-lock-dialog" title={t('wfe.lock.lock_title')} disabled={!from || !to || to < from} busy={lock.isPending} error={lock.isError ? errText(lock.error, t) : null}
          onSubmit={(reason) => lock.mutate({ version: f.version, starts_on: from, ends_on: to, reason }, { onSuccess: () => { toast(t('settings.audited')); setDlg(null); } })}>
          <p className="text-sm text-mute">{t('wfe.lock.lock_hint')}</p>
          <div className="flex flex-wrap gap-3">
            <label className="text-sm font-semibold">{t('wfe.lock.from')}<DateInput className="input mt-1 font-normal" dir="ltr" data-testid="freeze-from" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="text-sm font-semibold">{t('wfe.lock.to')}<DateInput className="input mt-1 font-normal" dir="ltr" data-testid="freeze-to" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          </div>
          {lockErrs['/ends_on'] && <p role="alert" className="text-sm text-lateInk">{t('wfe.lock.window_invalid')}</p>}
        </FormDialog>
      )}
    </section>
  );
}
