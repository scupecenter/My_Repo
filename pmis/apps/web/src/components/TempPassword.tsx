import * as Dialog from '@radix-ui/react-dialog';
import { Check, Copy, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ruleKey } from '@/lib/passwordRules';

/** Generate (default) or type a temporary password. `value` is undefined while "generate" is chosen. */
export function PasswordMode({ id, typed, onTyped, value, onValue, errors }: {
  id: string; typed: boolean; onTyped: (b: boolean) => void; value: string; onValue: (v: string) => void; errors?: string[];
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="space-y-2" data-testid={`${id}-mode`}>
      <legend className="text-sm font-semibold">{t('tempPw.mode')}</legend>
      <label className="flex items-center gap-2 text-sm"><input type="radio" name={`${id}-mode`} data-testid={`${id}-mode-generate`} checked={!typed} onChange={() => onTyped(false)} />{t('tempPw.generate')}</label>
      <label className="flex items-center gap-2 text-sm"><input type="radio" name={`${id}-mode`} data-testid={`${id}-mode-type`} checked={typed} onChange={() => onTyped(true)} />{t('tempPw.type')}</label>
      {typed && (
        <div>
          <input data-testid={`${id}-password`} aria-label={t('tempPw.field')} type="text" className="input" dir="ltr" autoComplete="off" spellCheck={false} value={value} onChange={(e) => onValue(e.target.value)} aria-invalid={!!errors?.length} />
          <p className="mt-1 text-xs text-mute">{t('changePw.policy_short')}</p>
          {errors?.map((c) => <p key={c} role="alert" data-testid={`${id}-password-error`} className="text-sm text-lateInk">{t(`changePw.rule_${ruleKey(c)}`)}</p>)}
        </div>
      )}
    </fieldset>
  );
}

/** Shows a temporary password once. It closes only with the button, so it cannot vanish by a stray click. */
export function TempPasswordDialog({ password, title, subject, onClose }: { password: string; title: string; subject?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(password); setCopied(true); setFailed(false); }
    catch { setFailed(true); }
  };
  return (
    <Dialog.Root open onOpenChange={() => { /* closed only by the button */ }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-scrim/60" />
        <Dialog.Content data-testid="temp-password-dialog" className="card fixed inset-x-0 top-[10vh] z-[80] mx-auto w-[min(480px,94vw)] space-y-3 p-5"
          onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
          <Dialog.Title className="text-lg font-bold">{title}</Dialog.Title>
          <Dialog.Description className="text-mute">{subject ? t('tempPw.body_for', { name: subject }) : t('tempPw.body')}</Dialog.Description>
          <div className="flex items-center gap-2">
            <code className="mono flex-1 select-all break-all rounded-md border border-line bg-card2 p-3 text-lg" dir="ltr" data-testid="temp-password">{password}</code>
            <button className="btn" data-testid="temp-password-copy" onClick={() => void copy()}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? t('tempPw.copied') : t('tempPw.copy')}</button>
          </div>
          {failed && <p role="alert" className="text-sm text-lateInk">{t('tempPw.copy_failed')}</p>}
          <p role="alert" className="flex gap-2 rounded-md bg-waitBg p-3 text-sm text-waitInk" data-testid="temp-password-warning"><TriangleAlert size={16} className="mt-0.5 shrink-0" />{t('tempPw.warning')}</p>
          <div className="flex justify-end"><button className="btn btn-accent" data-testid="temp-password-done" onClick={onClose}>{t('tempPw.done')}</button></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
