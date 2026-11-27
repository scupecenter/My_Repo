import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { useAskLeave, useUnsavedGuard, type GuardSource } from '@/lib/unsavedGuard';
import { InlinePanel } from './InlinePanel';

/** Message for a failed call: a specific text for known problem codes, else the generic one. */
export function errText(e: unknown, t: (k: string) => string) {
  if (!(e instanceof ApiError)) return t('errors.generic');
  // A field-level code (too_many_rows, not_supported) is more telling than the generic validation_failed.
  const keys = [`errors.${e.code}`, ...(e.problem.errors ?? []).map((x) => `errors.${x.code}`)];
  const first = e.code === 'validation_failed' ? [...keys.slice(1), keys[0]] : keys;
  for (const k of first) { const s = t(k); if (s !== k) return s; }
  return e.status === 403 ? t('errors.forbidden') : t('errors.generic');
}

/** Dialog with an optional mandatory reason (min 3 characters, as the contract says). `onSubmit` gets the trimmed reason. */
export function FormDialog({ open, onClose, title, testid, children, onSubmit, submitLabel, busy, error, disabled, withReason = true, wide, inline }: {
  open: boolean; onClose: () => void; title: string; testid: string; children?: ReactNode; onSubmit: (reason: string) => void; submitLabel?: string; busy?: boolean; error?: string | null; disabled?: boolean; withReason?: boolean; wide?: boolean; /** Settings, edit in place: render the form in the page (InlinePanel), not as a modal; same testids, same reason rule. */ inline?: boolean;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const short = withReason && reason.trim().length < 3;
  // Decision 11: typed input in the dialog (any field, or the reason) is guarded; closing it by Cancel, Esc or a click outside asks first
  const [typed, setTyped] = useState(false);
  const [sent, setSent] = useState(false); // Save was pressed: what follows (a close, a navigation) is the save itself, so it is not asked about, unless the save failed
  const src: GuardSource = { scope: 'dialogs', dirty: typed && open && (!sent || !!error), label: title, onSave: () => { if (short || disabled || busy) { setTouched(true); return false; } src.dirty = false; setSent(true); onSubmit(reason.trim()); return 'stay'; } };
  useUnsavedGuard(src);
  const ask = useAskLeave(src);
  const reset = () => { setReason(''); setTouched(false); setTyped(false); setSent(false); };
  useEffect(() => { if (!open) { setReason(''); setTouched(false); setTyped(false); setSent(false); } }, [open]);
  const close = () => ask(() => { reset(); onClose(); });
  if (inline) return open ? <InlinePanel onClose={onClose} title={title} testid={testid} onSubmit={onSubmit} submitLabel={submitLabel} busy={busy} error={error} disabled={disabled} withReason={withReason}>{children}</InlinePanel> : null;
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="motion-overlay fixed inset-0 z-[70] bg-scrim/60" />
        <Dialog.Content data-testid={testid} onInput={() => { setTyped(true); setSent(false); }} className={`motion-panel card fixed inset-x-0 top-[6vh] z-[70] mx-auto max-h-[88vh] space-y-3 overflow-y-auto p-5 ${wide ? 'w-[min(720px,94vw)]' : 'w-[min(480px,94vw)]'}`}>
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
            <button className="btn" onClick={close}>{t('common.cancel')}</button>
            <button className="btn btn-accent" data-testid={`${testid}-submit`} disabled={busy || disabled} onClick={() => { if (short) setTouched(true); else { src.dirty = false; setSent(true); onSubmit(reason.trim()); } }}>{submitLabel ?? t('common.save')}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
