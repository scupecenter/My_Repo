import { Check, Copy, Download, KeyRound, ShieldCheck, ShieldOff, TriangleAlert } from 'lucide-react';
import QRCode from 'qrcode';
import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useEnrolConfirm, useEnrolStart, useRegenerateRecoveryCodes, useTwoFactorSignIn } from '@/api/auth';
import { ApiError } from '@/api/client';
import type { Session } from '@/api/types';
import { errText, FormDialog } from './FormDialog';
import { useToast } from './Toast';

/** Text of a failed code check. The detail of the server says when the code was already used. */
export function codeErrorText(e: unknown, t: (k: string) => string): string {
  if (e instanceof ApiError && e.status === 401 && e.code === 'invalid_code') return /already used/i.test(e.problem.detail ?? '') ? t('twoFactor.reused') : t('twoFactor.wrong');
  // Contract 0.6.0: the one-time enrolment code from the administrator
  if (e instanceof ApiError && e.status === 401 && e.code === 'invalid_enrol_code') return t('twoFactor.enrol_code_wrong');
  if (e instanceof ApiError && e.status === 401 && e.code === 'enrol_code_expired') return t('twoFactor.enrol_code_expired');
  if (e instanceof ApiError && e.status === 422) return t('twoFactor.enrol_code_required');
  if (e instanceof ApiError && e.status === 429) return t('twoFactor.locked');
  if (e instanceof ApiError && e.status === 401) return t('twoFactor.expired');
  return t('errors.generic');
}

/** Six digits typed or pasted, with the space people put in the middle. */
export function CodeField({ id, value, onChange, label, hint, error, autoFocus }: {
  id: string; value: string; onChange: (v: string) => void; label?: string; hint?: string; error?: string; autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <label className="block text-sm font-semibold" htmlFor={id}>{label ?? t('twoFactor.code_label')}</label>
      <input id={id} data-testid={id} className="input mono mt-1 tracking-widest" dir="ltr" inputMode="numeric" autoComplete="one-time-code" maxLength={7} autoFocus={autoFocus}
        placeholder="123 456" value={value} onChange={(e) => onChange(e.target.value.replace(/[^0-9 ]/g, ''))} aria-invalid={!!error} />
      <p className="mt-1 text-xs text-mute">{hint ?? t('twoFactor.code_hint')}</p>
      {error && <p role="alert" data-testid={`${id}-error`} className="mt-1 text-sm text-lateInk">{error}</p>}
    </div>
  );
}

export const digitsOnly = (v: string) => v.replace(/\s/g, '');
export const codeComplete = (v: string) => /^[0-9]{6}$/.test(digitsOnly(v));

/** Sign-in step 2: the code from the authenticator app, or a recovery code. */
export function CodeStep({ onDone, onBack, onExpired }: { onDone: () => void; onBack: () => void; onExpired: () => void }) {
  const { t } = useTranslation();
  const verify = useTwoFactorSignIn();
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [rc, setRc] = useState('');
  const [err, setErr] = useState('');
  const ready = recovery ? rc.trim().length >= 10 : codeComplete(code);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (verify.isPending || !ready) return;
    setErr('');
    verify.mutate(recovery ? { recovery_code: rc.trim() } : { code: digitsOnly(code) }, {
      onSuccess: onDone,
      onError: (x) => {
        setCode(''); setRc('');
        if (x instanceof ApiError && x.status === 401 && x.code === 'unauthenticated') return onExpired();
        setErr(codeErrorText(x, t));
      },
    });
  };
  return (
    <form onSubmit={submit} className="card w-[min(440px,100%)] space-y-4 p-6" data-testid="two-factor-form">
      <div className="flex items-center gap-2 text-lg font-bold"><span className="grid h-8 w-8 place-items-center rounded-md bg-accent text-accentInk"><ShieldCheck size={18} /></span>{t('twoFactor.login_title')}</div>
      <p className="text-mute">{t('twoFactor.login_body')}</p>
      {recovery
        ? <div>
            <label className="block text-sm font-semibold" htmlFor="two-factor-recovery">{t('twoFactor.recovery_label')}</label>
            <input id="two-factor-recovery" data-testid="two-factor-recovery" className="input mono mt-1" dir="ltr" autoComplete="off" spellCheck={false} autoFocus placeholder="XXXXX-XXXXX" value={rc} onChange={(e) => setRc(e.target.value)} />
            <p className="mt-1 text-xs text-mute">{t('twoFactor.recovery_hint')}</p>
          </div>
        : <CodeField id="two-factor-code" value={code} onChange={setCode} autoFocus />}
      {err && <p role="alert" data-testid="two-factor-error" className="text-lateInk">{err}</p>}
      <button className="btn btn-accent w-full" type="submit" data-testid="two-factor-submit" disabled={verify.isPending || !ready}>{t('twoFactor.login_submit')}</button>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <button type="button" className="text-accent underline" data-testid="two-factor-toggle" onClick={() => { setRecovery(!recovery); setErr(''); }}>{recovery ? t('twoFactor.use_code') : t('twoFactor.use_recovery')}</button>
        <button type="button" className="text-mute underline" data-testid="two-factor-back" onClick={onBack}>{t('twoFactor.login_back')}</button>
      </div>
    </form>
  );
}

