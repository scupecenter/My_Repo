import { ArrowLeft, MailCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useRequestPasswordReset } from '@/api/auth';
import { ApiError } from '@/api/client';
import { AuthShell } from '@/components/AuthShell';

/** "Forgot password": one box. The answer is always the same sentence, whether or not the account exists. */
export function ForgotPassword() {
  const { t } = useTranslation();
  const [id, setId] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<'' | 'rate' | 'other'>('');
  const req = useRequestPasswordReset();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (req.isPending || !id.trim()) return;
    setErr('');
    req.mutate({ identifier: id.trim() }, {
      onSuccess: () => setSent(true),
      onError: (x) => setErr(x instanceof ApiError && x.status === 429 ? 'rate' : 'other'),
    });
  };
  return (
    <AuthShell>
      <div className="card space-y-4 p-6 sm:p-8" data-testid="forgot-form-card">
        {sent ? (
          <div className="space-y-3" data-testid="forgot-sent" role="status">
            <MailCheck size={32} className="text-accentText" aria-hidden />
            <h1 className="text-2xl font-bold">{t('forgot.sent_title')}</h1>
            <p className="text-mute">{t('forgot.sent_body')}</p>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4" data-testid="forgot-form" aria-busy={req.isPending}>
            <div>
              <h1 className="text-2xl font-bold">{t('forgot.title')}</h1>
              <p className="mt-1 text-mute">{t('forgot.subtitle')}</p>
            </div>
            <div>
              <label className="block text-sm font-semibold" htmlFor="forgot-identifier">{t('login.label')}</label>
              <input id="forgot-identifier" data-testid="forgot-identifier" className="input mt-1 w-full" dir="ltr" autoComplete="username" autoFocus placeholder={t('login.placeholder')} value={id} onChange={(e) => setId(e.target.value)} />
            </div>
            {err && <p role="alert" data-testid="forgot-error" className="text-lateInk">{err === 'rate' ? t('login.rate') : t('login.error')}</p>}
            <button className="btn btn-accent w-full" data-testid="forgot-submit" type="submit" disabled={req.isPending || !id.trim()}>{req.isPending ? t('login.busy') : t('forgot.button')}</button>
            <p className="text-xs text-faint">{t('forgot.admin_note')}</p>
          </form>
        )}
        <Link to="/login" className="inline-flex items-center gap-1 text-sm font-semibold text-link hover:underline" data-testid="forgot-back"><ArrowLeft size={14} className="rtl:rotate-180" aria-hidden />{t('forgot.back')}</Link>
      </div>
    </AuthShell>
  );
}
