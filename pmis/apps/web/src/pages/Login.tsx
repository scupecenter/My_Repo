import { AlertTriangle, Info, LifeBuoy, LogIn } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useLoginPagePublic } from '@/api/settings';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { isPending, useLocalLogin } from '@/api/auth';
import { API_BASE, ApiError } from '@/api/client';
import { AuthShell, PasswordField } from '@/components/AuthShell';
import { PostLogin } from '@/components/PostLogin';
import { CodeStep, DeviceCodeStep, EnrolFlow } from '@/components/TwoFactor';
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
  const { t, i18n } = useTranslation();
  // 0658: render-only card settings (Settings > Screens > Login page); until they load, and when they cannot be read, everything shows.
  const card = useLoginPagePublic().data;
  const showRemember = card?.show_remember ?? true, showHelp = card?.show_help ?? true;
  const arLang = i18n.language === 'ar';
  const welcomeTitle = (arLang ? card?.welcome_title_ar : card?.welcome_title_en)?.trim() || (arLang ? card?.welcome_title_en : card?.welcome_title_ar)?.trim() || t('login.title');
  const welcomeSub = (arLang ? card?.welcome_subtitle_ar : card?.welcome_subtitle_en)?.trim() || (arLang ? card?.welcome_subtitle_en : card?.welcome_subtitle_ar)?.trim() || t('login.subtitle');
  const saved = readRememberedId();
  const [id, setId] = useState(saved);
  const [remember, setRemember] = useState(saved !== '');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<'' | 'invalid' | 'rate' | 'other' | 'expired'>('');
  // After a right password, two-factor adds a step: the code, or the first-time setup (contract 0.5.0).
  const [step, setStep] = useState<'password' | 'code' | 'enrol' | 'device'>('password');
  // After a successful sign-in (password, code or enrolment): the calm post-login transition, then the app (0197).
  const [entering, setEntering] = useState(false);
  const [params] = useSearchParams();
  const nav = useNavigate();
  const login = useLocalLogin();
  const keepId = () => { if (remember && showRemember) writeRememberedId(id); else clearRememberedId(); };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (login.isPending) return;
    setErr('');
    login.mutate({ identifier: id.trim(), password: pw }, {
      onSuccess: (r) => {
        keepId();
        if (isPending(r)) { setPw(''); setStep(r.next === 'enrol' ? 'enrol' : r.next === 'device_code' ? 'device' : 'code'); return; }
        setEntering(true);
      },
      onError: (x) => {
        setPw('');
        // One generic message for every 401: it never says which part was wrong.
        setErr(x instanceof ApiError && x.status === 401 ? 'invalid' : x instanceof ApiError && x.status === 429 ? 'rate' : 'other');
      },
    });
  };
  const restart = (why: '' | 'expired') => { setStep('password'); setPw(''); setErr(why); };
  const finish = () => setEntering(true);
  if (entering) return <PostLogin onDone={() => nav(safeNext(params.get('next')) ?? '/', { replace: true })} />;
  if (step === 'code') return <AuthShell><CodeStep onDone={finish} onBack={() => restart('')} onExpired={() => restart('expired')} /></AuthShell>;
  if (step === 'device') return <AuthShell><DeviceCodeStep onDone={finish} onBack={() => restart('')} onExpired={() => restart('expired')} /></AuthShell>;
  if (step === 'enrol') return <AuthShell><EnrolFlow onDone={finish} onExpired={() => restart('expired')} /></AuthShell>;
  const msg = err === 'expired' ? t('twoFactor.expired') : err === 'invalid' ? t('login.invalid') : err === 'rate' ? t('login.rate') : err === 'other' ? t('login.error') : params.get('error') ? t('login.error') : '';
  const notice = !msg && params.get('reason') === 'expired' ? t('login.session_ended') : '';
  return (
    <AuthShell>
      <form onSubmit={submit} className="card auth-card auth-enter space-y-4 p-6 sm:p-8" data-testid="login-form" aria-busy={login.isPending}>
        <div>
          <h1 className="text-2xl font-bold" data-testid="login-title">{welcomeTitle}</h1>
          <p className="mt-1 text-mute" data-testid="login-subtitle">{welcomeSub}</p>
        </div>
        {notice && <p role="status" className="flex items-start gap-2 rounded-md bg-accentSoft p-3 text-sm text-accentText" data-testid="login-notice"><Info size={16} className="mt-0.5 shrink-0" aria-hidden />{notice}</p>}
        <div>
          <label className="block text-sm font-semibold" htmlFor="identifier">{t('login.label')}</label>
          <input id="identifier" data-testid="login-identifier" className="input mt-1 w-full" dir="ltr" autoComplete="username" autoFocus placeholder={t('login.placeholder')} value={id} onChange={(e) => setId(e.target.value)} />
        </div>
        <PasswordField id="password" label={t('login.password')} testid="login-password" autoComplete="current-password" value={pw} onChange={setPw} />
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          {showRemember ? <label className="flex cursor-pointer items-center gap-2" title={t('login.remember_hint')}>
            <input type="checkbox" data-testid="login-remember" checked={remember} onChange={(e) => { setRemember(e.target.checked); if (!e.target.checked) clearRememberedId(); }} />
            {t('login.remember')}
          </label> : <span />}
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
        {showHelp && <p className="flex items-start gap-2 border-t border-line pt-3 text-xs text-faint" data-testid="login-help"><LifeBuoy size={14} className="mt-0.5 shrink-0" aria-hidden />{t('login.note')}</p>}
        <p className="text-xs text-faint">{t('login.need_access')}</p>
      </form>
    </AuthShell>
  );
}