/** The otpauth URI as an inline SVG (drawn in the browser, nothing leaves it). Always dark on white so any app can scan it, in both themes. */
export function QrCode({ value, label }: { value: string; label: string }) {
  const q = useMemo(() => {
    const c = QRCode.create(value, { errorCorrectionLevel: 'M' });
    const n = c.modules.size;
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (c.modules.get(x, y)) d += `M${x} ${y}h1v1h-1z`;
    return { n, d };
  }, [value]);
  const quiet = 3;
  return (
    <svg role="img" aria-label={label} data-testid="enrol-qr" viewBox={`${-quiet} ${-quiet} ${q.n + quiet * 2} ${q.n + quiet * 2}`} width={208} height={208} shapeRendering="crispEdges" className="rounded-md border border-line bg-white">
      <path d={q.d} fill="#000" />
    </svg>
  );
}

function useCopy() {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setState('copied'); } catch { setState('failed'); }
  };
  return { state, copy };
}

/** The 10 recovery codes, once, with copy and download. `onDone` is offered only after the user confirms they saved them. */
export function RecoveryCodesView({ codes, onDone, doneLabel }: { codes: string[]; onDone: () => void; doneLabel?: string }) {
  const { t } = useTranslation();
  const { state, copy } = useCopy();
  const [saved, setSaved] = useState(false);
  const text = codes.join('\n');
  const download = () => {
    const blob = new Blob([`${t('twoFactor.codes_file_header')}\n\n${text}\n`], { type: 'text/plain' });
    if (typeof URL.createObjectURL !== 'function') return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = t('twoFactor.codes_file');
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="space-y-3" data-testid="recovery-codes">
      <h2 className="text-lg font-bold">{t('twoFactor.codes_title')}</h2>
      <p className="flex gap-2 rounded-md bg-waitBg p-3 text-sm text-waitInk"><TriangleAlert size={16} className="mt-0.5 shrink-0" />{t('twoFactor.codes_body')}</p>
      <ul className="mono grid grid-cols-2 gap-2 rounded-md border border-line bg-card2 p-3 text-base" dir="ltr" data-testid="recovery-code-list">
        {codes.map((c) => <li key={c} data-testid="recovery-code" className="select-all">{c}</li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn" data-testid="recovery-copy" onClick={() => void copy(text)}>{state === 'copied' ? <Check size={16} /> : <Copy size={16} />}{state === 'copied' ? t('twoFactor.copied') : t('twoFactor.codes_copy')}</button>
        <button type="button" className="btn" data-testid="recovery-download" onClick={download}><Download size={16} />{t('twoFactor.codes_download')}</button>
      </div>
      {state === 'failed' && <p role="alert" className="text-sm text-lateInk">{t('twoFactor.copy_failed')}</p>}
      <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" data-testid="recovery-saved" checked={saved} onChange={(e) => setSaved(e.target.checked)} />{t('twoFactor.codes_saved')}</label>
      <div className="flex justify-end"><button type="button" className="btn btn-accent" data-testid="recovery-continue" disabled={!saved} onClick={onDone}>{doneLabel ?? t('twoFactor.codes_continue')}</button></div>
    </div>
  );
}

/** The enrolment code as people type it: upper case, letters and digits only, the dash after the fourth character (XXXX-XXXX). */
export const formatEnrolCode = (v: string) => {
  const c = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
};
export const enrolCodeComplete = (v: string) => /^[A-Z0-9]{8}$/.test(v.replace('-', ''));

/**
 * Forced enrolment (a user whose two-factor is on and not set up yet). Contract 0.6.0: the one-time code from the administrator comes first;
 * the QR code is shown only after the server accepted it (a password alone cannot enrol a phone). Then the QR code, the manual key,
 * the first code, and the recovery codes. The enrolment code is sent again with the first code and is used up there.
 */
export function EnrolFlow({ onDone, onExpired }: { onDone: () => void; onExpired: () => void }) {
  const { t } = useTranslation();
  const start = useEnrolStart();
  const confirm = useEnrolConfirm();
  const { state, copy } = useCopy();
  const [enrolCode, setEnrolCode] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);

  const askQr = (e: FormEvent) => {
    e.preventDefault();
    if (start.isPending || !enrolCodeComplete(enrolCode)) return;
    setErr('');
    start.mutate({ enrol_code: enrolCode }, {
      onError: (x) => {
        if (x instanceof ApiError && x.status === 401 && x.code === 'unauthenticated') return onExpired();
        setErr(codeErrorText(x, t));
      },
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (confirm.isPending || !codeComplete(code)) return;
    setErr('');
    confirm.mutate({ code: digitsOnly(code), enrol_code: enrolCode }, {
      onSuccess: (r) => setCodes(r.recovery_codes),
      onError: (x) => {
        setCode('');
        if (x instanceof ApiError && x.status === 401 && x.code === 'unauthenticated') return onExpired();
        setErr(codeErrorText(x, t));
      },
    });
  };

  if (codes) return <div className="card w-[min(520px,100%)] p-6"><RecoveryCodesView codes={codes} onDone={onDone} /></div>;
  const e = start.data;
  if (!e) {
    return (
      <form onSubmit={askQr} className="card w-[min(520px,100%)] space-y-4 p-6" data-testid="enrol-code-form">
        <div className="flex items-center gap-2 text-lg font-bold"><span className="grid h-8 w-8 place-items-center rounded-md bg-accent text-accentInk"><KeyRound size={18} /></span>{t('twoFactor.enrol_code_title')}</div>
        <p className="rounded-md bg-waitBg p-2 text-sm text-waitInk" data-testid="enrol-forced">{t('twoFactor.enrol_body')}</p>
        <p className="text-sm">{t('twoFactor.enrol_code_body')}</p>
        <div>
          <label className="block text-sm font-semibold" htmlFor="enrol-admin-code">{t('twoFactor.enrol_code_label')}</label>
          <input id="enrol-admin-code" data-testid="enrol-admin-code" className="input mono mt-1 text-center text-xl tracking-widest" dir="ltr" autoComplete="off" spellCheck={false} autoCapitalize="characters" autoFocus
            placeholder="XXXX-XXXX" maxLength={9} value={enrolCode} onChange={(x) => setEnrolCode(formatEnrolCode(x.target.value))} aria-invalid={!!err} />
          <p className="mt-1 text-xs text-mute">{t('twoFactor.enrol_code_hint')}</p>
          {err && <p role="alert" data-testid="enrol-admin-code-error" className="mt-1 text-sm text-lateInk">{err}</p>}
        </div>
        <button className="btn btn-accent w-full" type="submit" data-testid="enrol-admin-code-submit" disabled={start.isPending || !enrolCodeComplete(enrolCode)}>{t('twoFactor.enrol_code_submit')}</button>
      </form>
    );
  }
  return (
    <form onSubmit={submit} className="card w-[min(520px,100%)] space-y-4 p-6" data-testid="enrol-form">
      <div className="flex items-center gap-2 text-lg font-bold"><span className="grid h-8 w-8 place-items-center rounded-md bg-accent text-accentInk"><ShieldCheck size={18} /></span>{t('twoFactor.enrol_title')}</div>
      <p className="text-sm">{t('twoFactor.enrol_step1')}</p>
      <div className="flex justify-center"><QrCode value={e.otpauth_uri} label={t('twoFactor.qr_alt')} /></div>
      <p className="text-sm">{t('twoFactor.enrol_step2')}</p>
      <div className="flex items-center gap-2">
        <code className="mono flex-1 select-all break-all rounded-md border border-line bg-card2 p-2 text-sm" dir="ltr" aria-label={t('twoFactor.manual_key')} data-testid="enrol-key">{e.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
        <button type="button" className="btn" data-testid="enrol-copy" onClick={() => void copy(e.secret)}>{state === 'copied' ? <Check size={16} /> : <Copy size={16} />}{state === 'copied' ? t('twoFactor.copied') : t('twoFactor.copy')}</button>
      </div>
      {state === 'failed' && <p role="alert" className="text-sm text-lateInk">{t('twoFactor.copy_failed')}</p>}
      <p className="text-sm">{t('twoFactor.enrol_step3')}</p>
      <CodeField id="enrol-code" value={code} onChange={setCode} error={err} />
      <button className="btn btn-accent w-full" type="submit" data-testid="enrol-submit" disabled={confirm.isPending || !codeComplete(code)}>{t('twoFactor.confirm')}</button>
    </form>
  );
}

/** Account card: two-factor state, recovery codes left, and making new ones (needs a valid code). Users cannot turn it off. */
export function TwoFactorCard({ session }: { session: Session | undefined }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [fresh, setFresh] = useState<string[] | null>(null);
  const tf = session?.two_factor;
  if (!tf) return null;
  return (
    <section className="card mt-4 w-[min(460px,100%)] space-y-2 p-4" data-testid="two-factor-card">
      <h2 className="flex items-center gap-2 font-bold">{tf.enabled ? <ShieldCheck size={16} /> : <ShieldOff size={16} />}{t('twoFactor.card_title')}</h2>
      <p className="text-sm text-mute" data-testid="two-factor-card-state">{tf.enabled ? t('twoFactor.card_on') : t('twoFactor.card_off')}</p>
      {tf.enabled && (
        <>
          <p className="text-sm font-semibold" data-testid="recovery-remaining">{t('twoFactor.card_remaining', { count: tf.recovery_codes_remaining })}</p>
          {tf.recovery_codes_remaining <= 3 && <p className="text-sm text-waitInk" data-testid="recovery-low">{t('twoFactor.card_low')}</p>}
          <button className="btn" data-testid="recovery-regenerate" onClick={() => setOpen(true)}>{t('twoFactor.regen_open')}</button>
          <p className="text-xs text-mute">{t('twoFactor.card_note')}</p>
        </>
      )}
      {open && <RegenerateDialog onClose={() => setOpen(false)} onDone={(c) => { setOpen(false); setFresh(c); toast(t('twoFactor.regen_title')); }} />}
      {fresh && (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-scrim/60 p-4" role="dialog" aria-modal="true" data-testid="recovery-codes-dialog">
          <div className="card w-[min(520px,100%)] p-6"><RecoveryCodesView codes={fresh} onDone={() => setFresh(null)} /></div>
        </div>
      )}
    </section>
  );
}

function RegenerateDialog({ onClose, onDone }: { onClose: () => void; onDone: (codes: string[]) => void }) {
  const { t } = useTranslation();
  const regen = useRegenerateRecoveryCodes();
  const [code, setCode] = useState('');
  return (
    <FormDialog open onClose={onClose} testid="regen-dialog" title={t('twoFactor.regen_title')} submitLabel={t('twoFactor.regen_submit')} withReason={false} busy={regen.isPending} disabled={!codeComplete(code)}
      error={regen.isError ? (regen.error instanceof ApiError && regen.error.code === 'invalid_code' ? codeErrorText(regen.error, t) : errText(regen.error, t)) : null}
      onSubmit={() => regen.mutate({ code: digitsOnly(code) }, { onSuccess: (r) => onDone(r.recovery_codes), onError: () => setCode('') })}>
      <p className="text-sm text-mute">{t('twoFactor.regen_body')}</p>
      <CodeField id="regen-code" value={code} onChange={setCode} autoFocus />
    </FormDialog>
  );
}
