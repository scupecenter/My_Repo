import * as Dialog from '@radix-ui/react-dialog';
import { Check, Copy, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fmtDateTime } from '@/lib/time';

/**
 * The one-time two-factor enrolment code, shown once to the admin who turned two-factor on, reset it or issued a new code (contract 0.6.0).
 * The admin hands it to the user in person or by phone; the user cannot enrol without it. It closes only with the button, so a stray click
 * cannot lose a code that is never shown again.
 */
export function EnrolCodeDialog({ code, expiresAt, name, onClose }: { code: string; expiresAt: string; name: string; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setFailed(false); }
    catch { setFailed(true); }
  };
  return (
    <Dialog.Root open onOpenChange={() => { /* closed only by the button */ }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-scrim/60" />
        <Dialog.Content data-testid="enrol-code-dialog" className="card fixed inset-x-0 top-[10vh] z-[80] mx-auto w-[min(480px,94vw)] space-y-3 p-5"
          onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
          <Dialog.Title className="text-lg font-bold">{t('twoFactor.code_dialog_title', { name })}</Dialog.Title>
          <Dialog.Description className="text-mute">{t('twoFactor.code_dialog_body', { name })}</Dialog.Description>
          <div className="flex items-center gap-2">
            <code className="mono flex-1 select-all break-all rounded-md border border-line bg-card2 p-3 text-center text-2xl font-bold tracking-widest" dir="ltr" data-testid="enrol-code-value">{code}</code>
            <button className="btn" data-testid="enrol-code-copy" onClick={() => void copy()}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? t('twoFactor.copied') : t('twoFactor.copy')}</button>
          </div>
          {failed && <p role="alert" className="text-sm text-lateInk">{t('twoFactor.copy_failed')}</p>}
          <p className="text-sm" data-testid="enrol-code-expiry">{t('twoFactor.code_dialog_expires', { date: fmtDateTime(expiresAt, i18n.language) })}</p>
          <p role="alert" className="flex gap-2 rounded-md bg-waitBg p-3 text-sm text-waitInk" data-testid="enrol-code-warning"><TriangleAlert size={16} className="mt-0.5 shrink-0" />{t('twoFactor.code_dialog_warning')}</p>
          <div className="flex justify-end"><button className="btn btn-accent" data-testid="enrol-code-done" onClick={onClose}>{t('twoFactor.code_dialog_done')}</button></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
