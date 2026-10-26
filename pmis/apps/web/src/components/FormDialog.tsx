import * as Dialog from '@radix-ui/react-dialog';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';

/** Message for a failed call: a specific text for known problem codes, else the generic one. */
export function errText(e: unknown, t: (k: string) => string) {
  if (!(e instanceof ApiError)) return t('errors.generic');
  const k = `errors.${e.code}`;
  const s = t(k);
  return s === k ? (e.status === 403 ? t('errors.forbidden') : t('errors.generic')) : s;
}

/** Dialog with an optional mandatory reason (min 3 characters, as the contract says). `onSubmit` gets the trimmed reason. */
export function FormDialog({ open, onClose, title, testid, children, onSubmit, submitLabel, busy, error, disabled, withReason = true, wide }: {
  open: boolean; onClose: () => void; title: string; testid: string; children?: ReactNode; onSubmit: (reason: string) => void; submitLabel?: string; busy?: boolean; error?: string | null; disabled?: boolean; withReason?: boolean; wide?: boolean;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const short = withReason && reason.trim().length < 3;
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) { setReason(''); setTouched(false); onClose(); } }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-scrim/60" />
        <Dialog.Content data-testid={testid} className={`card fixed inset-x-0 top-[6vh] z-[70] mx-auto max-h-[88vh] space-y-3 overflow-y-auto p-5 ${wide ? 'w-[min(720px,94vw)]' : 'w-[min(480px,94vw)]'}`}>
          <Dialog.Title className="text-lg font-bold">{title}</Dialog.Title>
          <Dialog.Description className="sr-only">{title}</Dialog.Description>
          {children}
          {withReason && (
            <div>
              <label htmlFor={`${testid}-reason`} className="text-sm font-semibold">{t('common.reason')}</label>
              <textarea id={`${testid}-reason`} data-testid={`${testid}-reason`} className="input mt-1 min-h-16" value={reason} onChange={(e) => setReason(e.target.value)} onBlur={() => setTouched(true)} />
              {touched && short && <p role="alert" data-testid={`${testid}-reason-error`} className="mt-1 text-sm text-lateInk">{t('common.reason_required')}</p>}
            </div>
          )}
          {error && <p role="alert" data-testid={`${testid}-error`} className="text-lateInk">{error}</p>}
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
            <button className="btn btn-accent" data-testid={`${testid}-submit`} disabled={busy || disabled} onClick={() => (short ? setTouched(true) : onSubmit(reason.trim()))}>{submitLabel ?? t('common.save')}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
