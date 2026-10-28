import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useLocalLogin } from '@/api/auth';
import { API_BASE, ApiError } from '@/api/client';

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
  const [id, setId] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<'' | 'invalid' | 'rate' | 'other'>('');
  const [params] = useSearchParams();
  const nav = useNavigate();
  const login = useLocalLogin();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (login.isPending) return;
    setErr('');
    login.mutate({ identifier: id.trim(), password: pw }, {
      onSuccess: () => nav('/my-work', { replace: true }),
      onError: (x) => {
        setPw('');
        // One generic message for every 401: it never says which part was wrong.
        setErr(x instanceof ApiError && x.status === 401 ? 'invalid' : x instanceof ApiError && x.status === 429 ? 'rate' : 'other');
      },
    });
  };
  const msg = err === 'invalid' ? t('login.invalid') : err === 'rate' ? t('login.rate') : err === 'other' ? t('login.error') : params.get('error') ? t('login.error') : '';
  return (
    <div className="grid min-h-screen place-items-center p-4">
      <form onSubmit={submit} className="card w-[min(440px,100%)] space-y-4 p-6" data-testid="login-form">
        <div className="flex items-center gap-2 text-lg font-bold"><span className="grid h-8 w-8 place-items-center rounded-md bg-accent text-accentInk">G</span>{t('app.name')}</div>
        <h1 className="text-2xl font-bold">{t('login.title')}</h1>
        <p className="text-mute">{t('login.subtitle')}</p>
        <div>
          <label className="block text-sm font-semibold" htmlFor="identifier">{t('login.label')}</label>
          <input id="identifier" data-testid="login-identifier" className="input mt-1" dir="ltr" autoComplete="username" autoFocus placeholder={t('login.placeholder')} value={id} onChange={(e) => setId(e.target.value)} />
        </div>
        <div>
          <label className="block text-sm font-semibold" htmlFor="password">{t('login.password')}</label>
          <input id="password" data-testid="login-password" type="password" className="input mt-1" dir="ltr" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </div>
        {msg && <p role="alert" data-testid="login-error" className="text-lateInk">{msg}</p>}
        <button className="btn btn-accent w-full" data-testid="login-submit" type="submit" disabled={login.isPending || !id.trim() || !pw}>{t('login.button')}</button>
        {M365_ENABLED && (
          <>
            <div className="flex items-center gap-2 text-xs text-faint"><span className="h-px flex-1 bg-line" />{t('login.or')}<span className="h-px flex-1 bg-line" /></div>
            <button className="btn w-full" data-testid="login-m365" type="button" onClick={() => window.location.assign(loginUrl(id))}>{t('login.m365')}</button>
          </>
        )}
        <p className="text-xs text-faint">{t('login.note')}</p>
      </form>
    </div>
  );
}
