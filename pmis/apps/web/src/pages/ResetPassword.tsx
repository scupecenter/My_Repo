import { ArrowLeft, CheckCircle2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useConfirmPasswordReset } from '@/api/auth';
import { ApiError } from '@/api/client';
import { AuthShell, PasswordField } from '@/components/AuthShell';

/** The token travels in the URL fragment (never sent to a server or a log). It is read once and removed from the address bar. */
export const tokenFromHash = (hash: string): string => new URLSearchParams(hash.replace(/^#/, '')).get('token') ?? '';

export function ResetPassword() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [token] = useState(() => tokenFromHash(window.location.hash));
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<'' | 'link' | 'rate' | 'other'>(token ? '' : 'link');
  const [weak, setWeak] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const confirm = useConfirmPasswordReset();
  useEffect(() => { if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search); }, []);
  const mismatch = pw2.length > 0 && pw !== pw2;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (confirm.isPending || !token || !pw || pw !== pw2) return;
    setErr(''); setWeak([]);
    confirm.mutate({ token, new_password: pw }, {
      onSuccess: () => { setPw(''); setPw2(''); setDone(true); },
      onError: (x) => {
        if (x instanceof ApiError && x.status === 422 && x.code === 'weak_password') { setWeak(['policy']); return; }
        setErr(x instanceof ApiError && x.status === 422 ? 'link' : x instanceof ApiError && x.status === 429 ? 'rate' : 'other');
      },
    });
  };
  return (
    <AuthShell>
      <div className="card auth-card auth-enter space-y-4 p-6 sm:p-8" data-testid="reset-card">
        {done ? (
          <div className="space-y-3" role="status" data-testid="reset-done">
            <CheckCircle2 size={32} className="text-doneInk" aria-hidden />
            <h1 className="text-2xl font-bold">{t('reset.done_title')}</h1>
            <p className="text-mute">{t('reset.done_body')}</p>
            <button type="button" className="btn btn-accent w-full" data-testid="reset-to-login" onClick={() => nav('/login', { replace: true })}>{t('reset.to_login')}</button>
          </div>
        ) : err === 'link' ? (
          <div className="space-y-3" role="alert" data-testid="reset-bad-link">
            <h1 className="text-2xl font-bold">{t('reset.bad_title')}</h1>
            <p className="text-mute">{t('reset.bad_body')}</p>
            <Link to="/forgot-password" className="btn btn-accent w-full" data-testid="reset-new-link">{t('reset.new_link')}</Link>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4" data-testid="reset-form" aria-busy={confirm.isPending}>
            <div>
              <h1 className="text-2xl font-bold">{t('reset.title')}</h1>
              <p className="mt-1 text-mute">{t('reset.subtitle')}</p>
            </div>
            <PasswordField id="new-password" label={t('reset.new_password')} testid="reset-password" autoComplete="new-password" autoFocus value={pw} onChange={setPw} describedBy="reset-rules" />
            <PasswordField id="confirm-password" label={t('reset.confirm_password')} testid="reset-password2" autoComplete="new-password" value={pw2} onChange={setPw2} />
            <p id="reset-rules" className="text-xs text-faint">{t('reset.rules')}</p>
            {mismatch && <p role="alert" data-testid="reset-mismatch" className="text-lateInk">{t('reset.mismatch')}</p>}
            {weak.length > 0 && <p role="alert" data-testid="reset-weak" className="text-lateInk">{t('reset.weak')}</p>}
            {(err === 'rate' || err === 'other') && <p role="alert" data-testid="reset-error" className="text-lateInk">{err === 'rate' ? t('login.rate') : t('login.error')}</p>}
            <button className="btn btn-accent w-full" data-testid="reset-submit" type="submit" disabled={confirm.isPending || !pw || pw !== pw2}>{confirm.isPending ? t('login.busy') : t('reset.button')}</button>
          </form>
        )}
        {!done && <Link to="/login" className="inline-flex items-center gap-1 text-sm font-semibold text-link hover:underline"><ArrowLeft size={14} className="rtl:rotate-180" aria-hidden />{t('forgot.back')}</Link>}
      </div>
    </AuthShell>
  );
}
