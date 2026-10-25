import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { API_BASE } from '@/api/client';

export const USE_MOCKS = import.meta.env.VITE_USE_MOCKS === 'true';

/** One box. The browser is sent to the API, which resolves the identifier server-side and redirects to Microsoft 365. */
export function loginUrl(identifier: string, returnTo = '/my-work') {
  const q = new URLSearchParams({ return_to: returnTo });
  if (identifier.trim()) q.set('identifier', identifier.trim());
  return USE_MOCKS ? `/mock-m365?${q}` : `${API_BASE}/auth/login?${q}`;
}

export function Login() {
  const { t } = useTranslation();
  const [v, setV] = useState('');
  const [params] = useSearchParams();
  const submit = (e: FormEvent) => { e.preventDefault(); window.location.assign(loginUrl(v)); };
  return (
    <div className="grid min-h-screen place-items-center p-4">
      <form onSubmit={submit} className="card w-[min(440px,100%)] space-y-4 p-6" data-testid="login-form">
        <div className="flex items-center gap-2 text-lg font-bold"><span className="grid h-8 w-8 place-items-center rounded-md bg-accent text-accentInk">G</span>{t('app.name')}</div>
        <h1 className="text-2xl font-bold">{t('login.title')}</h1>
        <p className="text-mute">{t('login.subtitle')}</p>
        <label className="block text-sm font-semibold" htmlFor="identifier">{t('login.label')}</label>
        <input id="identifier" data-testid="login-identifier" className="input" dir="ltr" autoComplete="username" placeholder={t('login.placeholder')} value={v} onChange={(e) => setV(e.target.value)} />
        {params.get('error') && <p role="alert" className="text-lateInk">{t('login.error')}</p>}
        <button className="btn btn-accent w-full" data-testid="login-submit" type="submit">{t('login.button')}</button>
        <p className="text-xs text-faint">{t('login.note')}</p>
      </form>
    </div>
  );
}
