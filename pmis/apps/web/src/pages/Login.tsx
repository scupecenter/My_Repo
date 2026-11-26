import { AlertTriangle, Info, LifeBuoy, LogIn } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { isPending, useLocalLogin } from '@/api/auth';
import { API_BASE, ApiError } from '@/api/client';
import { AuthShell, PasswordField } from '@/components/AuthShell';
import { CodeStep, EnrolFlow } from '@/components/TwoFactor';
import { clearRememberedId, readRememberedId, writeRememberedId } from '@/lib/rememberId';

import { safeNext } from '@/lib/nextPath';

export const USE_MOCKS = import.meta.env.VITE_USE_MOCKS === 'true';
/** Microsoft 365 sign-in stays in the code but is hidden until IT registers the app (ADR 0012). */
export const M365_ENABLED = import.meta.env.VITE_M365_ENABLED === 'true';

/** One box. The browser is sent to the API, which resolves the identifier server-side and redirects to Microsoft 365. */
export function loginUrl(identifier: string, returnTo = '/my-work') {
  const q = new URLSearchParams({ return_to: returnTo });
  if (identifier.trim()) q.set('identifier', identifier.trim());
  return USE_MOCKS ? `/mock-m365?${q}` : `${API_BASE}/auth/login?${q}`;
}

export function Login() {
  const { t } = useTranslation();
  const saved = readRememberedId();
  const [id, setId] = useState(saved);
  const [remember, setRemember] = useState(saved !== '');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<'' | 'invalid' | 'rate' | 'other' | 'expired'>('');
  // After a right password, two-factor adds a step: the code, or the first-time setup (contract 0.5.0).
  const [step, setStep] = useState<'password' | 'code' | 'enrol'>('password');
  const [params] = useSearchParams();
  const nav = useNavigate();
  const login = useLocalLogin();
  const keepId = () => { if (remember) writeRememberedId(id); else clearRememberedId(); };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (login.isPending) return;
    setErr('');
    login.mutate({ identifier: id.trim(), password: pw }, {
      onSuccess: (r) => {
        keepId();
        if (isPending(r)) { setPw(''); setStep(r.next === 'enrol' ? 'enrol' : 'code'); return; }
        nav(safeNext(params.get('next')) ?? '/', { replace: true });
      },
      onError: (x) => {
        setPw('');
        // One generic message for every 401: it never says which part was wrong.
        setErr(x instanceof ApiError && x.status === 401 ? 'invalid' : x instanceof ApiError && x.status === 429 ? 'rate' : 'other');
      },
    });
  };
  const restart = (why: '' | 'expired') => { setStep('password'); setPw(''); setErr(why); };
  const finish = () => nav(safeNext(params.get('next')) ?? '/', { replace: true });
  if (step === 'code') return <AuthShell><CodeStep onDone={finish} onBack={() => restart('')} onExpired={() => restart('expired')} /></AuthShell>;
  if (step === 'enrol') return <AuthShell><EnrolFlow onDone={finish} onExpired={() => restart('expired')} /></AuthShell>;
  const msg = err === 'expired' ? t('twoFactor.expired') : err === 'invalid' ? t('login.invalid') : err === 'rate' ? t('login.rate') : err === 'other' ? t('login.error') : params.get('error') ? t('login.error') : '';
  const notice = !msg && params.get('reason') === 'expired' ? t('login.session_ended') : '';
  return (
    <AuthShell>
      <form onSubmit={submit} className="card space-y-4 p-6 sm:p-8" data-testid="login-form" aria-busy={login.isPending}>
        <div>
          <h1 className="text-2xl font-bold">{t('login.title')}</h1>
          <p className="mt-1 text-mute">{t('login.subtitle')}</p>
        </div>
        {notice && <p role="status" className="flex items-start gap-2 rounded-md bg-accentSoft p-3 text-sm text-accentText" data-testid="login-notice"><Info size={16} className="mt-0.5 shrink-0" aria-hidden />{notice}</p>}
        <div>
          <label className="block text-sm font-semibold" htmlFor="identifier">{t('login.label')}</label>
          <input id="identifier" data-testid="login-identifier" className="input mt-1 w-full" dir="ltr" autoComplete="username" autoFocus placeholder={t('login.placeholder')} value={id} onChange={(e) => setId(e.target.value)} />
        </div>
        <PasswordField id="password" label={t('login.password')} testid="login-password" autoComplete="current-password" value={pw} onChange={setPw} />
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <label className="flex cursor-pointer items-center gap-2" title={t('login.remember_hint')}>
            <input type="checkbox" data-testid="login-remember" checked={remember} onChange={(e) => { setRemember(e.target.checked); if (!e.target.checked) clearRememberedId(); }} />
            {t('login.remember')}
          </label>
          <Link to="/forgot-password" className="font-semibold text-link hover:underline" data-testid="login-forgot">{t('login.forgot')}</Link>
        </div>
        {msg && <p role="alert" data-testid="login-error" className="flex items-start gap-2 text-lateInk"><AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />{msg}</p>}
        <button className="btn btn-accent w-full gap-2" data-testid="login-submit" type="submit" disabled={login.isPending || !id.trim() || !pw}>
          <LogIn size={16} aria-hidden />{login.isPending ? t('login.busy') : t('login.button')}
        </button>
        {M365_ENABLED && (
          <>
            <div className="flex items-center gap-2 text-xs text-faint"><span className="h-px flex-1 bg-line" />{t('login.or')}<span className="h-px flex-1 bg-line" /></div>
            <button className="btn w-full" data-testid="login-m365" type="button" onClick={() => window.location.assign(loginUrl(id))}>{t('login.m365')}</button>
          </>
        )}
        <p className="flex items-start gap-2 border-t border-line pt-3 text-xs text-faint" data-testid="login-help"><LifeBuoy size={14} className="mt-0.5 shrink-0" aria-hidden />{t('login.note')}</p>
        <p className="text-xs text-faint">{t('login.need_access')}</p>
      </form>
    </AuthShell>
  );
}
