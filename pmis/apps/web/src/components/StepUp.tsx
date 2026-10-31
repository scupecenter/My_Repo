import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { localStepUp } from '@/api/auth';
import { ApiError, setStepUpHandler } from '@/api/client';
import type { Problem } from '@/api/types';

/** Step-up in a popup so the SPA (and the pending request) survives; the popup lands on /step-up-done and posts back. */
export const STEP_UP_DONE = '/step-up-done';

/** Step-up of a local session: ask for the password; a wrong one stays here with an inline message. */
function PasswordStep({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pw || busy) return;
    setBusy(true); setErr('');
    try { await localStepUp(pw); onDone(); }
    catch (x) {
      setPw('');
      setErr(x instanceof ApiError && x.status === 401 ? t('stepUp.wrong') : x instanceof ApiError && x.status === 429 ? t('login.rate') : t('errors.generic'));
    } finally { setBusy(false); }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="mt-3 space-y-3" data-testid="stepup-password-form">
      <label className="block text-sm font-semibold" htmlFor="stepup-password">{t('stepUp.password')}</label>
      <input id="stepup-password" data-testid="stepup-password" type="password" className="input" dir="ltr" autoComplete="current-password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} aria-invalid={!!err} />
      {err && <p role="alert" data-testid="stepup-error" className="text-lateInk">{err}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" data-testid="stepup-cancel" onClick={onCancel}>{t('stepUp.cancel')}</button>
        <button type="submit" className="btn btn-accent" data-testid="stepup-continue" disabled={busy || !pw}>{t('stepUp.confirm')}</button>
      </div>
    </form>
  );
}

export function StepUpProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [problem, setProblem] = useState<Problem | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const finish = useCallback((ok: boolean) => { resolver.current?.(ok); resolver.current = null; setProblem(null); }, []);

  useEffect(() => {
    setStepUpHandler((p) => new Promise<boolean>((resolve) => { resolver.current = resolve; setProblem(p); }));
    return () => setStepUpHandler(null);
  }, []);

  const start = () => {
    if (!problem?.step_up_url) return finish(false);
    const u = new URL(problem.step_up_url, window.location.origin);
    if (!u.searchParams.has('return_to')) u.searchParams.set('return_to', STEP_UP_DONE);
    const popup = window.open(u.toString(), 'pmis-stepup', 'popup,width=520,height=680');
    if (!popup) { window.location.assign(u.toString()); return; }
    const onMsg = (e: MessageEvent) => {
      if (e.origin === window.location.origin && e.data?.type === 'pmis-step-up-ok') cleanup(true);
    };
    const poll = window.setInterval(() => { if (popup.closed) cleanup(false); }, 500);
    const cleanup = (ok: boolean) => { window.removeEventListener('message', onMsg); clearInterval(poll); finish(ok); };
    window.addEventListener('message', onMsg);
  };

  return (
    <>
      {children}
      <Dialog.Root open={!!problem} onOpenChange={(o) => { if (!o) finish(false); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[90] bg-scrim/60" />
          <Dialog.Content data-testid="stepup-dialog" className="card fixed inset-x-0 top-1/3 z-[90] mx-auto w-[min(420px,92vw)] p-5">
            <Dialog.Title className="text-lg font-bold">{t('stepUp.title')}</Dialog.Title>
            {problem?.step_up_method === 'password' ? (
              <>
                <Dialog.Description className="mt-1 text-mute">{t('stepUp.body_password')}</Dialog.Description>
                <PasswordStep onDone={() => finish(true)} onCancel={() => finish(false)} />
              </>
            ) : (
              <>
                <Dialog.Description className="mt-1 text-mute">{t('stepUp.body')}</Dialog.Description>
                <div className="mt-4 flex justify-end gap-2">
                  <button className="btn" data-testid="stepup-cancel" onClick={() => finish(false)}>{t('stepUp.cancel')}</button>
                  <button className="btn btn-accent" data-testid="stepup-continue" onClick={start}>{t('stepUp.continue')}</button>
                </div>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
